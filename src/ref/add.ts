import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { RafError } from '../plan.js';
import { attachRegions, citedPages, indexText, type Placed } from './figures.js';
import { DPI, extractImages, imageFile, imageRegions, listImages, pageCount, renderPages, renderThumbnails, textLayout } from './pdf.js';
import { readDocument, writeDocument, type StoredDocument, type StoredImage, type StoredPage } from './store.js';
import { requireTools } from './tools.js';

/** Sans `--sections`, un document de cette taille ou plus petit est rendu en entier ; au-delà, seul l'index est construit. */
export const WHOLE_DOCUMENT_MAX = 30;

/** Une page de moins de 20 caractères de texte est tenue pour scannée (recette du skill norme-etude). */
const SCANNED_MAX_CHARS = 20;

/** [1, 2, 3, 6] → « 1-3, 6 ». */
function ranges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(j > i ? `${pages[i]}-${pages[j]}` : String(pages[i]));
    i = j + 1;
  }
  return out.join(', ');
}

/** `3-5,9` → [3, 4, 5, 9] (pages du PDF, 1 = première), sans doublon, dans l'ordre. */
export function parseSections(text: string, pages: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new RafError(`ref : --sections invalide : « ${part.trim()} » (attendu : 3, 3-5 ou 3-5,9)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) throw new RafError(`ref : --sections invalide : « ${part.trim()} » (pages de 1 à ${pages}, début avant fin)`);
    if (to > pages) throw new RafError(`ref : --sections : page ${to} demandée, le document a ${pages} pages`);
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

const slugOf = (file: string): string => basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface AddOptions {
  document: string;
  slug?: string;
  sections?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  refsDir: () => string;
  now: Date;
  out: (line: string) => void;
}

/**
 * `cadence ref add` : enregistre un PDF, rend les pages visées, garde le texte positionné et les images, construit l'index des figures. Rend le dossier du document
 * et `lues`, les pages qu'une lecture doit lire : avec `--sections`, ces pages et celles des figures qu'elles citent (pas les pages rendues par un appel précédent) ; sans, toutes les pages rendues.
 */
export function add(o: AddOptions): { slug: string; docDir: string; doc: StoredDocument; lues: number[] } {
  // Les outils d'abord : sans eux, rien n'est lu ni écrit.
  const tools = requireTools(o.env);
  const file = resolve(o.cwd, o.document);
  if (!existsSync(file) || !statSync(file).isFile()) throw new RafError(`ref : document introuvable : ${file}`);
  const slug = o.slug ?? slugOf(file);
  if (!SLUG.test(slug)) throw new RafError(`ref : slug invalide : « ${slug} » (lettres minuscules, chiffres et tirets ; --slug pour le choisir)`);
  const total = pageCount(tools, file);
  const wanted = o.sections === undefined ? (total <= WHOLE_DOCUMENT_MAX ? Array.from({ length: total }, (_, i) => i + 1) : []) : parseSections(o.sections, total);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const docDir = join(o.refsDir(), slug);
  const before = readDocument(docDir);
  if (before && before.sha256 !== sha256) {
    throw new RafError(`ref : le slug « ${slug} » est déjà pris par un autre document (${before.source}, empreinte ${before.sha256.slice(0, 12)}) : choisir un autre nom avec --slug`);
  }

  const text = textLayout(tools, file);
  const listed = listImages(tools, file);
  const index = indexText(text, new Set(listed.map((i) => i.page)));
  // pages à rendre : celles visées, celles déjà rendues par un appel précédent du même document, et celles des figures qu'elles citent
  const keep = new Set(before?.pages.filter((p) => p.rendered).map((p) => p.n));
  const visees = new Set([...wanted, ...keep]);
  const rendered = new Set([...visees, ...citedPages(index, visees)]);
  const ordered = [...rendered].sort((a, b) => a - b);

  renderPages(tools, file, ordered, join(docDir, 'pages'));
  renderThumbnails(tools, file, total, join(docDir, 'thumbs'));
  const images: StoredImage[] = [];
  const placed: Placed[] = [];
  const regions = new Map<number, ReturnType<typeof imageRegions>>();
  for (const n of ordered) {
    if (!listed.some((i) => i.page === n)) continue;
    extractImages(tools, file, n, join(docDir, 'images'));
    regions.set(n, imageRegions(tools, file, n));
  }
  for (const img of listed) {
    const box = regions.get(img.page)?.[img.rank - 1];
    const stored: StoredImage = box && rendered.has(img.page) ? { page: img.page, file: `images/${imageFile(img.page, img.slot)}`, x: box.x, y: box.y, l: box.l, h: box.h } : { page: img.page, file: null, x: null, y: null, l: null, h: null };
    images.push(stored);
    placed.push({ page: img.page, box: stored.x === null ? null : { x: stored.x, y: stored.y!, l: stored.l!, h: stored.h! } });
  }
  attachRegions(index, placed);

  const pages: StoredPage[] = text.map((p) => ({ ...p, rendered: rendered.has(p.n) }));
  const doc: StoredDocument = {
    slug,
    source: file,
    sha256,
    added: before?.added ?? o.now.toISOString(),
    dpi: DPI,
    sections: o.sections ?? before?.sections ?? null,
    tools,
    pages,
    images,
    figures: index.figures,
    unresolved: index.unresolved,
  };
  writeDocument(docDir, doc);
  o.out(`${slug} : ${basename(file)}`);
  o.out(`pages : ${total}`);
  const sansTexte = text.filter((p) => p.lines.reduce((n, l) => n + l.text.trim().length, 0) < SCANNED_MAX_CHARS).map((p) => p.n);
  if (sansTexte.length > 0) o.out(`pages sans texte : ${sansTexte.length} (${ranges(sansTexte)}) — scannées ou faites d'images : l'index n'en dit rien, parcourir ${join(docDir, 'thumbs')} pour choisir les pages à rendre (--sections)`);
  o.out(`rendues : ${ordered.length}${ordered.length > 0 ? ` (${ordered.join(', ')})` : ''}`);
  o.out(`images : ${images.length}`);
  o.out(`figures : ${index.figures.length}`);
  o.out(`liens non résolus : ${index.unresolved.length}`);
  o.out(`dossier : ${docDir}`);
  if (ordered.length === 0) o.out(`aucune page rendue (grand document : seul l'index est construit) — cadence ref add ${o.document} --slug ${slug} --sections 3-5 pour rendre des pages`);
  const lues = o.sections === undefined ? ordered : [...new Set([...wanted, ...citedPages(index, new Set(wanted))])].sort((a, b) => a - b);
  return { slug, docDir, doc, lues };
}
