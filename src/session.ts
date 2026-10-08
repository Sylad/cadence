import { spawnSync } from 'node:child_process';
import { CLEAN_DAYS, scanStale } from './clean.js';
import { dueLine, isRecurring, recurringByDue } from './recurring.js';
import { audit, exemptPlanOnly, nextUp, planCommits } from './audit.js';
import { diffDays, maxDay, type Day } from './dates.js';
import { repoStatus, type Commit } from './git.js';
import { linkCommits, type Linked } from './link.js';
import type { Lot, Plan } from './plan.js';
import { lockAlive, readLock, readNext, readSessionMark, writeSessionMark } from './state.js';

export interface SessionCtx {
  plan: Plan;
  root: string;
  newsDir: string;
  /** État du worktree (notes de clôture). */
  state: string;
  /** État commun aux worktrees (verrou de livraison). */
  shared: string;
  today: Day;
  /** Instant de la session (borne de la prochaine clôture) ; absent : rien n'est enregistré. */
  now?: Date;
  out: (line: string) => void;
  /** Commande du projet (cadence.yaml : session.start / session.close) dont la sortie complète le rapport. */
  facts?: string;
  /** Lignes de `cadence verify` rejouée à la reprise (déjà calculées : la reprise reste synchrone). */
  effects?: string[];
  /** Motifs de fichiers de travail à proposer au nettoyage de clôture (cadence.yaml : session.clean). */
  clean?: { patterns: string[]; days?: number };
}

const FACTS_TIMEOUT = 120_000;

/**
 * Sortie de la commande du projet, ligne à ligne. Un échec se dit et ne bloque rien : ce sont des
 * faits en plus, pas une condition de la session.
 */
function projectFacts(ctx: SessionCtx, since: string): string[] {
  if (!ctx.facts) return [];
  const r = spawnSync('sh', ['-c', ctx.facts], {
    cwd: ctx.root,
    env: { ...process.env, CADENCE_SINCE: since, CADENCE_TODAY: ctx.today },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FACTS_TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\s+$/, '').split('\n').filter((l, i, all) => l !== '' || all.length > 1);
  if (r.error || r.signal) lines.push(`✗ commande interrompue (${r.signal ? `délai de ${FACTS_TIMEOUT / 1000} s dépassé` : r.error!.message}) : ${ctx.facts}`);
  else if (r.status !== 0) lines.push(`✗ commande en échec (code ${r.status})`);
  return lines;
}

const short = (c: Commit) => `${c.sha.slice(0, 7)} ${c.subject}`;

/** Commits de la fenêtre reliés aux lots, sans compter comme « sans lot » ceux qui ne touchent que le plan. */
function period(ctx: SessionCtx, since: string): Linked {
  const commits = planCommits(ctx.plan, ctx.root, { since });
  const linked = exemptPlanOnly(linkCommits(ctx.plan.lots(), commits, ctx.plan.refs), ctx.plan, ctx.root);
  // Comme raf check : un commit antérieur à l'adoption du plan n'avait pas à citer de lot.
  const adopted = ctx.plan.since;
  return adopted ? { ...linked, orphans: linked.orphans.filter((c) => c.day >= adopted) } : linked;
}

function byLotLines(linked: Linked): string[] {
  return [...linked.byLot].map(([id, cs]) => {
    const subjects = cs.slice(0, 3).map((c) => c.subject).join(' ; ');
    return `${id} — ${cs.length} commit(s) : ${subjects}${cs.length > 3 ? ' ; …' : ''}`;
  });
}

/** Ligne de livraison en cours ; `live` faux quand le verrou appartient à un processus mort. */
export function lockStatus(state: string): { line: string; live: boolean } | null {
  const lock = readLock(state);
  if (!lock) return null;
  if (lockAlive(lock)) return { line: `Livraison en cours : ${lock.sha.slice(0, 7)} (pid ${lock.pid}, depuis ${lock.started})`, live: true };
  return { line: `Verrou de livraison périmé (pid ${lock.pid} mort, sha ${lock.sha.slice(0, 7)}) : cadence deliver le retirera`, live: false };
}

function repoLine(root: string): { line: string; open: number } {
  const s = repoStatus(root);
  const bits = [s.branch ? `branche ${s.branch}` : 'HEAD détachée'];
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
export function lastActivity(lot: Lot, commits: Commit[]): Day | undefined {
  const days = [commits[0]?.day, lot.started, ...lot.notes.map((n) => n.date)].filter((d): d is Day => !!d);
  return days.length ? days.reduce(maxDay) : undefined;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Fenêtre de la clôture : --since s'il est donné ; sinon depuis la dernière ouverture du
 * projet, dite avec son heure ; sinon le jour même.
 */
function closeWindow(ctx: SessionCtx, since: string | undefined): { since: string; label: string } {
  if (since !== undefined) return { since, label: `depuis ${since}` };
  const mark = readSessionMark(ctx.state);
  if (!mark) return { since: `${ctx.today} 00:00`, label: `depuis ${ctx.today} 00:00` };
  const at = new Date(mark.at);
  const what = mark.kind === 'start' ? "l'ouverture" : 'la clôture';
  const sameDay = at.toDateString() === (ctx.now ?? new Date()).toDateString();
  const when = sameDay ? `de ${hhmm(at)}` : `du ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} à ${hhmm(at)}`;
  return { since: mark.at, label: `depuis ${what} ${when}` };
}

export function sessionStart(ctx: SessionCtx, opts: { since: string; idle: number }): number {
  const { plan, out, today } = ctx;
  const lots = plan.lots();
  const all = linkCommits(lots, planCommits(plan, ctx.root), plan.refs);
  out(`${plan.project} — reprise du ${today}`);

  const next = readNext(ctx.state);
  if (next) section(out, `Notes de la dernière clôture (${next.date})`, next.lines.map((l) => `- ${l}`));

  const lock = lockStatus(ctx.shared);
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

  section(
    out,
    'Récurrent',
    recurringByDue(lots, today).map((l) => `${l.id}  ${l.title} — ${dueLine(l, today)}`),
  );
  section(out, 'Écarts (raf check)', audit(plan, ctx.root, ctx.newsDir, today).map((i) => `${i.warning ? '⚠' : '✗'} ${i.message}`));
  section(out, 'Dépôt', [repoLine(ctx.root).line]);
  section(out, 'Effets en production (cadence verify)', ctx.effects ?? []);
  section(out, 'Faits propres au projet', projectFacts(ctx, opts.since));

  const proposals = [
    ...doing.map((l) => ({ l, why: 'en cours' })),
    ...ready.map((l) => ({ l, why: l.quickwin ? 'gain rapide prêt' : 'prêt' })),
  ].slice(0, 3);
  section(
    out,
    'Propositions',
    proposals.map(({ l, why }, i) => `${i + 1}. ${l.quickwin ? '⚡ ' : ''}${l.id}  ${l.title} — ${why}`),
  );
  // La clôture du soir part de cette heure : elle ne relit pas ce que l'ouverture vient de rapporter.
  writeSessionMark(ctx.state, { kind: 'start', at: (ctx.now ?? new Date()).toISOString() });
  return 0;
}

export function sessionClose(ctx: SessionCtx, opts: { since?: string }): number {
  const { plan, out, today } = ctx;
  out(`${plan.project} — clôture du ${today}`);

  const window = closeWindow(ctx, opts.since);
  const recent = period(ctx, window.since);
  const commits = byLotLines(recent);
  if (recent.orphans.length) {
    commits.push(`${recent.orphans.length} commit(s) sans lot :`, ...recent.orphans.map((c) => `  ${short(c)}`));
  }
  section(out, `Commits de la période (${window.label})`, commits.length ? commits : ['(aucun)']);

  const quiet = plan.lots().filter((l) => l.status === 'doing' && !isRecurring(l) && !recent.byLot.has(l.id));
  section(out, 'Lots en cours', quiet.map((l) => `${l.id}  ${l.title} — aucun commit sur la période : ${plan.readonly ? "le fermer ou l'annoter avec l'outil du projet" : 'raf done ou raf note'}`));

  const issues = audit(plan, ctx.root, ctx.newsDir, today);
  section(out, 'Écarts (raf check)', issues.map((i) => `${i.warning ? '⚠' : '✗'} ${i.message}`));

  const repo = repoLine(ctx.root);
  const lock = lockStatus(ctx.shared);
  section(out, 'Dépôt', [repo.line, ...(lock ? [lock.line] : [])]);

  section(out, 'Faits propres au projet', projectFacts(ctx, window.since));

  // Une proposition, pas une condition : rien n'est supprimé ici, le skill demande l'accord. Le
  // nettoyage ne change jamais le verdict et ne fait jamais tomber la clôture.
  if (ctx.clean?.patterns.length) {
    const days = ctx.clean.days ?? CLEAN_DAYS;
    try {
      const { stale, unreadable } = scanStale(ctx.root, ctx.clean.patterns, days, today);
      section(out, `Nettoyage proposé (${stale.length} élément(s) plus vieux de ${days} j)`, stale.map((s) => `${s.path} — ${s.age} j`));
      section(out, `Nettoyage : ${unreadable.length} élément(s) illisible(s), jamais proposé(s)`, unreadable);
    } catch (e) {
      section(out, "Nettoyage : parcours interrompu, rien n'est proposé", [e instanceof Error ? e.message : String(e)]);
    }
  }

  else {
    out(`\n(aucun motif de nettoyage déclaré — exemple de session.clean, dans cadence.yaml : session: { clean: [ "tmp/*", "~/partage/capture-*.png" ], cleanDays: 7 } ; chemins relatifs à la racine ou absolus, cleanDays = âge minimal en jours)`);
  }

  const open = issues.filter((i) => !i.warning).length + repo.open + (lock?.live ? 1 : 0);
  out(open === 0 ? '\n✓ prêt à fermer' : `\n✗ pas fermé : ${open} point(s)`);
  // La clôture ne déplace jamais la borne : relancée sans ouverture entre-temps (le skill la relance exprès),
  // elle rapporte encore depuis l'ouverture. Seule une ouverture pose la marque.
  return open === 0 ? 0 : 1;
}
