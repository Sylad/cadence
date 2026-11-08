#!/usr/bin/env node
// Hook PreToolUse du bras candidat « sequence-v2 » (lecture obligatoire, spec banc séquence §5, besoin 2 ; R30, R31).
// Refuse Edit|Write|MultiEdit|NotebookEdit sur un fichier du clone tant qu'une pièce n'est pas COUVERTE par des Read
// réussis (hooks/lecture.mjs) dans le transcript de la session, sous-agents compris.
// La liste vient de l'environnement du bras, fixé par le banc au lancement (le bras ne peut pas la changer) :
// CADENCE_CLONE (dossier du clone), CADENCE_PIECES (tableau JSON de chemins absolus) et CADENCE_BANC_RACINE. Absente ou illisible : refus.
// R32 : refuse aussi toute écriture des réglages de Claude Code (~/.claude/, **/.claude/settings*.json) et du dossier du banc hors du clone.
// Fermé en cas d'erreur : toute exception refuse l'écriture. Transcripts lus par blocs, lignes filtrées avant tout JSON.parse.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { cheminOutil, dansClone, ECRITURES, evenements, lectures, reel, reglageClaude } from './lecture.mjs';

/** Transcript principal et transcripts des sous-agents (`<session>/subagents/*.jsonl`), que le hook tourne dans l'un ou l'autre. */
export function transcripts(t) {
  const m = /^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(resolve(t));
  const principal = m ? join(m[1], `${m[2]}.jsonl`) : resolve(t);
  const sous = (d) => (existsSync(d) && statSync(d).isDirectory()
    ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? sous(p) : e.endsWith('.jsonl') ? [p] : []; }) : []);
  return [...new Set([principal, resolve(t), ...sous(principal.replace(/\.jsonl$/, ''))])].filter((f) => existsSync(f));
}

/** Appelle `f` sur chaque ligne du fichier qui contient un des `filtres`, par blocs de 1 Mo (mémoire bornée). */
function lignes(fichier, filtres, f) {
  const fd = openSync(fichier, 'r'), bloc = Buffer.alloc(1 << 20), dec = new StringDecoder('utf8');
  const garder = (l) => { if (filtres.some((x) => l.includes(x))) f(l); };
  let reste = '';
  try {
    for (let n; (n = readSync(fd, bloc, 0, bloc.length, null)) > 0;) {
      const morceaux = (reste + dec.write(bloc.subarray(0, n))).split('\n');
      reste = morceaux.pop();
      morceaux.forEach(garder);
    }
    garder(reste + dec.end());
  } finally { closeSync(fd); }
}

/** Pièces pas encore couvertes par des Read réussis, d'après les transcripts. */
export function nonLues(pieces, fichiers) {
  const appels = [], ok = new Set();
  for (const t of fichiers) lignes(t, ['"Read"', '"tool_use_id"'], (l) => {
    const e = evenements(l);
    appels.push(...e.appels.filter((a) => a.name === 'Read'));
    for (const r of e.resultats) if (!r.erreur) ok.add(r.id);
  });
  return [...lectures(appels, ok, pieces)].filter(([, v]) => !v.entiere).map(([p]) => p);
}

/** Décision pour une entrée de hook : null (permis) ou la raison du refus. */
export function decider(e, env) {
  if (!ECRITURES.includes(e?.tool_name)) return null;
  const clone = env.CADENCE_CLONE, racine = env.CADENCE_BANC_RACINE;
  if (!clone || !racine) return 'Écriture refusée : CADENCE_CLONE ou CADENCE_BANC_RACINE absent, la liste des pièces du bras est introuvable.';
  const brut = cheminOutil(e.tool_input);
  if (!brut) return null;
  const f = resolve(e.cwd ?? process.cwd(), brut);
  if (reglageClaude(f, env.HOME)) return `Écriture refusée : ${f} est un réglage de Claude Code ; ne touche pas aux réglages de Claude Code.`;
  const permis = dansClone(f, clone) || dansClone(f, `${clone}.captures`) || reel(f) === reel(`${clone}.question.md`);
  if (dansClone(f, racine) && !permis) return `Écriture refusée : ${f} est dans le dossier du banc, hors de ton dépôt.`;
  if (!dansClone(f, clone)) return null;
  let pieces;
  try { pieces = JSON.parse(env.CADENCE_PIECES ?? ''); } catch { pieces = null; }
  if (!Array.isArray(pieces) || !pieces.every((p) => typeof p === 'string'))
    return 'Écriture refusée : CADENCE_PIECES absent ou illisible (tableau JSON de chemins attendu).';
  if (!pieces.length) return null;
  const manque = nonLues(pieces, e.transcript_path ? transcripts(e.transcript_path) : []);
  if (!manque.length) return null;
  return `Lis d'abord en entier (outil Read ; texte long : offset/limit jusqu'à la dernière ligne ; PDF : pages jusqu'à la dernière) : ${manque.join(', ')}. `
    + 'Ces pièces et documents de référence doivent être lus avant d\'écrire dans le dépôt.';
}

function refuser(raison) {
  // Forme JSON documentée (PreToolUse, permissionDecision deny) ET code 2 avec la raison sur stderr : le refus tient dans les deux lectures.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } }));
  process.stderr.write(`${raison}\n`);
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  let raison;
  try { raison = decider(JSON.parse(readFileSync(0, 'utf8')), process.env); } catch (err) { raison = `hook en erreur : ${err?.message ?? err}`; }
  if (raison) refuser(raison);
  process.exit(0);
}
