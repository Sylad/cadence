import { dirname, join, relative } from 'node:path';
import { check } from './check.js';
import type { Day } from './dates.js';
import { changedFiles, readCommits, type Commit } from './git.js';
import { linkCommits, type Linked } from './link.js';
import { loadEntries, newsIssues } from './news.js';
import { isOpen, type Lot, type Plan, type Verdict } from './plan.js';

/** Le plan, sa page Gantt et les fichiers tenus avec lui (cadence.yaml : plan.files). */
function ownFiles(plan: Plan, root: string): Set<string> {
  return new Set([relative(root, plan.path), relative(root, join(dirname(plan.path), 'gantt.html')), ...plan.files]);
}

/** Commits du dépôt sans les commits automatiques (motifs `ignore`) : ni audités ni comptés pour un lot. */
export function planCommits(plan: Plan, root: string, opts: { since?: string; range?: string } = {}): Commit[] {
  const { patterns } = plan.ignore;
  const commits = readCommits(root, opts);
  return patterns.length ? commits.filter((c) => !patterns.some((re) => re.test(c.subject))) : commits;
}

/** Commit d'entretien du plan : ne touche-t-il que des fichiers du plan (plan, page Gantt, plan.files) ? */
export function isPlanOnly(sha: string, plan: Plan, root: string): boolean {
  const own = ownFiles(plan, root);
  const files = changedFiles(root, sha);
  return files.length > 0 && files.every((f) => own.has(f));
}

/**
 * N'ont pas besoin de citer un lot : un commit d'entretien du plan — TOUS ses fichiers sont des fichiers
 * du plan (le plan, sa page Gantt, ceux que le projet déclare sous plan.files, son plan publié par
 * exemple) — et un commit automatique dont le sujet correspond à un motif `ignore:` du plan.
 * Les fichiers décident, jamais le sujet : « chore(plan): … » qui touche un fichier source est un
 * commit comme un autre.
 */
export function exemptPlanOnly(linked: Linked, plan: Plan, root: string): Linked {
  const own = ownFiles(plan, root);
  const { patterns } = plan.ignore;
  const orphans = linked.orphans.filter((c) => {
    if (patterns.some((re) => re.test(c.subject))) return false;
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
  const linked = exemptPlanOnly(linkCommits(lots, planCommits(plan, root, { since: auditSince(plan, opts.since) }), plan.refs), plan, root);
  // L'inactivité se mesure sur tout l'historique, pas seulement la fenêtre --since.
  const all = linkCommits(lots, planCommits(plan, root), plan.refs);
  // Planifier un lot (commit qui ne touche que le plan) n'est pas y travailler : un lot « todo »
  // cité seulement par de tels commits n'a pas à être démarré. Ni par des commits antérieurs à
  // l'adoption du plan : citer un identifiant n'engageait alors à rien.
  for (const l of lots) {
    const cs = all.byLot.get(l.id);
    if (l.status === 'todo' && cs) all.byLot.set(l.id, workCommits(plan, root, cs));
  }
  // Un plan en lecture seule ne reçoit aucun verdict de raf : les deux portes n'y valent pas, même si
  // uxSince ou reviewSince y sont écrits à la main — l'écart ne pourrait jamais être levé.
  const gates = plan.readonly ? [] : [...uxIssues(plan), ...reviewIssues(plan, root, all.byLot)];
  const issues = [...check(lots, { ...linked, byLot: all.byLot }, today, opts.idle ?? 7), ...newsIssues(lots, loadEntries(newsDir), newsDir), ...gates,
    ...plan.ignore.invalid.map((src) => ({ message: `ignore : motif invalide « ${src} »` }))];
  // Un plan en lecture seule se corrige avec l'outil du projet : ne pas conseiller une commande raf qui refuserait.
  return plan.readonly ? issues.map((i) => ({ ...i, message: i.message.replace(/ — raf start .*$/, '') })) : issues;
}

/** Commits qui portent du travail sur un lot : ni antérieurs à l'adoption du plan, ni réduits au plan. */
function workCommits(plan: Plan, root: string, commits: Commit[]): Commit[] {
  const adopted = plan.since;
  return commits.filter((c) => (!adopted || c.day >= adopted) && !isPlanOnly(c.sha, plan, root));
}

/** Commits liés à un lot, du plus récent au plus ancien, avant tout tri : commits de plan et d'avant l'adoption compris. */
function lotCommits(plan: Plan, root: string, lotId: string): Commit[] {
  return linkCommits(plan.lots(), planCommits(plan, root), plan.refs).byLot.get(lotId) ?? [];
}

/** Commits à relire d'un lot, du plus récent au plus ancien — ce que compte la porte de revue de code et que liste `raf commits`. */
export function lotWork(plan: Plan, root: string, lotId: string): Commit[] {
  return workCommits(plan, root, lotCommits(plan, root, lotId));
}

/**
 * Commits à relire que la revue de code d'un lot ne couvre pas, parmi ses commits liés (du plus récent
 * au plus ancien) : tous sans verdict ; aucun pour un verdict qui ne dit pas quel commit il a relu
 * (écrit à la main) ; sinon ceux qui suivent le commit relu — tous quand il n'y en avait aucun, ou
 * quand il n'est plus parmi ceux du lot (historique réécrit) : la revue ne se rattache alors à rien.
 */
function unreviewed(plan: Plan, root: string, review: Verdict | undefined, linked: Commit[]): Commit[] {
  if (!review) return workCommits(plan, root, linked);
  const reviewed = review.commit;
  if (reviewed === undefined) return [];
  const at = reviewed === null ? -1 : linked.findIndex((c) => c.sha === reviewed);
  // Seuls les commits postérieurs sont examinés : un lot relu à son dernier commit ne coûte aucun appel git.
  return workCommits(plan, root, at < 0 ? linked : linked.slice(0, at));
}

/** Nombre de commits d'un lot que sa revue de code ne couvre pas — ce que `raf done` refuse quand la porte est active. */
export function unreviewedWork(plan: Plan, root: string, lotId: string): number {
  const lot = plan.lots().find((l) => l.id === lotId);
  return lot ? unreviewed(plan, root, lot.review, lotCommits(plan, root, lotId)).length : 0;
}

/**
 * Lots visibles terminés APRÈS le jour d'activation sans revue UX enregistrée. Le jour même est exclu :
 * à la journée près, on ne distingue pas un lot fermé avant l'activation d'un lot fermé après
 * (et `raf done` refuse de toute façon dès l'activation).
 */
export function uxIssues(plan: Plan): { message: string }[] {
  const since = plan.uxSince;
  if (!since) return [];
  return plan
    .lots()
    .filter((l) => l.visible && l.status === 'done' && !l.ux && (!l.finished || l.finished > since))
    .map((l) => ({ message: `${l.id} est visible et terminé sans revue UX — raf ux ${l.id} "verdict"` }));
}

/**
 * Lots terminés APRÈS le jour d'activation avec des commits à relire que leur revue de code ne couvre
 * pas : aucun verdict, ou un verdict antérieur à ces commits. Même règle de date que `uxIssues` ; un
 * lot sans commit n'a rien à faire relire.
 */
export function reviewIssues(plan: Plan, root: string, byLot: Map<string, Commit[]>): { message: string }[] {
  const since = plan.reviewSince;
  if (!since) return [];
  return plan
    .lots()
    .filter((l) => l.status === 'done' && (!l.finished || l.finished > since))
    .map((l) => ({ id: l.id, reviewed: !!l.review, commits: unreviewed(plan, root, l.review, byLot.get(l.id) ?? []).length }))
    .filter((l) => l.commits > 0)
    .map((l) => ({
      message: l.reviewed
        ? `${l.id} est terminé avec ${l.commits} commit(s) postérieur(s) à sa revue de code, à refaire — raf review ${l.id} "verdict"`
        : `${l.id} est terminé avec ${l.commits} commit(s) sans revue de code — raf review ${l.id} "verdict"`,
    }));
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
