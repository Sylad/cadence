import { diffDays, type Day } from './dates.js';
import type { Commit } from './git.js';
import type { Linked } from './link.js';
import { isOpen, type Lot } from './plan.js';

export interface Issue {
  kind: 'orphan-commit' | 'unknown-ref' | 'todo-with-commits' | 'idle' | 'done-open-tasks' | 'bad-dependency' | 'cycle' | 'bad-field';
  message: string;
}

const short = (c: Commit) => `${c.sha.slice(0, 7)} ${c.subject}`;

export function check(lots: Lot[], linked: Linked, today: Day, idleDays = 7): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(lots.map((l) => l.id));

  for (const c of linked.orphans) issues.push({ kind: 'orphan-commit', message: `commit sans lot : ${short(c)}` });
  for (const u of linked.unknown) {
    issues.push({ kind: 'unknown-ref', message: `${u.ref} inconnu, cité par ${short(u.commit)}` });
  }

  for (const lot of lots) {
    const commits = linked.byLot.get(lot.id) ?? [];
    if (lot.status === 'todo' && commits.length > 0) {
      issues.push({ kind: 'todo-with-commits', message: `${lot.id} a ${commits.length} commit(s) mais est encore todo — raf start ${lot.id}` });
    }
    if (lot.status === 'doing') {
      const last = commits[0]?.day ?? lot.started;
      if (last && diffDays(last, today) > idleDays) {
        issues.push({ kind: 'idle', message: `${lot.id} en cours sans commit depuis ${diffDays(last, today)} j (${lot.title})` });
      }
    }
    if (lot.status === 'done') {
      const open = lot.tasks.filter((t) => isOpen(t.status));
      if (open.length > 0) {
        issues.push({ kind: 'done-open-tasks', message: `${lot.id} terminé avec sous-tâche(s) ouverte(s) : ${open.map((t) => t.id).join(', ')}` });
      }
    }
    for (const p of lot.problems) issues.push({ kind: 'bad-field', message: `${lot.id} : ${p}` });
    for (const d of lot.after) {
      if (!ids.has(d)) issues.push({ kind: 'bad-dependency', message: `${lot.id} dépend de ${d}, absent du plan` });
    }
  }

  for (const cycle of findCycles(lots)) issues.push({ kind: 'cycle', message: `dépendances circulaires : ${cycle.join(' → ')}` });
  return issues;
}

function findCycles(lots: Lot[]): string[][] {
  const deps = new Map(lots.map((l) => [l.id, l.after]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[][] = [];
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) if (deps.has(d)) visit(d, [...path, id]);
    state.set(id, 'done');
  };
  for (const l of lots) visit(l.id, []);
  return cycles;
}
