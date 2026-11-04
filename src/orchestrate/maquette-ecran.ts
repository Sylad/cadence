import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { LARGEURS } from '../spec.js';

// Fiche qui déclare l'index de la maquette (`ecran.maquette`) ET la page qui dessine les états (`ecran.maquette_ecran`) (L573, issue #34).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const states = (doc: Obj): string[] => [...new Set(Array.isArray(doc.etats) ? doc.etats.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : [])];

const hasTestid = (html: string, id: string): boolean => new RegExp(`data-testid=["']${id}["']`).test(html);
const hasSection = (html: string, etat: string): boolean => new RegExp(`\\bid=["']etat-${etat}["']`).test(html);
const escapeHtml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** La page `ecran.maquette_ecran` (relative au dépôt) quand elle existe, reste dans le dépôt et n'est pas l'index lui-même ; sinon null. */
function ecranPage(repo: string, doc: Obj, index: string): string | null {
  const ecran = isObj(doc.ecran) ? doc.ecran : {};
  if (typeof ecran.maquette_ecran !== 'string' || ecran.maquette_ecran.trim() === '') return null;
  const rel = relative(repo, resolve(repo, ecran.maquette_ecran));
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || rel === index) return null;
  return existsSync(join(repo, rel)) && statSync(join(repo, rel)).isFile() ? rel : null;
}

/** `ecran.maquette_ecran` doit être un texte quand la clé est là (les écarts de `cadence spec check`). */
export const maquetteEcranProblems = (ecran: Obj): string[] =>
  'maquette_ecran' in ecran && !(typeof ecran.maquette_ecran === 'string' && ecran.maquette_ecran.trim() !== '') ? ['ecran.maquette_ecran : texte attendu (le chemin de la page qui dessine les états, ou retirer la clé)'] : [];

/**
 * Les écarts de l'index de la maquette : une section `#etat-<état>` par état, un `data-testid` par champ. Quand la page `maquette_ecran` dessine ce que l'index n'a pas,
 * l'écart dit « présent dans maquette_ecran, absent de l'index ». `html` vide (index absent) : aucun écart ici, l'absence de l'index est déjà relevée.
 */
export function indexProblems(repo: string, doc: Obj, index: string, html: string, etats: string[]): string[] {
  if (!html) return [];
  const page = ecranPage(repo, doc, index);
  const drawn = page ? readFileSync(join(repo, page), 'utf8') : '';
  const where = (what: string, feminine: boolean, inPage: boolean, plain: string) => (inPage ? `maquette.html : ${what} ${feminine ? 'présente' : 'présent'} dans maquette_ecran, ${feminine ? 'absente' : 'absent'} de l'index` : plain);
  return [
    ...etats.filter((e) => !hasSection(html, e)).map((e) => where(`section id="etat-${e}"`, true, hasSection(drawn, e), `maquette.html : section id="etat-${e}" absente`)),
    ...list(doc.champs).flatMap((c) => (typeof c.id === 'string' && !hasTestid(html, c.id) ? [where(`data-testid="${c.id}"`, false, hasTestid(drawn, c.id), `maquette.html : data-testid="${c.id}" absent (chaque champ de la fiche le porte)`)] : [])),
  ];
}

/** Les entrées de l'index que la page dessine et que l'index n'a pas : un `<p data-testid>` par champ, une `<section id="etat-…">` par état. */
function missingEntries(doc: Obj, html: string, drawn: string): string[] {
  const fields = list(doc.champs).filter((c) => typeof c.id === 'string' && !hasTestid(html, c.id) && hasTestid(drawn, c.id));
  return [
    ...fields.map((c) => `<p data-testid="${String(c.id)}">${escapeHtml(typeof c.libelle === 'string' ? c.libelle : String(c.id))}</p>`),
    ...states(doc).filter((e) => !hasSection(html, e) && hasSection(drawn, e)).map((e) => `<section id="etat-${e}"></section>`),
  ];
}

/** Copie dans `folder` les captures `maquette-<état>-<largeur>.png` posées dans `from` et absentes de `folder` ; rend les fichiers copiés. */
function copyCaptures(repo: string, doc: Obj, from: string, folder: string): string[] {
  if (from === folder) return [];
  const names = states(doc).flatMap((e) => LARGEURS.map((w) => `maquette-${e}-${w}.png`));
  return names
    .filter((n) => !existsSync(join(repo, folder, n)) && existsSync(join(repo, from, n)))
    .map((n) => {
      copyFileSync(join(repo, from, n), join(repo, folder, n));
      return `${folder}/${n}`;
    });
}

/**
 * Index de la maquette complété depuis `ecran.maquette_ecran` : ce que la page dessine et que l'index n'a pas y est ajouté, et les captures posées à côté de la page sont
 * copiées dans le dossier de la fiche quand elles y manquent. Rien n'est inventé : ce que la page ne dessine pas reste un écart de `checkSpec`. Rend les fichiers
 * (relatifs au dépôt) écrits, vide quand il n'y a rien à faire (aucune clé, page introuvable ou hors du dépôt, déjà complet) ; l'appelant les commite.
 */
export function completeIndex(repo: string, fiche: string): string[] {
  const file = join(repo, fiche);
  let doc: unknown;
  try {
    doc = existsSync(file) ? parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return [];
  }
  const folder = fiche.replace(/\/fiche\.yaml$/, '');
  const index = `${folder}/maquette.html`;
  const page = isObj(doc) ? ecranPage(repo, doc, index) : null;
  if (!isObj(doc) || !page || !existsSync(join(repo, index))) return [];
  const html = readFileSync(join(repo, index), 'utf8');
  const entries = missingEntries(doc, html, readFileSync(join(repo, page), 'utf8'));
  if (entries.length) writeFileSync(join(repo, index), `${html.replace(/\s*$/, '')}\n${entries.join('\n')}\n`);
  return [...(entries.length ? [index] : []), ...copyCaptures(repo, doc, dirname(page), folder)];
}
