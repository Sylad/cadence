import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { isDay, type Day } from './dates.js';
import { addedTimes } from './git.js';
import { RafError, type Lot } from './plan.js';

export interface Entry {
  file: string;
  slug: string;
  title: string;
  date: Day;
  lots: string[];
  captures: string[];
  /** Raison de l'absence de capture, quand une capture n'a pas de sens. */
  nocapture?: string;
  body: string;
  problems: string[];
}

export interface NewsIssue {
  kind: 'bad-entry' | 'unknown-lot' | 'missing-capture' | 'no-capture' | 'visible-without-entry';
  message: string;
}

const CAPTURE = /^[\w./-]+\.(?:png|jpe?g|webp|gif)$/i;
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export function parseEntry(file: string, text: string): Entry {
  const entry: Entry = { file, slug: basename(file).replace(/\.md$/, ''), title: '', date: '', lots: [], captures: [], body: '', problems: [] };
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
  entry.lots = list(head.lots);
  entry.captures = list(head.captures);
  if (head.nocapture != null && String(head.nocapture).trim()) entry.nocapture = String(head.nocapture).trim();
  entry.body = m[2].trim();
  for (const c of entry.captures) {
    // Copiées telles quelles sous le dossier de build : un chemin qui sort du dossier écrirait ailleurs.
    if (isAbsolute(c) || c.split(/[\\/]/).includes('..')) entry.problems.push(`capture hors du dossier des Nouveautés : ${c}`);
    // Noms sages : utilisables tels quels dans une URL, et seulement des images.
    else if (!CAPTURE.test(c)) entry.problems.push(`capture ${c} : image .png, .jpg, .webp ou .gif, nom en lettres, chiffres, « . _ - / »`);
  }
  if (!entry.title) entry.problems.push('title vide');
  if (!isDay(entry.date)) entry.problems.push(`date « ${entry.date} » n'est pas une date AAAA-MM-JJ`);
  return entry;
}

/**
 * Entrées du dossier, plus récentes d'abord : par date, puis à date égale par instant de création
 * (date du premier commit du fichier ; pas encore commité = le plus récent), puis par nom de fichier décroissant.
 */
export function loadEntries(dir: string): Entry[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.md') && f.name.toLowerCase() !== 'readme.md')
    .map((f) => parseEntry(f.name, readFileSync(join(dir, f.name), 'utf8')));
  const added = addedTimes(dir);
  const created = (e: Entry) => added.get(e.file) ?? Infinity;
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

/** Crée le squelette d'une entrée ; refuse d'écraser un fichier existant. */
export function newEntry(dir: string, lots: string[], rawTitle: string, today: Day): string {
  const title = rawTitle.replace(/\s+/g, ' ').trim(); // un saut de ligne casserait l'en-tête
  const path = join(dir, `${today}-${slugify(title)}.md`);
  if (existsSync(path)) throw new RafError(`${path} existe déjà`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `---\ntitle: ${stringify(title).trimEnd()}\ndate: ${today}\nlots: [${lots.join(', ')}]\ncaptures: []\n# nocapture: raison, quand une capture n'a pas de sens\n---\nCe qui change pour l'utilisateur.\n`,
  );
  return path;
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
  entries: { slug: string; title: string; date: Day; lots: string[]; captures: string[]; html: string }[];
}

export function newsData(project: string, entries: Entry[], generated: string): NewsData {
  return {
    project,
    generated,
    entries: entries.map((e) => ({ slug: e.slug, title: e.title, date: e.date, lots: e.lots, captures: e.captures, html: renderMarkdown(e.body) })),
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
  ${e.captures.map((c) => `<a href="${escapeText(c)}"><img src="${escapeText(c)}" alt="Capture : ${escapeText(e.title)}" loading="lazy"></a>`).join('\n  ')}
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
