// Définition unique de « lire » et « écrire » dans un transcript Claude Code (R30, R31), partagée par le hook
// lecture-obligatoire.mjs (bras candidat) et par la mesure lectureReferences (src/sequence/mesures.ts).
// Lire = COUVRIR le fichier avec des Read RÉUSSIS (tool_result sans is_error) : texte, l'union des [offset, offset+limit)
// couvre toutes ses lignes ; PDF, l'union des `pages` couvre toutes ses pages (un Read sans pages réussi couvre tout) ;
// image, un Read réussi. JavaScript sans dépendance : le hook tourne sous node nu.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Outils qui écrivent un fichier ; Bash : voir ecritureBash. */
export const ECRITURES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const LIMITE_READ = 2000; // défauts de Read : offset 1, limit 2000
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const cheminOutil = (input) => { const f = input?.file_path ?? input?.notebook_path; return typeof f === 'string' ? f : undefined; };

/** Chemin réel (liens résolus) ; un chemin qui n'existe pas encore garde son nom sous l'ancêtre réel. */
export function reel(p) {
  const a = resolve(p);
  try { return realpathSync(a); } catch { const d = dirname(a); return d === a ? a : join(reel(d), basename(a)); }
}

export const dansClone = (p, clone) => {
  const r = relative(reel(clone), reel(p));
  return r !== '..' && !r.startsWith('../') && !isAbsolute(r);
};

/** Réglages de Claude Code (R32) : tout ce qui est sous ~/.claude/, et tout `.claude/settings*.json` (disableAllHooks y couperait le hook). */
export const reglageClaude = (p, home) => (!!home && dansClone(p, join(home, '.claude'))) || (basename(dirname(reel(p))) === '.claude' && /^settings.*\.json$/.test(basename(p)));
/** Contournement par un appel d'outil : écriture d'un réglage de Claude Code, ou commande Bash qui y touche. */
export const contournement = (name, input, home) => (ECRITURES.includes(name) && !!cheminOutil(input) && reglageClaude(cheminOutil(input), home))
  || (name === 'Bash' && /disableAllHooks|\.claude\/settings/.test(String(input?.command ?? '')));

/** Une commande Bash écrit-elle dans `clone` ? Redirection > >>, tee, rm, touch, patch, truncate, cp, mv, install, ln (cible), sed/perl -i,
 * git apply/checkout/restore/reset/merge/stash…, --write/--fix, ng/nest generate, python -c|- / node -e|- qui écrit (heredoc : oui). Cible dans le clone, ou relative depuis un dossier courant dans le clone. Dans le doute : oui. */
export function ecritureBash(cmd, clone, cwd = clone) {
  let dir = cwd;
  const dedans = (t) => !!t && t !== '/dev/null' && dansClone(resolve(dir, t.replace(/^(['"])(.*)\1$/, '$2')), clone);
  const texte = String(cmd).replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, '$1') // corps des heredocs retirés
    .replace(/'[^']*'|"[^"]*"/g, (q) => (/[>|;&\n]/.test(q) ? '""' : q)); // guillemets qui cachent un opérateur
  for (const seg of texte.split(/&&|\|\|?|;|\n/)) {
    for (const m of seg.matchAll(/(?<![<>=-])(?:\d|&)?>>?\s*([^\s;&|<>()]+)/g)) if (dedans(m[1])) return true;
    const mots = seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    while (/^\w+=/.test(mots[0] ?? '')) mots.shift();
    const [c, ...args] = mots, noms = args.filter((a) => !a.startsWith('-')), opts = args.filter((a) => a.startsWith('-'));
    if (c === 'cd' && noms[0]) dir = resolve(dir, noms[0].replace(/^(['"])(.*)\1$/, '$2'));
    else if (/^(tee|rm|touch|truncate)$/.test(c) ? noms.some(dedans) : /^(cp|mv|install|ln)$/.test(c) ? dedans(noms.at(-1)) : false) return true;
    else if (c === 'patch' && (dansClone(dir, clone) || noms.some(dedans))) return true;
    else if (/^(sed|perl)$/.test(c) && opts.some((o) => /^-[a-zA-Z]*i|^--in-place/.test(o)) && noms.filter((a) => !/^['"]/.test(a)).some(dedans)) return true;
    else if ((opts.some((o) => /^--(write|fix)(=|$)/.test(o)) || (/^(ng|nest)$/.test(c === 'npx' ? noms[0] : c) && noms.some((a) => /^(g|generate)$/.test(a)))) && (dansClone(dir, clone) || noms.some(dedans))) return true;
    else if (c === 'git') {
      const k = args.indexOf('-C'), g = k >= 0 ? resolve(dir, args[k + 1]) : dir, s = args.indexOf('stash');
      if ((args.some((a) => /^(apply|checkout|restore|reset|merge|pull|rebase|cherry-pick|revert|am|clean|switch|mv|rm)$/.test(a)) || (s >= 0 && !/^(list|show)$/.test(args[s + 1] ?? ''))) && dansClone(g, clone)) return true;
    } else if (/^(python3?|node)$/.test(c ?? '') && opts.some((o) => /^-[ce]?$/.test(o)) && /write|<</i.test(seg) && (dansClone(dir, clone) || seg.includes(clone))) return true;
  }
  return false;
}

/** Appels d'outils (assistant) et résultats (tool_result) d'une ligne de transcript, sous-agents compris.
 * Chemin rapide : une ligne de résultats sans `"is_error":true` n'est pas analysée, ses ids sont lus par motif. */
export function evenements(ligne) {
  if (!ligne.includes('"tool_use"') && ligne.includes('"tool_use_id"') && !ligne.includes('"is_error":true'))
    return { appels: [], resultats: [...ligne.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => ({ id: m[1], erreur: false })) };
  let d;
  try { d = JSON.parse(ligne); } catch { return { appels: [], resultats: [] }; }
  const c = Array.isArray(d?.message?.content) ? d.message.content : [];
  return {
    appels: d?.type === 'assistant' ? c.filter((x) => x?.type === 'tool_use' && typeof x.name === 'string').map((x) => ({ id: x.id, name: x.name, input: x.input ?? {}, cwd: d.cwd })) : [],
    resultats: c.filter((x) => x?.type === 'tool_result' && typeof x.tool_use_id === 'string').map((x) => ({ id: x.tool_use_id, erreur: x.is_error === true })),
  };
}

const compte = new Map();
const memo = (cle, f) => { if (!compte.has(cle)) compte.set(cle, f()); return compte.get(cle); };
/** Nombre de lignes au sens de Read (un saut final ne compte pas). */
const lignesDe = (f) => memo(`l:${f}`, () => { const t = readFileSync(f, 'utf8'); return t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0); });
/** Pages d'un PDF : pdfinfo, sinon objets /Type /Page ; null si inconnu. */
export const pagesDe = (f) => memo(`p:${f}`, () => Number(/^Pages:\s+(\d+)/m.exec(spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout ?? '')?.[1])
  || (readFileSync(f, 'latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length || null);
const plages = (pages) => String(pages).split(',').map((s) => s.trim().split('-').map(Number)).map(([a, b]) => [a, b ?? a]);
/** Les intervalles [a, b] couvrent-ils 1..n ? */
const couvre = (iv, n) => [...iv].sort((x, y) => x[0] - y[0]).reduce((j, [a, b]) => (a > j + 1 ? j : Math.max(j, b)), 0) >= n;

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
  for (const a of appels) if (a.name === 'Read' && cheminOutil(a.input) && ok.has(a.id)) parPiece.get(reel(cheminOutil(a.input)))?.push(a.input);
  return new Map(pieces.map((p) => {
    const inputs = parPiece.get(reel(p));
    const c = (() => { try { return couverture(p, inputs); } catch { return { entiere: false, pages_inconnues: false }; } })(); // illisible : jamais entière
    return [p, { lue: inputs.length > 0, ...c }];
  }));
}
