import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RafError } from '../plan.js';
import { SLUG } from './add.js';
import { decodePng, encodePng, type Raster } from './png.js';
import { readDocument } from './store.js';
import { requireTools, type ToolPaths } from './tools.js';

const QUOI = ['couleurs', 'contraste', 'boites', 'texte'] as const;
type Quoi = (typeof QUOI)[number];

/** Largeur d'écran de référence, en pixels, à laquelle les mesures sont ramenées. */
const REFERENCE_WIDTH = 1440;

/** Écart d'un canal (0-255) après arrondi de la moyenne d'un carré. */
const COLOR_TOLERANCE = 1;
/** Part de la taille de police due à la forme des lettres : la hauteur de capitale n'est pas la même dans toutes les polices (0,70 à 0,73 em). */
const FONT_TOLERANCE = 5;
/** Hauteur de capitale, en part de la taille de police (Helvetica / Arial : 0,716 ; la valeur sert de repère, la tolérance couvre l'écart des autres polices). */
const CAP_HEIGHT = 0.72;
/** Distance (RVB, euclidienne) au fond à partir de laquelle un pixel n'est plus du fond ; en dessous de cette distance maximale, la zone est unie. Un seul seuil : une zone non unie a toujours un pixel de contenu. */
const FLAT_DISTANCE = 24;
/** Une boîte de moins de pixels que cela est de la poussière. */
const MIN_BOX_AREA = 16;
const MAX_BOXES = 20;
/** Une couleur qui couvre moins de cette part de la zone n'est pas dominante. */
const MIN_SHARE = 0.01;
const MAX_DOMINANT = 5;
/** Part minimale des pixels non-fond pour qu'une couleur soit une couleur de texte, et non un dégradé d'anticrénelage. */
const MIN_INK_SHARE = 0.1;
/** Confiance tesseract (0-100) à partir de laquelle la hauteur d'un mot sert à estimer la police. */
const FONT_CONFIDENCE = 60;

interface Zone {
  x: number;
  y: number;
  l: number;
  h: number;
}
interface Color {
  hex: string;
  rgb: [number, number, number];
}
interface Box extends Zone {}

interface MeasureOptions {
  slug: string;
  page: string;
  zone: string;
  quoi?: string;
  largeur?: string;
  env: NodeJS.ProcessEnv;
  refsDir: () => string;
  json: boolean;
  out: (line: string) => void;
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
const color = (r: number, g: number, b: number): Color => ({ hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, rgb: [r, g, b] });
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Luminance relative WCAG 2.2 (sRGB). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Rapport de contraste WCAG 2.2, non arrondi. */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `page`, `x,y` (un point) ou `x,y,l,h` (un carré), en pixels de la page rendue. */
function parseZone(text: string, raster: Raster): { zone: Zone; point: boolean } {
  if (text === 'page') return { zone: { x: 0, y: 0, l: raster.width, h: raster.height }, point: false };
  const parts = text.split(',');
  const nums = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p) : NaN));
  if ((parts.length !== 2 && parts.length !== 4) || nums.some(Number.isNaN) || (nums.length === 4 && (nums[2]! < 1 || nums[3]! < 1))) {
    throw new RafError(`ref : zone invalide : « ${text} » (attendu : page, x,y pour un point ou x,y,l,h pour un carré, en pixels de la page rendue)`);
  }
  const [x, y, l, h] = nums.length === 2 ? [nums[0]!, nums[1]!, 1, 1] : (nums as [number, number, number, number]);
  if (x + l > raster.width || y + h > raster.height) throw new RafError(`ref : zone ${text} hors de la page (${raster.width} × ${raster.height} px)`);
  return { zone: { x, y, l, h }, point: nums.length === 2 };
}

/** Pixel (r, g, b) d'une image, l'alpha composé sur du blanc. */
function pixel(r: Raster, x: number, y: number): [number, number, number] {
  const o = (y * r.width + x) * 4;
  const a = r.data[o + 3]!;
  const mix = (c: number): number => (a === 255 ? c : Math.round((c * a + 255 * (255 - a)) / 255));
  return [mix(r.data[o]!), mix(r.data[o + 1]!), mix(r.data[o + 2]!)];
}

function pixelsOf(r: Raster, z: Zone): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.l; x++) out.push(pixel(r, x, y));
  return out;
}

const distance = (a: [number, number, number], b: [number, number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function meanOf(px: [number, number, number][]): [number, number, number] {
  const s = [0, 0, 0];
  for (const p of px) for (let i = 0; i < 3; i++) s[i]! += p[i]!;
  return [Math.round(s[0]! / px.length), Math.round(s[1]! / px.length), Math.round(s[2]! / px.length)];
}

/** Couleurs regroupées par 8 niveaux par canal, de la plus étendue à la moins étendue (celles sous `minShare` de la zone sont écartées) ; chacune est la moyenne de son groupe. */
function dominant(px: [number, number, number][], minShare = MIN_SHARE): (Color & { part: number })[] {
  const groups = new Map<number, [number, number, number][]>();
  for (const p of px) {
    const key = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .filter(([, g]) => g.length / px.length >= minShare)
    .slice(0, MAX_DOMINANT)
    .map(([, g]) => ({ ...color(...meanOf(g)), part: round2(g.length / px.length) }));
}

function measureColors(r: Raster, z: Zone, point: boolean) {
  if (point) return { point: color(...pixel(r, z.x, z.y)) };
  const px = pixelsOf(r, z);
  return { moyenne: color(...meanOf(px)), dominantes: dominant(px) };
}

/** Texte et fond d'une zone : le fond est la couleur dominante, le texte la moyenne des pixels les plus éloignés du fond. */
function inkAndBackground(r: Raster, z: Zone): { bg: Color; fg: Color; px: [number, number, number][]; ink: [number, number, number][] } | null {
  const px = pixelsOf(r, z);
  const bg = dominant(px, 0)[0]!.rgb;
  let far = 0;
  for (const p of px) far = Math.max(far, distance(p, bg));
  if (far < FLAT_DISTANCE) return null;
  const ink = px.filter((p) => distance(p, bg) >= far * 0.75);
  return { bg: color(...bg), fg: color(...meanOf(ink)), px, ink: px.filter((p) => distance(p, bg) >= FLAT_DISTANCE) };
}

/** Le texte peut avoir plusieurs couleurs : chaque couleur portée par au moins `MIN_INK_SHARE` des pixels non-fond est un texte, et le verdict est celui de la moins contrastée (jamais une moyenne, qui n'existe pas dans l'image), sauf si aucune couleur n'en porte autant (dégradé, photo) : le texte est alors la moyenne des pixels les plus éloignés du fond et la sortie le signale (`texte.moyenne`). */
function measureContrast(r: Raster, z: Zone) {
  const found = inkAndBackground(r, z);
  if (!found) return null;
  const texts = dominant(found.ink, MIN_INK_SHARE);
  // repli (dégradé, photo) : aucune couleur ne domine, le texte est la moyenne des pixels les plus éloignés du fond, et la sortie le dit
  const repli = texts.length === 0;
  if (repli) texts.push({ ...found.fg, part: 1 });
  const ratios = texts.map((t) => contrastRatio(t.rgb, found.bg.rgb));
  const worst = ratios.indexOf(Math.min(...ratios));
  const ratio = ratios[worst]!;
  const { part: _part, ...couleur } = texts[worst]!;
  const texte = repli ? { ...couleur, moyenne: true } : couleur;
  // les seuils se lisent sur le rapport non arrondi : 4,499 n'atteint pas 4,5
  return { texte, fond: found.bg, rapport: round2(ratio), aa: ratio >= 4.5, aaGrand: ratio >= 3, aaa: ratio >= 7 };
}

const scaleBox = (b: Box, f: number): Box => {
  const x0 = Math.round(b.x * f);
  const y0 = Math.round(b.y * f);
  return { x: x0, y: y0, l: Math.round((b.x + b.l) * f) - x0, h: Math.round((b.y + b.h) * f) - y0 };
};

function measureBoxes(r: Raster, z: Zone, f: number) {
  const found = inkAndBackground(r, z);
  if (!found) return { fond: { hex: dominant(pixelsOf(r, z), 0)[0]!.hex }, contenu: null, boites: [], total: 0 };
  const { bg, px } = found;
  const mask = new Uint8Array(z.l * z.h);
  let x0 = z.l, y0 = z.h, x1 = -1, y1 = -1;
  px.forEach((p, i) => {
    if (distance(p, bg.rgb) < FLAT_DISTANCE) return;
    mask[i] = 1;
    const x = i % z.l;
    const y = (i - x) / z.l;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  });
  // composantes connexes (8 voisins), chacune avec sa boîte englobante
  const boxes: (Box & { area: number })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1) continue;
    mask[start] = 2;
    stack.push(start);
    let bx0 = z.l, by0 = z.h, bx1 = -1, by1 = -1, area = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % z.l;
      const y = (i - x) / z.l;
      area++;
      bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= z.l || ny >= z.h) continue;
          const n = ny * z.l + nx;
          if (mask[n] === 1) {
            mask[n] = 2;
            stack.push(n);
          }
        }
      }
    }
    if (area >= MIN_BOX_AREA) boxes.push({ x: z.x + bx0, y: z.y + by0, l: bx1 - bx0 + 1, h: by1 - by0 + 1, area });
  }
  boxes.sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x);
  return {
    fond: { hex: bg.hex },
    contenu: scaleBox({ x: z.x + x0, y: z.y + y0, l: x1 - x0 + 1, h: y1 - y0 + 1 }, f),
    boites: boxes.slice(0, MAX_BOXES).map((b) => scaleBox(b, f)),
    total: boxes.length,
  };
}

interface Word extends Box {
  texte: string;
  confiance: number;
}

/** Mots de tesseract (tsv) sur le recadrage de la zone, en pixels de la page puis ramenés à l'échelle ; la hauteur de capitale en pixels de la page sert à la police. */
function readWords(tools: ToolPaths, r: Raster, z: Zone, f: number): { words: Word[]; caps: number[] } {
  const work = mkdtempSync(join(tmpdir(), 'cadence-ref-'));
  try {
    const crop = Buffer.alloc(z.l * z.h * 4);
    for (let y = 0; y < z.h; y++) r.data.copy(crop, y * z.l * 4, ((z.y + y) * r.width + z.x) * 4, ((z.y + y) * r.width + z.x + z.l) * 4);
    const file = join(work, 'zone.png');
    writeFileSync(file, encodePng(z.l, z.h, crop));
    let tsv: string;
    try {
      tsv = execFileSync(tools.tesseract!, [file, 'stdout', '--psm', '6', '-l', 'eng', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64 });
    } catch (e) {
      throw new RafError(`ref : tesseract a échoué : ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split('\n')[0]}`);
    }
    const words: Word[] = [];
    const caps: number[] = [];
    for (const row of tsv.split('\n').slice(1)) {
      const c = row.split('\t');
      const texte = (c[11] ?? '').trim();
      if (c[0] !== '5' || texte === '') continue;
      const confiance = Math.round(Number(c[10]));
      const [left, top, width, height] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
      words.push({ texte, confiance, ...scaleBox({ x: z.x + left, y: z.y + top, l: width, h: height }, f) });
      // hauteur de capitale : un mot sans jambage (g j p q y), dont une lettre monte à la hauteur de capitale (majuscule, chiffre, b d f h k l)
      if (confiance >= FONT_CONFIDENCE && /^[A-Za-z0-9]+$/.test(texte) && /[A-Zbdfhkl0-9]/.test(texte) && !/[gjpqy]/.test(texte)) caps.push(height);
    }
    return { words, caps };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function measureText(tools: ToolPaths, r: Raster, z: Zone, f: number) {
  const { words, caps } = readWords(tools, r, z, f);
  if (caps.length === 0) return { mots: words, police: null };
  const sorted = [...caps].sort((a, b) => a - b);
  const cap = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  // un pixel de hauteur de capitale mal lu pèse 1/cap de la taille
  return { mots: words, police: { px: round1((cap / CAP_HEIGHT) * f), tolerancePourcent: Math.ceil(FONT_TOLERANCE + 100 / cap), mots: caps.length } };
}

const pct = (n: number): string => `${Math.round(n * 100)} %`;

/** `cadence ref measure <slug> <page> <zone>` : mesures d'une zone d'une page rendue, ramenées à la largeur de référence. */
export function measure(o: MeasureOptions): void {
  const tools = requireTools(o.env);
  if (!SLUG.test(o.slug)) throw new RafError(`ref : document inconnu : « ${o.slug} »`);
  const docDir = join(o.refsDir(), o.slug);
  const doc = readDocument(docDir);
  if (!doc) throw new RafError(`ref : document inconnu : « ${o.slug} » (cadence ref add <document.pdf> --slug ${o.slug})`);
  if (!/^\d+$/.test(o.page) || Number(o.page) < 1) throw new RafError(`ref : page invalide : « ${o.page} » (un numéro à partir de 1)`);
  const n = Number(o.page);
  if (n > doc.pages.length) throw new RafError(`ref : page ${n} absente : « ${o.slug} » a ${doc.pages.length} pages`);
  const file = join(docDir, 'pages', `page-${n}.png`);
  if (!existsSync(file)) throw new RafError(`ref : page ${n} non rendue : cadence ref add ${doc.source} --slug ${o.slug} --sections ${n}`);
  if (o.quoi !== undefined && !(QUOI as readonly string[]).includes(o.quoi)) throw new RafError(`ref : --quoi invalide : « ${o.quoi} » (couleurs, contraste, boites ou texte)`);
  const largeur = o.largeur === undefined ? REFERENCE_WIDTH : Number(o.largeur);
  if (!(largeur > 0) || !Number.isFinite(largeur)) throw new RafError(`ref : --largeur invalide : « ${o.largeur} » (un nombre de pixels > 0)`);

  const raster = decodePng(readFileSync(file), file);
  const { zone, point } = parseZone(o.zone, raster);
  if (point && o.quoi !== undefined && o.quoi !== 'couleurs') throw new RafError('ref : un point ne se mesure qu\'en couleurs (donner un carré x,y,l,h ou page)');
  const wanted: Quoi[] = o.quoi !== undefined ? [o.quoi as Quoi] : point ? ['couleurs'] : [...QUOI];
  const f = largeur / raster.width;

  const result: Record<string, unknown> = {
    document: o.slug,
    page: n,
    zone,
    echelle: { largeur, facteur: round2(f) },
    tolerance: { couleurs: COLOR_TOLERANCE, boitesPx: Math.max(1, Math.ceil(f)), policePourcent: FONT_TOLERANCE },
  };
  if (wanted.includes('couleurs')) result.couleurs = measureColors(raster, zone, point);
  if (wanted.includes('contraste')) result.contraste = measureContrast(raster, zone);
  if (wanted.includes('boites')) result.boites = measureBoxes(raster, zone, f);
  if (wanted.includes('texte')) result.texte = measureText(tools, raster, zone, f);

  if (o.json) {
    o.out(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of render(result, point)) o.out(line);
}

function render(m: Record<string, any>, point: boolean): string[] {
  const z = m.zone as Zone;
  const lines = [`${m.document} p.${m.page} · zone ${point ? `${z.x},${z.y}` : `${z.x},${z.y},${z.l},${z.h}`} px de la page · ramené à ${m.echelle.largeur} px (×${m.echelle.facteur})`];
  const c = m.couleurs;
  if (c?.point) lines.push(`couleurs : ${c.point.hex} rgb(${c.point.rgb.join(', ')})`);
  else if (c) lines.push(`couleurs : moyenne ${c.moyenne.hex} ; dominantes ${c.dominantes.length === 0 ? 'aucune' : c.dominantes.map((d: any) => `${d.hex} ${pct(d.part)}`).join(', ')}`);
  if ('contraste' in m) {
    const k = m.contraste;
    const ok = (b: boolean): string => (b ? '✓' : '✗');
    lines.push(k ? `contraste : ${k.rapport}:1 (texte ${k.texte.hex}${k.texte.moyenne ? ', moyenne des pixels les plus éloignés du fond : aucune couleur de texte ne domine' : ''} sur fond ${k.fond.hex}) · AA ${ok(k.aa)} · AA grand texte et composants ${ok(k.aaGrand)} · AAA ${ok(k.aaa)}` : 'contraste : zone d\'une seule couleur, rien à mesurer');
  }
  if (m.boites) {
    const b = m.boites;
    const box = (q: Box): string => `${q.x},${q.y} ${q.l}×${q.h}`;
    lines.push(b.contenu ? `boîtes : fond ${b.fond.hex} · contenu ${box(b.contenu)} · ${b.total} boîte(s)${b.boites.length < b.total ? ` (${b.boites.length} plus grandes)` : ''}` : 'boîtes : zone d\'une seule couleur, aucune boîte');
    for (const q of b.boites) lines.push(`  ${box(q)}`);
  }
  if (m.texte) {
    const t = m.texte;
    lines.push(t.mots.length === 0 ? 'texte : aucun mot lu' : `texte : ${t.mots.map((w: Word) => w.texte).join(' ')}`);
    for (const w of t.mots) lines.push(`  « ${w.texte} » ${w.x},${w.y} ${w.l}×${w.h} (confiance ${w.confiance})`);
    if (t.mots.length > 0) lines.push(t.police ? `police : ≈ ${t.police.px} px (±${t.police.tolerancePourcent} %, ${t.police.mots} mot(s) à hauteur de capitale)` : 'police : aucun mot exploitable pour estimer la taille');
  }
  const tol = m.tolerance;
  lines.push(`tolérance : couleurs ±${tol.couleurs}/255 par canal, boîtes ±${tol.boitesPx} px, police ±${tol.policePourcent} % plus un pixel de hauteur de capitale`);
  return lines;
}
