import type { Commit } from './git.js';
import type { Lot, Ref } from './plan.js';

export interface Linked {
  /** Commits per lot id, newest first (same order as the log). */
  byLot: Map<string, Commit[]>;
  /** Commits citing no lot at all. */
  orphans: Commit[];
  /** References to ids that are not in the plan. */
  unknown: { commit: Commit; ref: string }[];
}

export function isMerge(c: Commit): boolean {
  return /^Merge\b/.test(c.subject);
}

/** Portée d'un sujet « type(L24,L25)! : … » ; null sans parenthèses. */
export function scopeOf(subject: string): string | null {
  return /^[\w-]+\(([^)]*)\)!?\s*:/.exec(subject)?.[1] ?? null;
}

/**
 * Références qui décident à quels lots appartient un commit : celles de la portée « type(L24) » quand elle
 * en cite ; sinon, celles du message entier. Les mentions en passage (« page équipe (L27) »), les plages
 * (« L28–L31 ») et le corps du message ne comptent donc pas dès que la portée désigne les lots.
 */
export function citedRefs(c: Commit, refsOf: (text: string) => Ref[]): Ref[] {
  const scope = scopeOf(c.subject);
  const scoped = scope === null ? [] : refsOf(scope);
  return scoped.length > 0 ? scoped : refsOf(`${c.subject}\n${c.body}`);
}

/** `refs` lit les références d'un message : `plan.refs`. */
export function linkCommits(lots: Lot[], commits: Commit[], refsOf: (text: string) => Ref[]): Linked {
  const ids = new Set(lots.map((l) => l.id));
  const tasks = new Set(lots.flatMap((l) => l.tasks.map((t) => `${l.id}/${t.id}`)));
  const byLot = new Map<string, Commit[]>();
  const orphans: Commit[] = [];
  const unknown: Linked['unknown'] = [];
  for (const c of commits) {
    const refs = citedRefs(c, refsOf);
    if (refs.length === 0) {
      if (!isMerge(c)) orphans.push(c);
      continue;
    }
    const seen = new Set<string>();
    for (const r of refs) {
      const full = r.task ? `${r.lot}/${r.task}` : r.lot;
      if (!ids.has(r.lot) || (r.task && !tasks.has(full))) {
        unknown.push({ commit: c, ref: full });
        continue;
      }
      if (seen.has(r.lot)) continue;
      seen.add(r.lot);
      byLot.set(r.lot, [...(byLot.get(r.lot) ?? []), c]);
    }
  }
  return { byLot, orphans, unknown };
}
