// Les étapes de la porte complète d'un projet (L786, revue r1 M1) : une seule définition pour `cadence verify --gate` (src/verify-gate.ts, src/config.ts)
// et la porte de `cadence run` (v2/src/run/run.ts). `orchestrate.build`, puis `orchestrate.test` (les tests lisent ce que le build produit), le test en
// chaîne ou en parties (L512 : chaque partie dans son dossier, `cd <dir> && <run>`). Le 19-11, la porte du run ne gardait que `test` en chaîne : sur un projet
// à test en parties (warhammer40k), un run ne jouait que le build, et depuis L786 son vert valait verdict au push sans qu'aucun test ait tourné.
// JavaScript sans dépendance, comme scripts/verdicts-porte.mjs : src et v2 l'importent hors de leur rootDir.
import { isAbsolute, posix } from 'node:path';

const CLES_PARTIE = ['dir', 'run', 'replay'];

/** Un argument protégé pour le shell : tel quel s'il n'a que des caractères sûrs, entre apostrophes sinon. */
function argShell(s) {
  return /^[\w./@+=,:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Le dossier d'une partie, normalisé (`./front/` → `front`) ; null s'il est vide, absolu ou contient « .. ». */
function dossierDePartie(v) {
  if (typeof v !== 'string' || !v.trim() || isAbsolute(v.trim()) || v.split(/[\\/]/).includes('..')) return null;
  const n = posix.normalize(v.trim().replaceAll('\\', '/')).replace(/\/+$/, '');
  return n || null;
}

/** Le replay d'une partie : absent, ou une commande non vide contenant `{files}` ; `{ replay }` ou `{ refus }`. */
function lireReplay(v, dir) {
  if (v == null) return {};
  if (typeof v !== 'string' || !v.trim() || !v.includes('{files}')) return { refus: `test : le replay de la partie « ${dir} » doit être une commande non vide contenant {files} (remplacé par les fichiers des tests rouges)` };
  return { replay: v.trim() };
}

/** Une partie de `orchestrate.test` (`vus` : les dossiers déjà lus) : `{ partie }` ou `{ refus }`. */
function lirePartie(item, vus) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return { refus: 'test : chaque partie doit être un objet { dir, run, replay? }' };
  const inconnue = Object.keys(item).find((k) => !CLES_PARTIE.includes(k));
  if (inconnue) return { refus: `test : clé « ${inconnue} » inconnue dans une partie (attendu : dir, run, replay)` };
  const dir = dossierDePartie(item.dir);
  if (dir === null || vus.has(dir)) return { refus: `test : dir invalide « ${typeof item.dir === 'string' ? item.dir : JSON.stringify(item.dir)} » (chemin relatif, sans « .. », unique)` };
  vus.add(dir);
  if (typeof item.run !== 'string' || !item.run.trim()) return { refus: `test : la commande run de la partie « ${dir} » ne peut pas être vide (chaîne non vide attendue)` };
  const r = lireReplay(item.replay, dir);
  if (r.refus) return r;
  return { partie: { dir, run: item.run.trim(), ...(r.replay ? { replay: r.replay } : {}) } };
}

/**
 * Lecture de `orchestrate.test` (contrat A1 de L512) : `{ porte }` — la chaîne sans ses blancs, ou la liste des parties validées — ou `{ refus }`, ce qui
 * est refusé (src/config.ts en fait l'erreur de cadence.yaml ; la porte d'un run ne joue alors rien et ne note aucun verdict).
 */
export function lirePorteTest(brut) {
  if (typeof brut === 'string') return brut.trim() ? { porte: brut.trim() } : { refus: 'test : commande non vide attendue' };
  if (!Array.isArray(brut)) return { refus: 'test : commande non vide attendue (chaîne ou liste de parties { dir, run, replay? })' };
  if (!brut.length) return { refus: 'test : au moins une partie attendue (dir, run, replay facultatif)' };
  const vus = new Set(), parties = [];
  for (const item of brut) {
    const p = lirePartie(item, vus);
    if (p.refus) return { refus: p.refus };
    parties.push(p.partie);
  }
  return { porte: parties };
}

/** La commande d'une partie jouée depuis la racine du lieu : un dossier introuvable fait sortir le shell en échec en le nommant (« can't cd to dir »). */
export const commandeDePartie = (partie, commande = partie.run) => `cd ${argShell(partie.dir)} && ${commande}`;

/**
 * Les étapes de la porte lues dans la clé `orchestrate` de cadence.yaml (brute ou déjà lue par src/config.ts) : `{ etapes }`, chacune
 * `{ nom: 'build' | 'tests', porte, commandes }` (`porte` : la chaîne ou les parties ; `commandes` : ce que le shell joue, une par partie), dans l'ordre de
 * `verify --gate` ; ou `{ refus }` quand `build` ou `test` est refusé.
 */
export function lireEtapes(orchestrate) {
  const o = orchestrate ?? {}, etapes = [];
  if (o.build != null) {
    if (typeof o.build !== 'string' || !o.build.trim()) return { refus: 'build : commande non vide attendue' };
    etapes.push({ nom: 'build', porte: o.build.trim(), commandes: [o.build.trim()] });
  }
  if (o.test != null) {
    const t = lirePorteTest(o.test);
    if (t.refus) return { refus: t.refus };
    etapes.push({ nom: 'tests', porte: t.porte, commandes: Array.isArray(t.porte) ? t.porte.map((p) => commandeDePartie(p)) : [t.porte] });
  }
  return { etapes };
}
