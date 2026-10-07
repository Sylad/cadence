import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readPlanConfig, readSessionConfig } from './config.js';
import { audit, exemptPlanOnly, isPlanOnly, lotWork, nextUp, planCommits, unreviewedWork } from './audit.js';
import { short } from './check.js';
import { isDay, toDay, type Day } from './dates.js';
import { deliver, parseDeliverConfig, realDeps } from './deliver.js';
import { defaultTarget, effectLines, realCheckDeps, verifyCommand } from './verify.js';
import { ganttData, renderGantt } from './gantt.js';
import { gitRoot, readCommits, resolveCommit } from './git.js';
import { installHook } from './hook.js';
import { citedRefs, linkCommits } from './link.js';
import { buildNews, loadEntries, newEntry, newsData, newsIssues, stampEntries } from './news.js';
import { Plan, RafError, STATUSES, type Lot, type Status } from './plan.js';
import { dueLine, isRecurring, recurringByDue } from './recurring.js';
import { schedule } from './schedule.js';
import { AGENTS_DIR, installAgents, installSkills, SKILLS_DIR } from './skills.js';
import { orchestrate, realOrchestrateDeps } from './orchestrate/command.js';
import { activeLock, REPO_LOCK } from './orchestrate/lock.js';
import { sessionClose, sessionStart, type SessionCtx } from './session.js';
import { clearNext, readNext, sharedStateDir, stateDir, writeNext } from './state.js';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const HELP = `raf — plan « reste à faire » versionné dans le dépôt, relié aux commits

  raf init [--project nom] [--prefix L] [--no-hook]
  raf add "titre" [--estimate j] [--quickwin] [--visible] [--public "titre public"] [--every jours] [--after L2,L4] [--parent L3]
  raf public <id> "titre public" | --clear   titre du lot dans le langage du public (pages Nouveautés et Plan)
  raf start <id>        raf done <id> [--force]        raf drop <id> [--reason texte]
  raf note <id> "texte"
  raf did <id> ["texte"]   un lot récurrent (--every) a été refait : le « dû depuis N j » repart de aujourd'hui
  raf ux enable         revue UX obligatoire avant « done » pour les lots --visible
  raf ux <id> "verdict" enregistre la revue d'ergonomie du lot (agent ux-reviewer)
  raf review enable     revue de code obligatoire avant « done » pour les lots qui ont des commits
  raf review <id> "verdict" enregistre la revue de code du lot (agent code-reviewer)
  raf commits <id>      les commits du lot que compte la porte de revue de code, du plus ancien au plus récent
  raf now               ce qui est en cours, la suite, les derniers terminés
  raf list [--status todo|doing|done|dropped]
  raf check [--since date] [--idle 7]   (défaut : date « since » du plan) code 1 s'il y a des écarts
  raf gantt [-o docs/plan/gantt.html]
  raf hook install
  cadence orchestrate <projet>:<lot>[@modèle]… [--budget 2M] [--dry-run] [--wave nom]   une session claude neuve par étape ; --status [vague] ; --resume [vague] [--budget 1M] [--answer projet:lot "réponse"]
  cadence verify [--retry s] [--sha rév]   rejoue deliver.verify hors livraison : 0 vert, 1 effet rouge, 2 rien à vérifier
  raf news new <lot…> [--title t] | list | check | stamp | build [-o dossier]   (aussi « cadence news … »)

Un commit appartient à un lot quand son message cite l'identifiant : « feat(L3): … », « L3/t1 ».
Quand la portée du sujet cite des lots — « feat(L3): … », « chore(L31,L32): … » — elle seule décide : une
mention en passage (« page équipe (L27) »), une plage (« L28–L31 », « L45 à L48 ») ou le corps n'y comptent pas.
Sans portée citant un lot, tout le message est lu : « fix: L3 corrigé », « L3/t1 ».
Un commit qui ne touche que le plan, la clé plan: de cadence.yaml (deliver/session sont du travail) (et les fichiers déclarés sous plan.files, un plan
publié par exemple, ainsi que le fichier d'attendus QA : docs/qa/expectations.md ou qa.expectations) n'a pas à en citer, et ne compte pas pour les lots qu'il cite ; le sujet n'y change rien.
Un lot --visible attend une entrée Nouveautés (docs/nouveautes/, --dir) avec capture ; raf check le vérifie.
Un texte qui commence par « - » se passe après « -- » : raf note L1 -- "-5 %".
Le plan est docs/plan/raf.yaml, ou celui que nomme « plan: » dans cadence.yaml ; un plan tenu par un
autre outil se lit sans migration (correspondance des champs, voir le README) et reste en lecture seule.
Options communes : --file chemin (ou RAF_FILE), RAF_TODAY=AAAA-MM-JJ pour figer la date.`;

/** Ajoute `line` au .gitignore de `root` s'il n'y est pas déjà (avec ou sans `/` initial ou final). Rend vrai si écrit. */
export function ensureGitignore(root: string, line: string): boolean {
  const file = join(root, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const norm = (l: string) => l.trim().replace(/^\//, '').replace(/\/$/, '');
  if (text.split('\n').some((l) => norm(l) === norm(line))) return false;
  writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
  return true;
}

export function run(argv: string[], io: Io): number | Promise<number> {
  try {
    // orchestrate a ses propres options (--status et --resume prennent une valeur facultative, --answer en prend deux).
    if (argv[0] === 'orchestrate') {
      return orchestrate(argv.slice(1), io, realOrchestrateDeps(io.env)).catch((e: unknown) => failure(e, io));
    }
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
      public: { type: 'string' },
      every: { type: 'string' },
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
      sha: { type: 'string' },
      retry: { type: 'string' },
      clear: { type: 'boolean' },
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
  // cadence.yaml peut dire où est le plan et, s'il est tenu par un autre outil, comment le lire.
  const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
  // Installer les skills ou le hook ne lit pas le plan : un cadence.yaml fautif ne doit pas l'empêcher.
  const installing = command === 'skills' || (command === 'hook' && rest[0] === 'install');
  const planConfig = installing ? null : readPlanConfig(configPath, root);
  const planPath = resolve(io.cwd, values.file ?? io.env.RAF_FILE ?? resolve(root, planConfig?.path ?? 'docs/plan/raf.yaml'));
  const loadPlan = () => Plan.load(planPath, { ...planConfig?.settings, config: configPath });
  const newsDir = resolve(io.cwd, values.dir ?? join(root, 'docs/nouveautes'));
  // Une session d'orchestration ne ferme pas un lot, n'enregistre pas de verdict à la place du lead et ne livre pas.
  if (io.env.CADENCE_ORCHESTRATED && (command === 'done' || command === 'ux' || command === 'review' || command === 'deliver')) {
    throw new RafError(`${command} refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead`);
  }
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new RafError(`usage : raf ${usage}`);
  };

  switch (command) {
    case 'init': {
      if (planConfig?.settings.format) throw new RafError(`plan en lecture seule : ${configPath} décrit un plan tenu par un autre outil`);
      const plan = Plan.create(planPath, values.project ?? basename(root), values.prefix ?? 'L', today);
      io.out(`plan créé : ${plan.path}`);
      if (ensureGitignore(root, '.playwright-mcp/')) io.out('.gitignore : .playwright-mcp/');
      if (!values['no-hook'] && gitRoot(io.cwd)) io.out(`hook : ${installHook(io.cwd).path}`);
      return 0;
    }
    case 'add': {
      need(1, 'add "titre"');
      const plan = loadPlan();
      let id: string;
      if (values.parent) {
        if (values.public !== undefined) throw new RafError('--public se pose sur un lot, pas sur une sous-tâche');
        if (values.every !== undefined) throw new RafError('--every se pose sur un lot, pas sur une sous-tâche');
        id = plan.addTask(values.parent, rest.join(' '));
      } else {
        const estimate = values.estimate === undefined ? undefined : Number(values.estimate);
        if (estimate !== undefined && !(estimate > 0)) throw new RafError(`estimation invalide : ${values.estimate}`);
        const after = values.after ? values.after.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const every = values.every === undefined ? undefined : Number(values.every);
        if (every !== undefined && !(Number.isInteger(every) && every > 0)) throw new RafError(`périodicité invalide : ${values.every} (un nombre entier de jours)`);
        id = plan.add(rest.join(' '), today, { estimate, quickwin: values.quickwin, visible: values.visible, public: values.public, every, after });
      }
      plan.save();
      io.out(id);
      return 0;
    }
    case 'start':
    case 'done':
    case 'drop': {
      need(1, `${command} <id>`);
      const plan = loadPlan();
      const status: Status = command === 'start' ? 'doing' : command === 'done' ? 'done' : 'dropped';
      // Le plan ne lit pas git : lui dire combien de commits du lot sa revue ne couvre pas quand elle est exigée.
      const unreviewed = status === 'done' && plan.reviewSince && !plan.readonly && !values.force ? unreviewedWork(plan, root, rest[0]) : 0;
      plan.setStatus(rest[0], status, today, { force: values.force, unreviewed });
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
      const plan = loadPlan();
      plan.note(rest[0], rest.slice(1).join(' '), today);
      plan.save();
      return 0;
    }
    case 'did': {
      need(1, 'did <id> ["texte"]');
      const plan = loadPlan();
      plan.did(rest[0], today, rest.slice(1).join(' '));
      plan.save();
      io.out(`${rest[0]} refait le ${today}`);
      return 0;
    }
    case 'public': {
      need(values.clear ? 1 : 2, 'public <id> "titre public" | public <id> --clear');
      if (values.clear && rest.length > 1) throw new RafError('--clear n\'attend pas de titre');
      const plan = loadPlan();
      plan.setPublic(rest[0], values.clear ? null : rest.slice(1).join(' '));
      plan.save();
      return 0;
    }
    case 'ux':
    case 'review':
      return gate(command, rest, loadPlan, root, today, io);
    case 'commits': {
      need(1, 'commits <lot>');
      const plan = loadPlan();
      const id = rest[0];
      if (!plan.lots().some((l) => l.id === id)) {
        throw new RafError(id.includes('/') ? `les commits se listent par lot, pas par sous-tâche : ${id}` : `lot inconnu : ${id}`);
      }
      // Une lecture : le même ensemble que « raf done » et « raf check », plan en lecture seule compris.
      for (const c of lotWork(plan, root, id).reverse()) io.out(short(c));
      return 0;
    }
    case 'list': {
      const plan = loadPlan();
      if (values.status && !STATUSES.includes(values.status as Status)) throw new RafError(`statut inconnu : ${values.status}`);
      for (const l of plan.lots().filter((l) => !values.status || l.status === values.status)) {
        io.out(`${l.id.padEnd(6)} ${l.status.padEnd(8)} ${l.quickwin ? '⚡ ' : ''}${l.title}`);
      }
      return 0;
    }
    case 'now':
      return now(loadPlan(), root, newsDir, today, io);
    case 'check': {
      const idle = values.idle === undefined ? 7 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      const issues = audit(loadPlan(), root, newsDir, today, { since: values.since, idle });
      for (const i of issues) io.out(`✗ ${i.message}`);
      io.out(issues.length === 0 ? '✓ plan et historique cohérents' : `${issues.length} écart(s)`);
      return issues.length === 0 ? 0 : 1;
    }
    case 'gantt': {
      const plan = loadPlan();
      const lots = plan.lots();
      const linked = linkCommits(lots, planCommits(plan, root), plan.refs);
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
      if (rest[0] === 'post-commit') return postCommit(existsSync(planPath) ? loadPlan : null, newsDir, root, today, io);
      throw new RafError('usage : raf hook install|post-commit');
    }
    case 'session': {
      if (!gitRoot(io.cwd)) throw new RafError('session : à lancer dans un dépôt git');
      // « next » n'écrit que les notes : la commande du projet ne se joue qu'à la reprise et à la clôture.
      const sconf = rest[0] === 'start' || rest[0] === 'close' ? readSessionConfig(configPath) : {};
      const facts = rest[0] === 'start' || rest[0] === 'close' ? sconf[rest[0]] : undefined;
      const clean = rest[0] === 'close' && sconf.clean ? { patterns: sconf.clean, days: sconf.cleanDays } : undefined;
      const sctx: SessionCtx = { plan: loadPlan(), root, newsDir, state: stateDir(root), shared: sharedStateDir(root), today, out: io.out, facts, clean };
      if (rest[0] !== 'start') return session(rest, sctx, values);
      // La reprise rejoue les vérifications d'effet (un essai, borné) : un effet rouge d'hier se lit avec les faits du matin.
      const effects = morningEffects(configPath, root);
      if (effects === null) return session(rest, sctx, values);
      return Promise.resolve(effects).then((lines) => session(rest, { ...sctx, effects: lines }, values));
    }
    case 'deliver': {
      if (!gitRoot(io.cwd)) throw new RafError('deliver : à lancer dans un dépôt git');
      const orchestrating = activeLock(join(sharedStateDir(root), REPO_LOCK));
      if (orchestrating) throw new RafError(`deliver : orchestration en cours (vague ${orchestrating.wave}, pid ${orchestrating.pid}) — livrer une fois la vague finie`);
      if (!existsSync(configPath)) throw new RafError(`pas de configuration de livraison : ${configPath} (voir « cadence.yaml » dans le README)`);
      const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
      const plan = existsSync(planPath) ? loadPlan() : null;
      const ctx = { root, state: sharedStateDir(root), plan, config, today, dryRun: !!values['dry-run'], sha: values.sha, args: rest, out: io.out, err: io.err };
      return deliver(ctx, realDeps(root));
    }
    case 'verify': {
      if (!gitRoot(io.cwd)) throw new RafError('verify : à lancer dans un dépôt git');
      if (!existsSync(configPath)) throw new RafError(`pas de configuration : ${configPath} (voir « cadence.yaml » dans le README)`);
      const retry = values.retry === undefined ? 0 : Number(values.retry);
      if (!Number.isFinite(retry) || retry < 0) throw new RafError(`--retry invalide : ${values.retry} (secondes, 0 ou plus)`);
      const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
      const target = values.sha ? { sha: resolveCommit(root, values.sha) ?? '', note: null } : defaultTarget(root, config);
      if (values.sha && !target.sha) throw new RafError(`--sha ${values.sha} : commit introuvable`);
      return verifyCommand({ config, sha: target.sha, note: target.note, retry, out: io.out }, realCheckDeps(root));
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
      return news(rest, loadPlan(), newsDir, today, values, io);
    default:
      throw new RafError(`commande inconnue : ${command} (raf --help)`);
  }
}

const GATES = {
  ux: { on: 'revue UX obligatoire pour les lots visibles', already: 'revue UX déjà active' },
  review: { on: 'revue de code obligatoire pour les lots à commits', already: 'revue de code déjà active' },
};

/** « raf ux … » et « raf review … » ont la même forme : activer la porte, ou noter le verdict d'un lot. */
function gate(kind: keyof typeof GATES, rest: string[], loadPlan: () => Plan, root: string, today: Day, io: Io): number {
  if (rest.length < 1) throw new RafError(`usage : raf ${kind} enable | ${kind} <lot> "verdict"`);
  const plan = loadPlan();
  if (rest[0] === 'enable') {
    const changed = kind === 'ux' ? plan.enableUx(today) : plan.enableReview(today);
    plan.save();
    io.out(changed ? `${GATES[kind].on} à partir du ${today}` : `${GATES[kind].already} depuis le ${kind === 'ux' ? plan.uxSince : plan.reviewSince}`);
    return 0;
  }
  if (rest.length < 2) throw new RafError(`usage : raf ${kind} <lot> "verdict"`);
  // Le plan refuse lui-même une sous-tâche, un verdict vide, un lot inconnu.
  const verdict = rest.slice(1).join(' ');
  if (kind === 'ux') plan.recordUx(rest[0], verdict, today);
  // Le verdict vaut jusqu'au dernier commit compté du lot ; un plan en lecture seule refuse sans lire git.
  else plan.recordReview(rest[0], verdict, today, plan.readonly ? null : (lotWork(plan, root, rest[0])[0]?.sha ?? null));
  plan.save();
  return 0;
}

function describe(l: Lot, commits: number): string {
  const bits = [`${l.estimate} j`];
  if (commits) bits.push(`${commits} commit(s)`);
  if (l.tasks.length) bits.push(`sous-tâches ${l.tasks.filter((t) => t.status === 'done').length}/${l.tasks.length}`);
  return `${l.quickwin ? '⚡ ' : ''}${l.id}  ${l.title}  (${bits.join(', ')})`;
}

function now(plan: Plan, root: string, newsDir: string, today: Day, io: Io): number {
  const lots = plan.lots();
  const linked = linkCommits(lots, planCommits(plan, root), plan.refs);
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

  const issues = audit(plan, root, newsDir, today);
  if (issues.length) io.out(`\n${issues.length} écart(s) entre le plan et l'historique — raf check`);
  return 0;
}

function postCommit(load: (() => Plan) | null, newsDir: string, root: string, today: Day, io: Io): number {
  if (!load) return 0;
  try {
    const plan = load();
    const head = readCommits(root, { range: '-1' })[0];
    if (!head) return 0;
    const refs = citedRefs(head, plan.refs);
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
      else if (isRecurring(lot)) io.err(`raf: ${r.lot} est récurrent (${dueLine(lot, today)})${plan.readonly ? '' : ` — raf did ${r.lot}`}`);
      else if (lot.status === 'todo' && !planning) io.err(`raf: ${r.lot} est encore todo${plan.readonly ? '' : ` — raf start ${r.lot}`}`);
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
      io.out(newEntry(dir, args, values.title ?? plan.lot(args[0]).public ?? plan.lot(args[0]).title, today, io.now()));
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
      throw new RafError('usage : cadence news new|list|check|stamp|build');
  }
}

/**
 * Reprise : lignes d'effets à rejouer, ou null quand il n'y a rien à vérifier (sans cadence.yaml, sans deliver,
 * script sans verify) — la reprise reste alors synchrone. Ne lève jamais.
 */
function morningEffects(configPath: string, root: string): Promise<string[]> | string[] | null {
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, 'utf8');
  if (!/^deliver\s*:/m.test(text)) return null;
  try {
    const config = parseDeliverConfig(text, configPath);
    if (config.verify.length === 0) return null;
    const target = defaultTarget(root, config);
    return effectLines(config, target.sha, realCheckDeps(root, { quiet: true }), target.note);
  } catch (e) {
    return [`✗ ${(e as Error).message}`];
  }
}

function session([sub, ...args]: string[], ctx: SessionCtx, values: { since?: string; idle?: string; clear?: boolean }): number {
  switch (sub) {
    case 'start': {
      const idle = values.idle === undefined ? 2 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      return sessionStart(ctx, { since: values.since ?? '24 hours ago', idle });
    }
    case 'close':
      return sessionClose(ctx, { since: values.since ?? `${ctx.today} 00:00` });
    case 'next': {
      const lines = args.filter((l) => l.trim() !== '');
      if (values.clear) {
        if (lines.length) throw new RafError('session next --clear efface les notes : ne pas lui passer de ligne');
        const gone = clearNext(ctx.state);
        ctx.out(gone ? `notes effacées (${gone.lines.length} ligne(s) du ${gone.date})` : 'aucune note à effacer');
        return 0;
      }
      // Lancée sans ligne (variable vide dans un script, agent pressé), la commande effaçait en silence
      // les notes de la dernière clôture : effacer se demande exprès.
      if (lines.length === 0) {
        const kept = readNext(ctx.state);
        throw new RafError(
          `session next : aucune ligne — ${kept ? `${kept.lines.length} ligne(s) du ${kept.date} conservée(s)` : "rien n'est écrit"} ; ` +
            'usage : cadence session next "ligne" … (pour effacer les notes exprès : cadence session next --clear)',
        );
      }
      writeNext(ctx.state, ctx.today, lines);
      return 0;
    }
    default:
      throw new RafError('usage : cadence session start [--since …] [--idle 2] | close [--since …] | next "ligne" … | next --clear');
  }
}
