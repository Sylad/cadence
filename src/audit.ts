import { dirname, join, relative } from 'node:path';
import { check } from './check.js';
import type { Day } from './dates.js';
import { changedFiles, readCommits } from './git.js';
import { linkCommits, type Linked } from './link.js';
import { loadEntries, newsIssues } from './news.js';
import { isOpen, type Lot, type Plan } from './plan.js';

/** Un commit qui ne touche que le plan (ou la page Gantt) n'a pas besoin de citer un lot. */
export function exemptPlanOnly(linked: Linked, plan: Plan, root: string): Linked {
  const own = new Set([relative(root, plan.path), relative(root, join(dirname(plan.path), 'gantt.html'))]);
  const orphans = linked.orphans.filter((c) => {
    const files = changedFiles(root, c.sha);
    return files.length === 0 || !files.every((f) => own.has(f));
  });
  return { ...linked, orphans };
}

/** Fenêtre de l'audit : --since, sinon la date d'adoption du plan, sinon 30 jours. */
export function auditSince(plan: Plan, explicit?: string): string {
  if (explicit) return explicit;
  // Une date seule vaudrait « ce jour-là à l'heure actuelle » pour git : minuit explicite.
  return plan.since ? `${plan.since} 00:00` : '30 days ago';
}

/** Écarts entre le plan, l'historique et les Nouveautés — ce que `raf check` affiche. */
export function audit(plan: Plan, root: string, newsDir: string, today: Day, opts: { since?: string; idle?: number } = {}): { message: string }[] {
  const lots = plan.lots();
  const linked = exemptPlanOnly(linkCommits(lots, readCommits(root, { since: auditSince(plan, opts.since) }), plan.prefix), plan, root);
  // L'inactivité se mesure sur tout l'historique, pas seulement la fenêtre --since.
  const all = linkCommits(lots, readCommits(root), plan.prefix);
  return [...check(lots, { ...linked, byLot: all.byLot }, today, opts.idle ?? 7), ...newsIssues(lots, loadEntries(newsDir), newsDir), ...uxIssues(plan)];
}

/** Lots visibles terminés depuis l'activation de la règle sans revue UX enregistrée. */
export function uxIssues(plan: Plan): { message: string }[] {
  const since = plan.uxSince;
  if (!since) return [];
  return plan
    .lots()
    .filter((l) => l.visible && l.status === 'done' && !l.ux && (!l.finished || l.finished >= since))
    .map((l) => ({ message: `${l.id} est visible et terminé sans revue UX — raf ux ${l.id} "verdict"` }));
}

/** Ce qui vient ensuite : lots en cours, puis lots prêts (dépendances closes), gains rapides d'abord. */
export function nextUp(lots: Lot[]): { doing: Lot[]; ready: Lot[]; blocked: Lot[] } {
  const byId = new Map(lots.map((l) => [l.id, l]));
  const doing = lots.filter((l) => l.status === 'doing');
  const ready = lots
    .filter((l) => l.status === 'todo' && l.after.every((d) => !byId.has(d) || !isOpen(byId.get(d)!.status)))
    .sort((a, b) => Number(b.quickwin) - Number(a.quickwin));
  const blocked = lots.filter((l) => l.status === 'todo' && !ready.includes(l));
  return { doing, ready, blocked };
}
