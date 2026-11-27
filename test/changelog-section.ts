import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changelogWithFragments, FRAGMENTS_DIR } from '../src/changelog-fragments.js';

/**
 * Le CHANGELOG du dépôt tel que la prochaine release le publierait (L679) : les fragments de `changelog.d/` assemblés sous `[Unreleased]`.
 * Un test qui cherche l'entrée d'un lot pas encore publié lit ce texte, avec `changelogSectionOf`.
 */
export const repoChangelog = (root: string): string => changelogWithFragments(root);

/**
 * La section du CHANGELOG qui porte l'entrée d'un lot : `[Unreleased]` avant la publication, `[x.y.z]` après le commit de version
 * (qui renomme `[Unreleased]` et en laisse une vide). Un test qui cherche l'entrée d'un lot passe par ici, jamais par `[Unreleased]` seul
 * (L368 : 1.14.0 rouge au run publish ; L380 : 1.15.2 arrêtée).
 */
export function changelogSectionOf(changelog: string, marker: string | RegExp): string {
  const carries = (s: string) => (typeof marker === 'string' ? s.includes(marker) : marker.test(s));
  return changelog.split(/\n(?=## \[)/).find((s) => s.startsWith('## [') && carries(s)) ?? '';
}

/** Vrai quand le source d'un test lit le CHANGELOG.md du dépôt et y choisit la section `## [Unreleased]` (startsWith, indexOf, includes ou split) (les lignes de commentaire ne comptent pas). */
export function readsUnreleasedOnly(source: string): boolean {
  const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const readsRepoLog = /\bread\w*\(\s*(?:join\((?:root|__dirname|import\.meta\.dirname)\b[^)]*,\s*)?['"](?:\.\.\/)?CHANGELOG\.md['"]\s*\)/.test(code);
  return readsRepoLog && /(?:startsWith|indexOf|includes|split)\(\s*['"]## \[Unreleased\]/.test(code);
}

/**
 * Le texte du CHANGELOG qu'un lot a écrit, sous ses deux formes (L778, correctif de publication : 2.0.16 refusée, ENOENT sur `changelog.d/L778.md`
 * dans le clone du commit de version) : avant la publication, son fragment `changelog.d/<lot>.md` ; après, les entrées qui citent le lot dans la
 * section de `CHANGELOG.md` où `cadence release` a assemblé le fragment avant de le retirer. Seules les entrées du lot sont rendues, jamais
 * celles des autres lots de la même version : un test peut y affirmer ce que le texte ne dit pas. Un test qui lit l'entrée d'un lot passe par ici,
 * jamais par `changelog.d/<lot>.md` directement.
 */
export function entreeDuLot(root: string, lot: string): string {
  const fragment = join(root, FRAGMENTS_DIR, `${lot}.md`);
  if (existsSync(fragment)) return readFileSync(fragment, 'utf8');
  const cite = new RegExp(`\\b${lot}\\b`);
  const section = changelogSectionOf(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), cite);
  // Une entrée : une puce en début de ligne et ses lignes de suite, jusqu'à la puce, la rubrique ou la section suivante.
  const entrees = section.split(/\n(?=- |#{2,3} )/).filter((e) => e.startsWith('- ') && cite.test(e)).map((e) => e.trimEnd());
  if (!entrees.length) throw new Error(`entrée du lot ${lot} introuvable : ni ${FRAGMENTS_DIR}/${lot}.md, ni entrée qui cite ${lot} dans une section de CHANGELOG.md`);
  return `${entrees.join('\n')}\n`;
}

/**
 * Les lignes d'un source de test qui désignent le fragment précis d'un lot du dépôt (`changelog.d/L<n>.md`) sans passer par `entreeDuLot`
 * (L917 : 2.0.19 refusée, `test/banc-code-mode-l839.test.ts` lisait `join(RACINE, 'changelog.d', 'L839.md')`, forme que R11 de L778 ne voyait pas).
 * Une ligne compte quand elle nomme le fragment (chemin d'un seul tenant, segments de `join`, ou `FRAGMENTS_DIR`) ET la racine du dépôt
 * (`root`, `racine`, `RACINE`, `import.meta.dirname`, `__dirname`, `process.cwd()`, ou un chemin relatif lu tel quel) ; un fragment écrit
 * dans un dépôt jetable (`d`, `dir`, `tempDir()`) ne compte pas, ni une ligne de commentaire.
 */
export function lignesFragmentSansRepli(source: string): string[] {
  const fragment = /changelog\.d\/L\d+\.md|(?:['"`]changelog\.d['"`]|FRAGMENTS_DIR)\s*,\s*['"`]L\d+\.md|\$\{FRAGMENTS_DIR\}\/L\d+\.md/;
  const racine = /\b(?:root|racine|RACINE|ROOT|repoRoot)\b|import\.meta\.dirname|__dirname|process\.cwd\(\)|\b(?:read|lire|exists)\w*\(\s*['"`](?:\.\.?\/)?changelog\.d\//;
  return source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && fragment.test(l) && racine.test(l)).map((l) => l.trim());
}
