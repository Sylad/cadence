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
const NUMBER = String.raw`[A-Z]{0,2}[-.]?\d+(?:[.-](?:\d+|[A-Z](?![a-z])))*[a-z]?`;
/** Ce qui joint les deux bornes d'une plage : « 4 to 6 », « 4 à 6 », « 2–4 » (demi-cadratin ou cadratin collé aux numéros ; entouré d'espaces, c'est une incise de prose). */
const RANGE = String.raw`(?:\s+(?:to|à)\s+|[–—])`;
/** Ce qui sépare deux numéros d'une énumération au pluriel : « 2, 3 », « 2 and 3 », plus les plages. */
const SEPARATOR = String.raw`(?:\s*,\s*(?:(?:and|et)\s+)?|\s+(?:and|et|&)\s+|${RANGE})`;
const REFERENCE = new RegExp(String.raw`\b(Figures?|Figs?|Tables?|Tableaux|Tableau|Planches?)\.?\s+(${NUMBER}(?:${SEPARATOR}${NUMBER})*)(?![\w])`, 'gi');
const PLURAL = /^(?:figures|figs|tables|tableaux|planches)$/i;
const NUMBER_ONLY = new RegExp(NUMBER, 'g');
/** « Figure n » en début de ligne, puis le séparateur éventuel (tiret, deux-points, point) et le reste de la ligne. */
const CAPTION = new RegExp(String.raw`^(Figure|Fig|Table|Tableau|Planche)\.?\s+(${NUMBER})(?![\w])\s*([:.–—-])?\s*(.*)$`, 'i');
/** Le reste d'une ligne qui n'est qu'une parenthèse fermée : « (in accordance with 4.3.11) ». */
const WHOLE_PARENTHESIS = /^\([^()]*\)$/;
const DEICTIC = /\b(as shown (?:below|above)|shown (?:below|above)|illustrated (?:below|above)|ci-(?:dessous|dessus))\b/i;
/** Points de conduite d'un sommaire : « Figure 1 Titre ..... 12 ». */
const LEADER = /\.{4,}|(?:\.\s){4,}/;
/** Numéro de page en fin de titre d'un sommaire sans points de conduite : « Figure 1 Titre 12 » (le titre est « Titre 12 », le numéro de la figure n'en est pas un). */
const TRAILING_PAGE = /(?:^|\s)(\d{1,4})\s*$/;

const labelOf = (word: string, num: string): { label: string; kind: FigureKind } => {
  const w = WORDS[word.toLowerCase()]!;
  return { label: `${w.word} ${num}`, kind: w.kind };
};
const key = (label: string): string => label.toLowerCase();

/**
 * Une ligne a la forme d'une légende quand elle COMMENCE par « Figure n » / « Table n » et que ce qui suit n'est pas une phrase en
 * cours. Après un séparateur (« Figure 1 — titre en minuscule », « Table 2: codes ») c'est une légende quelle que soit la casse ;
 * sans séparateur, une minuscule (« Figure 3 shows … »), une virgule ou une parenthèse (« Figure 5, which … », « Figure 5 (page 4) and … »)
 * en font une citation. Un séparateur suivi d'un titre vide (« figure 24. » en fin de phrase) n'est pas une légende non plus.
 * Exception : une ligne faite UNIQUEMENT du numéro et d'une parenthèse fermée (« Table IV.3 (in accordance with 4.3.11) ») a la forme
 * d'une légende, `parenthetical` ; `indexText` ne la retient que si aucune autre ligne ne l'est pour ce numéro.
 * « Table 2 The WMO … » a la forme d'une légende : `indexText` la départage des autres lignes de même forme.
 */
function captionForm(text: string): { label: string; kind: FigureKind; separated: boolean; parenthetical: boolean; title: string } | null {
  const m = CAPTION.exec(text.trim());
  if (!m) return null;
  const parenthetical = m[3] === undefined && WHOLE_PARENTHESIS.test(m[4]!);
  if (m[3] === undefined && !parenthetical && /^[a-zà-ÿ,;(\[]/.test(m[4]!)) return null;
  if (m[3] !== undefined && m[4] === '') return null;
  return { ...labelOf(m[1]!, m[2]!), separated: m[3] !== undefined, parenthetical, title: m[4]! };
}

/**
 * Lignes d'une page qui sont des entrées de sommaire (liste des figures, des tables). Une ligne à points de conduite (sur elle ou
 * sur la suivante, titre coupé) en est une. Un numéro final ne suffit jamais : « Table 4.1. … presented in Chapter 4 » est une
 * vraie légende ; il ne compte que dans une page de sommaire, où plus de la moitié des lignes (deux au moins) sont des entrées à
 * points de conduite ou des lignes de forme de légende qui finissent par un numéro de page possible. Toutes les lignes d'une page
 * de sommaire en sont.
 */
function tocLines(page: PageText, lastPage: number): boolean[] {
  const leaders = page.lines.map((l, i) => LEADER.test(l.text) || LEADER.test(page.lines[i + 1]?.text ?? ''));
  const numbered = page.lines.map((l) => {
    const number = TRAILING_PAGE.exec(captionForm(l.text)?.title ?? '')?.[1];
    return number !== undefined && Number(number) <= lastPage;
  });
  const candidates = page.lines.filter((_, i) => leaders[i] || numbered[i]).length;
  const contents = candidates >= 2 && candidates * 2 > page.lines.length;
  return leaders.map((e) => e || contents);
}

const RANGE_ONLY = new RegExp(`^${RANGE}$`, 'i');
/** Un numéro cité ; `interior` : le milieu d'une plage développée, que le texte ne nomme pas (« 5 » dans « 4 to 6 »). */
interface Named {
  num: string;
  interior: boolean;
}
const named = (num: string): Named => ({ num, interior: false });

/**
 * Numéros d'une plage : « 4 » et « 6 » donnent 4, 5, 6 ; « 1.1 » et « 1.3 » donnent 1.1, 1.2, 1.3. Les bornes sont nommées, le milieu non.
 * Sinon les bornes seules : préfixes différents, plage décroissante, 50 numéros ou plus. Une borne nue après une borne à préfixe
 * (« 4.8–10 », « A3–1 ») n'est pas une figure à part : seule la première est gardée.
 */
function expand(from: string, to: string): Named[] {
  const a = /^(.*\.)?(\d+)$/.exec(from);
  const b = /^(.*\.)?(\d+)$/.exec(to);
  if (b && b[1] === undefined && (!a || a[1] !== undefined)) return [named(from)];
  if (!a || !b || (a[1] ?? '') !== (b[1] ?? '')) return [named(from), named(to)];
  const [lo, hi] = [Number(a[2]), Number(b[2])];
  if (hi < lo || hi - lo >= 50) return [named(from), named(to)];
  return Array.from({ length: hi - lo + 1 }, (_, i) => ({ num: `${a[1] ?? ''}${lo + i}`, interior: i > 0 && i < hi - lo }));
}

/** Numéros nommés par une référence : le seul numéro au singulier ; au pluriel la liste, chaque plage (« 4 to 6 », « 2–4 ») développée quand ses bornes le permettent. */
function numbersOf(head: string, list: string): Named[] {
  const found = [...list.matchAll(NUMBER_ONLY)];
  if (!PLURAL.test(head)) return found.slice(0, 1).map((m) => named(m[0]));
  const out: Named[] = [];
  found.forEach((m, i) => {
    const prev = found[i - 1];
    if (prev && RANGE_ONLY.test(list.slice(prev.index + prev[0].length, m.index))) out.splice(out.length - 1, 1, ...expand(prev[0], m[0]));
    else out.push(named(m[0]));
  });
  return out;
}

interface Candidate {
  label: string;
  kind: FigureKind;
  separated: boolean;
  parenthetical: boolean;
  title: string;
  page: number;
  line: number;
  text: string;
  box: Box;
}

/**
 * Légendes, citations et liens non résolus, d'après le texte seul ; les images viennent après (`attachRegions`).
 * Une légende est une ligne de forme de légende (`captionForm`) qui n'est pas une entrée de sommaire ; une entrée de sommaire ne
 * cite rien non plus. Quand plusieurs lignes ont la forme de la légende d'une même figure, on ne garde que celles qui ont un titre
 * (« Figure 5 Jet speed » plutôt que « Figure 5 » seul), s'il y en a ; parmi elles la première qui est sur une page portant une image
 * (`imagePages`), à défaut la première qui a un séparateur (« Table 3 — Mapping… » contre « Table 3 Identifies… »), à défaut la
 * première du document.
 */
export function indexText(pages: PageText[], imagePages: ReadonlySet<number> = new Set()): FigureIndex {
  const last = pages.reduce((m, p) => Math.max(m, p.n), 0);
  const toc = new Map(pages.map((p) => [p.n, tocLines(p, last)]));
  const candidates = new Map<string, Candidate[]>();
  for (const p of pages) {
    p.lines.forEach((l, i) => {
      const c = toc.get(p.n)![i] ? null : captionForm(l.text);
      if (!c) return;
      const list = candidates.get(key(c.label)) ?? [];
      list.push({ ...c, page: p.n, line: i + 1, text: l.text.trim(), box: { x: l.x, y: l.y, l: l.l, h: l.h } });
      candidates.set(key(c.label), list);
    });
  }
  const chosen = [...candidates.values()]
    .map((candidatesOfLabel) => {
      // une ligne « Table n (…) » n'est une légende que si elle est la seule ligne de forme de légende de ce numéro
      const all = candidatesOfLabel.filter((c) => !c.parenthetical || candidatesOfLabel.length === 1);
      if (all.length === 0) return null;
      const list = all.some((c) => c.title !== '') ? all.filter((c) => c.title !== '') : all;
      return list.find((c) => imagePages.has(c.page)) ?? list.find((c) => c.separated) ?? list[0]!;
    })
    .filter((c) => c !== null)
    .sort((a, b) => a.page - b.page || a.line - b.line);
  const figures = new Map<string, Figure>(chosen.map((c) => [key(c.label), { label: c.label, kind: c.kind, page: c.page, line: c.line, caption: c.text, box: c.box, regions: [], citations: [] }]));
  const captionLine = new Set(chosen.map((c) => `${c.page}:${c.line}`));
  const unresolved: Unresolved[] = [];
  for (const p of pages) {
    const captions = [...figures.values()].filter((f) => f.page === p.n);
    p.lines.forEach((l, i) => {
      if (toc.get(p.n)![i]) return;
      const line = i + 1;
      const own = captionLine.has(`${p.n}:${line}`);
      const seen = new Set<string>();
      for (const m of l.text.matchAll(REFERENCE)) {
        // la légende ne se cite pas elle-même
        if (own && m.index === 0) continue;
        for (const { num, interior } of numbersOf(m[1]!, m[2]!)) {
          const { label } = labelOf(m[1]!, num);
          if (seen.has(key(label))) continue;
          seen.add(key(label));
          const fig = figures.get(key(label));
          if (fig) fig.citations.push({ page: p.n, line, extrait: l.text.trim(), type: 'nommee' });
          // le milieu d'une plage sans légende n'est pas un lien à résoudre : « code figures 11–20 » n'en désigne aucune
          else if (!interior) unresolved.push({ label, page: p.n, extrait: l.text.trim() });
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
