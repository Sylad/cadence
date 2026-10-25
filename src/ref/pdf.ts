import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RafError } from '../plan.js';
import type { ToolPaths } from './tools.js';

/** Résolution du rendu des pages (points PDF → pixels). */
export const DPI = 200;
const SCALE = DPI / 72;

export interface Box {
  x: number;
  y: number;
  l: number;
  h: number;
}
export interface TextLine extends Box {
  text: string;
}
export interface PageText {
  n: number;
  width: number;
  height: number;
  lines: TextLine[];
}
export interface ListedImage {
  page: number;
  /** Rang de l'image dans la page, dans l'ordre de `pdfimages -list` (masques exclus) : celui de `pdftohtml`. */
  rank: number;
  /** Numéro du fichier que `extractImages` écrit pour elle (les masques de transparence en prennent un aussi). */
  slot: number;
  pixelsW: number;
  pixelsH: number;
}
export interface HtmlRegion extends Box {
  page: number;
}

const px = (pt: number): number => Math.round(pt * SCALE);

function exec(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 512, env: { ...process.env, LC_ALL: 'C' } });
}

/** Lance un outil poppler ; son échec (code non nul, sortie trop grosse, sortie illisible) devient une RafError qui le nomme, avec la raison. */
function poppler(name: string, tools: ToolPaths, args: string[], file: string): string {
  try {
    return exec(tools[name]!, args);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const reason = String(err.stderr ?? '').split('\n').find((l) => l.trim() !== '') ?? String(err.message ?? '').split('\n')[0] ?? '';
    const clean = reason.replace(/^Syntax Error[^:]*: /, '').trim();
    throw new RafError(`ref : ${name} a échoué sur ${file}${clean ? ` (${clean})` : ''}`);
  }
}

/** Nombre de pages ; un PDF chiffré, abîmé ou sans page est refusé avec la raison. */
export function pageCount(tools: ToolPaths, file: string): number {
  let out: string;
  try {
    out = exec(tools.pdfinfo!, [file]);
  } catch (e) {
    const err = String((e as { stderr?: string }).stderr ?? '');
    if (/password/i.test(err)) throw new RafError(`ref : ${file} est un PDF chiffré (mot de passe demandé), il n'est pas lu`);
    throw new RafError(`ref : ${file} est un PDF abîmé ou n'est pas un PDF (${err.split('\n')[0]?.replace(/^Syntax Error[^:]*: /, '') || 'pdfinfo refuse de le lire'})`);
  }
  if (/^Encrypted:\s+yes/m.test(out) && /copy:no/.test(out)) throw new RafError(`ref : ${file} est un PDF chiffré dont la copie est interdite, il n'est pas lu`);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1] ?? 0);
  if (pages < 1) throw new RafError(`ref : ${file} n'a aucune page`);
  return pages;
}

const attr = (tag: string, name: string): string => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Texte positionné de tout le document (`pdftotext -bbox-layout` : mots regroupés en lignes), en pixels de la page rendue. */
export function textLayout(tools: ToolPaths, file: string): PageText[] {
  const xml = poppler('pdftotext', tools, ['-bbox-layout', file, '-'], file);
  const pages: PageText[] = [];
  for (const chunk of xml.split('<page ').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf('>'));
    const page: PageText = { n: pages.length + 1, width: px(Number(attr(head, 'width'))), height: px(Number(attr(head, 'height'))), lines: [] };
    for (const m of chunk.matchAll(/<line ([^>]*)>([\s\S]*?)<\/line>/g)) {
      const words = [...m[2]!.matchAll(/<word [^>]*>([^<]*)<\/word>/g)].map((w) => unescapeXml(w[1]!));
      if (words.length === 0) continue;
      const x0 = Number(attr(m[1]!, 'xMin'));
      const y0 = Number(attr(m[1]!, 'yMin'));
      page.lines.push({ text: words.join(' '), x: px(x0), y: px(y0), l: px(Number(attr(m[1]!, 'xMax')) - x0), h: px(Number(attr(m[1]!, 'yMax')) - y0) });
    }
    pages.push(page);
  }
  return pages;
}

/** Images embarquées (masques de transparence exclus), page par page, dans l'ordre du document. */
export function listImages(tools: ToolPaths, file: string): ListedImage[] {
  const out: ListedImage[] = [];
  const slots = new Map<number, number>();
  const ranks = new Map<number, number>();
  for (const row of poppler('pdfimages', tools, ['-list', file], file).split('\n').slice(2)) {
    const c = row.trim().split(/\s+/);
    if (c.length < 5) continue;
    const page = Number(c[0]);
    const slot = slots.get(page) ?? 0;
    slots.set(page, slot + 1);
    if (c[2] === 'smask') continue;
    const rank = (ranks.get(page) ?? 0) + 1;
    ranks.set(page, rank);
    out.push({ page, rank, slot, pixelsW: Number(c[3]), pixelsH: Number(c[4]) });
  }
  return out;
}

/** Rend les pages à 200 dpi dans `dir/page-<n>.png`. */
export function renderPages(tools: ToolPaths, file: string, pages: number[], dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const n of pages) poppler('pdftoppm', tools, ['-r', String(DPI), '-png', '-singlefile', '-f', String(n), '-l', String(n), file, join(dir, `page-${n}`)], file);
}

/** Résolution des vignettes de toutes les pages (à parcourir pour repérer les planches d'un document sans texte). */
export const THUMB_DPI = 40;

/** Vignettes basse résolution de toutes les pages dans `dir/page-<n>.png`. */
export function renderThumbnails(tools: ToolPaths, file: string, total: number, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= total; n++) poppler('pdftoppm', tools, ['-r', String(THUMB_DPI), '-png', '-singlefile', '-f', String(n), '-l', String(n), file, join(dir, `page-${n}`)], file);
}

/** Extrait les images d'une page dans `dir/p<page>-<slot sur 3 chiffres>.png`. */
export function extractImages(tools: ToolPaths, file: string, page: number, dir: string): void {
  mkdirSync(dir, { recursive: true });
  poppler('pdfimages', tools, ['-png', '-f', String(page), '-l', String(page), file, join(dir, `p${page}`)], file);
}

export const imageFile = (page: number, slot: number): string => `p${page}-${String(slot).padStart(3, '0')}.png`;

/** Régions des images d'une page (ordre du document), en pixels de la page rendue : `pdftohtml -xml` au zoom 200/72. */
export function imageRegions(tools: ToolPaths, file: string, page: number): HtmlRegion[] {
  const work = mkdtempSync(join(tmpdir(), 'cadence-ref-'));
  try {
    poppler('pdftohtml', tools, ['-xml', '-q', '-nodrm', '-zoom', String(SCALE), '-f', String(page), '-l', String(page), file, join(work, 'p')], file);
    const xml = readFileSync(join(work, 'p.xml'), 'utf8');
    return [...xml.matchAll(/<image ([^>]*)\/>/g)].map((m) => ({ page, x: Number(attr(m[1]!, 'left')), y: Number(attr(m[1]!, 'top')), l: Number(attr(m[1]!, 'width')), h: Number(attr(m[1]!, 'height')) }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
