import type { Box, PageText } from './pdf.js';

export type FigureKind = 'figure' | 'table' | 'planche';

export interface Citation {
  page: number;
  /** Rang de la ligne dans la page, à partir de 1. */
  line: number;
  /** La ligne entière, telle que lue. */
  extrait: string;
  /** `nommee` : le texte nomme la figure ; `designee` : « as shown below », rattachée à la légende la plus proche de la page. */
  type: 'nommee' | 'designee';
}

export interface Figure {
  label: string;
  kind: FigureKind;
  page: number;
  line: number;
  caption: string;
  box: Box;
  /** Rangs dans `document.images` des images qui la portent. */
  regions: number[];
  citations: Citation[];
}

export interface Unresolved {
  label: string;
  page: number;
  extrait: string;
}

export interface FigureIndex {
  figures: Figure[];
  unresolved: Unresolved[];
}

const WORDS: Record<string, { kind: FigureKind; word: string }> = {
  figure: { kind: 'figure', word: 'Figure' },
  figures: { kind: 'figure', word: 'Figure' },
  fig: { kind: 'figure', word: 'Figure' },
  figs: { kind: 'figure', word: 'Figure' },
  table: { kind: 'table', word: 'Table' },
  tables: { kind: 'table', word: 'Table' },
  tableau: { kind: 'table', word: 'Tableau' },
  tableaux: { kind: 'table', word: 'Tableau' },
  planche: { kind: 'planche', word: 'Planche' },
  planches: { kind: 'planche', word: 'Planche' },
};
const NUMBER = String.raw`[A-Z]{0,2}[-.]?\d+(?:[.-]\d+)*[a-z]?`;
/** Ce qui sépare deux numéros d'une énumération au pluriel : « 2, 3 », « 2 and 3 », « 4 to 6 ». */
const SEPARATOR = String.raw`(?:\s*,\s*(?:(?:and|et)\s+)?|\s+(?:and|et|to|à|&)\s+)`;
const REFERENCE = new RegExp(String.raw`\b(Figures?|Figs?|Tables?|Tableaux|Tableau|Planches?)\.?\s+(${NUMBER}(?:${SEPARATOR}${NUMBER})*)(?![\w])`, 'gi');
const PLURAL = /^(?:figures|figs|tables|tableaux|planches)$/i;
const NUMBER_ONLY = new RegExp(NUMBER, 'g');
const CAPTION = new RegExp(String.raw`^(Figure|Fig|Table|Tableau|Planche)\.?\s+(${NUMBER})(?![\w])\s*(?:[:.–—-]\s*)?(.*)$`, 'i');
const DEICTIC = /\b(as shown (?:below|above)|shown (?:below|above)|illustrated (?:below|above)|ci-(?:dessous|dessus))\b/i;
/** Sommaire : « Figure 1 Titre ..... 12 ». */
const LEADER = /\.{4,}|(?:\.\s){4,}/;

const labelOf = (word: string, num: string): { label: string; kind: FigureKind } => {
  const w = WORDS[word.toLowerCase()]!;
  return { label: `${w.word} ${num}`, kind: w.kind };
};
const key = (label: string): string => label.toLowerCase();

/**
 * Une ligne est une légende quand elle COMMENCE par « Figure n » / « Table n » et que ce qui suit n'est pas une phrase en cours
 * (« Figure 3 shows … » cite, « Figure 3 Station model » légende) ; une ligne de sommaire n'en est pas une.
 */
function captionOf(text: string): { label: string; kind: FigureKind } | null {
  const m = CAPTION.exec(text.trim());
  if (!m || LEADER.test(text)) return null;
  if (/^[a-zà-ÿ]/.test(m[3]!)) return null;
  return labelOf(m[1]!, m[2]!);
}

/** Numéros nommés par une référence : le seul numéro au singulier ; au pluriel la liste, et « 4 to 6 » donne 4, 5, 6 quand ce sont des entiers. */
function numbersOf(head: string, list: string): string[] {
  const nums = list.match(NUMBER_ONLY) ?? [];
  if (!PLURAL.test(head)) return nums.slice(0, 1);
  const range = /^(\d+)\s+(?:to|à)\s+(\d+)$/i.exec(list.trim());
  if (range && Number(range[2]) >= Number(range[1]) && Number(range[2]) - Number(range[1]) < 50) {
    return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => String(Number(range[1]) + i));
  }
  return nums;
}

/** Légendes, citations et liens non résolus, d'après le texte seul ; les images viennent après (`attachRegions`). */
export function indexText(pages: PageText[]): FigureIndex {
  const figures = new Map<string, Figure>();
  const captionLine = new Set<string>();
  for (const p of pages) {
    p.lines.forEach((l, i) => {
      const c = captionOf(l.text);
      if (!c || figures.has(key(c.label))) return;
      figures.set(key(c.label), { label: c.label, kind: c.kind, page: p.n, line: i + 1, caption: l.text.trim(), box: { x: l.x, y: l.y, l: l.l, h: l.h }, regions: [], citations: [] });
      captionLine.add(`${p.n}:${i + 1}`);
    });
  }
  const unresolved: Unresolved[] = [];
  for (const p of pages) {
    const captions = [...figures.values()].filter((f) => f.page === p.n);
    p.lines.forEach((l, i) => {
      const line = i + 1;
      const own = captionLine.has(`${p.n}:${line}`);
      const seen = new Set<string>();
      for (const m of l.text.matchAll(REFERENCE)) {
        // la légende ne se cite pas elle-même
        if (own && m.index === 0) continue;
        for (const num of numbersOf(m[1]!, m[2]!)) {
          const { label } = labelOf(m[1]!, num);
          if (seen.has(key(label))) continue;
          seen.add(key(label));
          const fig = figures.get(key(label));
          if (fig) fig.citations.push({ page: p.n, line, extrait: l.text.trim(), type: 'nommee' });
          else unresolved.push({ label, page: p.n, extrait: l.text.trim() });
        }
      }
      const d = DEICTIC.exec(l.text);
      if (!d) return;
      const nearest = captions.reduce<Figure | null>((best, f) => (best === null || Math.abs(f.line - line) < Math.abs(best.line - line) ? f : best), null);
      if (nearest) nearest.citations.push({ page: p.n, line, extrait: l.text.trim(), type: 'designee' });
      else unresolved.push({ label: d[1]!.toLowerCase(), page: p.n, extrait: l.text.trim() });
    });
  }
  // une figure que rien ne cite est aussi à résoudre
  for (const f of figures.values()) if (f.citations.length === 0) unresolved.push({ label: f.label, page: f.page, extrait: f.caption });
  return { figures: [...figures.values()], unresolved };
}

/** Pages à rendre en plus de celles visées : celles des figures que les pages visées citent par leur nom. */
export function citedPages(index: FigureIndex, wanted: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const f of index.figures) if (f.citations.some((c) => c.type === 'nommee' && wanted.has(c.page))) out.add(f.page);
  return out;
}

export interface Placed {
  page: number;
  /** Région connue seulement pour une page rendue. */
  box: Box | null;
}

const centre = (b: Box): number => b.y + b.h / 2;

/** Relie chaque image à la légende de sa page la plus proche (en hauteur) ; une page sans région connue ne la donne qu'à sa seule légende. Une image sur une page sans légende est un lien non résolu. */
export function attachRegions(index: FigureIndex, images: Placed[]): void {
  images.forEach((img, rank) => {
    const captions = index.figures.filter((f) => f.page === img.page);
    const target = img.box
      ? captions.reduce<Figure | null>((best, f) => (best === null || Math.abs(centre(f.box) - centre(img.box!)) < Math.abs(centre(best.box) - centre(img.box!)) ? f : best), null)
      : captions.length === 1
        ? captions[0]!
        : null;
    target?.regions.push(rank);
    if (captions.length === 0) index.unresolved.push({ label: 'image sans légende', page: img.page, extrait: '' });
  });
}
