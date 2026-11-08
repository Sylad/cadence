// Définition unique de « lire » et « écrire » dans un transcript Claude Code (R30, R31), partagée par le hook
// lecture-obligatoire.mjs (bras candidat) et par la mesure lectureReferences (src/sequence/mesures.ts).
// Lire = COUVRIR le fichier avec des Read RÉUSSIS (tool_result sans is_error) : texte, l'union des [offset, offset+limit)
// couvre toutes ses lignes ; PDF, l'union des `pages` couvre toutes ses pages (un Read sans pages réussi couvre tout) ;
// image, un Read réussi. JavaScript sans dépendance : le hook tourne sous node nu.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Outils qui écrivent un fichier. Une écriture par Bash (sed -i, tee, redirection) n'est pas vue : limite connue. */
export const ECRITURES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const LIMITE_READ = 2000; // défauts de Read : offset 1, limit 2000
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const cheminOutil = (input) => {
  const f = input?.file_path ?? input?.notebook_path;
  return typeof f === 'string' ? f : undefined;
};

/** Chemin réel (liens résolus) ; un chemin qui n'existe pas encore garde son nom sous l'ancêtre réel. */
export function reel(p) {
  const a = resolve(p);
  try { return realpathSync(a); } catch { const d = dirname(a); return d === a ? a : join(reel(d), basename(a)); }
}

export const dansClone = (p, clone) => {
  const r = relative(reel(clone), reel(p));
  return r !== '..' && !r.startsWith('../') && !isAbsolute(r);
};

/** Appels d'outils (assistant) et résultats (tool_result) d'une ligne de transcript, sous-agents compris.
 * Chemin rapide : une ligne de résultats sans `"is_error":true` n'est pas analysée, ses ids sont lus par motif. */
export function evenements(ligne) {
  if (!ligne.includes('"tool_use"') && ligne.includes('"tool_use_id"') && !ligne.includes('"is_error":true'))
    return { appels: [], resultats: [...ligne.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => ({ id: m[1], erreur: false })) };
  let d;
  try { d = JSON.parse(ligne); } catch { return { appels: [], resultats: [] }; }
  const c = Array.isArray(d?.message?.content) ? d.message.content : [];
  return {
    appels: d?.type === 'assistant' ? c.filter((x) => x?.type === 'tool_use' && typeof x.name === 'string').map((x) => ({ id: x.id, name: x.name, input: x.input ?? {} })) : [],
    resultats: c.filter((x) => x?.type === 'tool_result' && typeof x.tool_use_id === 'string').map((x) => ({ id: x.tool_use_id, erreur: x.is_error === true })),
  };
}

const compte = new Map();
const memo = (cle, f) => { if (!compte.has(cle)) compte.set(cle, f()); return compte.get(cle); };
/** Nombre de lignes au sens de Read (un saut final ne compte pas). */
const lignesDe = (f) => memo(`l:${f}`, () => { const t = readFileSync(f, 'utf8'); return t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0); });
/** Pages d'un PDF : pdfinfo, sinon objets /Type /Page ; null si inconnu. */
export const pagesDe = (f) => memo(`p:${f}`, () => {
  const p = spawnSync('pdfinfo', [f], { encoding: 'utf8' });
  const n = Number(/^Pages:\s+(\d+)/m.exec(p.stdout ?? '')?.[1]);
  if (n > 0) return n;
  const objets = (readFileSync(f, 'latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return objets || null;
});
const plages = (pages) => String(pages).split(',').map((s) => s.trim().split('-').map(Number)).map(([a, b]) => [a, b ?? a]);
/** Les intervalles [a, b] couvrent-ils 1..n ? */
function couvre(intervalles, n) {
  let jusqua = 0;
  for (const [a, b] of [...intervalles].sort((x, y) => x[0] - y[0])) { if (a > jusqua + 1) break; jusqua = Math.max(jusqua, b); }
  return jusqua >= n;
}

/** Couverture d'un fichier par ses Read réussis : { entiere, pages_inconnues }. */
export function couverture(f, inputs) {
  if (!inputs.length) return { entiere: false, pages_inconnues: false };
  if (IMAGE.test(f)) return { entiere: true, pages_inconnues: false };
  if (/\.pdf$/i.test(f)) {
    if (inputs.some((i) => i.pages === undefined)) return { entiere: true, pages_inconnues: false };
    const iv = inputs.flatMap((i) => plages(i.pages)).filter(([a, b]) => a > 0 && b >= a);
    const n = pagesDe(f);
    if (n !== null) return { entiere: couvre(iv, n), pages_inconnues: false };
    return { entiere: iv.length > 0 && couvre(iv, Math.max(...iv.map((x) => x[1]))), pages_inconnues: true };
  }
  const iv = inputs.map((i) => { const a = Math.max(1, Number(i.offset ?? 1)); return [a, a + Number(i.limit ?? LIMITE_READ) - 1]; });
  return { entiere: couvre(iv, lignesDe(f)), pages_inconnues: false };
}

/** Pour chaque pièce : lue (au moins un Read réussi), entière (couverte), nombre de pages inconnu.
 * `appels` : Read retenus (déjà filtrés par fenêtre) ; `ok` : ids des résultats sans erreur. */
export function lectures(appels, ok, pieces) {
  const parPiece = new Map(pieces.map((p) => [reel(p), []]));
  for (const a of appels) {
    const f = cheminOutil(a.input);
    if (a.name !== 'Read' || !f || !ok.has(a.id)) continue;
    parPiece.get(reel(f))?.push(a.input);
  }
  return new Map(pieces.map((p) => {
    const inputs = parPiece.get(reel(p));
    let c;
    try { c = couverture(p, inputs); } catch { c = { entiere: false, pages_inconnues: false }; } // pièce illisible : jamais entière
    return [p, { lue: inputs.length > 0, ...c }];
  }));
}
