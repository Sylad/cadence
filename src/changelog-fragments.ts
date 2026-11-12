import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RafError } from './plan.js';

/**
 * L679 — les fragments du CHANGELOG : un fichier `changelog.d/<lot>.md` par lot, au lieu d'une entrée sous `[Unreleased]` de
 * `CHANGELOG.md`. Deux branches qui ajoutent chacune leur fragment ne touchent pas le même fichier : plus de conflit d'ajout
 * (7 conflits et 13 rejeux de porte dans la vague 2026-11-07-0800). `cadence release` les assemble dans la section de la version.
 * Un dépôt sans dossier `changelog.d/` garde l'ancienne façon : rien ne change pour lui.
 */
export const FRAGMENTS_DIR = 'changelog.d';

/** Les rubriques de Keep a Changelog, dans l'ordre où la section de la version les range. */
export const RUBRIQUES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const;

interface Fragment {
  /** Le chemin du fichier depuis la racine (`changelog.d/L679.md`), ou `CHANGELOG.md` pour les entrées laissées sous [Unreleased]. */
  file: string;
  /** Les entrées par rubrique, chacune sans ligne blanche en tête ni en queue. */
  parts: Map<string, string>;
}

/** Vrai quand le dépôt écrit son CHANGELOG en fragments (le dossier existe). */
const hasFragments = (root: string): boolean => {
  const dir = join(root, FRAGMENTS_DIR);
  return existsSync(dir) && statSync(dir).isDirectory();
};

/** Un fichier du dossier qui n'est pas un fragment : le mode d'emploi (`README.md`), ce qui commence par `.` ou `_`. */
const isFragmentFile = (name: string): boolean => name.endsWith('.md') && !/^(README|[._])/i.test(name);

/** L'ordre stable des fragments : lot le plus récent en tête (L711 avant L710, comme les entrées écrites à la main), puis le nom. */
function compareFragments(a: string, b: string): number {
  const num = (f: string) => Number(/^L(\d+)/.exec(f)?.[1] ?? -1);
  return num(b) - num(a) || a.localeCompare(b);
}

/** Lit un texte de fragment : `### Rubrique` puis ses entrées ; une rubrique inconnue, du texte avant la première ou un fragment vide est refusé. */
export function parseFragment(file: string, text: string): Fragment {
  const parts = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  const close = () => {
    if (current === null) return;
    const body = lines.join('\n').replace(/^\s*\n/, '').trimEnd();
    if (body.trim() === '') throw new RafError(`${file} : la rubrique « ### ${current} » n'a aucune entrée`);
    parts.set(current, parts.has(current) ? `${parts.get(current)}\n${body}` : body);
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^###\s+(.+?)\s*$/.exec(line);
    if (head) {
      close();
      const rubrique = RUBRIQUES.find((r) => r.toLowerCase() === head[1].toLowerCase());
      if (!rubrique) throw new RafError(`${file} : rubrique « ### ${head[1]} » inconnue — une de ${RUBRIQUES.join(', ')}`);
      current = rubrique;
      lines = [];
    } else if (current === null) {
      if (line.trim() !== '') throw new RafError(`${file} : texte avant la première rubrique (« ${line.trim().slice(0, 60)} ») — un fragment commence par « ### Added », « ### Fixed »…`);
    } else lines.push(line);
  }
  close();
  if (parts.size === 0) throw new RafError(`${file} : fragment vide — au moins une rubrique (« ### Fixed ») et une entrée`);
  return { file, parts };
}

/** Les fragments du dépôt, dans l'ordre stable ; aucun sans dossier `changelog.d/`. */
export function readFragments(root: string): Fragment[] {
  if (!hasFragments(root)) return [];
  return readdirSync(join(root, FRAGMENTS_DIR))
    .filter(isFragmentFile)
    .sort(compareFragments)
    .map((name) => parseFragment(`${FRAGMENTS_DIR}/${name}`, readFileSync(join(root, FRAGMENTS_DIR, name), 'utf8')));
}

/**
 * Le corps d'une section de version assemblé : une rubrique par titre, dans l'ordre de Keep a Changelog, les entrées des fragments
 * à la suite dans leur ordre. Même forme que le corps d'une section écrite à la main (ligne blanche en tête et en queue).
 */
export function assembleFragments(fragments: Fragment[]): string {
  let body = '\n';
  for (const r of RUBRIQUES) {
    const entries = fragments.map((f) => f.parts.get(r)).filter((e): e is string => e !== undefined);
    if (entries.length > 0) body += `### ${r}\n\n${entries.join('\n')}\n\n`;
  }
  return body;
}

/** Une section est vide quand elle n'a que des titres de sous-section (« ### Added ») et des lignes blanches. */
export function hasEntries(body: string): boolean {
  return body.split('\n').some((l) => l.trim() !== '' && !/^#{3,}\s/.test(l));
}

/**
 * Le corps de la section d'une version et les fragments que le commit de version retire : `own` (le corps de [Unreleased]) seul quand
 * le dépôt n'a pas de fragment, sinon ses entrées puis celles des fragments, assemblées par rubrique.
 */
export function versionSection(root: string, own: string): { body: string; removes: string[] } {
  const fragments = readFragments(root);
  if (fragments.length === 0) return { body: own, removes: [] };
  const all = hasEntries(own) ? [parseFragment('CHANGELOG.md [Unreleased]', own), ...fragments] : fragments;
  return { body: assembleFragments(all), removes: fragments.map((f) => f.file) };
}

/** Le refus d'une release sans rien à publier, selon que le dépôt écrit en fragments ou sous [Unreleased]. */
export function nothingToRelease(root: string): string {
  return hasFragments(root)
    ? `release : rien à publier — ni fragment dans ${FRAGMENTS_DIR}/ ni entrée sous [Unreleased] de CHANGELOG.md ; écrire ce qui change pour l'utilisateur dans ${FRAGMENTS_DIR}/<lot>.md`
    : "release : la section [Unreleased] est vide dans CHANGELOG.md — rien à publier ; y écrire ce qui change pour l'utilisateur (lots cités)";
}

/** La ligne d'un fichier du commit de version : écrit (version, ou CHANGELOG et ses sources), ou retiré (un fragment assemblé). */
export function releaseFileLine(file: string, o: { version: string; today: string; removes: string[]; dryRun: boolean }): string {
  if (o.removes.includes(file)) return `  ${o.dryRun ? 'retirerait' : 'retire'} : ${file} (assemblé dans [${o.version}])`;
  const sources = o.removes.length > 0 ? `[Unreleased] et ${o.removes.length} fragment(s) de ${FRAGMENTS_DIR}/` : '[Unreleased]';
  const note = file === 'CHANGELOG.md' ? ` (${sources} → [${o.version}] - ${o.today}, une section [Unreleased] vide au-dessus)` : ' (version)';
  return `  ${o.dryRun ? 'écrirait' : 'écrit'} : ${file}${note}`;
}

/** Le CHANGELOG du dépôt tel que la prochaine release le publierait : les fragments assemblés sous `[Unreleased]`, à la suite de ce qui y est déjà. */
export function changelogWithFragments(root: string): string {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!head) return text;
  const start = head.index + head[0].length;
  const next = /^## /m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return `${text.slice(0, start)}${versionSection(root, text.slice(start, end)).body}${text.slice(end)}`;
}

/** Retire les fragments assemblés dans la section de la version (le commit de version les compte comme supprimés). */
export function removeFragments(root: string, removes: string[]): void {
  for (const file of removes) rmSync(join(root, file));
}
