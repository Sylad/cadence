/** Ordre des sections de Keep a Changelog ; un titre inconnu vient après, dans l'ordre où il apparaît. */
const SECTION_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

type Sections = Map<string, string[]>;
type Split = { head: string; block: string[]; tail: string };

/** Découpe le fichier autour de `## [Unreleased]` : ce qui précède (titre compris), le bloc, ce qui suit à partir de la version suivante. */
function split(text: string): Split | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l));
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return { head: lines.slice(0, at + 1).join('\n'), block: lines.slice(at + 1, end), tail: lines.slice(end).join('\n') };
}

/** Sections du bloc `[Unreleased]` : une entrée est une ligne `- ` et ses lignes de suite. Deux titres identiques sont fondus. Du texte hors entrée : null. */
function sections(block: string[]): Sections | null {
  const out: Sections = new Map();
  let current: string[] | null = null;
  for (const line of block) {
    if (line.trim() === '') continue;
    const title = /^### (.+?)\s*$/.exec(line)?.[1];
    if (title) {
      current = out.get(title) ?? [];
      out.set(title, current);
    } else if (!current) {
      return null;
    } else if (line.startsWith('- ')) {
      current.push(line);
    } else if (current.length > 0) {
      current[current.length - 1] += `\n${line}`;
    } else {
      return null;
    }
  }
  return out;
}

/** `base` est une sous-suite de `side` : rien n'a été retiré ni modifié, seul de l'ajout s'y est glissé. */
function onlyAdds(base: string[], side: string[]): boolean {
  let i = 0;
  for (const e of side) if (i < base.length && e === base[i]) i++;
  return i === base.length;
}

/** Un côté qui n'a pas bougé laisse l'autre gagner ; deux côtés qui ont bougé de la même façon aussi ; sinon, pas de réponse. */
function pick(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  return null;
}

/**
 * Fusion à trois du CHANGELOG quand deux lots y ont chacun ajouté une entrée sous `[Unreleased]` (L314) : union par section, un seul titre par section,
 * sections dans l'ordre de Keep a Changelog, les entrées de `ours` puis celles de `theirs` qui n'y sont pas déjà. Le reste du fichier suit le côté qui l'a
 * changé. Rend null quand ce n'est pas de l'ajout pur — une entrée de base retirée ou modifiée, du texte libre sous `[Unreleased]`, le reste du fichier
 * changé des deux côtés, pas de section `[Unreleased]` — : le conflit reste alors à la main.
 *
 * `start` est le CHANGELOG du point de départ de la branche rejouée (L323). Une entrée de `base` qui n'y était pas a été ajoutée par un commit précédent du
 * lot lui-même : `theirs` peut la modifier ou la retirer, sa version gagne (l'ancienne est écartée de `ours`). Sans `start`, aucune entrée n'est au lot.
 */
export function mergeUnreleased(base: string, ours: string, theirs: string, start?: string): string | null {
  const [b, o, t] = [split(base), split(ours), split(theirs)];
  if (!b || !o || !t) return null;
  const head = pick(b.head, o.head, t.head);
  const tail = pick(b.tail, o.tail, t.tail);
  const [bs, os, ts] = [sections(b.block), sections(o.block), sections(t.block)];
  if (head === null || tail === null || !bs || !os || !ts) return null;
  const st = start === undefined ? null : split(start);
  const startEntries = new Set([...(st ? (sections(st.block)?.values() ?? []) : [])].flat());
  const own = new Set<string>(start === undefined || !st ? [] : [...bs.values()].flat().filter((e) => !startEntries.has(e)));
  for (const [title, entries] of bs) {
    const kept = entries.filter((e) => !own.has(e));
    if (!onlyAdds(kept, (os.get(title) ?? []).filter((e) => !own.has(e))) || !onlyAdds(entries, os.get(title) ?? []) || !onlyAdds(kept, ts.get(title) ?? [])) {
      return null;
    }
  }
  const titles = [...new Set([...os.keys(), ...ts.keys()])];
  const rank = (s: string) => (SECTION_ORDER.includes(s) ? SECTION_ORDER.indexOf(s) : SECTION_ORDER.length);
  titles.sort((x, y) => rank(x) - rank(y));
  const body = titles.map((title) => {
    const entries = [...new Set([...(os.get(title) ?? []).filter((e) => !own.has(e)), ...(ts.get(title) ?? [])])];
    return `### ${title}\n\n${entries.join('\n')}\n`;
  });
  return `${head}\n\n${body.join('\n')}\n${tail}`;
}
