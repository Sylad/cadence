#!/usr/bin/env node
// Hook PreToolUse du bras candidat « sequence-v2 » (lecture obligatoire, spec banc séquence §5 ; R30-R32). Refuse une écriture dans le clone
// (Edit|Write|MultiEdit|NotebookEdit, ou Bash qui écrit : ecritureBash) tant qu'une pièce n'est pas COUVERTE par des Read réussis
// (hooks/lecture.mjs), sous-agents compris. Liste par l'environnement fixé au lancement : CADENCE_CLONE, CADENCE_PIECES (JSON), CADENCE_BANC_RACINE.
// Refuse toujours : réglages de Claude Code, dossier du banc hors du clone, code de ce hook. Fermé : absence, illisible ou exception = refus.
// L808 : au banc (CADENCE_LECTURE_BORNEE = id du banc, posé par lancerBras, jamais par cadence run), refuse aussi tout appel (Read, Glob, Grep, Bash, écritures)
// qui cite un chemin que le détecteur de fuites compterait comme fuite certaine (même règle : classer de lecture.mjs).
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { cheminOutil, cheminsCites, classer, contournement, dansClone, dossierTranscripts, ECRITURES, ecritureBash, evenements, lectures, reel, reglageClaude, zonesCertaines } from './lecture.mjs';
const ICI = dirname(new URL(import.meta.url).pathname); // le code du hook

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
      reste = morceaux.pop(); morceaux.forEach(garder);
    }
    garder(reste + dec.end());
  } finally { closeSync(fd); }
}

/** Pièces pas encore couvertes par des Read réussis, d'après les transcripts. */
export function nonLues(pieces, fichiers) {
  const appels = [], ok = new Set();
  for (const t of fichiers) lignes(t, ['"Read"', '"tool_use_id"'], (l) => {
    const e = evenements(l); appels.push(...e.appels.filter((a) => a.name === 'Read')); for (const r of e.resultats) if (!r.erreur) ok.add(r.id);
  });
  return [...lectures(appels, ok, pieces)].filter(([, v]) => !v.entiere).map(([p]) => p);
}

/** L808 : pièces du bras (CADENCE_PIECES), ou null si la liste est absente ou illisible. */
function piecesDe(env) {
  let pieces;
  try { pieces = JSON.parse(env.CADENCE_PIECES ?? ''); } catch { return null; }
  return Array.isArray(pieces) && pieces.every((p) => typeof p === 'string') ? pieces : null;
}

/** L808 : au banc, raison du refus d'un appel qui cite un chemin hors du clone compté fuite certaine, ou null. Règles du détecteur (reglesDuBras, le banc
 * étant CADENCE_LECTURE_BORNEE), les pièces du bras en plus des chemins autorisés. */
export function lectureHorsClone(e, env) {
  const clone = env.CADENCE_CLONE, racine = env.CADENCE_BANC_RACINE, home = env.HOME, pieces = piecesDe(env), banc = env.CADENCE_LECTURE_BORNEE;
  if (!clone || !racine || !home || !pieces || !/^[^/]+$/.test(banc ?? '') || banc === '..') return 'Appel refusé : CADENCE_CLONE, CADENCE_BANC_RACINE, HOME, CADENCE_PIECES ou CADENCE_LECTURE_BORNEE absent ou illisible, les limites du bras sont introuvables.';
  const r = { autorises: [clone, `${clone}.captures`, `${clone}.question.md`, `${clone}.install.log`, `${clone}.tests-base.log`, join(racine, 'bancs', banc), dossierTranscripts(home, clone), ...pieces],
    certains: zonesCertaines(home, racine), runs: join(racine, 'runs') };
  for (const p of cheminsCites(e?.tool_name ?? '', e?.tool_input, e?.cwd, clone, home)) {
    const k = classer(p, r);
    if (k?.classe === 'certaine') return `Appel refusé : il lit hors de ton dépôt (${k.chemin}). Reste dans ${clone} : ce qui te manque se cherche dans le clone. `
      + 'Un paquet Node se trouve depuis le dossier du script : pose ton script dans le sous-projet dont les node_modules ont ce paquet (par exemple frontend/), ou lance-le de là.';
  }
  return null;
}

/** Décision pour une entrée de hook : null (permis) ou la raison du refus. */
export function decider(e, env) {
  const bash = e?.tool_name === 'Bash', cwd = e?.cwd ?? process.cwd();
  if (env.CADENCE_LECTURE_BORNEE) { const hors = lectureHorsClone(e, env); if (hors) return hors; }
  if (!ECRITURES.includes(e?.tool_name) && !bash) return null;
  const clone = env.CADENCE_CLONE, racine = env.CADENCE_BANC_RACINE;
  if (!clone || !racine) return 'Écriture refusée : CADENCE_CLONE ou CADENCE_BANC_RACINE absent, la liste des pièces du bras est introuvable.';
  if (bash) {
    const cmd = String(e.tool_input?.command ?? '');
    if (contournement('Bash', e.tool_input, env.HOME)) return 'Commande refusée : ne touche pas aux réglages de Claude Code.';
    if (ecritureBash(cmd, ICI, cwd)) return 'Commande refusée : elle écrit dans le code du hook.';
    if (!ecritureBash(cmd, clone, cwd)) return ecritureBash(cmd, racine, cwd) && !ecritureBash(cmd, `${clone}.captures`, cwd) ? 'Commande refusée : elle écrit dans le dossier du banc, hors de ton dépôt.' : null;
  } else {
    const brut = cheminOutil(e.tool_input);
    if (!brut) return null;
    const f = resolve(cwd, brut);
    if (reglageClaude(f, env.HOME)) return `Écriture refusée : ${f} est un réglage de Claude Code ; ne touche pas aux réglages de Claude Code.`;
    if (dansClone(f, ICI)) return `Écriture refusée : ${f} est le code du hook.`;
    const permis = dansClone(f, clone) || dansClone(f, `${clone}.captures`) || reel(f) === reel(`${clone}.question.md`);
    if (dansClone(f, racine) && !permis) return `Écriture refusée : ${f} est dans le dossier du banc, hors de ton dépôt.`;
    if (!dansClone(f, clone)) return null;
  }
  const pieces = piecesDe(env);
  if (!pieces)
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
