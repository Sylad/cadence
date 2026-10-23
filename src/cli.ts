import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultPlan, PLAN_DEFAULT, PLAN_LEGACY, readDocsConfig, readHookConfig, readNewsConfig, readOrchestrateConfig, readPerfConfig, readPlanConfig, readSessionConfig } from './config.js';
import { repoSections, repoShas, resolveLotRepos } from './repos.js';
import { audit, exemptPlanOnly, gateProgress, gateText, gateWaiting, hypothesesOf, ownFiles, isPlanOnly, lotWork, nextUp, planCommits, unreviewedWork } from './audit.js';
import { short } from './check.js';
import { isDay, toDay, type Day } from './dates.js';
import { deliver, parseDeliverConfig, realDeps, shellQuote } from './deliver.js';
import { defaultTarget, effectLines, realCheckDeps, verifyCommand } from './verify.js';
import { ganttData, renderGantt } from './gantt.js';
import { gitRoot, isTracked, readCommits, matchesHead, resolveCommit, stage, stagedFiles, syncIndexWithHead } from './git.js';
import { installHook, pendingCommitMessage, REFUSED } from './hook.js';
import { citedRefs, linkCommits } from './link.js';
import { buildNews, loadEntries, newEntry, newsData, newsIssues, publicTitleTooLong, stampEntries } from './news.js';
import { invalidResource, Plan, RafError, SCREENS, STATUSES, type Lot, type Screen, type Status } from './plan.js';
import { dueLine, isRecurring, recurringByDue } from './recurring.js';
import { schedule } from './schedule.js';
import { AGENTS_DIR, installAgents, installSkills, SKILLS_DIR } from './skills.js';
import { findProjects, leadTour, readLeadUx, tourFreeLine, tourLine } from './lead.js';
import { configuredCap, liveLines, orchestrate, realOrchestrateDeps } from './orchestrate/command.js';
import { addHold, releaseHold } from './orchestrate/registry.js';
import { activeLock, REPO_LOCK } from './orchestrate/lock.js';
import { cadenceHome, liveWaves, openLotsIn, openWavesIn, type OpenWave } from './orchestrate/registry.js';
import { classifyAll, measure, ollamaClassifier, readCache, readJournals, readRuns, renderReport, sampleKeys, serializeCache } from './corrections.js';
import { computePerf, perfHeader, perfWindows, readPlans, readProjectDeliveries, readProjectFailedDeliveries, renderPerf, type PerfResult } from './perf.js';
import { findAcceptation, parseAcceptation, resealAcceptation } from './orchestrate/accept.js';
import { refCommand } from './ref/command.js';
import { checkFiche, deriveQa, readFiche, summary } from './spec.js';
import { readHudContext } from './hud-context.js';
import { sessionClose, sessionStart, type SessionCtx } from './session.js';
import { clearNext, readNext, sharedStateDir, stateDir, writeNext } from './state.js';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Avis qui ne sont pas des erreurs (plan hérité, L246) ; absent : `err`. `session --all` y met la vraie sortie d'erreur, pas sa sortie standard. */
  notice?: (line: string) => void;
  now: () => Date;
}

const HELP = `raf — plan « reste à faire » versionné dans le dépôt, relié aux commits

  raf init [--project nom] [--prefix L] [--no-hook]
  raf add "titre" [--estimate j] [--quickwin] [--visible [--screen page|component|journey]] [--spec] [--public "titre public"] [--every jours] [--after L2,L4] [--uses banc,passerelle] [--parent L3]
  raf public <id> "titre public" | --clear   titre du lot dans le langage du public (pages Nouveautés et Plan)
  raf screen <id> page|component|journey|none   pose, remplace ou retire screen: d'un lot visible existant (seule la valeur page adopte l'étape spec d'orchestrate)
  raf spec <id> on|off   pose ou retire spec: d'un lot existant (le lot change un comportement : étape spec back d'orchestrate)
  raf uses <lot> [<ressource>…]   remplace les ressources partagées du lot (uses:, déclarées par resources: dans le cadence.yaml du dossier parent ; raf check refuse un nom non déclaré) ; sans nom, retire la clé
  raf start <id>        raf done <id> [--force]        raf drop <id> [--reason texte]
  raf todo <id> [--reason texte]   remet en attente un lot démarré sans commit de travail (doing → todo, started retiré, note datée) ; refusé s'il a des commits
  raf note <id> "texte"
  raf title <id> "nouveau titre"   remplace le titre d'un lot, de tout statut (done compris), et note l'ancien dans une note datée
  raf did <id> ["texte"]   un lot récurrent (--every) a été refait : le « dû depuis N j » repart de aujourd'hui
  raf ux enable         revue UX obligatoire avant « done » pour les lots --visible
  raf ux <id> "verdict" enregistre la revue d'ergonomie du lot (agent ux-reviewer)
  raf review enable     revue de code obligatoire avant « done » pour les lots qui ont des commits
  raf review <id> "verdict" enregistre la revue de code du lot (agent code-reviewer)
  raf show <id> [--notes]   le lot : statut, dates, after, titre public, notes datées, commits comptés ; --notes : les notes seules
  raf commits <id>      les commits du lot que compte la porte de revue de code, du plus ancien au plus récent
  raf now               ce qui est en cours, la suite, les derniers terminés
  raf list [--status todo|doing|done|dropped]
  raf check [--since date] [--idle 7]   (défaut : date « since » du plan) code 1 s'il y a des écarts
  raf ignore <sha> | "<sujet exact>" [--reason texte]   acquitte un commit sans lot (ou citant un id inconnu) sans réécrire l'historique ; raf check --ignored les liste
  raf gantt [-o .cadence/gantt.html]
  raf hook install      (pre-commit et post-commit ; cadence.yaml hook.autostart: warn|refuse|start)
  cadence orchestrate <projet>:<lot>[@modèle]… [--budget 2M] [--goal "…"] [--dry-run] [--wave nom] [--continue [--until HH:MM] [--priority a,b]]   une session claude neuve par étape ; --status [vague] [--watch [--interval s]] ; --resume [vague] [--budget 1M] [--budget projet:lot=+300k] [--answer projet:lot "réponse"] [--drop projet:lot] ; --drop projet:lot [--wave vague] ; --stop-after-current [--wave vague] ; --waits [--since AAAA-MM-JJ]
  cadence lead tour [dossier] [--idle 3] [--depth n] [--json]   le tableau du lead, sans modèle : une ligne par sous-dossier qui a un plan, ou la ligne du dossier seul s'il est lui-même un projet (en cours, dérive, notes de clôture, prochain lot prêt, dépôt), précédées de l'en-tête perf : une ligne par ⚠ de cadence perf, rien si tout est stable
  cadence lead hold <étiquette> [--ttl minutes] | lead release <étiquette>   déclare (60 min par défaut), puis rend, une session lancée à la main par le lead : elle est soustraite des créneaux libres de orchestrate --status et de lead tour
  cadence corrections [dossier] [--classify [--model m]] [--cache fichier] [--sample n] [--until date] [--since date] [--json]   mesure des passes de correction des journaux dossier/.cadence/runs : lots à ≥1 et ≥2 corrections, par projet, visibles ou non, passes par cause (classées par Ollama avec --classify, hors quota)
  cadence perf [dossier] [--since date] [--json]   tableau de bord du workflow, sans modèle : deux fenêtres (7 derniers jours contre les 7 précédents) lues dans dossier/.cadence/runs et les plans, chaque vitesse à côté de sa qualité, ⚠ au-delà de 25 % de dégradation ; tokens par lot selon l'estimate, part de la revue, délais création → done → livraison, durée de mur par étape, coût en euros par lot livré (grille cadence.yaml perf.prices) ; --since est un jour qui tronque les fenêtres
  cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]   enregistre un document de référence hors du dépôt (references.dir de cadence.yaml, sinon $XDG_DATA_HOME/cadence/references) : pages rendues à 200 dpi, texte positionné, images incluses, index des figures et des passages qui les citent ; exige poppler, ImageMagick et tesseract (outil absent nommé avec sa commande, code 2)
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
Le plan est .cadence/raf.yaml (versionné, jamais publié avec docs/ ; un docs/plan/raf.yaml hérité reste lu, raf propose le git mv (mv si git ne le suit pas), avec cd <racine> pour qu'il s'exécute de n'importe quel dossier), ou celui que nomme « plan: » dans cadence.yaml ; un plan tenu par un
autre outil se lit sans migration (correspondance des champs, voir docs/raf.md du paquet @sylad/cadence) et reste en lecture seule.
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

/**
 * La ligne stderr d'un docs/plan/raf.yaml hérité : le déplacement proposé (jamais fait), ou l'avertissement quand .cadence/raf.yaml existe aussi.
 * La commande proposée commence par `cd <racine>` : elle s'exécute telle quelle depuis n'importe quel dossier (et non depuis la racine
 * seulement) et, sous `session --all`, elle nomme le projet dont il s'agit.
 */
function legacyPlanLine(root: string, legacy: 'read' | 'ignored'): string {
  if (legacy === 'ignored') return `raf: ${PLAN_LEGACY} est ignoré : ${PLAN_DEFAULT} existe aussi et fait foi (supprimer ou fusionner l'ancien)`;
  return `raf: ${PLAN_LEGACY} est l'ancien emplacement du plan ; le déplacer : cd ${shellQuote(root)} && mkdir -p ${dirname(PLAN_DEFAULT)} && ${gitRoot(root) && isTracked(root, PLAN_LEGACY) ? 'git mv' : 'mv'} ${PLAN_LEGACY} ${PLAN_DEFAULT}`;
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
      screen: { type: 'string' },
      spec: { type: 'boolean' },
      public: { type: 'string' },
      every: { type: 'string' },
      dir: { type: 'string' },
      title: { type: 'string' },
      after: { type: 'string' },
      uses: { type: 'string' },
      parent: { type: 'string' },
      force: { type: 'boolean' },
      reason: { type: 'string' },
      porteur: { type: 'string' },
      status: { type: 'string' },
      since: { type: 'string' },
      idle: { type: 'string' },
      ttl: { type: 'string' },
      session: { type: 'string' },
      all: { type: 'boolean' },
      depth: { type: 'string' },
      output: { type: 'string', short: 'o' },
      config: { type: 'string' },
      'dry-run': { type: 'boolean' },
      sha: { type: 'string' },
      retry: { type: 'string' },
      clear: { type: 'boolean' },
      ignored: { type: 'boolean' },
      notes: { type: 'boolean' },
      json: { type: 'boolean' },
      classify: { type: 'boolean' },
      model: { type: 'string' },
      cache: { type: 'string' },
      sample: { type: 'string' },
      sections: { type: 'string' },
      slug: { type: 'string' },
      until: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    io.out(HELP);
    return 0;
  }
  if (command !== 'session' && !(command === 'lead' && !values.all) && (values.all || values.depth !== undefined)) throw new RafError(`${values.all ? '--all' : '--depth'} ne va qu'avec session start ou session close`);
  const today: Day = io.env.RAF_TODAY ?? toDay(io.now());
  if (!isDay(today)) throw new RafError(`RAF_TODAY invalide : ${today} (attendu AAAA-MM-JJ)`);
  const root = gitRoot(io.cwd) ?? io.cwd;
  // Le tour parcourt les sous-dossiers (ou, sans sous-projet, prend le dossier lui-même s'il est un projet) : il ne lit pas le plan du dossier courant.
  if (command === 'lead') {
    if (rest[0] === 'hold' || rest[0] === 'release') return leadHold(rest, values.ttl, io);
    if (values.ttl !== undefined) throw new RafError('--ttl ne va qu\'avec lead hold');
    if (rest[0] !== 'tour' || rest.length > 2) throw new RafError('usage : cadence lead tour [dossier] [--idle 3] [--depth n] [--json] | lead hold <étiquette> [--ttl minutes] | lead release <étiquette>');
    const idle = values.idle === undefined ? undefined : Number(values.idle);
    if (idle !== undefined && !(Number.isInteger(idle) && idle >= 0)) throw new RafError(`--idle invalide : ${values.idle}`);
    const depth = values.depth === undefined ? undefined : Number(values.depth);
    if (depth !== undefined && !(Number.isInteger(depth) && depth >= 1)) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
    const parent = resolve(io.cwd, rest[1] ?? '.');
    if (!existsSync(parent)) throw new RafError(`lead tour : dossier introuvable : ${parent}`);
    const rows = leadTour(parent, today, idle, depth);
    if (values.json) io.out(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) io.out(`aucun projet sous ${parent} (.cadence/raf.yaml, docs/plan/raf.yaml ou cadence.yaml avec plan:)`);
    else {
      // L'en-tête perf (L227) : un ⚠ par ligne avant les projets ; un dossier que perf ne lit pas n'en donne pas, et ses avertissements ne sont pas repris.
      try {
        for (const l of perfHeader(readPerf(parent, today, undefined, () => {}))) io.out(l);
      } catch {
        // pas de .cadence/runs, grille de prix mal formée, journaux ou plans illisibles : le tour ne change pas
      }
      for (const r of rows) io.out(tourLine(r));
      // les créneaux libres viennent du registre, le lead les lit au lieu de les calculer (L141)
      const [slots] = liveLines(configuredCap(io.env), io.now());
      if (slots) io.out(slots);
      // en face des créneaux libres, les lots prêts dont aucune ressource n'est prise (L252) ; sans vague en cours ni session tenue par le lead (L255), pas de créneau à remplir : seul --json les donne
      const free = slots ? tourFreeLine(rows) : null;
      if (free) io.out(free);
      // le réglage lead.ux du cadence.yaml du dossier (L197) : le lead lit ici qui pose le verdict UX, au lieu d'ouvrir le fichier
      try {
        if (readLeadUx(parent) === 'lead') io.out('verdict UX : lead (le lead pose raf ux d\'après le rapport du ux-reviewer et les captures ; l\'humain n\'est consulté qu\'en cas de doute)');
      } catch (e) {
        // un cadence.yaml illisible a déjà sa ligne d'erreur en tête de tour
        if (/lead\.ux/.test((e as Error).message)) io.out(`cadence.yaml · ✗ erreur : ${(e as Error).message.replace(/^.*cadence\.yaml : /, '')}`);
      }
    }
    return 0;
  }
  if (command === 'corrections') return corrections(rest, values, io);
  if (command === 'perf') return perf(rest, values, today, io);
  if (command === 'ref') return refCommand(rest, values, root, io);
  // `spec` est aussi un verbe de raf (raf spec <lot> on|off, L186) : seuls check et qa vont à la fiche.
  if (command === 'spec' && (rest[0] === 'check' || rest[0] === 'qa')) return spec(rest, io);
  const reseal = command === 'spec' && rest[0] === 'reseal';
  // --all balaie les sous-dossiers : il ne lit ni le plan ni le cadence.yaml du dossier courant.
  if (command === 'session' && (values.all || values.depth !== undefined)) return sessionAll(rest, values, io);
  // cadence.yaml peut dire où est le plan et, s'il est tenu par un autre outil, comment le lire.
  const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
  // Installer les skills ou le hook ne lit pas le plan : un cadence.yaml fautif ne doit pas l'empêcher.
  const installing = command === 'skills' || (command === 'hook' && rest[0] === 'install');
  const planConfig = installing ? null : readPlanConfig(configPath, root);
  // Le défaut (ni --file, ni RAF_FILE, ni plan:) : .cadence/raf.yaml, ou le docs/plan/raf.yaml hérité, dont le déplacement est proposé sur stderr (L246).
  // --file et RAF_FILE se lisent depuis le dossier courant ; le plan: de cadence.yaml, depuis la racine du dépôt où est ce fichier.
  const chosen = values.file ?? io.env.RAF_FILE ?? planConfig?.path;
  const fallback = chosen === undefined ? defaultPlan(root) : null;
  const planPath = resolve(io.cwd, values.file ?? io.env.RAF_FILE ?? (planConfig?.path !== undefined ? resolve(root, planConfig.path) : fallback!.path));
  if (fallback?.legacy && !installing) (io.notice ?? io.err)(legacyPlanLine(root, fallback.legacy));
  const loadPlan = () => Plan.load(planPath, { ...planConfig?.settings, config: configPath });
  const newsDir = resolve(io.cwd, values.dir ?? join(root, 'docs/nouveautes'));
  // Limite DÉCLARÉE (news.publicTitleMax) : sans clé, seul « raf check » avertit ; avec, la pose d'un titre public est refusée.
  const refuseLongTitle = (text: string, hint = '') => {
    const max = readNewsConfig(configPath).publicTitleMax;
    const m = max === undefined ? null : publicTitleTooLong(text, max);
    if (m) throw new RafError(m + hint);
  };
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
      if (chosen === undefined) {
        mkdirSync(join(root, '.cadence/notes'), { recursive: true });
        writeFileSync(join(root, '.cadence/notes/.gitkeep'), '');
      }
      if (ensureGitignore(root, '.playwright-mcp/')) io.out('.gitignore : .playwright-mcp/');
      if (!values['no-hook'] && gitRoot(io.cwd)) io.out(`hook : ${installHook(io.cwd).path}`);
      return 0;
    }
    case 'add': {
      need(1, 'add "titre"');
      const plan = loadPlan();
      let id: string;
      if (values.parent) {
        if (values.screen !== undefined) throw new RafError('--screen se pose sur un lot, pas sur une sous-tâche');
        if (values.spec) throw new RafError('--spec se pose sur un lot, pas sur une sous-tâche');
        if (values.public !== undefined) throw new RafError('--public se pose sur un lot, pas sur une sous-tâche');
        if (values.every !== undefined) throw new RafError('--every se pose sur un lot, pas sur une sous-tâche');
        if (values.uses !== undefined) throw new RafError(`uses se pose sur un lot, pas sur une sous-tâche : ${values.parent}`);
        id = plan.addTask(values.parent, rest.join(' '));
      } else {
        const estimate = values.estimate === undefined ? undefined : Number(values.estimate);
        if (estimate !== undefined && !(estimate > 0)) throw new RafError(`estimation invalide : ${values.estimate}`);
        const after = values.after ? values.after.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const every = values.every === undefined ? undefined : Number(values.every);
        if (every !== undefined && !(Number.isInteger(every) && every > 0)) throw new RafError(`périodicité invalide : ${values.every} (un nombre entier de jours)`);
        if (values.public !== undefined) refuseLongTitle(values.public);
        const uses = values.uses?.split(',').map((n) => n.trim()).filter(Boolean);
        if (uses?.length === 0) throw new RafError(invalidResource(''));
        id = plan.add(rest.join(' '), today, { estimate, quickwin: values.quickwin, visible: values.visible, screen: values.screen as Screen | undefined, spec: values.spec, public: values.public, every, after, uses });
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
      // Le titre public part au site : un titre au-delà de la limite déclarée y ferait échouer le build.
      if (status === 'done' && !rest[0].includes('/')) {
        const lot = plan.lots().find((l) => l.id === rest[0]);
        // Sans public: d'un lot visible, le site reprend le titre de sa Nouveauté la plus récente.
        const pub = lot?.public ?? (lot?.visible ? loadEntries(newsDir).find((e) => e.lots.includes(lot.id))?.title : undefined);
        if (pub) refuseLongTitle(pub, lot?.public ? '' : ' — titre de la Nouveauté reprise par le site : corriger l\'entrée ou poser raf public');
      }
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
    case 'todo': {
      need(1, 'todo <id> [--reason texte]');
      const plan = loadPlan();
      plan.putBack(rest[0], today, values.reason ?? '', () => lotWork(plan, root, rest[0]).length);
      plan.save();
      io.out(`${rest[0]} → todo`);
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
    case 'title': {
      need(2, 'title <id> "nouveau titre"');
      const plan = loadPlan();
      plan.setTitle(rest[0], rest.slice(1).join(' '), today);
      plan.save();
      return 0;
    }
    case 'uses': {
      need(1, 'uses <lot> [<ressource>…]');
      const plan = loadPlan();
      plan.setUses(rest[0], rest.slice(1));
      plan.save();
      return 0;
    }
    case 'public': {
      need(values.clear ? 1 : 2, 'public <id> "titre public" | public <id> --clear');
      if (values.clear && rest.length > 1) throw new RafError('--clear n\'attend pas de titre');
      const plan = loadPlan();
      if (!values.clear) refuseLongTitle(rest.slice(1).join(' '));
      plan.setPublic(rest[0], values.clear ? null : rest.slice(1).join(' '));
      plan.save();
      return 0;
    }
    case 'screen': {
      need(2, 'screen <id> page|component|journey|none');
      if (rest.length > 2) throw new RafError('usage : raf screen <id> page|component|journey|none');
      const plan = loadPlan();
      if (rest[1] !== 'none' && !(SCREENS as readonly string[]).includes(rest[1])) throw new RafError(`screen inconnu : ${rest[1]} (${SCREENS.join(', ')}, none)`);
      plan.setScreen(rest[0], rest[1] === 'none' ? null : (rest[1] as Screen));
      plan.save();
      return 0;
    }
    case 'spec': {
      if (reseal) return specReseal(rest.slice(1), values.reason, values.porteur, { root, loadPlan, configPath, today }, io);
      if (rest.length !== 2 || (rest[1] !== 'on' && rest[1] !== 'off')) throw new RafError('usage : raf spec <id> on|off (ou cadence spec check|qa <fiche.yaml>)');
      const plan = loadPlan();
      if (!plan.setSpec(rest[0], rest[1] === 'on')) {
        io.out(`${rest[0]} a déjà screen: page — l'écran implique la spec, rien à changer`);
        return 0;
      }
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
      knownLot(plan, id, 'les commits se listent par lot, pas par sous-tâche');
      // Une lecture : le même ensemble que « raf done » et « raf check », plan en lecture seule compris.
      for (const c of lotWork(plan, root, id).reverse()) io.out(short(c));
      for (const line of repoSections(plan, root, plan.lot(id))) io.out(line);
      return 0;
    }
    case 'show': {
      need(1, 'show <lot> [--notes]');
      const plan = loadPlan();
      const lot = knownLot(plan, rest[0], 'show se lit par lot, pas par sous-tâche');
      const notes = lot.notes.map((n) => `${n.date}  ${n.text}`);
      if (values.notes) {
        for (const n of notes) io.out(n);
        return 0;
      }
      io.out(`${lot.id}  ${lot.status}  ${lot.title}`);
      if (lot.goal) io.out(`goal : ${lot.goal}`);
      const dates = [['créé', lot.created], ['démarré', lot.started], [lot.status === 'dropped' ? 'abandonné' : 'terminé', lot.finished]].filter(([, d]) => d);
      if (dates.length) io.out(dates.map(([k, d]) => `${k} : ${d}`).join('  '));
      if (lot.after.length) io.out(`after : ${lot.after.join(', ')}`);
      if (lot.public) io.out(`public : ${lot.public}`);
      if (lot.screen) io.out(`screen : ${lot.screen}`);
      if (lot.spec) io.out('spec : true');
      if (lot.uses) io.out(`uses : ${lot.uses.join(', ')}`);
      const gate = gateProgress(plan.lots(), lot);
      if (lot.gate && gate) io.out(lot.gate.invalid ? `gate : ${gateText(gate)}` : `gate : ${gate.n} lots ${gate.label} faits`);
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
    case 'ignore': {
      need(1, 'ignore <sha> | "<sujet exact>" [--reason texte]');
      if (rest.length > 1) throw new RafError('un seul commit attendu ; la raison se passe par --reason "texte"');
      const plan = loadPlan();
      const arg = rest[0];
      const commits = planCommits(plan, root);
      // Un sujet exact l'emporte sur un nom de ref homonyme (`other` à la fois sujet et branche).
      const sha = commits.some((c) => c.subject === arg) ? null : resolveCommit(root, arg);
      const found = sha ? commits.find((c) => c.sha === sha) : commits.find((c) => c.subject === arg);
      if (!found) throw new RafError(`aucun commit ne correspond à « ${arg} » (sha ou sujet exact)`);
      // Un sha est exact ; un sujet vaut pour tous les commits qui le portent.
      const bySha = sha !== null;
      plan.acknowledge({ ...(bySha ? { sha: found.sha, subject: found.subject } : { subject: found.subject }), date: today, ...(values.reason ? { reason: values.reason } : {}) });
      plan.save();
      io.out(`${bySha ? short(found) : found.subject} acquitté`);
      return 0;
    }
    case 'check': {
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
      if (rest[0] === 'post-commit') return postCommit(existsSync(planPath) ? loadPlan : null, newsDir, root, today, io, readHookConfig(configPath).autostart);
      if (rest[0] === 'pre-commit') return preCommit(existsSync(planPath) ? loadPlan : null, readHookConfig(configPath).autostart, root, today, io);
      throw new RafError('usage : raf hook install|pre-commit|post-commit');
    }
    case 'session': {
      // Le contexte de la session ne dépend d'aucun dépôt : le lead le lit depuis le dossier parent.
      if (rest[0] === 'context') return sessionContext(io, values.session);
      if (!gitRoot(io.cwd)) throw new RafError('session : à lancer dans un dépôt git');
      // « next » n'écrit que les notes : la commande du projet ne se joue qu'à la reprise et à la clôture.
      const sconf = rest[0] === 'start' || rest[0] === 'close' ? readSessionConfig(configPath) : {};
      const facts = rest[0] === 'start' || rest[0] === 'close' ? sconf[rest[0]] : undefined;
      const clean = rest[0] === 'close' && sconf.clean ? { patterns: sconf.clean, days: sconf.cleanDays } : undefined;
      const sctx: SessionCtx = { plan: loadPlan(), root, newsDir, state: stateDir(root), shared: sharedStateDir(root), today, now: io.now(), out: io.out, facts, clean };
      if (rest[0] !== 'start') return session(rest, sctx, values);
      // La reprise rejoue les vérifications d'effet (un essai, borné) : un effet rouge d'hier se lit avec les faits du matin.
      const effects = morningEffects(configPath, root);
      if (effects === null) return session(rest, sctx, values);
      return Promise.resolve(effects).then((lines) => session(rest, { ...sctx, effects: lines }, values));
    }
    case 'deliver': {
      if (!gitRoot(io.cwd)) throw new RafError('deliver : à lancer dans un dépôt git');
      const orchestrating = waveHolding(root);
      if (orchestrating) throw new RafError(`deliver : orchestration en cours (vague ${orchestrating.wave}, pid ${orchestrating.pid}) — livrer une fois les lots de ce dépôt finis (le verrou tombe dès que tous sont prêts ou rendus)`);
      if (!existsSync(configPath)) throw new RafError(`pas de configuration de livraison : ${configPath} (voir « cadence.yaml » dans docs/deliver.md du paquet @sylad/cadence)`);
      const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
      const plan = existsSync(planPath) ? loadPlan() : null;
      const articles = readDocsConfig(configPath).articles;
      // Sans public: d'un lot visible, le site reprend le titre de sa Nouveauté la plus récente.
      const publicTitle = (lot: Lot) => lot.public ?? (lot.visible ? loadEntries(newsDir).find((e) => e.lots.includes(lot.id))?.title : undefined);
      const ctx = { root, state: sharedStateDir(root), plan, config, today, dryRun: !!values['dry-run'], sha: values.sha, args: rest, articles, publicTitle, out: io.out, err: io.err };
      return deliver(ctx, realDeps(root));
    }
    case 'verify': {
      if (!gitRoot(io.cwd)) throw new RafError('verify : à lancer dans un dépôt git');
      if (!existsSync(configPath)) throw new RafError(`pas de configuration : ${configPath} (voir « cadence.yaml » dans docs/deliver.md du paquet @sylad/cadence)`);
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
      return news(rest, loadPlan(), newsDir, today, values, io, refuseLongTitle, () => hypothesesOf(root, configPath));
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
  else {
    // Les dépôts voisins du lot : un dépôt qu'on ne peut pas lire ferait enregistrer un verdict sur un sha non lu.
    const neighbours = plan.readonly || rest[0].includes('/') ? undefined : resolveLotRepos(root, plan.lots().find((l) => l.id === rest[0]) ?? {});
    if (neighbours?.problems.length) throw new RafError(`${neighbours.problems.join(' ; ')} — la revue de code relit aussi les dépôts du lot`);
    plan.recordReview(rest[0], verdict, today, plan.readonly ? null : (lotWork(plan, root, rest[0])[0]?.sha ?? null), neighbours?.repos.length ? repoShas(plan, neighbours.repos, rest[0]) : undefined);
  }
  plan.save();
  return 0;
}

function knownLot(plan: Plan, id: string, subtask: string): Lot {
  const lot = plan.lots().find((l) => l.id === id);
  if (!lot) throw new RafError(id.includes('/') ? `${subtask} : ${id}` : `lot inconnu : ${id}`);
  return lot;
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
  const gated = gateWaiting(lots, blocked);
  const byDeps = blocked.filter((l) => !gated.some((g) => g.lot === l));
  if (byDeps.length) io.out(`  en attente de dépendances : ${byDeps.map((l) => l.id).join(', ')}`);
  if (gated.length) io.out(`  en attente de condition de tirage : ${gated.map((g) => `${g.lot.id} (${g.text})`).join(', ')}`);

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

/**
 * Pre-commit : un commit qui cite un lot encore todo. `warn` (défaut) : rien ici, le post-commit avertit ; `refuse` :
 * échoue (REFUSED) avec « raf start <id> » ; `start` : démarre le lot et met le plan dans l'index, donc dans CE commit,
 * mais seulement si le plan est identique à HEAD : sinon rien n'est démarré (message, puis avertissement du post-commit).
 * Ne rend REFUSED que pour un refus : toute autre panne laisse le commit passer. Sans message lisible (éditeur), rien.
 */
function preCommit(load: (() => Plan) | null, mode: 'warn' | 'refuse' | 'start' | undefined, root: string, today: Day, io: Io): number {
  if (!load || !mode || mode === 'warn') return 0;
  try {
    const message = pendingCommitMessage(io.env);
    if (message === null) return 0;
    const plan = load();
    const [subject = '', ...body] = message.split('\n');
    const refs = citedRefs({ sha: '', day: today, subject, body: body.join('\n').trim() }, plan.refs);
    const staged = stagedFiles(root);
    const own = ownFiles(plan, root);
    // Entretien du plan : tous les fichiers du commit sont ceux du plan (la configuration seule ne compte pas).
    if (staged.length > 0 && staged.every((f) => own.has(f) && f !== relative(root, plan.configFile ?? join(root, 'cadence.yaml')))) return 0;
    const todo = [...new Set(refs.map((r) => r.lot))].filter((id) => {
      const lot = plan.lots().find((l) => l.id === id);
      return lot?.status === 'todo' && !isRecurring(lot);
    });
    if (todo.length === 0) return 0;
    if (mode === 'refuse') {
      for (const id of todo) io.err(`raf: ${id} est encore todo — commit refusé (hook.autostart: refuse)${plan.readonly ? '' : ` : raf start ${id}`} (--no-verify pour passer outre)`);
      return REFUSED;
    }
    if (plan.readonly) return 0;
    const file = relative(root, plan.path);
    // Un plan déjà modifié (stagé ou non) : le restager emporterait ces modifications dans ce commit, ou, sur un
    // commit partiel, les perdrait. On ne démarre rien ; le post-commit avertit comme en mode warn.
    if (!matchesHead(root, file)) {
      io.err(`raf: plan modifié non commité : démarrage automatique sauté (hook.autostart: start), raf start ${todo.join(' ')} à la main`);
      return 0;
    }
    for (const id of todo) {
      plan.setStatus(id, 'doing', today, {});
      io.err(`raf: ${id} était todo — raf start ${id} fait par le hook, plan inclus dans ce commit`);
    }
    plan.save();
    stage(root, file);
  } catch {
    // Un hook ne doit jamais gêner un commit, hors refus.
  }
  return 0;
}

function postCommit(load: (() => Plan) | null, newsDir: string, root: string, today: Day, io: Io, mode?: 'warn' | 'refuse' | 'start'): number {
  if (!load) return 0;
  try {
    const plan = load();
    if (mode === 'start' && !plan.readonly) syncIndexWithHead(root, relative(root, plan.path));
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

/** La vague qui tient le verrou du dépôt tant qu'un de ses lots y travaille encore (état illisible : on la tient pour active) ; null si le dépôt est libre. Partagé par `deliver` et `spec reseal`. */
function waveHolding(root: string): { wave: string; pid: number } | null {
  const orchestrating = activeLock(join(sharedStateDir(root), REPO_LOCK));
  if (!orchestrating) return null;
  const stillOpen = openLotsIn(cadenceHome(), orchestrating.pid, root);
  return stillOpen === null || stillOpen.length > 0 ? orchestrating : null;
}

/**
 * `cadence spec reseal <lot> <test> --reason texte` (L200) : le chemin du lead quand un test d'acceptation scellé du lot EN COURS contredit la fiche.
 * Le test est corrigé dans l'arbre de travail (fiche inchangée, ou amendée et commitée par des commits du lot, L217) ; la commande refait l'empreinte de ce seul test, journalise la raison dans
 * acceptation.json, commite test + acceptation (le nouveau commit rouge), et note la raison au lot. Le verrou garde tout le reste.
 */
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Chemin à coller dans un shell : entre apostrophes dès qu'il contient autre chose que des caractères sûrs. */
const shellPath = (p: string): string => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/** Le refus de `spec reseal` devant des vagues non terminées (L238) : chaque vague (vivante ou arrêtée), son dossier de lancement, ses lots, et pour chaque vague arrêtée UNE commande à lancer telle quelle (un `--drop` par lot ouvert du dépôt, y compris ceux en file qui ne sont pas en cours au plan : `--resume` relance toute la vague avec les lots non retirés, et un lot en file reprendrait le verrou, L239). */
function openWavesRefusal(open: OpenWave[]): string {
  const lines = open.map((w) => {
    const where = [w.live ? 'vivante' : 'arrêtée', ...(w.live && w.pid !== undefined ? [`pid ${w.pid}`] : []), ...(w.launchDir ? [`lancée depuis ${w.launchDir}`] : [])].join(', ');
    return `  - vague ${w.wave} (${where}) : ${w.lots.length ? [...w.lots.map((l) => `${l.key} (${l.status})`), ...w.others.map((l) => `${l.key} (${l.status}, pas en cours au plan)`)].join(', ') : 'lots illisibles'}`;
  });
  const how = open.map((w) =>
    w.live
      ? `  vague ${w.wave} : orchestration en cours, à attendre (le verrou du dépôt tombe dès que tous ses lots y sont prêts ou rendus)`
      : `  cd ${shellPath(w.launchDir)} && cadence orchestrate --resume ${w.wave}${[...w.lots, ...w.others].map((l) => ` --drop ${l.key}`).join('')}`,
  );
  return [
    `spec reseal : refusé — ${open.length > 1 ? `${open.length} vagues non terminées gardent` : 'une vague non terminée garde'} ouvert au moins un lot en cours de ce dépôt (un rescellé commité maintenant lui serait rendu comme « premier commit fautif » à la reprise de la vague) :`,
    ...lines,
    'Marche à suivre : clore chacun de ces lots dans sa vague (attendre les vivantes, retirer les lots des arrêtées), puis relancer le rescellé :',
    ...how,
  ].join('\n');
}

/**
 * Les vagues non terminées qui gardent ouvert un lot de `repo` encore en cours au plan (L238). Une vague range son état dans le dossier d'où elle a été lancée (`RunStore.runsDir(cwd)`),
 * souvent un dossier PARENT du dépôt (le dossier des projets) : on remonte donc de la racine du plan jusqu'à la racine du disque.
 */
function unfinishedWaves(root: string, repo: string, plan: Plan): OpenWave[] {
  const launchDirs = new Set<string>();
  for (let d = resolve(root); !launchDirs.has(d); d = dirname(d)) launchDirs.add(d);
  launchDirs.add(repo);
  const doing = new Set(plan.lots().filter((l) => l.status === 'doing').map((l) => l.id));
  const alive = liveWaves(cadenceHome());
  return [...launchDirs].flatMap((dir) => openWavesIn(dir, repo, (l) => doing.has(l.lot), alive));
}

/** La vague qui tient le verrou du dépôt rejoint la liste des vagues en cause, même quand l'état de ses lots ne dit rien (illisible, ou lots absents du plan) : le refus est unique et la nomme toujours. */
function withHolder(open: OpenWave[], holder: { wave: string; pid: number }, repo: string): OpenWave[] {
  const known = open.find((w) => w.wave === holder.wave);
  if (known) return open.map((w) => (w === known ? { ...w, live: true, pid: holder.pid } : w));
  const reg = liveWaves(cadenceHome()).find((w) => w.pid === holder.pid);
  const keys = openLotsIn(cadenceHome(), holder.pid, repo) ?? [];
  return [{ wave: holder.wave, launchDir: reg?.cwd ?? '', live: true, pid: holder.pid, lots: keys.map((key) => ({ key, status: 'ouvert' })), others: [] }, ...open];
}

function specReseal(args: string[], reason: string | undefined, porteur: string | undefined, ctx: { root: string; loadPlan: () => Plan; configPath: string; today: Day }, io: Io): number {
  if (args.length !== 2 || !reason?.trim()) throw new RafError('usage : cadence spec reseal <lot> <test> --reason "pourquoi le test contredit la fiche" [--porteur <lot en cours>, pour un lot livré]');
  if (io.env.CADENCE_ORCHESTRATED) throw new RafError(`spec reseal refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead, hors session`);
  // Comme `deliver` : la vague tient le verrou du dépôt tant qu'un de ses lots y travaille (état illisible : on refuse) ; un commit du lead en pleine passe ferait signaler au lot suivant un écart qui n'est pas le sien.
  // Le refus est UN message : la vague vivante qui tient le verrou (à attendre) et les vagues arrêtées du dépôt, avec leurs dossiers et leurs commandes (L238).
  const orchestrating = waveHolding(ctx.root);
  if (orchestrating) {
    const repo = gitRoot(ctx.root) ?? ctx.root;
    let open: OpenWave[] = [];
    try {
      open = unfinishedWaves(ctx.root, repo, ctx.loadPlan());
    } catch {
      // plan illisible : le verrou seul motive le refus, la vague qui le tient est nommée
    }
    throw new RafError(openWavesRefusal(withHolder(open, orchestrating, repo)));
  }
  const [lotId, test] = args as [string, string];
  const plan = ctx.loadPlan();
  const lot = plan.lot(lotId);
  const repo = gitRoot(ctx.root) ?? ctx.root;
  const dir = readOrchestrateConfig(ctx.configPath).spec.dir;
  const json = findAcceptation(repo, dir, lotId);
  // Un lot livré (acceptation verte) se rescelle pour un test instable dont le contrat ne change pas : le lot en cours qui porte la correction est nommé (--porteur) et cité dans le commit.
  const livre = lot.status !== 'doing' && !!json && ((a) => typeof a !== 'string' && a.vert)(parseAcceptation(readFileSync(join(repo, json), 'utf8')));
  if (lot.status !== 'doing' && !livre) throw new RafError(`${lotId} n'est pas en cours (${lot.status}) : le rescellé vaut pour le lot en cours, ou pour un lot livré dont l'acceptation est verte (vert: true) avec --porteur <lot en cours>`);
  if (porteur && lot.status === 'doing') throw new RafError(`--porteur n'a de sens que pour un lot livré : ${lotId} est en cours, son rescellé est cité sous son propre id`);
  if (livre && !porteur?.trim()) throw new RafError(`${lotId} est livré : --porteur <lot en cours> est obligatoire (le lot dont le commit porte la correction du test)`);
  if (livre && porteur) {
    if (porteur === lotId) throw new RafError(`--porteur doit être un autre lot que ${lotId} (le lot livré est clos)`);
    const carrier = plan.lot(porteur);
    if (carrier.status !== 'doing') throw new RafError(`--porteur ${porteur} n'est pas en cours (${carrier.status}) : le lot porteur est celui dont le commit porte la correction`);
  }
  const cite = livre ? (porteur as string) : lotId;
  if (!json) throw new RafError(`${lotId} : aucune acceptation sous ${dir} (le lot n'a pas passé l'étape accept)`);
  // Une vague non terminée (arrêtée sur une question ou le quota) garde ouverts des lots que son `--resume` rejouera : un rescellé commité entre-temps serait rendu à l'un d'eux comme « premier commit fautif » (L238).
  // Le verrou du rescellé couvre tous les lots ouverts du dépôt, pas seulement le porteur : on refuse dès qu'un lot DE CE DÉPÔT, encore en cours au plan, reste ouvert dans une vague non terminée.
  const open = unfinishedWaves(ctx.root, repo, plan);
  if (open.length) throw new RafError(openWavesRefusal(open));
  const before = { json: readFileSync(join(repo, json), 'utf8'), test: existsSync(join(repo, test)) ? readFileSync(join(repo, test), 'utf8') : '' };
  let r: { avant: string; apres: string; ficheAmendee?: string };
  try {
    r = resealAcceptation(repo, json, test, reason, ctx.today, livre ? porteur : undefined, plan.refs, plan.lots().filter((l) => l.status === 'done').map((l) => l.id));
  } catch (e) {
    throw new RafError((e as Error).message);
  }
  const norm = posix.normalize(test);
  try {
    git(repo, ['add', '--', json, norm]);
    git(repo, ['commit', '-q', '-m', `test(${cite}): acceptation rescellée${livre ? ` du lot livré ${lotId}` : ''}, ${norm} : ${reason.trim()}${r.ficheAmendee ? ` (fiche amendée en ${r.ficheAmendee})` : ''}`, '--', json, norm]);
  } catch (e) {
    // Atomique : un commit refusé (hook pre-commit, ...) ne laisse ni empreinte refaite ni index à moitié prêt ; le test retrouve le texte du lead.
    writeFileSync(join(repo, json), before.json);
    writeFileSync(join(repo, norm), before.test);
    try {
      git(repo, ['reset', '-q', '--', json, norm]);
    } catch {
      // rien d'indexé : rien à défaire
    }
    const out = e as { stderr?: string; stdout?: string; message: string };
    throw new RafError(`spec reseal : le commit du rescellé a échoué, ${json} et ${norm} sont revenus tels qu'avant la commande (rien n'est rescellé) — ${(out.stderr || out.stdout || out.message).trim().split('\n').slice(-5).join(' | ')}`);
  }
  const sha = git(repo, ['rev-parse', '--short', 'HEAD']).trim();
  // Un plan tenu par un autre outil ne se modifie pas d'ici : la raison est déjà dans acceptation.json et dans le commit, la note reste à la main du lead.
  if (plan.readonly) {
    io.out(`${lotId} : ${norm} rescellé (${r.avant.slice(0, 7)} → ${r.apres.slice(0, 7)}), commit ${sha}${r.ficheAmendee ? `, fiche amendée en ${r.ficheAmendee}` : ''} ; raison dans ${json} et dans le commit — note à ajouter au lot ${cite} avec l'outil du projet (plan en lecture seule)`);
    return 0;
  }
  plan.note(cite, `test d'acceptation rescellé${livre ? ` (lot livré ${lotId}, ` : ' ('}${norm}, ${r.ficheAmendee ? `fiche amendée en ${r.ficheAmendee}` : 'fiche inchangée'}) : ${reason.trim()}`, ctx.today);
  plan.save();
  // La note du lot rejoint le dépôt dans la foulée (un dépôt sale arrêterait la vague suivante) ; un plan hors du dépôt ou non suivi reste à la main du lead.
  const planRel = relative(repo, plan.path);
  const tracked = !planRel.startsWith('..') && git(repo, ['ls-files', '--', planRel]).trim() !== '';
  if (tracked) {
    try {
      git(repo, ['add', '--', planRel]);
      git(repo, ['commit', '-q', '-m', `plan: ${cite} test d'acceptation rescellé (${norm})`, '--', planRel]);
    } catch (e) {
      // Le rescellé est fait (commit ${sha}) : on ne le défait pas, on dit où en est la note, au lieu d'une pile d'appels.
      const out = e as { stderr?: string; stdout?: string; message: string };
      throw new RafError(`spec reseal : le rescellé a eu lieu (commit ${sha}) mais le commit de la note du lot a échoué — la note est écrite dans ${planRel}, à commiter à la main (un plan sale arrêterait la vague suivante) — ${(out.stderr || out.stdout || out.message).trim().split('\n').slice(-5).join(' | ')}`);
    }
  }
  io.out(`${lotId} : ${norm} rescellé (${r.avant.slice(0, 7)} → ${r.apres.slice(0, 7)}), commit ${sha}${r.ficheAmendee ? `, fiche amendée en ${r.ficheAmendee}` : ''} ; raison dans ${json} et en note du lot ${cite}${tracked ? '' : ' (plan à commiter)'}`);
  return 0;
}

/** Durée par défaut (minutes) d'une session du lead inscrite par `lead hold` : de quoi finir un correctif ou une revue, pas de quoi oublier la réservation toute la journée. */
const HOLD_TTL_MINUTES = 60;

/** Longueur maximale de l'étiquette encodée : un nom de fichier tient en 255 octets, `.json.tmp` en prend 9. */
const HOLD_LABEL_MAX = 200;

/** `cadence lead hold <étiquette> [--ttl minutes]` / `lead release <étiquette>` (L255) : inscrit, ou rend, une session lancée à la main par le lead, qui compte dans les créneaux libres. */
function leadHold(rest: string[], ttl: string | undefined, io: Io): number {
  const [verb, label] = rest;
  const usage = verb === 'hold' ? 'usage : cadence lead hold <étiquette> [--ttl minutes]' : 'usage : cadence lead release <étiquette>';
  if (rest.length !== 2 || !label!.trim()) throw new RafError(usage);
  if (verb === 'release') {
    if (ttl !== undefined) throw new RafError(`--ttl ne va qu'avec lead hold (${usage})`);
    io.out(releaseHold(cadenceHome(), label!) ? `session « ${label} » rendue` : `aucune session « ${label} » inscrite`);
    return 0;
  }
  // le nom de fichier encode l'étiquette (6 octets par lettre accentuée) : au-delà, le système de fichiers refuse (ENAMETOOLONG)
  if (encodeURIComponent(label!).length > HOLD_LABEL_MAX) throw new RafError(`étiquette trop longue (${usage})`);
  const minutes = ttl === undefined ? HOLD_TTL_MINUTES : Number(ttl);
  if (!(Number.isInteger(minutes) && minutes >= 1)) throw new RafError(`--ttl invalide : ${ttl} (un nombre entier de minutes ≥ 1)`);
  addHold(cadenceHome(), label!, minutes, io.now());
  io.out(`session « ${label} » inscrite pour ${minutes} min : elle compte dans les créneaux libres (cadence lead release « ${label} » à sa fin)`);
  return 0;
}

/** `cadence spec check|qa <fiche>` (L170) : code 0 valide, 1 écarts, 2 usage ou fichier illisible. `qa` imprime la section expectations.md de l'écran. */
function spec(rest: string[], io: Io): number {
  const sub = rest[0];
  if ((sub !== 'check' && sub !== 'qa') || rest.length !== 2) throw new RafError('usage : cadence spec check|qa <fiche.yaml>');
  const doc = readFiche(resolve(io.cwd, rest[1]!));
  const problems = checkFiche(doc);
  if (sub === 'qa') {
    // les écarts vont sur la sortie d'erreur : la sortie standard est la section, qu'on redirige vers le fichier
    for (const m of problems) io.err(`✗ ${m}`);
    if (problems.length > 0) return 1;
    io.out(deriveQa(doc).trimEnd());
    return 0;
  }
  for (const m of problems) io.out(`✗ ${m}`);
  if (problems.length > 0) {
    io.out(`${problems.length} écart(s)`);
    return 1;
  }
  io.out(summary(doc as Record<string, unknown>));
  return 0;
}

/** `cadence corrections` (L165) : la mesure de référence des passes de correction d'une vague, lue dans <dossier>/.cadence/runs. */
async function corrections(rest: string[], values: { classify?: boolean; model?: string; cache?: string; sample?: string; until?: string; since?: string; json?: boolean }, io: Io): Promise<number> {
  if (rest.length > 1) throw new RafError('usage : cadence corrections [dossier] [--classify [--model m]] [--cache fichier] [--sample n] [--until date] [--since date] [--json]');
  const parent = resolve(io.cwd, rest[0] ?? '.');
  const runsDir = join(parent, '.cadence', 'runs');
  if (!existsSync(runsDir)) throw new RafError(`corrections : aucun journal de vague dans ${runsDir}`);
  const sample = values.sample === undefined ? undefined : Number(values.sample);
  if (sample !== undefined && !(Number.isInteger(sample) && sample > 0)) throw new RafError(`--sample invalide : ${values.sample}`);
  if (values.until !== undefined && Number.isNaN(Date.parse(values.until))) throw new RafError(`--until invalide : ${values.until} (une date ISO, ex. 2026-10-10T18:31Z)`);
  if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) throw new RafError(`--since invalide : ${values.since} (une date ISO, ex. 2026-10-10T18:31Z)`);
  const model = values.model ?? 'mistral-small3.2:24b';
  const cacheFile = resolve(io.cwd, values.cache ?? join(parent, '.cadence', 'corrections.json'));
  const data = readRuns(runsDir, values.until, values.since);
  const cache = readCache(cacheFile);
  if (values.classify) {
    const classify = ollamaClassifier({ url: io.env.OLLAMA_HOST ?? 'http://localhost:11434', model });
    await classifyAll(data.passes, cache, classify, model, (done, total) => {
      if (done % 25 === 0 || done === total) io.err(`classement : ${done}/${total}`);
    }, { every: 10, save: () => writeFileSync(cacheFile, serializeCache(cache)) });
    writeFileSync(cacheFile, serializeCache(cache));
  }
  if (sample !== undefined) {
    const byKey = new Map(data.passes.map((p) => [p.key, p]));
    // Une passe sans constat (tests rouges) n'a rien à relire : elle ne fait pas partie de l'échantillon.
    for (const key of sampleKeys(data.passes.filter((p) => p.findings.length > 0).map((p) => p.key), sample)) {
      const p = byKey.get(key)!;
      io.out(`## ${key} (${p.project} ${p.lot}) · modèle : ${cache.get(key)?.cause ?? 'non classé'}${cache.get(key)?.manual ? ` · relu : ${cache.get(key)!.manual}` : ''}`);
      for (const f of p.findings) io.out(`- ${f}`);
      for (const c of p.commits) io.out(`  commit : ${c}`);
      io.out('');
    }
    return 0;
  }
  const m = measure(data, cache);
  io.out(values.json ? JSON.stringify(m, null, 2) : renderReport(m));
  return 0;
}

/**
 * `cadence perf` (L225) : le tableau de bord du workflow, sans modèle ni écriture, lu dans <dossier>/.cadence/runs et les plans des projets du dossier.
 * Une erreur de saisie ou de lecture sort avec le code 1 (un ⚠ imprimé, 0). `--since` y est un jour qui tronque les fenêtres, non l'instant de `corrections --since`.
 */
/** `cadence perf` sur un dossier : lecture seule, une RafError dit pourquoi le dossier n'est pas lisible ; `warn` reçoit les avertissements (stderr de perf). */
function readPerf(parent: string, today: Day, since: string | undefined, warn: (line: string) => void): PerfResult {
  // La grille se lit avant tout journal : une grille mal formée refuse la commande sans sortie partielle (R7).
  const prices = readPerfConfig(join(parent, 'cadence.yaml'));
  const runsDir = join(parent, '.cadence', 'runs');
  if (!existsSync(runsDir)) throw new RafError(`perf : aucun journal de vague dans ${runsDir}`);
  const cache = readCache(join(parent, '.cadence', 'corrections.json'));
  const journals = readJournals(runsDir);
  const warnings: string[] = [];
  const plans = readPlans(parent, (l) => warnings.push(l));
  if (plans.size === 0 && warnings.length === 0) warnings.push(`perf : aucun plan sous ${parent}, indicateurs du plan n/d`);
  const deliveries = readProjectDeliveries(parent, [...plans.keys()]);
  const failedDeliveries = readProjectFailedDeliveries(parent, [...plans.keys()]);
  const result = computePerf({ journals, plans, cache, deliveries, failedDeliveries, prices, windows: perfWindows(today, since), today, since });
  if (!prices) warnings.push('perf : aucune grille de prix (cadence.yaml perf.prices), coût en euros n/d');
  for (const [model, lots] of Object.entries(result.cost.withoutPrice)) warnings.push(`perf : modèle sans prix dans perf.prices : ${model}, coût n/d pour ${lots} lot(s)`);
  warnings.forEach(warn);
  return result;
}

function perf(rest: string[], values: { since?: string; json?: boolean }, today: Day, io: Io): number {
  try {
    if (rest.length > 1) throw new RafError('usage : cadence perf [dossier] [--since date] [--json]');
    if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) throw new RafError(`--since invalide : ${values.since} (une date ISO, ex. 2026-10-10T18:31Z)`);
    const parent = resolve(io.cwd, rest[0] ?? '.');
    const result = readPerf(parent, today, values.since, io.err);
    if (values.json) io.out(JSON.stringify(result, null, 2));
    else for (const l of renderPerf(result)) io.out(l);
    return 0;
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    io.err(`raf: ${e.message}`);
    return 1;
  }
}

/** `session start|close --all [--depth n]` : la commande jouée dans chaque projet sous le dossier courant, une section par projet. */
async function sessionAll(rest: string[], values: { all?: boolean; depth?: string; since?: string; idle?: string; file?: string; config?: string }, io: Io): Promise<number> {
  const sub = rest[0];
  if (!values.all) throw new RafError('--depth demande --all');
  // Chaque projet lit son propre plan : un plan ou une config imposés se retrouveraient dans toutes les sections.
  const imposed = values.file !== undefined ? '--file' : values.config !== undefined ? '--config' : io.env.RAF_FILE !== undefined ? 'RAF_FILE' : null;
  if (imposed) throw new RafError(`${imposed} ne va pas avec --all : chaque projet lit son propre plan (lancer la commande dans le projet visé)`);
  if (sub !== 'start' && sub !== 'close') throw new RafError('--all ne va qu\'avec session start ou session close');
  const depth = values.depth === undefined ? 1 : Number(values.depth);
  if (!Number.isInteger(depth) || depth < 1) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
  if (values.idle !== undefined && !(Number.isInteger(Number(values.idle)) && Number(values.idle) >= 0)) throw new RafError(`--idle invalide : ${values.idle}`);
  const projects = findProjects(io.cwd, depth);
  if (projects.length === 0) {
    io.out(`aucun projet sous ${io.cwd} (.cadence/raf.yaml, docs/plan/raf.yaml ou cadence.yaml avec plan:)`);
    return 0;
  }
  const argv = ['session', sub, ...(values.since === undefined ? [] : [`--since=${values.since}`]), ...(values.idle === undefined ? [] : ['--idle', values.idle])];
  let worst = 0;
  for (const dir of projects) {
    io.out(`${dir === projects[0] ? '' : '\n'}## ${relative(io.cwd, dir)}`);
    let code: number;
    const top = gitRoot(dir);
    if (top && realpathSync(top) !== realpathSync(dir)) {
      // run() lirait le plan du dépôt parent : mieux vaut le dire que montrer le plan d'un autre projet.
      io.out(`✗ ${relative(io.cwd, dir)} n'a pas son propre dépôt git (dépôt parent : ${top}) — lancer cadence dans ce dossier`);
      worst = 2;
      continue;
    }
    try {
      code = await run(argv, { ...io, cwd: dir, err: (l) => io.out(`✗ ${l}`), notice: io.notice ?? io.err });
    } catch (e) {
      io.out(`✗ ${e instanceof Error ? e.message : String(e)}`);
      code = 2;
    }
    worst = Math.max(worst, code);
  }
  return worst;
}

/** Le contexte de la session de `--session <id>`, sinon de `CLAUDE_CODE_SESSION_ID`, sinon (variable absente) de la seule session du dossier courant, tel que la bande cadence-hud le publie ; illisible = code 2, à lire comme « au seuil ». */
function sessionContext(io: Io, session?: string): number {
  const r = readHudContext(io.env, io.now().getTime(), { cwd: io.cwd, session });
  if (!r.ok) throw new RafError(`session context : contexte illisible — ${r.reason} ; à traiter comme au seuil`);
  io.out(`ctx ${Math.round(r.ctx.percent)} % (${r.ctx.tokens}/${r.ctx.window})`);
  return 0;
}

function session([sub, ...args]: string[], ctx: SessionCtx, values: { since?: string; idle?: string; clear?: boolean }): number {
  switch (sub) {
    case 'start': {
      const idle = values.idle === undefined ? 2 : Number(values.idle);
      if (!Number.isInteger(idle) || idle < 0) throw new RafError(`--idle invalide : ${values.idle}`);
      return sessionStart(ctx, { since: values.since ?? '24 hours ago', idle });
    }
    case 'close':
      return sessionClose(ctx, { since: values.since });
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
      // Rien sur stdout laissait croire à un échec : on redit les lignes telles qu'enregistrées, pour que
      // session-close les rapporte sans relancer session start.
      const n = lines.length;
      ctx.out(`${n} ligne${n > 1 ? 's' : ''} enregistrée${n > 1 ? 's' : ''} pour la prochaine ouverture\n${lines.map((l) => `  - ${l}`).join('\n')}`);
      return 0;
    }
    default:
      throw new RafError('usage : cadence session start [--since …] [--idle 2] | close [--since …] | start|close --all [--depth n] | next "ligne" … | next --clear | context [--session id]');
  }
}
