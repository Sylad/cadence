import { audit, exemptPlanOnly, nextUp } from './audit.js';
import { diffDays, maxDay, type Day } from './dates.js';
import { readCommits, repoStatus, type Commit } from './git.js';
import { linkCommits, type Linked } from './link.js';
import type { Lot, Plan } from './plan.js';
import { pidAlive, readLock, readNext } from './state.js';

export interface SessionCtx {
  plan: Plan;
  root: string;
  newsDir: string;
  state: string;
  today: Day;
  out: (line: string) => void;
}

const short = (c: Commit) => `${c.sha.slice(0, 7)} ${c.subject}`;

/** Commits de la fenêtre reliés aux lots, sans compter comme « sans lot » ceux qui ne touchent que le plan. */
function period(ctx: SessionCtx, since: string): Linked {
  const commits = readCommits(ctx.root, { since });
  return exemptPlanOnly(linkCommits(ctx.plan.lots(), commits, ctx.plan.prefix), ctx.plan, ctx.root);
}

function byLotLines(linked: Linked): string[] {
  return [...linked.byLot].map(([id, cs]) => {
    const subjects = cs.slice(0, 3).map((c) => c.subject).join(' ; ');
    return `${id} — ${cs.length} commit(s) : ${subjects}${cs.length > 3 ? ' ; …' : ''}`;
  });
}

/** Ligne de livraison en cours ; `live` faux quand le verrou appartient à un processus mort. */
function lockStatus(state: string): { line: string; live: boolean } | null {
  const lock = readLock(state);
  if (!lock) return null;
  if (pidAlive(lock.pid)) return { line: `Livraison en cours : ${lock.sha.slice(0, 7)} (pid ${lock.pid}, depuis ${lock.started})`, live: true };
  return { line: `Verrou de livraison périmé (pid ${lock.pid} mort, sha ${lock.sha.slice(0, 7)}) : cadence deliver le retirera`, live: false };
}

function repoLine(root: string): { line: string; open: number } {
  const s = repoStatus(root);
  const bits = [`branche ${s.branch}`];
  if (s.dirty) bits.push(`${s.dirty} fichier(s) modifié(s)`);
  if (s.untracked) bits.push(`${s.untracked} non suivi(s)`);
  if (!s.upstream) bits.push('pas de branche amont');
  else if (s.ahead) bits.push(`${s.ahead} commit(s) non poussé(s) vers ${s.upstream}`);
  else bits.push(`à jour avec ${s.upstream}`);
  return { line: bits.join(', '), open: (s.dirty ? 1 : 0) + (s.ahead ? 1 : 0) };
}

function section(out: (l: string) => void, title: string, lines: string[]): void {
  if (lines.length === 0) return;
  out(`\n${title}`);
  for (const l of lines) out(`  ${l}`);
}

/** Dernière activité d'un lot : dernier commit, dernière note ou démarrage. */
function lastActivity(lot: Lot, commits: Commit[]): Day | undefined {
  const days = [commits[0]?.day, lot.started, ...lot.notes.map((n) => n.date)].filter((d): d is Day => !!d);
  return days.length ? days.reduce(maxDay) : undefined;
}

export function sessionStart(ctx: SessionCtx, opts: { since: string; idle: number }): number {
  const { plan, out, today } = ctx;
  const lots = plan.lots();
  const all = linkCommits(lots, readCommits(ctx.root), plan.prefix);
  out(`${plan.project} — reprise du ${today}`);

  const next = readNext(ctx.state);
  if (next) section(out, `Notes de la dernière clôture (${next.date})`, next.lines.map((l) => `- ${l}`));

  const lock = lockStatus(ctx.state);
  if (lock) out(`\n${lock.line}`);

  const { doing, ready } = nextUp(lots);
  out('\nEn cours');
  if (doing.length === 0) out('  (rien)');
  for (const l of doing) {
    const last = lastActivity(l, all.byLot.get(l.id) ?? []);
    const idle = last ? diffDays(last, today) : 0;
    const state = last ? `dernière activité ${last}${idle > opts.idle ? `, silencieux depuis ${idle} j` : ''}` : 'aucune activité';
    out(`  ${l.id}  ${l.title}  (${state})`);
  }

  const recent = period(ctx, opts.since);
  const done = byLotLines(recent);
  if (recent.orphans.length) done.push(`${recent.orphans.length} commit(s) sans lot`);
  section(out, `Fait depuis ${opts.since}`, done);

  section(out, 'Écarts (raf check)', audit(plan, ctx.root, ctx.newsDir, today).map((i) => `✗ ${i.message}`));
  section(out, 'Dépôt', [repoLine(ctx.root).line]);

  const proposals = [
    ...doing.map((l) => ({ l, why: 'en cours' })),
    ...ready.map((l) => ({ l, why: l.quickwin ? 'gain rapide prêt' : 'prêt' })),
  ].slice(0, 3);
  section(
    out,
    'Propositions',
    proposals.map(({ l, why }, i) => `${i + 1}. ${l.quickwin ? '⚡ ' : ''}${l.id}  ${l.title} — ${why}`),
  );
  return 0;
}

export function sessionClose(ctx: SessionCtx, opts: { since: string }): number {
  const { plan, out, today } = ctx;
  out(`${plan.project} — clôture du ${today}`);

  const recent = period(ctx, opts.since);
  const commits = byLotLines(recent);
  if (recent.orphans.length) {
    commits.push(`${recent.orphans.length} commit(s) sans lot :`, ...recent.orphans.map((c) => `  ${short(c)}`));
  }
  section(out, 'Commits de la période', commits.length ? commits : ['(aucun)']);

  const quiet = plan.lots().filter((l) => l.status === 'doing' && !recent.byLot.has(l.id));
  section(out, 'Lots en cours', quiet.map((l) => `${l.id}  ${l.title} — aucun commit sur la période : raf done ou raf note`));

  const issues = audit(plan, ctx.root, ctx.newsDir, today);
  section(out, 'Écarts (raf check)', issues.map((i) => `✗ ${i.message}`));

  const repo = repoLine(ctx.root);
  const lock = lockStatus(ctx.state);
  section(out, 'Dépôt', [repo.line, ...(lock ? [lock.line] : [])]);

  const open = issues.length + repo.open + (lock?.live ? 1 : 0);
  out(open === 0 ? '\n✓ prêt à fermer' : `\n✗ pas fermé : ${open} point(s)`);
  return open === 0 ? 0 : 1;
}
