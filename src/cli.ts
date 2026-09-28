import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { check } from './check.js';
import { audit, auditSince, exemptPlanOnly, isPlanOnly, nextUp } from './audit.js';
import { isDay, toDay, type Day } from './dates.js';
import { deliver, parseDeliverConfig, realDeps } from './deliver.js';
import { ganttData, renderGantt } from './gantt.js';
import { gitRoot, readCommits } from './git.js';
import { installHook } from './hook.js';
import { linkCommits } from './link.js';
import { buildNews, loadEntries, newEntry, newsData, newsIssues } from './news.js';
import { extractRefs, Plan, RafError, STATUSES, type Lot, type Status } from './plan.js';
import { schedule } from './schedule.js';
import { AGENTS_DIR, installAgents, installSkills, SKILLS_DIR } from './skills.js';
import { sessionClose, sessionStart, type SessionCtx } from './session.js';
import { sharedStateDir, stateDir, writeNext } from './state.js';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const HELP = `raf — plan « reste à faire » versionné dans le dépôt, relié aux commits

  raf init [--project nom] [--prefix L] [--no-hook]
  raf add "titre" [--estimate j] [--quickwin] [--visible] [--after L2,L4] [--parent L3]
  raf start <id>        raf done <id> [--force]        raf drop <id> [--reason texte]
  raf note <id> "texte"
  raf ux enable         revue UX obligatoire avant « done » pour les lots --visible
  raf ux <id> "verdict" enregistre la revue d'ergonomie du lot (agent ux-reviewer)
  raf now               ce qui est en cours, la suite, les derniers terminés
  raf list [--status todo|doing|done|dropped]
  raf check [--since date] [--idle 7]   (défaut : date « since » du plan) code 1 s'il y a des écarts
  raf gantt [-o docs/plan/gantt.html]
  raf hook install
  raf news new <lot…> [--title t] | list | check | build [-o dossier]   (aussi « cadence news … »)

Un commit appartient à un lot quand son message cite l'identifiant : « feat(L3): … », « L3/t1 ».
Un lot --visible attend une entrée Nouveautés (docs/nouveautes/, --dir) avec capture ; raf check le vérifie.
Un texte qui commence par « - » se passe après « -- » : raf note L1 -- "-5 %".
Options communes : --file chemin (ou RAF_FILE), RAF_TODAY=AAAA-MM-JJ pour figer la date.`;

export function run(argv: string[], io: Io): number | Promise<number> {
  try {
    const result = dispatch(argv, io);
    return result instanceof Promise ? result.catch((e: unknown) => failure(e, io)) : result;
  } catch (e) {
    return failure(e, io);
  }
}

function failure(e: unknown, io: Io): number {
  if (e instanceof RafError) {
    io.err(`raf: ${e.message}`);
    return 2;
  }
  if (e instanceof Error && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
    io.err(`raf: ${e.message} (un texte qui commence par « - » se passe après « -- »)`);
    return 2;
  }
  throw e;
}

function dispatch(argv: string[], io: Io): number | Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      project: { type: 'string' },
      prefix: { type: 'string' },
      'no-hook': { type: 'boolean' },
      estimate: { type: 'string' },
      quickwin: { type: 'boolean' },
      visible: { type: 'boolean' },
      dir: { type: 'string' },
      title: { type: 'string' },
      after: { type: 'string' },
      parent: { type: 'string' },
      force: { type: 'boolean' },
      reason: { type: 'string' },
      status: { type: 'string' },
      since: { type: 'string' },
      idle: { type: 'string' },
      output: { type: 'string', short: 'o' },
      config: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    io.out(HELP);
    return 0;
  }
  const today: Day = io.env.RAF_TODAY ?? toDay(io.now());
  if (!isDay(today)) throw new RafError(`RAF_TODAY invalide : ${today} (attendu AAAA-MM-JJ)`);
  const root = gitRoot(io.cwd) ?? io.cwd;
  const planPath = resolve(io.cwd, values.file ?? io.env.RAF_FILE ?? join(root, 'docs/plan/raf.yaml'));
  const newsDir = resolve(io.cwd, values.dir ?? join(root, 'docs/nouveautes'));
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new RafError(`usage : raf ${usage}`);
  };

  switch (command) {
    case 'init': {
      const plan = Plan.create(planPath, values.project ?? basename(root), values.prefix ?? 'L', today);
      io.out(`plan créé : ${plan.path}`);
      if (!values['no-hook'] && gitRoot(io.cwd)) io.out(`hook : ${installHook(io.cwd).path}`);
      return 0;
    }
    case 'add': {
      need(1, 'add "titre"');
      const plan = Plan.load(planPath);
      let id: string;
      if (values.parent) {
        id = plan.addTask(values.parent, rest.join(' '));
      } else {
        const estimate = values.estimate === undefined ? undefined : Number(values.estimate);
        if (estimate !== undefined && !(estimate > 0)) throw new RafError(`estimation invalide : ${values.estimate}`);
        const after = values.after ? values.after.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        id = plan.add(rest.join(' '), today, { estimate, quickwin: values.quickwin, visible: values.visible, after });
      }
      plan.save();
      io.out(id);
      return 0;
    }
    case 'start':
    case 'done':
    case 'drop': {
      need(1, `${command} <id>`);
      const plan = Plan.load(planPath);
      const status: Status = command === 'start' ? 'doing' : command === 'done' ? 'done' : 'dropped';
      plan.setStatus(rest[0], status, today, { force: values.force });
      if (command === 'drop' && values.reason) plan.note(rest[0], `abandonné : ${values.reason}`, today);
      plan.save();
      io.out(`${rest[0]} → ${status}`);
      if (status === 'done' && !rest[0].includes('/')) {
        const lot = plan.lot(rest[0]);
        if (lot.visible && !loadEntries(newsDir).some((e) => e.lots.includes(lot.id))) {
          io.out(`${lot.id} est visible : écrire l'entrée : cadence news new ${lot.id}`);
        }
      }
      return 0;
    }
    case 'note': {
      need(2, 'note <id> "texte"');
      const plan = Plan.load(planPath);
      plan.note(rest[0], rest.slice(1).join(' '), today);
      plan.save();
      return 0;
    }
    case 'ux': {
      need(1, 'ux enable | ux <lot> "verdict"');
      const plan = Plan.load(planPath);
      if (rest[0] === 'enable') {
        const changed = plan.enableUx(today);
        plan.save();
        io.out(changed ? `revue UX obligatoire pour les lots visibles à partir du ${today}` : `revue UX déjà active depuis le ${plan.uxSince}`);
        return 0;
      }
      need(2, 'ux <lot> "verdict"');
      plan.lot(rest[0]);
      plan.recordUx(rest[0], rest.slice(1).join(' '), today);
      plan.save();
      return 0;
    }
    case 'list': {
      const plan = Plan.load(planPath);
      if (values.status && !STATUSES.includes(values.status as Status)) throw new RafError(`statut inconnu : ${values.status}`);
      for (const l of plan.lots().filter((l) => !values.status || l.status === values.status)) {
        io.out(`${l.id.padEnd(6)} ${l.status.padEnd(8)} ${l.quickwin ? '⚡ ' : ''}${l.title}`);
      }
      return 0;
    }
    case 'now':
      return now(Plan.load(planPath), root, today, io);
    case 'check': {
      const idle = values.idle === undefined ? 7 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      const issues = audit(Plan.load(planPath), root, newsDir, today, { since: values.since, idle });
      for (const i of issues) io.out(`✗ ${i.message}`);
      io.out(issues.length === 0 ? '✓ plan et historique cohérents' : `${issues.length} écart(s)`);
      return issues.length === 0 ? 0 : 1;
    }
    case 'gantt': {
      const plan = Plan.load(planPath);
      const lots = plan.lots();
      const linked = linkCommits(lots, readCommits(root), plan.prefix);
      const stamp = io.now();
      const html = renderGantt(
        ganttData(plan.project, schedule(lots, linked.byLot, today), today, `${toDay(stamp)} ${stamp.toTimeString().slice(0, 5)}`),
      );
      const out = resolve(io.cwd, values.output ?? join(dirname(planPath), 'gantt.html'));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, html);
      io.out(out);
      return 0;
    }
    case 'hook': {
      if (rest[0] === 'install') {
        const { path, changed } = installHook(io.cwd);
        io.out(changed ? `hook installé : ${path}` : `hook déjà présent : ${path}`);
        return 0;
      }
      if (rest[0] === 'post-commit') return postCommit(planPath, newsDir, root, io);
      throw new RafError('usage : raf hook install|post-commit');
    }
    case 'session':
      if (!gitRoot(io.cwd)) throw new RafError('session : à lancer dans un dépôt git');
      return session(rest, { plan: Plan.load(planPath), root, newsDir, state: stateDir(root), shared: sharedStateDir(root), today, out: io.out }, values);
    case 'deliver': {
      if (!gitRoot(io.cwd)) throw new RafError('deliver : à lancer dans un dépôt git');
      const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
      if (!existsSync(configPath)) throw new RafError(`pas de configuration de livraison : ${configPath} (voir « cadence.yaml » dans le README)`);
      const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
      const plan = existsSync(planPath) ? Plan.load(planPath) : null;
      const ctx = { root, state: sharedStateDir(root), plan, config, today, dryRun: !!values['dry-run'], out: io.out, err: io.err };
      return deliver(ctx, realDeps(root));
    }
    case 'skills': {
      if (rest[0] !== 'install') throw new RafError('usage : cadence skills install [--dir .claude] [--force]');
      // --dir désigne le dossier .claude (défaut : celui du dépôt) : skills/ et agents/ dedans.
      const base = resolve(io.cwd, values.dir ?? join(root, '.claude'));
      const label = { installed: 'installé', updated: 'mis à jour', unchanged: 'inchangé' };
      const force = !!values.force;
      // Vérifier les deux avant d'écrire : un conflit d'agent ne doit pas laisser les skills à moitié installés.
      if (!force) {
        installSkills(SKILLS_DIR, join(base, 'skills'), false, true);
        installAgents(AGENTS_DIR, join(base, 'agents'), false, true);
      }
      for (const r of installSkills(SKILLS_DIR, join(base, 'skills'), force)) io.out(`${r.name} : ${label[r.status]}`);
      for (const r of installAgents(AGENTS_DIR, join(base, 'agents'), force)) io.out(`${r.name} (agent) : ${label[r.status]}`);
      io.out(base);
      return 0;
    }
    case 'news':
      return news(rest, Plan.load(planPath), newsDir, today, values, io);
    default:
      throw new RafError(`commande inconnue : ${command} (raf --help)`);
  }
}

function describe(l: Lot, commits: number): string {
  const bits = [`${l.estimate} j`];
  if (commits) bits.push(`${commits} commit(s)`);
  if (l.tasks.length) bits.push(`sous-tâches ${l.tasks.filter((t) => t.status === 'done').length}/${l.tasks.length}`);
  return `${l.quickwin ? '⚡ ' : ''}${l.id}  ${l.title}  (${bits.join(', ')})`;
}

function now(plan: Plan, root: string, today: Day, io: Io): number {
  const lots = plan.lots();
  const linked = linkCommits(lots, readCommits(root), plan.prefix);
  const count = (id: string) => linked.byLot.get(id)?.length ?? 0;
  const { doing, ready, blocked } = nextUp(lots);
  io.out(`${plan.project} — ${today}`);

  io.out('\nEn cours');
  if (doing.length === 0) io.out('  (rien)');
  for (const l of doing) io.out(`  ${describe(l, count(l.id))}`);

  io.out('\nÀ suivre');
  if (ready.length === 0) io.out('  (rien de prêt)');
  for (const l of ready.slice(0, 5)) io.out(`  ${describe(l, count(l.id))}`);
  if (ready.length > 5) io.out(`  … et ${ready.length - 5} autre(s)`);
  if (blocked.length) io.out(`  en attente de dépendances : ${blocked.map((l) => l.id).join(', ')}`);

  const done = lots
    .filter((l) => l.status === 'done' && l.finished)
    .sort((a, b) => (b.finished! > a.finished! ? 1 : -1))
    .slice(0, 3);
  if (done.length) {
    io.out('\nTerminés récemment');
    for (const l of done) io.out(`  ${l.id}  ${l.title}  (${l.finished})`);
  }

  const recent = exemptPlanOnly(linkCommits(lots, readCommits(root, { since: auditSince(plan) }), plan.prefix), plan, root);
  const issues = check(lots, { ...recent, byLot: linked.byLot }, today);
  if (issues.length) io.out(`\n${issues.length} écart(s) entre le plan et l'historique — raf check`);
  return 0;
}

function postCommit(planPath: string, newsDir: string, root: string, io: Io): number {
  if (!existsSync(planPath)) return 0;
  try {
    const plan = Plan.load(planPath);
    const head = readCommits(root, { range: '-1' })[0];
    if (!head) return 0;
    const refs = extractRefs(`${head.subject}\n${head.body}`, plan.prefix);
    if (refs.length === 0) {
      const planOnly = exemptPlanOnly({ byLot: new Map(), orphans: [head], unknown: [] }, plan, root).orphans.length === 0;
      if (!planOnly && !/^Merge\b/.test(head.subject)) {
        io.err('raf: commit sans lot — citer un identifiant la prochaine fois (raf now)');
      }
      return 0;
    }
    const lots = new Map(plan.lots().map((l) => [l.id, l]));
    const planning = isPlanOnly(head.sha, plan, root);
    for (const r of refs) {
      const lot = lots.get(r.lot);
      if (!lot) io.err(`raf: ${r.lot} n'existe pas dans le plan`);
      else if (lot.status === 'todo' && !planning) io.err(`raf: ${r.lot} est encore todo — raf start ${r.lot}`);
      else io.err(`raf: ${r.lot} (${lot.status}) ${lot.title}`);
    }
    const entries = loadEntries(newsDir);
    for (const id of new Set(refs.map((r) => r.lot))) {
      if (lots.get(id)?.visible && !entries.some((e) => e.lots.includes(id))) io.err(`raf: ${id} est visible : cadence news new ${id}`);
    }
  } catch {
    // Un hook ne doit jamais gêner un commit.
  }
  return 0;
}

function news(
  [sub, ...args]: string[],
  plan: Plan,
  dir: string,
  today: Day,
  values: { title?: string; output?: string },
  io: Io,
): number {
  const lots = plan.lots();
  switch (sub) {
    case 'new': {
      if (args.length === 0) throw new RafError('usage : cadence news new <lot…> [--title t]');
      for (const id of args) plan.lot(id);
      io.out(newEntry(dir, args, values.title ?? plan.lot(args[0]).title, today));
      return 0;
    }
    case 'list':
      for (const e of loadEntries(dir)) io.out(`${e.date}  ${e.title}  (${e.lots.join(', ')})`);
      return 0;
    case 'check':
    case 'build': {
      const entries = loadEntries(dir);
      const issues = newsIssues(lots, entries, dir);
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
      throw new RafError('usage : cadence news new|list|check|build');
  }
}

function session([sub, ...args]: string[], ctx: SessionCtx, values: { since?: string; idle?: string }): number {
  switch (sub) {
    case 'start': {
      const idle = values.idle === undefined ? 2 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      return sessionStart(ctx, { since: values.since ?? '24 hours ago', idle });
    }
    case 'close':
      return sessionClose(ctx, { since: values.since ?? `${ctx.today} 00:00` });
    case 'next':
      writeNext(ctx.state, ctx.today, args);
      return 0;
    default:
      throw new RafError('usage : cadence session start [--since …] [--idle 2] | close [--since …] | next "ligne" …');
  }
}
