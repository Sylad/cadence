// Contrôle des liens relatifs du README et des pages docs/ : le fichier visé existe, l'ancre aussi.
// Lancé par la CI (.github/workflows/tests.yml) et par test/readme-accueil.test.ts.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Les pages où part le contenu du README (L232), plus l'accueil : tout ce que le contrôle lit. */
export const DOC_PAGES = ['docs/raf.md', 'docs/orchestrate.md', 'docs/deliver.md', 'docs/spec.md', 'docs/lead.md', 'docs/stabilite.md'];
const AUTRES = ['docs/news.md', 'docs/session.md', 'docs/corrections.md', 'docs/skills.md', 'docs/cadence-hud.md', 'docs/releasing.md', 'docs/fonctionnement.md', 'docs/overview.md', 'docs/whats-new.md'];
export const CHECKED = ['README.md', ...DOC_PAGES, ...AUTRES];

/** Ancre GitHub d'un titre : minuscules, ponctuation retirée, espaces en tirets. */
export function slug(title) {
  return title.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function outsideFences(text) {
  let fence = false;
  return text.split('\n').map((l) => {
    if (/^\s*```/.test(l)) { fence = !fence; return ''; }
    return fence ? '' : l;
  }).join('\n');
}

function anchors(file) {
  const seen = new Map();
  const out = new Set();
  for (const l of outsideFences(readFileSync(file, 'utf8')).split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(l);
    if (!m) continue;
    const s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
}

/** Les cibles `[x](cible)`, `src=` et `srcset=` d'un document, hors blocs de code. */
function targets(text) {
  const t = outsideFences(text).replace(/`[^`\n]*`/g, '');
  const found = [];
  for (const m of t.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(m[1]);
  for (const m of t.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)) found.push(m[1]);
  return found;
}

/** Les liens cassés des `files` (relatifs à `root`), une phrase par lien. */
export function checkLinks(root, files = CHECKED) {
  const errors = [];
  for (const f of files) {
    const path = join(root, f);
    if (!existsSync(path)) { errors.push(`${f} : page absente`); continue; }
    for (const target of targets(readFileSync(path, 'utf8'))) {
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      const [rel, anchor] = target.split('#');
      const dest = rel ? resolve(dirname(path), rel) : path;
      if (!normalize(dest).startsWith(normalize(root))) { errors.push(`${f} : ${target} sort du dépôt`); continue; }
      if (!existsSync(dest)) { errors.push(`${f} : ${target} — fichier absent (${rel})`); continue; }
      if (anchor && dest.endsWith('.md') && statSync(dest).isFile() && !anchors(dest).has(decodeURIComponent(anchor))) {
        errors.push(`${f} : ${target} — ancre #${anchor} absente`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkLinks(root);
  for (const e of errors) console.error(e);
  console.log(`${errors.length} lien${errors.length > 1 ? "s" : ""} cassé${errors.length > 1 ? "s" : ""} dans ${CHECKED.length} pages`);
  process.exit(errors.length ? 1 : 0);
}
