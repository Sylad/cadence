import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { isDay, toStamp, type Day } from './dates.js';
import { addedTimes } from './git.js';
import { RafError, type Lot } from './plan.js';

export interface Entry {
  file: string;
  slug: string;
  title: string;
  date: Day;
  /** Horodatage de création « AAAA-MM-JJTHH:MM±hh:mm » (ou Z), fuseau obligatoire ; départage des entrées du même jour. */
  created?: string;
  lots: string[];
  /** Chemins des captures, relatifs au dossier des Nouveautés. */
  captures: string[];
  /** Texte alternatif de chaque capture, dans le même ordre ; « '' » quand l'entrée n'en donne pas. */
  alts: string[];
  /** Raison de l'absence de capture, quand une capture n'a pas de sens. */
  nocapture?: string;
  body: string;
  problems: string[];
}

export interface NewsIssue {
  kind: 'bad-entry' | 'unknown-lot' | 'missing-capture' | 'no-capture' | 'no-time' | 'visible-without-entry';
  message: string;
}

/** Limite avertie par `raf check` quand cadence.yaml n'en déclare pas (news.publicTitleMax). */
export const PUBLIC_TITLE_DEFAULT = 80;

/** Message quand un titre public dépasse `max` caractères, sinon null. */
export function publicTitleTooLong(text: string, max: number): string | null {
  const n = text.trim().length;
  return n > max ? `titre public de ${n} caractères, au-delà de la limite de ${max} (news.publicTitleMax) que la page Plan applique au build : « ${text.trim()} »` : null;
}

/**
 * Titre que le site reprend de la Nouveauté la plus récente (`entries`, plus récentes d'abord) pour un lot visible
 * terminé sans `public:` ; null si le lot n'est pas dans ce cas ou qu'aucune entrée ne le cite.
 */
export function reusedNewsTitle(lot: Lot, entries: Entry[]): string | null {
  if (!lot.visible || lot.status !== 'done' || lot.public) return null;
  return entries.find((e) => e.lots.includes(lot.id))?.title ?? null;
}

const CREATED_EMPTY = 'created vide — cadence news stamp';
const CREATED = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;
const CAPTURE = /^[\w./-]+\.(?:png|jpe?g|webp|gif)$/i;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Bien formée ET réelle : Date.parse accepte le 30 février (et rend NaN pour 25:70). */
function validStamp(s: string): boolean {
  const [y, mo, d, h, mi, sec = 0] = s.match(/\d+/g)!.slice(0, 6).map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  return (
    !Number.isNaN(Date.parse(s.replace(' ', 'T'))) && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && h < 24 && mi < 60 && sec < 60
  );
}

const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

const CAPTURE_KEYS = ['file', 'alt'];
const CAPTURE_SHAPE = '{ file: chemin, alt: "texte alternatif" }';

/**
 * Captures de l'en-tête : un chemin, ou `{ file, alt }` quand l'entrée dit ce que l'image montre.
 * Les chemins restent une liste de chaînes (ce que lit déjà le JSON publié), les textes les suivent un à un.
 */
function readCaptures(raw: unknown, problems: string[]): { captures: string[]; alts: string[] } {
  const captures: string[] = [];
  const alts: string[] = [];
  for (const [i, item] of (raw == null ? [] : Array.isArray(raw) ? raw : [raw]).entries()) {
    let file: string;
    let alt = '';
    if (typeof item === 'string' || typeof item === 'number') {
      file = String(item);
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const map = item as Record<string, unknown>;
      if (map.file == null || String(map.file).trim() === '') {
        problems.push(`capture n° ${i + 1} : fichier absent — ${CAPTURE_SHAPE}`);
        continue;
      }
      file = String(map.file);
      // Une ligne : le texte part tel quel dans un attribut alt.
      alt = map.alt == null ? '' : String(map.alt).replace(/\s+/g, ' ').trim();
      for (const k of Object.keys(map)) {
        if (!CAPTURE_KEYS.includes(k)) problems.push(`capture ${file} : clé inconnue « ${k} » (attendu : ${CAPTURE_KEYS.join(', ')})`);
      }
    } else {
      problems.push(`capture n° ${i + 1} illisible : un chemin ou ${CAPTURE_SHAPE}`);
      continue;
    }
    // Copiées telles quelles sous le dossier de build : un chemin qui sort du dossier écrirait ailleurs.
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) problems.push(`capture hors du dossier des Nouveautés : ${file}`);
    // Noms sages : utilisables tels quels dans une URL, et seulement des images.
    else if (!CAPTURE.test(file)) problems.push(`capture ${file} : image .png, .jpg, .webp ou .gif, nom en lettres, chiffres, « . _ - / »`);
    captures.push(file);
    alts.push(alt);
  }
  return { captures, alts };
}

export function parseEntry(file: string, text: string): Entry {
  const entry: Entry = { file, slug: basename(file).replace(/\.md$/, ''), title: '', date: '', lots: [], captures: [], alts: [], body: '', problems: [] };
  const m = FRONT.exec(text.replace(/^\uFEFF/, '')); // BOM des éditeurs Windows
  if (!m) {
    entry.problems.push('en-tête YAML absent (--- … ---)');
    return entry;
  }
  let head: Record<string, unknown>;
  try {
    head = (parse(m[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    entry.problems.push(`en-tête YAML illisible : ${(e as Error).message.split('\n')[0]}`);
    return entry;
  }
  entry.title = String(head.title ?? '').trim();
  entry.date = String(head.date ?? '');
  if ('created' in head) {
    const created = String(head.created ?? '').trim();
    if (!created) entry.problems.push(CREATED_EMPTY);
    else if (!CREATED.test(created)) entry.problems.push(`created « ${created} » n'est pas une heure AAAA-MM-JJTHH:MM±hh:mm`);
    // Sans fuseau, l'heure serait lue dans celui de la machine : l'ordre changerait entre le poste et la CI.
    else if (!OFFSET.test(created)) entry.problems.push(`created « ${created} » sans fuseau : ajouter ±hh:mm ou Z`);
    else if (!validStamp(created)) entry.problems.push(`created « ${created} » n'est pas une heure valide`);
    else entry.created = created.replace(' ', 'T');
  }
  entry.lots = list(head.lots);
  if (head.nocapture != null && String(head.nocapture).trim()) entry.nocapture = String(head.nocapture).trim();
  entry.body = m[2].trim();
  Object.assign(entry, readCaptures(head.captures, entry.problems));
  if (!entry.title) entry.problems.push('title vide');
  if (!isDay(entry.date)) entry.problems.push(`date « ${entry.date} » n'est pas une date AAAA-MM-JJ`);
  return entry;
}

/**
 * Entrées du dossier, plus récentes d'abord : par date, puis à date égale par instant de création
 * (`created` de l'en-tête, sinon date d'auteur du commit qui a ajouté le fichier sous ce nom — un renommage
 * compte comme un ajout — ; pas encore commité = le plus récent), puis par nom de fichier décroissant.
 * `added` (historique git) n'est appelé que si une entrée n'a pas de `created`.
 */
export function loadEntries(dir: string, added: () => Map<string, number> = () => addedTimes(dir)): Entry[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md')
    .map((f) => parseEntry(f.name, readFileSync(join(dir, f.name), 'utf8')));
  const history = entries.some((e) => !e.created) ? added() : new Map<string, number>();
  const created = (e: Entry) => (e.created ? Date.parse(e.created) : history.get(e.file) ?? Infinity);
  return entries.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    const ta = created(a);
    const tb = created(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return b.file.localeCompare(a.file);
  });
}

export function newsIssues(lots: Lot[], entries: Entry[], dir: string): NewsIssue[] {
  const issues: NewsIssue[] = [];
  const ids = new Set(lots.map((l) => l.id));
  const covered = new Set(entries.flatMap((e) => e.lots));
  for (const e of entries) {
    for (const p of e.problems) issues.push({ kind: 'bad-entry', message: `${e.file} : ${p}` });
    for (const id of e.lots) if (!ids.has(id)) issues.push({ kind: 'unknown-lot', message: `${e.file} cite ${id}, absent du plan` });
    for (const c of e.captures) {
      const path = resolve(dir, c);
      if (!existsSync(path) || !statSync(path).isFile()) issues.push({ kind: 'missing-capture', message: `${e.file} : capture absente ${c}` });
    }
    if (e.problems.length === 0 && !e.created) {
      issues.push({ kind: 'no-time', message: `${e.file} sans heure de création (created: AAAA-MM-JJTHH:MM±hh:mm) — cadence news stamp` });
    }
    if (e.problems.length === 0 && e.captures.length === 0 && !e.nocapture) {
      issues.push({ kind: 'no-capture', message: `${e.file} sans capture (ou « nocapture: raison »)` });
    }
  }
  for (const l of lots) {
    if (l.visible && l.status === 'done' && !covered.has(l.id)) {
      issues.push({ kind: 'visible-without-entry', message: `${l.id} est visible et terminé sans entrée Nouveautés — cadence news new ${l.id}` });
    }
  }
  return issues;
}

export function slugify(title: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'entree'
  );
}

/** Crée le squelette d'une entrée, horodatée de `now` ; refuse d'écraser un fichier existant. */
export function newEntry(dir: string, lots: string[], rawTitle: string, today: Day, now: Date): string {
  const title = rawTitle.replace(/\s+/g, ' ').trim(); // un saut de ligne casserait l'en-tête
  const path = join(dir, `${today}-${slugify(title)}.md`);
  if (existsSync(path)) throw new RafError(`${path} existe déjà`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `---\ntitle: ${stringify(title, { lineWidth: 0 }).trimEnd()}\ndate: ${today}\ncreated: ${toStamp(now)}\nlots: [${lots.join(', ')}]\ncaptures: []\n# une capture peut dire ce qu'elle montre : captures: [${CAPTURE_SHAPE.replace('chemin', 'captures/x.png')}]\n# nocapture: raison, quand une capture n'a pas de sens\n---\nCe qui change pour l'utilisateur.\n`,
  );
  return path;
}

/**
 * Migration : écrit `created:` dans les entrées lisibles qui n'en ont pas (ou l'ont vide), d'après la date
 * d'auteur du commit qui a ajouté le fichier sous ce nom — un renommage n'est pas suivi — (`now` s'il n'est pas
 * encore commité). Le reste du fichier est laissé tel quel.
 */
export function stampEntries(dir: string, now: Date): { file: string; created: string }[] {
  let history: Map<string, number> | undefined;
  const added = () => (history ??= addedTimes(dir)); // un seul git log, et seulement s'il sert
  const done: { file: string; created: string }[] = [];
  for (const e of loadEntries(dir, added)) {
    // Seule une clé created vide est réparée ici ; une heure fausse reste à corriger à la main.
    if (e.created || !e.problems.every((p) => p === CREATED_EMPTY)) continue;
    const created = toStamp(new Date(added().get(e.file) ?? now.getTime()));
    const path = join(dir, e.file);
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
    const key = (name: string) => lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${name}\\s*:`).test(l));
    const existing = key('created');
    const dateLine = key('date');
    const eol = lines[dateLine >= 0 ? dateLine : 0].endsWith('\r') ? '\r' : '';
    if (existing >= 0) lines[existing] = `created: ${created}${eol}`; // clé vide : remplacée, jamais dupliquée
    else lines.splice(dateLine >= 0 ? dateLine + 1 : end, 0, `created: ${created}${eol}`);
    writeFileSync(path, lines.join('\n'));
    done.push({ file: e.file, created });
  }
  return done;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Liens http(s), mailto ou relatifs ; tout autre schéma (javascript:, data:…) reste du texte. */
// Les navigateurs retirent les caractères de contrôle en tête d'URL (« \x01javascript: ») : refusés d'office.
const safeUrl = (url: string) =>
  !/[\x00-\x20\x7f]/.test(url) && (/^(?:https?:\/\/|mailto:)/i.test(url) || !/^[a-z][\w+.-]*:/i.test(url));

function inline(text: string): string {
  // Segments impairs = code : ni gras ni lien à l'intérieur.
  return text
    .split('`')
    .map((seg, i, all) => {
      if (i % 2 === 1 && i < all.length - 1) return `<code>${escapeText(seg)}</code>`;
      const raw = i % 2 === 1 ? `\`${seg}` : seg;
      return escapeText(raw)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label: string, url: string) =>
          safeUrl(url) ? `<a href="${url}">${label}</a>` : all,
        );
    })
    .join('');
}

/** Markdown minimal : paragraphes, listes « - », **gras**, `code`, [liens](url). Tout le reste est du texte échappé. */
export function renderMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${inline(block)}</p>`;
    })
    .join('\n');
}

export interface NewsData {
  project: string;
  generated: string;
  /** `alts` : texte alternatif de chaque capture, même ordre, « '' » sans texte — absent quand l'entrée n'en donne aucun. */
  entries: { slug: string; title: string; date: Day; lots: string[]; captures: string[]; alts?: string[]; html: string }[];
}

export function newsData(project: string, entries: Entry[], generated: string): NewsData {
  return {
    project,
    generated,
    entries: entries.map((e) => ({
      slug: e.slug,
      title: e.title,
      date: e.date,
      lots: e.lots,
      captures: e.captures,
      // Clé ajoutée seulement quand elle dit quelque chose : une entrée sans texte garde sa forme d'avant.
      ...(e.alts.some(Boolean) ? { alts: e.alts } : {}),
      html: renderMarkdown(e.body),
    })),
  };
}

/** Écrit nouveautes.json, index.html et copie les captures sous `out`. */
export function buildNews(data: NewsData, dir: string, out: string): string[] {
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  for (const c of new Set(data.entries.flatMap((e) => e.captures))) {
    const dest = resolve(out, c);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(dir, c), dest);
  }
  const json = join(out, 'nouveautes.json');
  writeFileSync(json, `${JSON.stringify(data, null, 2)}\n`);
  written.push(json);
  const html = join(out, 'index.html');
  writeFileSync(html, renderNewsPage(data));
  written.push(html);
  return written;
}

function renderNewsPage(data: NewsData): string {
  const title = escapeText(`${data.project} — nouveautés`);
  const entries = data.entries
    .map(
      (e) => `<article id="${escapeText(e.slug)}">
  <h2>${escapeText(e.title)}</h2>
  <p class="meta"><time datetime="${e.date}">${e.date}</time> · ${e.lots.map(escapeText).join(', ')}</p>
  ${e.html}
  ${e.captures.map((c, i) => `<a href="${escapeText(c)}"><img src="${escapeText(c)}" alt="${escapeText(e.alts?.[i] || `Capture : ${e.title}`)}" loading="lazy"></a>`).join('\n  ')}
</article>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${title}</h1><p class="meta">Généré le ${escapeText(data.generated)} par cadence</p></header>
<main>
${entries || '<p class="meta">Aucune entrée pour l\'instant.</p>'}
</main>
</body>
</html>
`;
}

const STYLE = `
:root { --bg:#fff; --fg:#1b1f24; --muted:#636c76; --grid:#e3e6ea; --link:#0969da; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8d96a0; --grid:#262c36; --link:#4493f8; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.55 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header, main { max-width: 820px; margin: 0 auto; padding: 16px 24px; }
h1 { margin:0 0 4px; font-size:22px; }
h2 { margin:0 0 2px; font-size:18px; }
.meta { margin:0 0 8px; color:var(--muted); font-size:13px; }
article { padding: 18px 0; border-bottom: 1px solid var(--grid); }
a { color: var(--link); }
img { display:block; max-width:100%; margin-top:10px; border:1px solid var(--grid); border-radius:6px; }
code { font-size: 13px; padding: 1px 4px; border-radius: 4px; background: var(--grid); }
`;
