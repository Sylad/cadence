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
