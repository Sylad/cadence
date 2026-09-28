import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { check } from './check.js';
import { isDay, toDay, type Day } from './dates.js';
import { ganttData, renderGantt } from './gantt.js';
import { changedFiles, gitRoot, readCommits } from './git.js';
import { installHook } from './hook.js';
import { linkCommits, type Linked } from './link.js';
import { extractRefs, isOpen, Plan, RafError, STATUSES, type Lot, type Status } from './plan.js';
import { schedule } from './schedule.js';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const HELP = `raf — plan « reste à faire » versionné dans le dépôt, relié aux commits

  raf init [--project nom] [--prefix L] [--no-hook]
  raf add "titre" [--estimate j] [--quickwin] [--after L2,L4] [--parent L3]
  raf start <id>        raf done <id> [--force]        raf drop <id> [--reason texte]
  raf note <id> "texte"
  raf now               ce qui est en cours, la suite, les derniers terminés
  raf list [--status todo|doing|done|dropped]
  raf check [--since date] [--idle 7]   (défaut : date « since » du plan) code 1 s'il y a des écarts
  raf gantt [-o docs/plan/gantt.html]
  raf hook install

Un commit appartient à un lot quand son message cite l'identifiant : « feat(L3): … », « L3/t1 ».
Un texte qui commence par « - » se passe après « -- » : raf note L1 -- "-5 %".
Options communes : --file chemin (ou RAF_FILE), RAF_TODAY=AAAA-MM-JJ pour figer la date.`;

export function run(argv: string[], io: Io): number {
  try {
    return dispatch(argv, io);
  } catch (e) {
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
}

function dispatch(argv: string[], io: Io): number {
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
      after: { type: 'string' },
      parent: { type: 'string' },
      force: { type: 'boolean' },
      reason: { type: 'string' },
      status: { type: 'string' },
      since: { type: 'string' },
      idle: { type: 'string' },
      output: { type: 'string', short: 'o' },
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
        id = plan.add(rest.join(' '), today, { estimate, quickwin: values.quickwin, after });
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
      return 0;
    }
    case 'note': {
      need(2, 'note <id> "texte"');
      const plan = Plan.load(planPath);
      plan.note(rest[0], rest.slice(1).join(' '), today);
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
      const plan = Plan.load(planPath);
      const lots = plan.lots();
      const linked = exemptPlanOnly(linkCommits(lots, readCommits(root, { since: auditSince(plan, values.since) }), plan.prefix), plan, root);
      // L'inactivité se mesure sur tout l'historique, pas seulement la fenêtre --since.
      const all = linkCommits(lots, readCommits(root), plan.prefix);
      const idle = values.idle === undefined ? 7 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      const issues = check(lots, { ...linked, byLot: all.byLot }, today, idle);
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
      if (rest[0] === 'post-commit') return postCommit(planPath, root, io);
      throw new RafError('usage : raf hook install|post-commit');
    }
    default:
      throw new RafError(`commande inconnue : ${command} (raf --help)`);
  }
}

/** Un commit qui ne touche que le plan (ou la page Gantt) n'a pas besoin de citer un lot. */
function exemptPlanOnly(linked: Linked, plan: Plan, root: string): Linked {
  const own = new Set([relative(root, plan.path), relative(root, join(dirname(plan.path), 'gantt.html'))]);
  const orphans = linked.orphans.filter((c) => {
    const files = changedFiles(root, c.sha);
    return files.length === 0 || !files.every((f) => own.has(f));
  });
  return { ...linked, orphans };
}

/** Fenêtre de l'audit : --since, sinon la date d'adoption du plan, sinon 30 jours. */
function auditSince(plan: Plan, explicit?: string): string {
  if (explicit) return explicit;
  // Une date seule vaudrait « ce jour-là à l'heure actuelle » pour git : minuit explicite.
  return plan.since ? `${plan.since} 00:00` : '30 days ago';
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
  const byId = new Map(lots.map((l) => [l.id, l]));
  io.out(`${plan.project} — ${today}`);

  const doing = lots.filter((l) => l.status === 'doing');
  io.out('\nEn cours');
  if (doing.length === 0) io.out('  (rien)');
  for (const l of doing) io.out(`  ${describe(l, count(l.id))}`);

  const ready = lots
    .filter((l) => l.status === 'todo' && l.after.every((d) => !byId.has(d) || !isOpen(byId.get(d)!.status)))
    .sort((a, b) => Number(b.quickwin) - Number(a.quickwin));
  const blocked = lots.filter((l) => l.status === 'todo' && !ready.includes(l));
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

function postCommit(planPath: string, root: string, io: Io): number {
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
    for (const r of refs) {
      const lot = lots.get(r.lot);
      if (!lot) io.err(`raf: ${r.lot} n'existe pas dans le plan`);
      else if (lot.status === 'todo') io.err(`raf: ${r.lot} est encore todo — raf start ${r.lot}`);
      else io.err(`raf: ${r.lot} (${lot.status}) ${lot.title}`);
    }
  } catch {
    // Un hook ne doit jamais gêner un commit.
  }
  return 0;
}
