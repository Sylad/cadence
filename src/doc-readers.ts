import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// L658 : une page de doc que le lot vide ou déplace est lue par des tests d'AUTRES lots (L651 : `test/lead-hold.test.ts` lisait la section déplacée, refusé par R14 à l'intégration).
// `vitest related` ne les trouve pas (le test lit le fichier, il ne l'importe pas) : on les cherche par le nom de la page dans le texte des tests.

const TEST_DIR = 'test';
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const PAGE = /[\w./-]+\.md\b/g;

/** Les tests du dépôt (chemins relatifs, `/`), récursivement ; vide sans dossier `test/`. */
function testFiles(root: string, dir = TEST_DIR): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : testFiles(root, `${dir}/${e.name}`)) : TEST_FILE.test(e.name) ? [`${dir}/${e.name}`] : []));
}

/** Le texte cite ce nom de page en entier : le caractère qui le précède n'est pas un bout de nom (« orchestrate-spec.md » ne cite pas « spec.md »). */
function cites(text: string, name: string): boolean {
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) if (i === 0 || !/[\w.-]/.test(text[i - 1])) return true;
  return false;
}

/** Les tests dont le texte cite le nom de chaque page (« orchestrate-cycle.md »), par page (clé : le chemin relatif donné) ; une page sans lecteur n'a pas de clé. Un test illisible est ignoré. */
export function testsReading(root: string, pages: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!pages.length) return out;
  for (const t of testFiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, t), 'utf8');
    } catch {
      continue;
    }
    for (const p of pages) if (cites(text, basename(p))) out.set(p, [...(out.get(p) ?? []), t]);
  }
  return out;
}

/** Les pages `.md` que ce texte cite et qui existent dans le dépôt (chemin relatif, sans doublon) ; un nom seul (« concepts.md ») se résout sous `docs/`. */
export function pagesCited(root: string, text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PAGE)) {
    const name = m[0].replace(/^\.\//, '');
    for (const candidate of name.includes('/') ? [name] : [name, `docs/${name}`]) {
      if (existsSync(join(root, candidate))) {
        found.add(candidate);
        break;
      }
    }
  }
  return [...found];
}

/** Les tests qui lisent ces pages, sans doublon, dans l'ordre des pages. */
export function readersOf(root: string, pages: string[]): string[] {
  return [...new Set([...testsReading(root, pages).values()].flat())];
}

/** La consigne du brief d'écriture : les tests qui lisent une page que le lot cite, à ne pas casser en vidant ou déplaçant la page ; '' quand aucune page citée n'a de lecteur. */
export function readersText(root: string, lotText: string): string {
  const readers = testsReading(root, pagesCited(root, lotText));
  if (!readers.size) return '';
  const lines = [...readers].map(([page, tests]) => `- \`${page}\`: ${tests.map((t) => `\`${t}\``).join(', ')}`);
  return `Tests that read a page this lot names (emptying or moving a section of it breaks them, and the integration refuses the lot; update the assertion in the same commit, a sealed acceptance test of another lot excepted: put that one in your report; the targeted gate plays them):\n${lines.join('\n')}`;
}

// L672 : une doc d'usage périmée par une phrase de comportement (L662 : orchestrate-gate.md:114, L666 : fonctionnement.md:30 et lead.md:13, majeurs de doc rendus après deux revues).
// L648 ne suit que les identifiants ; le titre d'un lot change aussi des phrases (« main a avancé »), qu'on cherche dans les pages de `docs/`.

const QUOTED = /«\s*([^»]+?)\s*»|“\s*([^”]+?)\s*”|"([^"]+)"|`([^`]+)`/g;
const MIN_PHRASE = 5;
const MAX_PAGES = 12;
const MAX_LINES = 3;
const DOCS_DIR = 'docs';

/** Les phrases citées par le titre (entre « », “ ”, "" ou accents graves) d'au moins 5 caractères, espaces réduits, sans doublon. */
export function phrasesOf(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(QUOTED)) {
    const phrase = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').replace(/\s+/g, ' ').trim();
    if (phrase.length >= MIN_PHRASE) out.add(phrase);
  }
  return [...out];
}

/** Les pages `.md` de `docs/`, récursivement (chemins relatifs, `/`) ; vide sans dossier `docs/`. */
function docPages(root: string, dir = DOCS_DIR): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? docPages(root, `${dir}/${e.name}`) : e.name.endsWith('.md') ? [`${dir}/${e.name}`] : []));
}

/** La consigne du brief d'écriture : les pages de `docs/` dont une ligne contient une phrase citée du titre (casse et espaces ignorés), avec leurs numéros de ligne, à relire et mettre à jour dans le même commit ; '' sans phrase citée ou sans page qui en contienne. */
export function docsPhrasesText(root: string, title: string): string {
  const phrases = phrasesOf(title).map((p) => ({ phrase: p, key: p.toLowerCase() }));
  if (!phrases.length) return '';
  const lines: string[] = [];
  for (const page of docPages(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, page), 'utf8');
    } catch {
      continue;
    }
    const hits: string[] = [];
    let total = 0;
    text.split('\n').forEach((line, i) => {
      const flat = line.replace(/\s+/g, ' ').toLowerCase();
      const cited = phrases.filter((p) => flat.includes(p.key));
      if (!cited.length) return;
      total++;
      if (hits.length < MAX_LINES) hits.push(`${i + 1} (${cited.map((p) => `« ${p.phrase} »`).join(', ')})`);
    });
    if (hits.length) lines.push(`- \`${page}\`: line ${hits.join(', ')}${total > hits.length ? `, and ${total - hits.length} more` : ''}`);
  }
  if (!lines.length) return '';
  const shown = lines.slice(0, MAX_PAGES);
  const rest = lines.length - shown.length;
  return `Usage pages that contain a phrase the title of this lot quotes (the lot changes that behaviour: read each line, and update it in the same commit when it no longer says what the code does; a page that still says the old behaviour is a major finding of the review, which already cost a correction pass on L662 and L666):\n${shown.join('\n')}${rest ? `\n- … and ${rest} more page(s)` : ''}`;
}
