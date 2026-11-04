// Les commandes qui lisent le plan et l'historique : commits, show, list, now, check, gantt, news (L488, sorti de cli.ts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readOrchestrateConfig } from '../config.js';
import { repoSections } from '../repos.js';
import { lotJson, lotLines } from '../lot-lines.js';
import { audit, closableLines, gateWaiting, hypothesesOf, lotWork, nextUp, planCommits, workByLot } from '../audit.js';
import { short } from '../check.js';
import { type Day, isCalendarDay, toDay } from '../dates.js';
import { ganttData, renderGantt } from '../gantt.js';
import { linkCommits } from '../link.js';
import { EXPORT_SCHEMA, eventLine, exportPlan, planEvents } from '../plan-events.js';
import { buildNews, loadEntries, newEntry, newsData, newsIssues, stampEntries } from '../news.js';
import { type Lot, Plan, RafError, type Status, STATUSES } from '../plan.js';
import { dueLine, recurringByDue } from '../recurring.js';
import { quickwinLines, quickwins, readMax } from '../quickwins.js';
import { schedule } from '../schedule.js';
import { coverageCommand } from '../ref/coverage.js';
import { type Ctx, type Io, knownLot, planFileIn } from './context.js';

function describe(l: Lot, commits: number): string {
  const bits = [`${l.estimate} j`];
  if (commits) bits.push(`${commits} commit(s)`);
  if (l.tasks.length) bits.push(`sous-tâches ${l.tasks.filter((t) => t.status === 'done').length}/${l.tasks.length}`);
  return `${l.quickwin ? '⚡ ' : ''}${l.id}  ${l.title}  (${bits.join(', ')})`;
}

function now(plan: Plan, root: string, newsDir: string, today: Day, io: Io): number {
  const lots = plan.lots();
  const linked = linkCommits(lots, planCommits(plan, root), plan.refs);
  const { doing, ready, blocked } = nextUp(lots);
  const work = workByLot(plan, root, linked, [...doing, ...ready.slice(0, 5)].map((l) => l.id));
  const count = (id: string) => work.get(id)?.length ?? 0;
  io.out(`${plan.project} — ${today}`);

  io.out('\nEn cours');
  if (doing.length === 0) io.out('  (rien)');
  for (const l of doing) io.out(`  ${describe(l, count(l.id))}`);

  io.out('\nÀ suivre');
  if (ready.length === 0) io.out('  (rien de prêt)');
  for (const l of ready.slice(0, 5)) io.out(`  ${describe(l, count(l.id))}`);
  if (ready.length > 5) io.out(`  … et ${ready.length - 5} autre(s)`);
  const gated = gateWaiting(lots, blocked);
  const byDeps = blocked.filter((l) => !gated.some((g) => g.lot === l));
  if (byDeps.length) io.out(`  en attente de dépendances : ${byDeps.map((l) => l.id).join(', ')}`);
  if (gated.length) io.out(`  en attente de condition de tirage : ${gated.map((g) => `${g.lot.id} (${g.text})`).join(', ')}`);

  const closable = closableLines(lots, plan.readonly);
  if (closable.length) io.out(`\nSous-tâches toutes fermées\n${closable.map((l) => `  ${l}`).join('\n')}`);

  const recurring = recurringByDue(lots, today);
  if (recurring.length) {
    io.out('\nRécurrent');
    for (const l of recurring) io.out(`  ${l.id}  ${l.title}  (tous les ${l.every} j, ${dueLine(l, today)})`);
  }

  const done = lots
    .filter((l) => l.status === 'done' && l.finished)
    .sort((a, b) => (b.finished! > a.finished! ? 1 : -1))
    .slice(0, 3);
  if (done.length) {
    io.out('\nTerminés récemment');
    for (const l of done) io.out(`  ${l.id}  ${l.title}  (${l.finished})`);
  }

  const issues = audit(plan, root, newsDir, today).filter((i) => !i.warning);
  if (issues.length) io.out(`\n${issues.length} écart(s) entre le plan et l'historique — raf check`);
  return 0;
}

function news(
  [sub, ...args]: string[],
  plan: Plan,
  dir: string,
  today: Day,
  values: { title?: string; output?: string },
  io: Io,
  refuseLongTitle: (text: string, hint?: string) => void,
  hypotheses: () => Map<string, string[]>,
): number {
  const lots = plan.lots();
  switch (sub) {
    case 'new': {
      if (args.length === 0) throw new RafError('usage : cadence news new <lot…> [--title t]');
      for (const id of args) plan.lot(id);
      // Mesuré comme newEntry l'écrit : espaces fusionnés.
      const title = (values.title ?? plan.lot(args[0]).public ?? plan.lot(args[0]).title).replace(/\s+/g, ' ').trim();
      refuseLongTitle(title, values.title === undefined ? ' — donner un titre court : cadence news new <lot> --title "…"' : '');
      io.out(newEntry(dir, args, title, today, io.now()));
      return 0;
    }
    case 'stamp': {
      const stamped = stampEntries(dir, io.now());
      for (const s of stamped) io.out(`${s.file}  created: ${s.created}`);
      if (stamped.length === 0) io.out('✓ toutes les entrées ont une heure de création');
      return 0;
    }
    case 'list':
      for (const e of loadEntries(dir)) io.out(`${e.date}  ${e.title}  (${e.lots.join(', ')})`);
      return 0;
    case 'check':
    case 'build': {
      const entries = loadEntries(dir);
      const issues = newsIssues(lots, entries, dir, sub === 'check' ? hypotheses() : undefined);
      for (const i of issues) io.out(`✗ ${i.message}`);
      // Le build refuse seulement ce qu'il ne saurait pas publier : entrée illisible, capture absente.
      const blocking = sub === 'check' ? issues : issues.filter((i) => i.kind === 'bad-entry' || i.kind === 'missing-capture');
      if (sub === 'check') io.out(issues.length === 0 ? '✓ Nouveautés cohérentes avec le plan' : `${issues.length} écart(s)`);
      if (blocking.length > 0) return 1;
      if (sub === 'build') {
        const stamp = io.now();
        const data = newsData(plan.project, entries, `${toDay(stamp)} ${stamp.toTimeString().slice(0, 5)}`);
        for (const f of buildNews(data, dir, resolve(io.cwd, values.output ?? join(dir, 'site')))) io.out(f);
      }
      return 0;
    }
    default:
      throw new RafError('usage : cadence news new|list|check|stamp|build');
  }
}

/** raf commits <lot> : les commits que compte la porte de revue. */
export function cmdCommits(c: Ctx): number | Promise<number> {
  const { rest, io, root, loadPlan, need } = c;
  need(1, 'commits <lot>');
  const plan = loadPlan();
  const id = rest[0];
  knownLot(plan, id, 'les commits se listent par lot, pas par sous-tâche');
  // Une lecture : le même ensemble que « raf done » et « raf check », plan en lecture seule compris.
  for (const c of lotWork(plan, root, id).reverse()) io.out(short(c));
  for (const line of repoSections(plan, root, plan.lot(id))) io.out(line);
  return 0;
}

/** raf show <lot> [--notes]. */
export function cmdShow(c: Ctx): number | Promise<number> {
  const { rest, values, io, root, loadPlan, need } = c;
  need(1, 'show <lot> [--notes]');
  const plan = loadPlan();
  const lot = knownLot(plan, rest[0], 'show se lit par lot, pas par sous-tâche');
  const notes = lot.notes.map((n) => `${n.date}  ${n.text}`);
  if (values.notes) {
    for (const n of notes) io.out(n);
    return 0;
  }
  for (const line of lotLines(plan, lot)) io.out(line);
  if (notes.length) {
    io.out('notes :');
    // Les lignes suivantes d'une note multiligne s'alignent sous son texte, pas en colonne 0.
    for (const n of lot.notes) io.out(`  ${n.date}  ${n.text.replace(/\n/g, `\n${' '.repeat(n.date.length + 4)}`)}`);
  }
  const commits = lotWork(plan, root, lot.id).reverse();
  io.out(`commits (${commits.length}) :`);
  for (const c of commits) io.out(`  ${short(c)}`);
  for (const line of repoSections(plan, root, lot, '  ')) io.out(line);
  return 0;
}

/** raf list [--status s] [--json]. */
export function cmdList(c: Ctx): number | Promise<number> {
  const { values, io, loadPlan } = c;
  const plan = loadPlan();
  if (values.status && !STATUSES.includes(values.status as Status)) throw new RafError(`statut inconnu : ${values.status}`);
  const shown = plan.lots().filter((l) => !values.status || l.status === values.status);
  if (values.json) io.out(JSON.stringify(shown.map(lotJson), null, 2));
  else for (const l of shown) io.out(`${l.id.padEnd(6)} ${l.status.padEnd(8)} ${l.quickwin ? '⚡ ' : ''}${l.title}`);
  return 0;
}

/** raf export [--json] : le plan entier en un document JSON versionné, sans date de génération (L470, M8). */
export function cmdExport(c: Ctx): number {
  c.io.out(JSON.stringify(exportPlan(c.loadPlan()), null, 2));
  return 0;
}

/** raf events [--since J] [--json] : les événements du plan, dérivés des dates, des notes, de l'historique git du plan et des commits (L470, M8). */
export function cmdEvents(c: Ctx): number {
  const { values, io, root, planPath, loadPlan } = c;
  if (values.since !== undefined && !isCalendarDay(values.since)) throw new RafError(`--since invalide : ${values.since} (attendu AAAA-MM-JJ)`);
  const plan = loadPlan();
  const events = planEvents(plan, root, planFileIn(root, planPath), planCommits(plan, root), { since: values.since, warn: io.err });
  if (values.json) io.out(JSON.stringify({ schema: EXPORT_SCHEMA, project: plan.project, events }, null, 2));
  else for (const e of events) io.out(eventLine(e));
  return 0;
}

/** raf check : les écarts entre le plan et l'historique, code 1 s'il y en a. */
export function cmdCheck(c: Ctx): number | Promise<number> {
  const { values, io, today, root, loadPlan, newsDir } = c;
  if (values.ignored) {
    const list = loadPlan().acknowledged;
    if (list.length === 0) io.out('aucun commit acquitté');
    for (const a of list) io.out(`${a.sha ? a.sha.slice(0, 7) : 'sujet  '} ${a.subject ?? ''}  (${a.date}${a.reason ? ` — ${a.reason}` : ''})`);
    return 0;
  }
  const idle = values.idle === undefined ? 7 : Number(values.idle);
  if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
  const issues = audit(loadPlan(), root, newsDir, today, { since: values.since, idle });
  for (const i of issues) io.out(`${i.warning ? '⚠' : '✗'} ${i.message}`);
  // Un avertissement s'affiche mais ne fait pas échouer : seuls les écarts comptent pour le code de sortie.
  const errors = issues.filter((i) => !i.warning).length;
  const warnings = issues.length - errors;
  io.out(errors === 0 ? `✓ plan et historique cohérents${warnings ? ` (${warnings} avertissement(s))` : ''}` : `${errors} écart(s)${warnings ? `, ${warnings} avertissement(s)` : ''}`);
  return errors === 0 ? 0 : 1;
}

/** raf gantt [-o fichier] : la page Gantt du plan. */
export function cmdGantt(c: Ctx): number | Promise<number> {
  const { values, io, today, root, planPath, loadPlan } = c;
  const plan = loadPlan();
  const lots = plan.lots();
  const linked = linkCommits(lots, planCommits(plan, root), plan.refs);
  const stamp = io.now();
  const html = renderGantt(
    ganttData(plan.project, schedule(lots, workByLot(plan, root, linked), today), today, `${toDay(stamp)} ${stamp.toTimeString().slice(0, 5)}`),
  );
  const out = resolve(io.cwd, values.output ?? join(dirname(planPath), 'gantt.html'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  io.out(out);
  return 0;
}

/** raf now : ce qui est en cours, la suite, les derniers terminés. */
export function cmdNow(c: Ctx): number {
  return now(c.loadPlan(), c.root, c.newsDir, c.today, c.io);
}

/** raf quickwins [--by champ] [--max jours] : les gains rapides prêts, groupés par un champ d'extension, et les prêts non estimés (L467). */
export function cmdQuickwins(c: Ctx): number {
  const { values, io, loadPlan, planConfig } = c;
  const declared = Object.keys(planConfig?.settings.extras ?? {});
  for (const l of quickwinLines(quickwins(loadPlan(), { by: values.by, max: readMax(values.max), declared }), values.by)) io.out(l);
  return 0;
}

/** raf news … : les entrées Nouveautés. */
export function cmdNews(c: Ctx): number {
  const { rest, values, io, today, root, configPath, loadPlan, newsDir, refuseLongTitle } = c;
  return news(rest, loadPlan(), newsDir, today, values, io, refuseLongTitle, () => hypothesesOf(root, configPath, loadPlan().refs));
}

/** cadence ref coverage lit le plan (les lots faits qui citent les éléments) : il passe après le choix du plan, les autres ref n'y touchent pas (L367). */
export function cmdRef(c: Ctx): number | Promise<number> {
  const { rest, io, root, configPath, loadPlan } = c;
  return coverageCommand(rest.slice(1), loadPlan, io, { repo: root, specDir: readOrchestrateConfig(configPath).spec.dir });
}
