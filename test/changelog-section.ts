/**
 * La section du CHANGELOG qui porte l'entrée d'un lot : `[Unreleased]` avant la publication, `[x.y.z]` après le commit de version
 * (qui renomme `[Unreleased]` et en laisse une vide). Un test qui cherche l'entrée d'un lot passe par ici, jamais par `[Unreleased]` seul
 * (L368 : 1.14.0 rouge au run publish ; L380 : 1.15.2 arrêtée).
 */
export function changelogSectionOf(changelog: string, marker: string | RegExp): string {
  const carries = (s: string) => (typeof marker === 'string' ? s.includes(marker) : marker.test(s));
  return changelog.split(/\n(?=## \[)/).find((s) => s.startsWith('## [') && carries(s)) ?? '';
}

/** Vrai quand le source d'un test lit le CHANGELOG.md du dépôt et y choisit la section `## [Unreleased]` (les lignes de commentaire ne comptent pas). */
export function readsUnreleasedOnly(source: string): boolean {
  const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const readsRepoLog = /\bread\w*\(\s*(?:join\((?:root|__dirname|import\.meta\.dirname)\b[^)]*,\s*)?['"](?:\.\.\/)?CHANGELOG\.md['"]\s*\)/.test(code);
  return readsRepoLog && /(?:startsWith|indexOf|includes)\(\s*['"]## \[Unreleased\]/.test(code);
}
