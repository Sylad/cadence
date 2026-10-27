/** Ordre des sections de Keep a Changelog ; un titre inconnu vient après, dans l'ordre où il apparaît. */
const SECTION_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const rank = (s: string) => (SECTION_ORDER.includes(s) ? SECTION_ORDER.indexOf(s) : SECTION_ORDER.length);

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

/** Clé des entrées nues (avant tout `### `) quand `sections` les accepte ; aucun titre réel n'est vide. */
const BARE = '';

/**
 * Sections du bloc `[Unreleased]` : une entrée est une ligne `- ` et ses lignes de suite. Deux titres identiques sont fondus. Du texte hors entrée : null.
 * Une entrée avant tout titre est refusée (null), sauf avec `allowBare` : elle est alors rangée sous la clé `BARE`.
 */
function sections(block: string[], allowBare = false): Sections | null {
  const out: Sections = new Map();
  let current: string[] | null = null;
  for (const line of block) {
    if (line.trim() === '') continue;
    const title = /^### (.+?)\s*$/.exec(line)?.[1];
    if (title) {
      current = out.get(title) ?? [];
      out.set(title, current);
    } else if (!current && allowBare && line.startsWith('- ')) {
      current = out.get(BARE) ?? [];
      out.set(BARE, current);
      current.push(line);
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

/**
 * Range les entrées nues des trois côtés sous une rubrique (L383) : celle que les côtés ont ajoutée à la base si elle est seule, sinon la seule rubrique qu'ils
 * portent. Aucune rubrique, ou plusieurs candidates : le choix serait le nôtre, on rend false et le conflit reste à la main.
 */
function fileBare(base: Sections, ours: Sections, theirs: Sections): boolean {
  if (![base, ours, theirs].some((s) => s.has(BARE))) return true;
  const titles = [...new Set([...ours.keys(), ...theirs.keys()])].filter((t) => t !== BARE);
  const added = titles.filter((t) => !base.has(t));
  const target = added.length === 1 ? added[0] : titles.length === 1 ? titles[0] : null;
  if (target === null) return false;
  for (const side of [base, ours, theirs]) {
    const bare = side.get(BARE);
    if (!bare) continue;
    side.delete(BARE);
    side.set(target, [...(side.get(target) ?? []), ...bare]);
  }
  return true;
}

/** `base` est une sous-suite de `side` : rien n'a été retiré ni modifié, seul de l'ajout s'y est glissé. */
function onlyAdds(base: string[], side: string[]): boolean {
  let i = 0;
  for (const e of side) if (i < base.length && e === base[i]) i++;
  return i === base.length;
}

/** `text` porte l'entrée `e` entière, sur ses propres lignes : « - Fix typo » n'est pas dans « - Fix typo in README ». */
const hasEntry = (text: string, e: string) => `\n${text}\n`.includes(`\n${e}\n`);

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
 * changé des deux côtés, pas de section `[Unreleased]` — : le conflit reste alors à la main. Une entrée nue (sans rubrique) d'un côté est rangée sous la
 * rubrique que l'autre a ajoutée (L383) ; sans rubrique unique où la ranger, le conflit reste à la main.
 *
 * `start` est le CHANGELOG du point de départ de la branche rejouée (L323). Une entrée de `base` qui n'y était pas a été ajoutée par un commit précédent du
 * lot lui-même : `theirs` peut la modifier ou la retirer, sa version gagne (l'ancienne est écartée de `ours`). Sans `start`, aucune entrée n'est au lot.
 */
export function mergeUnreleased(base: string, ours: string, theirs: string, start?: string): string | null {
  const [b, o, t] = [split(base), split(ours), split(theirs)];
  if (!b || !o || !t) return null;
  const head = pick(b.head, o.head, t.head);
  const tail = pick(b.tail, o.tail, t.tail);
  const [bs, os, ts] = [sections(b.block, true), sections(o.block, true), sections(t.block, true)];
  if (head === null || tail === null || !bs || !os || !ts || !fileBare(bs, os, ts)) return null;
  const st = start === undefined ? null : split(start);
  const startEntries = new Set([...(st ? (sections(st.block, true)?.values() ?? []) : [])].flat());
  const own = new Set<string>(start === undefined || !st ? [] : [...bs.values()].flat().filter((e) => !startEntries.has(e)));
  // Une entrée de base que ours range sous une version publiée (la branche a été publiée pendant la vie du lot) n'a pas été retirée : elle a changé de place.
  // Seule une entrée de base compte, entière : une entrée nouvelle de theirs qui est un bout d'une entrée publiée n'est pas la même, elle reste au lot.
  // Les entrées du lot (`own`) ne comptent pas dans l'ordre de ours : l'union d'un commit précédent les y a recasées en fin de section.
  const baseEntries = new Set([...bs.values()].flat());
  const released = (e: string) => baseEntries.has(e) && o.tail !== b.tail && hasEntry(o.tail, e) && !hasEntry(b.tail, e);
  for (const [title, entries] of bs) {
    const kept = entries.filter((e) => !own.has(e));
    if (!onlyAdds(kept.filter((e) => !released(e)), (os.get(title) ?? []).filter((e) => !own.has(e))) || !onlyAdds(kept, ts.get(title) ?? [])) {
      return null;
    }
  }
  const titles = [...new Set([...os.keys(), ...ts.keys()])];
  titles.sort((x, y) => rank(x) - rank(y));
  const body = titles.flatMap((title) => {
    const entries = [...new Set([...(os.get(title) ?? []).filter((e) => !own.has(e)), ...(ts.get(title) ?? []).filter((e) => !released(e))])];
    return entries.length ? [`### ${title}\n\n${entries.join('\n')}\n`] : [];
  });
  return `${head}\n\n${body.join('\n')}\n${tail}`;
}

/** Entrées du bloc `[Unreleased]` de `text`, par section ; null sans bloc ou avec du texte hors entrée. */
export function unreleasedSections(text: string): Sections | null {
  const s = split(text);
  return s ? sections(s.block) : null;
}

/**
 * Replace sous `[Unreleased]` les entrées du lot qu'une publication de la branche a laissées sous une version (L362). `lotTip` : le CHANGELOG du sommet du lot
 * avant le rebase, `start` celui de son point de départ — une entrée de `[Unreleased]` du premier absente du second est au lot — et `main` celui de la
 * branche du dépôt : une entrée déjà dans sa partie publiée n'a pas été glissée là par le rebase, elle reste. `rebased` : le CHANGELOG après le rebase.
 * Rend le texte corrigé et le nombre d'entrées déplacées, ou null quand il n'y a rien à déplacer (ou que le fichier n'a pas la forme attendue).
 */
export function moveToUnreleased(rebased: string, lotTip: string, start: string, main: string): { text: string; moved: number } | null {
  const [r, mainSplit] = [split(rebased), split(main)];
  const [tip, was] = [unreleasedSections(lotTip), unreleasedSections(start)];
  const [now, published] = [sections(r?.block ?? []), mainSplit ? mainSplit.tail : ''];
  if (!r || !tip || !was || !now) return null;
  const known = new Set([...was.values()].flat());
  let tail = r.tail;
  let moved = 0;
  const added = new Map<string, string[]>();
  for (const [title, entries] of tip) {
    for (const e of entries) {
      if (known.has(e) || hasEntry(published, e) || (now.get(title) ?? []).includes(e) || !hasEntry(tail, e)) continue;
      tail = tail.replace(`\n${e}\n`, '\n');
      added.set(title, [...(added.get(title) ?? []), e]);
      moved++;
    }
  }
  if (moved === 0) return null;
  tail = tail.replace(/^### .+\n\n(\n|$)/gm, '');
  for (const [title, entries] of added) now.set(title, [...(now.get(title) ?? []), ...entries]);
  const titles = [...now.keys()].sort((x, y) => rank(x) - rank(y));
  const body = titles.map((title) => `### ${title}\n\n${(now.get(title) ?? []).join('\n')}\n`);
  return { text: `${r.head}\n\n${body.join('\n')}\n${tail}`, moved };
}

/**
 * Une entrée finale par lot (L369) : après le rebase, le `[Unreleased]` ne porte du lot que ses entrées du sommet de sa branche. Les `intermediates` — les
 * entrées que ses commits successifs ont écrites puis réécrites, absentes du sommet comme de ses versions publiées — en sont retirées (sous `[Unreleased]` comme sous une version), à moins
 * que `main` ne les porte aussi : elles sont alors à elle. Une entrée du sommet absente du texte (ni sous `[Unreleased]`, ni sous une version, ni déjà publiée
 * sur `main`) y est remise sous sa section. `lotTip`, `start`, `main` : comme pour `moveToUnreleased`. Rend le texte corrigé, ou null quand il n'y a rien à
 * changer (ou que le fichier n'a pas la forme attendue).
 */
export function settleLotEntries(rebased: string, lotTip: string, start: string, main: string, intermediates: string[]): string | null {
  const [r, mainSplit] = [split(rebased), split(main)];
  const [tip, was] = [unreleasedSections(lotTip), unreleasedSections(start)];
  const now = sections(r?.block ?? []);
  if (!r || !mainSplit || !tip || !was || !now) return null;
  const mainOwn = new Set([...(sections(mainSplit.block)?.values() ?? [])].flat());
  const known = new Set([...was.values()].flat());
  const final = new Set([...tip.values()].flat());
  // Une entrée que le sommet du lot porte sous une version (le lot l'a publiée lui-même) est finale, pas intermédiaire.
  const tipTail = split(lotTip)?.tail ?? '';
  const stale = intermediates.filter((e) => !final.has(e) && !hasEntry(tipTail, e) && !mainOwn.has(e) && !hasEntry(mainSplit.tail, e));
  let changed = false;
  for (const [title, entries] of now) {
    const kept = entries.filter((e) => !stale.includes(e));
    if (kept.length !== entries.length) changed = true;
    now.set(title, kept);
  }
  let tail = r.tail;
  for (const e of stale) {
    if (hasEntry(tail, e)) {
      tail = tail.replace(`\n${e}\n`, '\n');
      changed = true;
    }
  }
  const present = (e: string) => [...now.values()].some((v) => v.includes(e)) || hasEntry(tail, e) || hasEntry(mainSplit.tail, e);
  for (const [title, entries] of tip) {
    for (const e of entries.filter((x) => !known.has(x) && !present(x))) {
      now.set(title, [...(now.get(title) ?? []), e]);
      changed = true;
    }
  }
  if (!changed) return null;
  tail = tail.replace(/^### .+\n\n(\n|$)/gm, '');
  const titles = [...now.keys()].filter((t) => (now.get(t) ?? []).length > 0).sort((x, y) => rank(x) - rank(y));
  const body = titles.map((title) => `### ${title}\n\n${(now.get(title) ?? []).join('\n')}\n`);
  return `${r.head}\n\n${body.join('\n')}\n${tail}`;
}
