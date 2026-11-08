#!/usr/bin/env node
// Hook PreToolUse du bras candidat « sequence-v2 » (lecture obligatoire, spec banc séquence §5, besoin 2).
// Refuse Edit|Write|MultiEdit|NotebookEdit sur un fichier du clone tant qu'une pièce de `<clone>.pieces.json`
// n'a pas été lue EN ENTIER (outil Read sans offset, limit ni pages, R30) dans le transcript de la session,
// sous-agents compris. Le clone est le dossier dont `<dossier>.pieces.json` existe parmi les ancêtres du fichier écrit.
// Sans pieces.json : rien n'est exigé. Lecture des transcripts par blocs, lignes filtrées avant tout JSON.parse.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { appelsOutils, cheminOutil, dansClone, ECRITURES, lectureEntiere } from './lecture.mjs';

/** Le clone qui contient `fichier` : premier ancêtre `d` tel que `d.pieces.json` existe. */
export function trouverClone(fichier) {
  for (let d = dirname(resolve(fichier)); d !== dirname(d); d = dirname(d)) if (existsSync(`${d}.pieces.json`)) return d;
  return null;
}

/** Transcript principal et transcripts des sous-agents (`<session>/subagents/*.jsonl`), que le hook tourne dans l'un ou l'autre. */
export function transcripts(t) {
  const m = /^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(resolve(t));
  const principal = m ? join(m[1], `${m[2]}.jsonl`) : resolve(t);
  const dossier = principal.replace(/\.jsonl$/, '');
  const sous = (d) => (existsSync(d) && statSync(d).isDirectory()
    ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? sous(p) : e.endsWith('.jsonl') ? [p] : []; }) : []);
  return [...new Set([principal, resolve(t), ...sous(dossier)])].filter((f) => existsSync(f));
}

/** Appelle `f` sur chaque ligne du fichier contenant `filtre`, par blocs de 1 Mo (mémoire bornée). */
function lignes(fichier, filtre, f) {
  const fd = openSync(fichier, 'r'), bloc = Buffer.alloc(1 << 20), dec = new StringDecoder('utf8'); // un caractère coupé entre deux blocs reste entier
  let reste = '';
  try {
    for (let n; (n = readSync(fd, bloc, 0, bloc.length, null)) > 0;) {
      const morceaux = (reste + dec.write(bloc.subarray(0, n))).split('\n');
      reste = morceaux.pop();
      for (const l of morceaux) if (l.includes(filtre)) f(l);
    }
    if (reste.includes(filtre)) f(reste);
  } finally { closeSync(fd); }
}

/** Pièces encore à lire en entier, d'après les transcripts. */
export function nonLues(pieces, fichiers) {
  const reste = new Map(pieces.map((p) => [resolve(p), p]));
  for (const t of fichiers) {
    if (!reste.size) break;
    lignes(t, '"Read"', (l) => {
      for (const c of appelsOutils(l)) {
        const f = cheminOutil(c.input);
        if (c.name === 'Read' && f && lectureEntiere(c.input)) reste.delete(resolve(f));
      }
    });
  }
  return [...reste.values()];
}

/** Décision pour une entrée de hook : null (permis) ou la raison du refus. */
export function decider(e) {
  if (!ECRITURES.includes(e?.tool_name)) return null;
  const brut = cheminOutil(e.tool_input);
  if (!brut) return null;
  const fichier = resolve(e.cwd ?? process.cwd(), brut);
  const clone = trouverClone(fichier);
  if (!clone || !dansClone(fichier, clone)) return null;
  let pieces;
  try {
    const j = JSON.parse(readFileSync(`${clone}.pieces.json`, 'utf8'));
    pieces = Array.isArray(j) ? j : j.pieces;
    if (!Array.isArray(pieces) || !pieces.every((p) => typeof p === 'string')) throw new Error('liste « pieces » attendue');
  } catch (err) {
    return `Écriture refusée : ${clone}.pieces.json illisible (${err.message}).`;
  }
  if (!pieces.length) return null;
  const manque = nonLues(pieces, e.transcript_path ? transcripts(e.transcript_path) : []);
  if (!manque.length) return null;
  return `Lis d'abord en entier (outil Read, sans offset, limit ni pages) : ${manque.join(', ')}. `
    + `Ces pièces et documents de référence doivent être lus avant d'écrire dans ${basename(clone)}.`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  let entree;
  try { entree = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const raison = decider(entree);
  if (raison) {
    // Forme JSON documentée (PreToolUse, permissionDecision deny) ET code 2 avec la raison sur stderr : le refus tient dans les deux lectures.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: raison } }));
    process.stderr.write(`${raison}\n`);
    process.exit(2);
  }
  process.exit(0);
}
