import { diffDays, type Day } from './dates.js';
import type { Commit } from './git.js';
import type { Linked } from './link.js';
import { isOpen, type Lot } from './plan.js';
import { isRecurring } from './recurring.js';

export interface Issue {
  kind: 'orphan-commit' | 'unknown-ref' | 'todo-with-commits' | 'idle' | 'done-open-tasks' | 'bad-dependency' | 'cycle' | 'bad-field' | 'ux-review-not-visible';
  message: string;
}

/** Un commit sur une ligne : sha abrégé et sujet. */
export const short = (c: Commit) => `${c.sha.slice(0, 7)} ${c.subject}`;

/** Titre d'un lot de revue UX planifiée : « Revue UX — <écran> ». */
const UX_REVIEW_TITLE = /^revue ux\s+—/i;

/** Ce que `check` doit savoir du plan pour ne pas conseiller une commande impossible (L321). */
export interface PlanKind {
  /** Plan tenu par un autre outil : aucune commande raf ne peut le corriger. */
  readonly?: boolean;
  /** Le plan porte le champ `visible` (toujours vrai pour un plan raf). */
  hasVisibleField?: boolean;
}

/** Message de l'écart d'une revue UX sans `visible:` ; la correction dépend de qui tient le plan (L321). */
function uxReviewMessage(lot: Lot, plan: PlanKind): string {
  const head = `${lot.id} est une revue UX (« ${lot.title.slice(0, 60)} ») sans visible: — l'étape UX n'aurait pas lieu`;
  if (!plan.readonly) return `${head} : poser visible: true dans le plan (raf visible ${lot.id} on, ou raf add --visible pour un nouveau lot)`;
  if (plan.hasVisibleField === false) return `${head} : ce plan ne porte pas visible : mapper le champ dans cadence.yaml (plan.fields.visible) si l'outil du projet l'écrit ; sans ce champ, la revue d'ergonomie de cet écran se fait hors orchestrate`;
  return `${head} : poser visible: true dans le plan avec l'outil du projet (plan en lecture seule)`;
}

export function check(lots: Lot[], linked: Linked, today: Day, idleDays = 7, plan: PlanKind = {}): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(lots.map((l) => l.id));

  for (const c of linked.orphans) issues.push({ kind: 'orphan-commit', message: `commit sans lot : ${short(c)}` });
  for (const u of linked.unknown) {
    issues.push({ kind: 'unknown-ref', message: `${u.ref} inconnu, cité par ${short(u.commit)}` });
  }

  for (const lot of lots) {
    const commits = linked.byLot.get(lot.id) ?? [];
    // Un lot récurrent reste ouvert par construction : ni todo-avec-commits ni idle.
    const recurring = isRecurring(lot);
    if (lot.status === 'todo' && !recurring && commits.length > 0) {
      issues.push({ kind: 'todo-with-commits', message: `${lot.id} a ${commits.length} commit(s) mais est encore todo — raf start ${lot.id}` });
    }
    if (lot.status === 'doing' && !recurring) {
      // Un lot parent travaille par ses sous-lots (champ parent:, L321) : leur dernier commit, ou leur démarrage s'ils sont en cours, compte comme le sien.
      const own: (Day | undefined)[] = [commits[0]?.day ?? lot.started];
      for (const sub of lots) {
        if (sub.parent !== lot.id) continue;
        own.push(linked.byLot.get(sub.id)?.[0]?.day ?? (sub.status === 'doing' ? sub.started : undefined));
      }
      const last = own.filter((d): d is Day => !!d).sort().at(-1);
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
    // L271 : sans visible:, le lot ne passe par aucune étape UX d'orchestrate (precheck → implement → review) et la revue de l'écran n'a pas lieu.
    if (isOpen(lot.status) && UX_REVIEW_TITLE.test(lot.title) && !lot.visible) {
      issues.push({ kind: 'ux-review-not-visible', message: uxReviewMessage(lot, plan) });
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
