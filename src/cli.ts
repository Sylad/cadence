import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultPlan, PLAN_DEFAULT, PLAN_LEGACY, readDocsConfig, readHookConfig, readNewsConfig, readOrchestrateConfig, readPerfConfig, readPlanConfig, readSessionConfig, readVerifyConfig } from './config.js';
import { repoSections, repoShas, resolveLotRepos } from './repos.js';
import { audit, exemptPlanOnly, gateProgress, gateText, gateWaiting, hypothesesOf, ownFiles, isPlanOnly, lotWork, nextUp, planCommits, unreviewedWork, workByLot } from './audit.js';
import { short } from './check.js';
import { isDay, toDay, type Day } from './dates.js';
import { deliver, parseDeliverConfig, realDeps, shellQuote } from './deliver.js';
import { defaultTarget, effectLines, realCheckDeps, verifyCommand } from './verify.js';
import { verifyGate } from './verify-gate.js';
import { ganttData, renderGantt } from './gantt.js';
import { PLAN_ACTIONS, planCommitMessage } from './plan-commit.js';
import { dirtyPaths, gitRoot, tryGit, isTracked, readCommits, matchesHead, resolveCommit, stage, stagedFiles, syncIndexWithHead } from './git.js';
import { installHook, pendingCommitMessage, REFUSED } from './hook.js';
import { gateRefusal, pushRefusal, UNGATED_ENV } from './push-guard.js';
import { citedRefs, linkCommits } from './link.js';
import { buildNews, loadEntries, newEntry, newsData, newsIssues, publicTitleTooLong, stampEntries } from './news.js';
import { invalidResource, Plan, RafError, SCREENS, STATUSES, setPlanNotice, type Lot, type Screen, type Status } from './plan.js';
import { dueLine, isRecurring, recurringByDue } from './recurring.js';
import { schedule } from './schedule.js';
import { AGENTS_DIR, installAgents, installSkills, SKILLS_DIR } from './skills.js';
import { configSet } from './config-set.js';
import { movePriority } from './priority.js';
import { findProjects, readDepth, leadTour, TITLE_MAX, truncate, readLeadUx, tourFreeLine, readLeadContextThreshold, tourLine, tourNoTestLines, tourWorktreeLines } from './lead.js';
import { configuredCap, expiredHoldLines, slotsLine, orchestrate, realOrchestrateDeps } from './orchestrate/command.js';
import { addHold, releaseHold } from './orchestrate/registry.js';
import { activeLock, REPO_LOCK } from './orchestrate/lock.js';
import { INTEGRATION_LOCK } from './orchestrate/integrate.js';
import { cadenceHome, liveWaves, openLotsIn, openWavesIn, waveLotsIn, type OpenWave } from './orchestrate/registry.js';
import { blockingLots, LABEL, resumeCommand } from './orchestrate/table.js';
import { bugCodeOf, bugCodePasses, classifyAll, classifySous, measure, ollamaClassifier, ollamaSousClassifier, readCache, readJournals, readRuns, readSousCache, renderReport, sampleKeys, serializeCache, serializeSousCache } from './corrections.js';
import { computePerf, perfHeader, perfWindows, readPlans, readProjectDeliveries, readProjectFailedEntries, renderPerf, type PerfResult } from './perf.js';
import { findAcceptation, parseAcceptation, redAcceptations, resealAcceptation, resealForGreen, runAcceptation, setVert } from './orchestrate/accept.js';
import { refCommand } from './ref/command.js';
import { coverageCommand } from './ref/coverage.js';
import { release } from './release.js';
import { applyMigration, describeMigration, planMigration, unhandledError } from './migrate.js';
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
  /** Entrée standard, lue en entier (hook pre-push, L405) ; absent : le descripteur 0. */
  stdin?: () => string;
}

const HELP = `raf — plan « reste à faire » versionné dans le dépôt, relié aux commits

  raf init [--project nom] [--prefix L] [--no-hook]
  raf add "titre" [--estimate j] [--quickwin] [--visible [--screen page|component|journey]] [--spec] [--public "titre public"] [--every jours] [--after L2,L4] [--uses banc,passerelle] [--parent L3]
  raf public <id> "titre public" | --clear   titre du lot dans le langage du public (pages Nouveautés et Plan)
  raf screen <id> page|component|journey|none   pose, remplace ou retire screen: d'un lot visible existant (seule la valeur page adopte l'étape spec d'orchestrate)
  raf visible <id> on|off   pose ou retire visible: d'un lot existant (changement visible : entrée Nouveautés et étape UX d'orchestrate) ; off est refusé tant que le lot a un screen:
  raf spec <id> on|off   pose ou retire spec: d'un lot existant (le lot change un comportement : étape spec back d'orchestrate)
  raf move <id> --before|--after <id>   réordonne un lot (ou une sous-tâche) dans le plan, parmi ceux du même parent ; refusé pendant une vague du dépôt, sur un lot archivé et sur un plan en lecture seule
  raf uses <lot> [<ressource>…]   remplace les ressources partagées du lot (uses:, déclarées par resources: dans le cadence.yaml du dossier parent ; raf check refuse un nom non déclaré) ; sans nom, retire la clé
  raf start <id>        raf done <id> [--force]        raf drop <id> [--reason texte]
  raf todo <id> [--reason texte]   remet en attente un lot démarré sans commit de travail (doing → todo, started retiré, note datée) ; refusé s'il a des commits ; rouvre un lot done ou dropped (→ todo, finished retiré, note « rouvert ») — la seule façon de rouvrir, archivé compris (il revient dans le fichier du plan)
  raf note <id> "texte"
  --verbose             avec done, ux, review, note, move ou public : imprime la ligne « id  état  titre entier » du lot touché ; avec hook post-commit : le titre entier (sinon 60 caractères au plus)
  raf title <id> "nouveau titre"   remplace le titre d'un lot, de tout statut (done compris), et note l'ancien dans une note datée
  raf did <id> ["texte"]   un lot récurrent (--every) a été refait : le « dû depuis N j » repart de aujourd'hui
  raf ux enable         revue UX obligatoire avant « done » pour les lots --visible
  raf ux <id> "verdict" enregistre la revue d'ergonomie du lot (agent ux-reviewer)
  raf review enable     revue de code obligatoire avant « done » pour les lots qui ont des commits
  raf review <id> "verdict" enregistre la revue de code du lot (agent code-reviewer)
  raf show <id> [--notes]   le lot : statut, dates, after, titre public, visible et verdict ux (lot visible), notes datées, commits comptés ; --notes : les notes seules
  raf commits <id>      les commits du lot que compte la porte de revue de code, du plus ancien au plus récent
  raf now               ce qui est en cours, la suite, les derniers terminés
  raf list [--status todo|doing|done|dropped]
  raf check [--since date] [--idle 7]   (défaut : date « since » du plan) code 1 s'il y a des écarts
  raf ignore <sha> | "<sujet exact>" [--reason texte]   acquitte un commit sans lot, citant un id inconnu ou des lots sans y travailler, sans réécrire l'historique ; raf check --ignored les liste
  raf docs-ok <lot> --reason texte   acquitte l'écart docs.sync d'un lot (documentation en retard) avec la raison pour laquelle la documentation reste telle quelle (plan en lecture seule : .cadence/docs-ok.yaml, le plan n'est pas touché) ; lu par raf check et par orchestrate, qui ne rend jamais prêt un lot avec un écart ouvert
  raf archive [--before date] [--dry-run]   déplace les lots done et dropped (terminés avant la date, s'il y en a une) du fichier du plan vers .cadence/archive/<année>.yaml ; le plan chargé présente toujours tous les lots (show, list, check, now, news, perf… inchangés), seules les sessions ne lisent jamais l'archive ; reste dans le plan un lot qui a un écart ouvert (raf check) ; un id présent dans deux fichiers est une erreur nommée ; refusé tant que le plan est à docs/plan/raf.yaml (raf migrate d'abord) ; rejouable
  raf gantt [-o .cadence/gantt.html]
  cadence config set <clé> <valeur> --all [--dry-run] [--depth n]   pose la même clé dans le cadence.yaml de chaque projet du dossier (ceux de lead tour), commentaires et ordre gardés, un lot de config qui la cite (raf add + start) et un commit à chemin explicite par projet ; ne pousse pas ; liste ce qui est fait et sauté (dépôt sale, déjà posée, plan en lecture seule) ; s'arrête sur une config qui ne se relit pas
  raf migrate [--dry-run]   déplace docs/plan/raf.yaml vers .cadence/raf.yaml (git mv) et réécrit les lecteurs du chemin dans le dépôt ; --dry-run les liste sans rien toucher ; refus tant qu'un lecteur n'est pas traité (migrate.keep de cadence.yaml pour ceux qui ne lisent pas le plan) ; rejouable
  raf hook install      (pre-commit et post-commit ; cadence.yaml hook.autostart: warn|refuse|start)
  cadence orchestrate <projet>:<lot>[@modèle]… [--budget 2M] [--goal "…"] [--dry-run] [--wave nom] [--continue [--until HH:MM] [--priority a,b]]   une session claude neuve par étape ; --status [vague] [--watch [--interval s]] ; --resume [vague | --wave vague] [--budget 1M] [--budget projet:lot=+300k] [--answer projet:lot "réponse"] [--drop projet:lot] ; --drop projet:lot [--wave vague] ; --stop-after-current [--wave vague] ; --waits [--since AAAA-MM-JJ]
                        mode worktree par lot (orchestrate.worktrees: true)  (activé par défaut dans cadence, désactivé ailleurs tant que la clé est absente) ; ses options : --resume --wave <vague> --integrate projet:lot (rejoue un lot rendu à l'intégration) · --resume --wave <vague> --replay projet:lot (idem, et après une écriture de plan refusée) · --remove-worktree projet:lot [--abandon-commits] (retire le worktree et la branche conservés) ; la liste des worktrees conservés : orchestrate --status et lead tour
  cadence lead tour [dossier] [--idle 3] [--depth n] [--json]   le tableau du lead, sans modèle : une ligne par sous-dossier qui a un plan, ou la ligne du dossier seul s'il est lui-même un projet (en cours, dérive, notes de clôture, prochain lot prêt, dépôt), précédées de l'en-tête perf : une ligne par ⚠ de cadence perf, rien si tout est stable
  cadence lead priority <projet> --before|--after <projet> [dossier] [--depth n]   range un projet dans la liste priority: du cadence.yaml du dossier (ordre du tour, de orchestrate --continue et du panneau des lots), commentaires gardés ; ne commite pas
  cadence lead hold <étiquette> [--ttl minutes] | lead release <étiquette>   déclare (60 min par défaut), puis rend, une session lancée à la main par le lead : elle est soustraite des créneaux libres de orchestrate --status et de lead tour ; au TTL échu, les deux la signalent en ⚠ jusqu'au release
  cadence corrections [dossier] [--classify [--model m]] [--cache fichier] [--cache-sous-causes fichier] [--sample n] [--until date] [--since date] [--json]   mesure des passes de correction des journaux dossier/.cadence/runs : lots à ≥1 et ≥2 corrections, par projet, visibles ou non, passes par cause (classées par Ollama avec --classify, hors quota)
  cadence perf [dossier] [--since date] [--json]   tableau de bord du workflow, sans modèle : deux fenêtres (7 derniers jours contre les 7 précédents) lues dans dossier/.cadence/runs et les plans, chaque vitesse à côté de sa qualité, ⚠ au-delà de 25 % de dégradation ; tokens par lot selon l'estimate, part de la revue, délais création → done → livraison, durée de mur par étape, coût en euros par lot livré (grille cadence.yaml perf.prices) ; --since est un jour qui tronque les fenêtres
  cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]   enregistre un document de référence hors du dépôt (references.dir de cadence.yaml, sinon $XDG_DATA_HOME/cadence/references) : pages rendues à 200 dpi, texte positionné, images incluses, index des figures et des passages qui les citent ; exige poppler, ImageMagick et tesseract (outil absent nommé avec sa commande, code 2)
  cadence ref analyse <document.pdf> [--sections 3-5,9] [--slug nom] [--model sonnet|opus|haiku] [--model-b sonnet|opus|haiku] [--seuil 30] [--double]   la chaîne : add, puis UNE lecture (une session de l'agent reference-analyst, lectures/a.json, le programme relit le fichier : ref check, document et genre) ; --double : deux lectures indépendantes (A sur --model, B sur --model-b, lectures/a.json et b.json), ref diff, le troisième regard (agent reference-verifier : confirme ou écarte ce qu'une seule lecture porte, d'après une découpe) et l'inventaire réconcilié (inventaire.json, usage.tokens = les trois sessions) — option dont la mesure n'a pas montré de gain (docs/mesures/ref-double-lecture-2026-10-25.md) ; --model-b et --seuil n'ont de sens qu'avec --double ; plafond déclaré : 20 pages par lecture ; code 1 lecture refusée ou (--double) trop d'éléments non appariés (--seuil, 30 %), 2 refus (plafond, modèle, session en échec), 3 quota
  cadence ref diff <lecture-a.json> <lecture-b.json> [--out inventaire.json] [--seuil 30]   réconcilie deux lectures du même document (même slug et même empreinte) : concordant → un élément lu ou mesuré, divergent → incertain avec les deux versions, seul (une lecture) → incertain en attente du troisième regard ; silences réunis ; au-delà de 30 % d'éléments non appariés (--seuil, en pour cent) code 1 et rien d'écrit ; --out écrit l'inventaire
  cadence ref measure <slug> <page> <page | x,y | x,y,l,h> [--quoi couleurs|contraste|boites|texte] [--largeur 1440] [--json]   mesure une zone d'une page rendue (pixels de la page) : couleurs (point, moyenne, dominantes), contraste WCAG 2.2, boîtes, mots OCR tesseract et taille de police estimée ; valeurs ramenées à 1440 px de large, tolérance déclarée
  cadence ref check <inventaire.json | lecture.json>   valide un inventaire ou une lecture (schéma version 1, modèle templates/inventaire.json) : une ligne « ✗ chemin : raison » par écart puis « N écart(s) » sur la sortie standard (code 1), le résumé par type sinon (code 0) ; fichier absent, vide ou illisible : code 2 ; n'appelle aucun outil système
  cadence ref coverage <inventaire.json>   couverture d'un document de référence, sans modèle : les éléments qu'aucun lot fait ne couvre (lot qui cite l'id) et qu'aucune exclusion écrite avec sa raison (clé « exclusions » de l'inventaire) ne justifie, une ligne ✗ chacun ; code 1 s'il en reste, 0 sinon, 2 pour un appel mal formé ou un fichier qui n'est pas un inventaire valide
  cadence ref eval <attendu.json | dossier> <lecture.json | dossier> [--json]   note une lecture contre l'inventaire attendu (vérité connue) : rappel et précision par type, faux lu (éléments sûrs et faux), pièges trouvés, tokens par page (usage.tokens de la lecture) ; lecture d'un autre document refusée (code 2) ; sur dossiers, un cas par sous-dossier (attendu.json / lecture.json)
  cadence ref corpus <dossier> [--sans-rendu]   écrit le corpus synthétique à vérité connue (7 pièges : texte ambigu levé par une figure, figure qui contredit, table en image, gabarit BUFR, contrôle translucide, page Proposal, scan bruité) : par cas document.html et attendu.json, puis document.pdf et page-<n>.png (1700×2200) rendus par Playwright (CADENCE_PLAYWRIGHT = dossier du paquet) ; dossier existant ou Playwright introuvable : code 2
  cadence release patch|minor|major [--dry-run]   prépare le commit de version (package.json, package-lock.json, plugin.json, marketplace.json, CHANGELOG.md) sans commiter ni publier ; imprime les étapes du lead et vérifie docs/whats-new.md : refus sur un arbre sale, un [Unreleased] vide ou une version déjà taguée
  cadence verify [--retry s] [--sha rév]   rejoue deliver.verify hors livraison : 0 vert, 1 effet rouge, 2 rien à vérifier
  cadence verify --gate --sha rév [--project dossier]   porte du projet (orchestrate.build puis orchestrate.test) : reprend le verdict enregistré par la vague quand son sha est le même et son arbre identique, sans rien rejouer (la sortie dit « verdict repris de la porte de la vague ») ; sinon la rejoue (« verdict rejoué : raison ») au sha dans l'arbre principal s'il est propre au sha, sinon dans un worktree jetable aux dépendances copiées (orchestrate.worktreeDeps), puis le retire : 0 vert, 1 rouge avec les tests en échec, 2 rien à rejouer ; le verdict (0 ou 1) est noté par sha et le hook pre-push refuse un push dont le sha n'a pas de verdict vert (CADENCE_PUSH_UNGATED=1 passe outre)
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

/** La version du paquet (`package.json` est à côté de `src/` comme de `dist/`). */
function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

export function run(argv: string[], io: Io): number | Promise<number> {
  setPlanNotice(io.err);
  try {
    // Comme `cadence --version` (L376) : en premier argument seulement, ailleurs c'est une option comme une autre.
    if (argv[0] === '--version' || argv[0] === '-v') {
      io.out(packageVersion());
      return 0;
    }
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
      before: { type: 'string' },
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
      gate: { type: 'boolean' },
      clear: { type: 'boolean' },
      ignored: { type: 'boolean' },
      notes: { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      classify: { type: 'boolean' },
      model: { type: 'string' },
      cache: { type: 'string' },
      'cache-sous-causes': { type: 'string' },
      sample: { type: 'string' },
      sections: { type: 'string' },
      slug: { type: 'string' },
      quoi: { type: 'string' },
      'sans-rendu': { type: 'boolean' },
      out: { type: 'string' },
      seuil: { type: 'string' },
      'model-b': { type: 'string' },
      double: { type: 'boolean' },
      largeur: { type: 'string' },
      until: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    io.out(HELP);
    return 0;
  }
  if (command !== 'session' && command !== 'config' && !(command === 'lead' && !values.all) && (values.all || values.depth !== undefined)) throw new RafError(`${values.all ? '--all' : '--depth'} ne va qu'avec session start ou session close`);
  const today: Day = io.env.RAF_TODAY ?? toDay(io.now());
  if (!isDay(today)) throw new RafError(`RAF_TODAY invalide : ${today} (attendu AAAA-MM-JJ)`);
  const root = gitRoot(io.cwd) ?? io.cwd;
  // Le tour parcourt les sous-dossiers (ou, sans sous-projet, prend le dossier lui-même s'il est un projet) : il ne lit pas le plan du dossier courant.
  if (command === 'lead') {
    if (rest[0] === 'hold' || rest[0] === 'release') return leadHold(rest, values.ttl, io, today);
    if (rest[0] === 'priority') return leadPriority(rest, values.before, values.after, values.depth, io);
    if (values.ttl !== undefined) throw new RafError('--ttl ne va qu\'avec lead hold');
    if (rest[0] !== 'tour' || rest.length > 2) throw new RafError('usage : cadence lead tour [dossier] [--idle 3] [--depth n] [--json] | lead priority <projet> --before|--after <projet> [dossier] | lead hold <étiquette> [--ttl minutes] | lead release <étiquette>');
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
      // les worktrees de lot que des vagues ont conservés : aucun n'est oublié en silence (L279, R19)
      for (const l of tourWorktreeLines(rows, io.now().getTime())) io.out(l);
      // un projet sans orchestrate.test : la vague ne lancera pas la suite (L327)
      for (const l of tourNoTestLines(rows)) io.out(l);
      // les créneaux libres viennent du registre, le lead les lit au lieu de les calculer (L141)
      // toujours imprimés, même sans vague ni session du lead (L416) : un créneau vide se lit, il ne se déduit pas d'une ligne absente
      io.out(slotsLine(configuredCap(io.env), io.now()).line);
      // en face des créneaux libres, les lots prêts dont aucune ressource n'est prise (L252)
      const free = tourFreeLine(rows);
      if (free) io.out(free);
      // une session du lead dont le TTL est échu (L278) : rien ne l'arrête, le tour la signale (hors --json, comme les créneaux)
      for (const l of expiredHoldLines(io.now())) io.out(l);
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
  // Poser une clé dans le cadence.yaml de chaque projet du dossier (L342) : ne lit ni le plan ni le cadence.yaml du dossier courant.
  if (command === 'config') {
    if (rest[0] !== 'set' || rest.length !== 3) throw new RafError('usage : cadence config set <clé> <valeur> --all [--dry-run] [--depth n]');
    if (!values.all) throw new RafError('config set demande --all : la commande s\'applique aux projets du dossier courant (lancer la commande dans le projet visé pour un seul)');
    if (values.depth !== undefined && !(Number.isInteger(Number(values.depth)) && Number(values.depth) >= 1)) throw new RafError(`--depth invalide : ${values.depth} (un entier ≥ 1)`);
    const parent = resolve(io.cwd);
    const result = configSet(parent, rest[1], rest[2], { dryRun: values['dry-run'], depth: values.depth === undefined ? readDepth(parent) : Number(values.depth) }, today);
    for (const l of result.lines) io.out(l);
    return result.code;
  }
  if (command === 'corrections') return corrections(rest, values, io);
  if (command === 'perf') return perf(rest, values, today, io);
  if (command === 'ref' && rest[0] !== 'coverage') return refCommand(rest, values, root, io);
  // Prépare le commit de version : écrit les fichiers de version, ne commite ni ne publie rien (L341).
  if (command === 'release') return release(rest, !!values['dry-run'], root, today, io.out);
  // Déplacer le plan ne lit pas le plan : pas d'avertissement « ancien emplacement » (L284).
  if (command === 'migrate') {
    if (rest.length > 0) throw new RafError('usage : raf migrate [--dry-run]');
    const migration = planMigration(root);
    // --dry-run décrit ce qui serait fait avant de refuser ; sans lui, un refus n'annonce rien de fait.
    if (values['dry-run'] || migration.unhandled.length === 0) for (const l of describeMigration(migration, !!values['dry-run'])) io.out(l);
    if (migration.unhandled.length > 0) throw unhandledError(migration);
    if (!values['dry-run']) applyMigration(root, migration);
    return 0;
  }
  // `spec` est aussi un verbe de raf (raf spec <lot> on|off, L186) : seuls check et qa vont à la fiche.
  if (command === 'spec' && (rest[0] === 'check' || rest[0] === 'qa')) return spec(rest, io);
  const reseal = command === 'spec' && rest[0] === 'reseal';
  const green = command === 'spec' && rest[0] === 'green';
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
  // `ref coverage` lit le plan (les lots faits qui citent les éléments) : il passe après le choix du plan, les autres `ref` n'y touchent pas (L367).
  if (command === 'ref') return coverageCommand(rest.slice(1), loadPlan, io, { repo: root, specDir: readOrchestrateConfig(configPath).spec.dir });
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
      warnIntegrating(root, io.err);
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
      // Un lot clos avec une acceptation à vert: false bloque les vagues suivantes du dépôt (verrou des tests d'acceptation, L366).
      if (status === 'done' && !rest[0].includes('/')) {
        const repo = gitRoot(root) ?? root;
        let dir: string | null = null;
        try {
          dir = readOrchestrateConfig(configPath).spec.dir;
        } catch {
          // un cadence.yaml illisible ne doit pas empêcher de clore un lot : `cadence check` en parle
        }
        const red = dir === null ? undefined : redAcceptations(repo, dir).find((a) => a.lot === rest[0]);
        if (red) {
          const text = `${rest[0]} : ${red.path} est à vert: false — clos ainsi, le lot bloquerait les vagues suivantes du dépôt (verrou des tests d'acceptation) ; cadence spec green ${rest[0]} lance la commande d'acceptation et pose vert: true`;
          if (!values.force) throw new RafError(`${text} (--force pour passer outre)`);
          io.err(`avertissement : ${text}`);
        }
      }
      const unreviewed = status === 'done' && plan.reviewSince && !plan.readonly && !values.force ? unreviewedWork(plan, root, rest[0]) : 0;
      plan.setStatus(rest[0], status, today, { force: values.force, unreviewed });
      if (command === 'drop' && values.reason) plan.note(rest[0], `abandonné : ${values.reason}`, today);
      plan.save();
      io.out(`${rest[0]} → ${status}`);
      if (status === 'done') warnIntegrating(root, io.err);
      touchedLot(plan, rest[0], values.verbose, io);
      if (status === 'done' && !rest[0].includes('/')) {
        const lot = plan.lot(rest[0]);
        if (lot.visible && !loadEntries(newsDir).some((e) => e.lots.includes(lot.id))) {
          io.out(`${lot.id} est visible : écrire l'entrée : cadence news new ${lot.id}`);
        }
        const uncommitted = uncommittedPlanCommand(plan, root, lot.id, planConfig?.commit);
        if (uncommitted) io.out(uncommitted);
      }
      return 0;
    }
    case 'archive': {
      if (values.before !== undefined && !isDay(values.before)) throw new RafError(`--before invalide : ${values.before} (attendu AAAA-MM-JJ)`);
      // L'archive vit à côté du plan : à l'ancien emplacement, elle irait sous docs/ (publié) et raf migrate ne la déplacerait pas — migrer d'abord.
      if (planPath === resolve(root, PLAN_LEGACY)) throw new RafError(`raf archive refusé : le plan est à l'ancien emplacement ${PLAN_LEGACY}, l'archive irait sous docs/ — le déplacer d'abord : raf migrate`);
      const dry = !!values['dry-run'];
      const plan = loadPlan();
      // Un lot clos qui a encore un écart (revue, UX, docs.sync, Nouveauté… ce que `raf check` signale) reste dans le plan, avec l'écart pour raison.
      const issues = audit(plan, root, newsDir, today);
      const blocked = (lot: Lot) => issues.find((i) => plan.refs(i.message).some((r) => r.lot === lot.id))?.message ?? null;
      const { moved, kept } = plan.archive(today, { before: values.before, dryRun: dry, blocked: (lot) => (blocked(lot) ? `écart ouvert — ${blocked(lot)}` : null) });
      const files = [...new Set(moved.map((m) => m.file))];
      for (const f of files) {
        const ids = moved.filter((m) => m.file === f).map((m) => m.lot.id);
        io.out(`${dry ? 'à archiver' : 'archivé'} dans ${relative(io.cwd, f)} : ${ids.join(', ')}`);
      }
      for (const k of kept) io.out(`${k.id} reste dans le plan : ${k.why}`);
      if (moved.length === 0) io.out('rien à archiver');
      else if (!dry) {
        if (plan.republishes) io.err('raf: plan.onWrite republie le fichier du plan sans les lots archivés : le générateur de la copie publiée doit aussi lire .cadence/archive/*.yaml (clé `lots`), sinon l\'historique livré disparaît de la feuille de route publique');
        const uncommitted = uncommittedPlanCommand(plan, root, moved[0].lot.id, planConfig?.commit, PLAN_ACTIONS.archived(moved.length));
        if (uncommitted) io.out(uncommitted);
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
      warnIntegrating(root, io.err);
      touchedLot(plan, rest[0], values.verbose, io);
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
    case 'move': {
      // Une seule position : --before ou --after, avec une cible (« after » est aussi le drapeau de « add », « before » celui de « archive »).
      const place = values.before !== undefined && values.after === undefined ? 'before' : values.after !== undefined && values.before === undefined ? 'after' : null;
      if (rest.length !== 1 || !place) throw new RafError('usage : raf move <id> --before <id> | raf move <id> --after <id>');
      const plan = loadPlan();
      plan.move(rest[0], place, values[place]!); // en mémoire : les refus de la commande (plan en lecture seule, parent, archive) passent avant celui de la vague
      // Un lot de la vague s'appuie sur l'ordre du plan qu'il a lu : le réordonner sous ses pieds est refusé tant que la vague tient le dépôt.
      const holding = waveHolding(root);
      if (holding) throw new RafError(`move : orchestration en cours (vague ${holding.wave}, pid ${holding.pid}) — attendre que les lots de ce dépôt soient finis (le verrou tombe dès que tous sont prêts ou rendus), puis relancer`);
      plan.save();
      touchedLot(plan, rest[0], values.verbose, io);
      return 0;
    }
    case 'public': {
      need(values.clear ? 1 : 2, 'public <id> "titre public" | public <id> --clear');
      if (values.clear && rest.length > 1) throw new RafError('--clear n\'attend pas de titre');
      const plan = loadPlan();
      if (!values.clear) refuseLongTitle(rest.slice(1).join(' '));
      plan.setPublic(rest[0], values.clear ? null : rest.slice(1).join(' '));
      plan.save();
      touchedLot(plan, rest[0], values.verbose, io);
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
    case 'visible': {
      if (rest.length !== 2 || (rest[1] !== 'on' && rest[1] !== 'off')) throw new RafError('usage : raf visible <id> on|off');
      const plan = loadPlan();
      plan.setVisible(rest[0], rest[1] === 'on');
      plan.save();
      return 0;
    }
    case 'spec': {
      if (green) return specGreen(rest.slice(1), { root, loadPlan, configPath, today }, io);
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
      return gate(command, rest, loadPlan, root, today, io, !!values.verbose);
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
      // L439 : le livreur lit ici si le lot est visible et s'il porte un verdict UX ; deux lignes stables, absentes d'un lot non visible.
      if (lot.visible) io.out('visible : oui');
      if (lot.screen) io.out(`screen : ${lot.screen}`);
      if (lot.visible) io.out(lot.ux ? `ux : ${lot.ux.verdict}` : 'ux : absent');
      if (lot.spec) io.out('spec : true');
      if (lot.uses) io.out(`uses : ${lot.uses.join(', ')}`);
      if (lot.docsOk) io.out(`docs-ok : ${lot.docsOk.date} — ${lot.docsOk.reason}`);
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
    case 'docs-ok': {
      need(1, 'docs-ok <lot> --reason texte');
      if (rest.length > 1) throw new RafError('un seul lot attendu ; la raison se passe par --reason "texte"');
      const plan = loadPlan();
      knownLot(plan, rest[0], 'docs-ok se pose sur un lot, pas sur une sous-tâche');
      plan.setDocsOk(rest[0], values.reason ?? '', today);
      // Un plan en lecture seule n'est pas écrit : l'acquittement est dans .cadence/docs-ok.yaml, à commiter à la place du plan (L386).
      if (plan.readonly) io.out(`${rest[0]} : écart docs.sync acquitté dans .cadence/docs-ok.yaml (le plan n'est pas touché) — commiter ce fichier`);
      else {
        plan.save();
        io.out(`${rest[0]} : écart docs.sync acquitté`);
      }
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
        ganttData(plan.project, schedule(lots, workByLot(plan, root, linked), today), today, `${toDay(stamp)} ${stamp.toTimeString().slice(0, 5)}`),
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
      if (rest[0] === 'post-commit') return postCommit(existsSync(planPath) ? loadPlan : null, newsDir, root, today, io, readHookConfig(configPath).autostart, !!values.verbose);
      if (rest[0] === 'pre-commit') return preCommit(existsSync(planPath) ? loadPlan : null, readHookConfig(configPath).autostart, root, today, io);
      if (rest[0] === 'pre-push') return prePush(root, io, rest[1], configPath, planFileIn(root, planPath));
      throw new RafError('usage : raf hook install|pre-commit|post-commit|pre-push');
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
      if (orchestrating) {
        const refusal = `deliver : orchestration en cours (vague ${orchestrating.wave}, pid ${orchestrating.pid})`;
        if (values.sha === undefined) throw new RafError(`${refusal} — livrer une fois les lots de ce dépôt finis (le verrou tombe dès que tous sont prêts ou rendus), ou un sha « livrable jusqu'à » de la vague (--sha)`);
        // L277 : un sha dont tous les commits de la vague citent des lots prêts se livre au fil de l'eau ; l'état de la vague illisible ou un sha inconnu : refus.
        const lots = waveLotsIn(cadenceHome(), orchestrating.pid, root);
        const target = resolveCommit(root, values.sha);
        if (lots === null) throw new RafError(`${refusal} — état de la vague illisible : --sha ${values.sha} ne peut pas être vérifié`);
        if (!target) throw new RafError(`${refusal} — --sha ${values.sha} : commit introuvable`);
        const { blocking, unreadable } = blockingLots(lots, root, target);
        if (blocking.length > 0) {
          throw new RafError(`${refusal} — ${target.slice(0, 7)} contient des commits de lots pas prêts : ${blocking.map((l) => `${l.project}:${l.lot} (${LABEL[l.status]})`).join(', ')} ; livrer un sha antérieur (« livrable jusqu'à » du tableau de la vague) ou attendre leur fin`);
        }
        if (unreadable.length > 0) {
          throw new RafError(`${refusal} — commits illisibles (plan du projet ou dépôt) des lots pas prêts ${unreadable.map((l) => `${l.project}:${l.lot} (${LABEL[l.status]})`).join(', ')} : --sha ${values.sha} ne peut pas être vérifié ; rétablir le plan ou attendre la fin de ces lots`);
        }
      }
      if (!existsSync(configPath)) throw new RafError(`pas de configuration de livraison : ${configPath} (voir « cadence.yaml » dans docs/deliver.md du paquet @sylad/cadence)`);
      const config = parseDeliverConfig(readFileSync(configPath, 'utf8'), configPath);
      const plan = existsSync(planPath) ? loadPlan() : null;
      const articles = readDocsConfig(configPath).articles;
      // Sans public: d'un lot visible, le site reprend le titre de sa Nouveauté la plus récente.
      const publicTitle = (lot: Lot) => lot.public ?? (lot.visible ? loadEntries(newsDir).find((e) => e.lots.includes(lot.id))?.title : undefined);
      const ctx = { root, state: sharedStateDir(root), plan, config, today, dryRun: !!values['dry-run'], sha: values.sha, duringWave: !!orchestrating, waveId: orchestrating?.wave, planCommit: readPlanConfig(configPath, root)?.commit, args: rest, articles, publicTitle, out: io.out, err: io.err };
      return deliver(ctx, realDeps(root));
    }
    case 'verify': {
      if (values.gate) return verifyGateCommand(values, io);
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
function gate(kind: keyof typeof GATES, rest: string[], loadPlan: () => Plan, root: string, today: Day, io: Io, verbose: boolean): number {
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
  touchedLot(plan, rest[0], verbose, io);
  return 0;
}

/** Un titre de lot n'est jamais rendu en entier par défaut (L453) : ~300 caractères répétés à chaque commande, chaque commit de plan. */
function shortTitle(title: string, verbose: boolean | undefined): string {
  return verbose ? title : truncate(title, TITLE_MAX);
}

/** `--verbose` (L453) : la ligne `id  état  titre entier` du lot touché par `done`, `ux`, `review`, `note`, `move`, `public` ; sans lui, rien de plus (une sous-tâche n'a pas de ligne). */
function touchedLot(plan: Plan, id: string, verbose: boolean | undefined, io: Io): void {
  const lot = verbose ? plan.lots().find((l) => l.id === id) : undefined;
  if (lot) io.out(`${lot.id}  ${lot.status}  ${lot.title}`);
}

function knownLot(plan: Plan, id: string, subtask: string): Lot {
  const lot = plan.lots().find((l) => l.id === id);
  if (!lot) throw new RafError(id.includes('/') ? `${subtask} : ${id}` : `lot inconnu : ${id}`);
  return lot;
}

/**
 * `raf done` écrit le plan et ne le commite jamais (voulu : raf n'a pas de réglage qui commite, docs/raf.md) : la commande de commit du plan et des fichiers
 * que `plan.onWrite` produit, au gabarit `plan.commit` du projet (L371). Null hors d'un dépôt git ou quand rien n'est à commiter.
 */
function uncommittedPlanCommand(plan: Plan, root: string, lot: string, template: string | undefined, action: string = PLAN_ACTIONS.done): string | null {
  const repo = gitRoot(root);
  if (!repo) return null;
  // Seuls les chemins que git voit modifiés : `git add` d'un chemin absent ou ignoré est fatal.
  const paths = dirtyPaths(repo, [relative(repo, plan.path), ...plan.files, ...plan.produced, ...plan.archiveFiles().map((f) => relative(repo, f))]);
  if (paths.length === 0) return null;
  const quote = (t: string) => (/^[\w./-]+$/.test(t) ? t : `'${t.replaceAll("'", "'\\''")}'`);
  const message = planCommitMessage(template, { lot, action });
  const list = paths.map(quote).join(' ');
  return `plan non commité : raf ne commite jamais (voulu, ce n'est pas un réglage), à commiter :\n  git add -- ${list} && git commit -m ${quote(message)} -- ${list}`;
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
    for (const id of todo) plan.setStatus(id, 'doing', today, {});
    try {
      plan.save();
    } catch (e) {
      if (!(e instanceof RafError)) throw e;
      // plan.onWrite en échec (L346) : le plan est resté tel quel, le commit part sans lui et le dit.
      io.err(`raf: démarrage automatique refusé : ${e.message} ; raf start ${todo.join(' ')} à la main`);
      return 0;
    }
    for (const id of todo) io.err(`raf: ${id} était todo — raf start ${id} fait par le hook, plan inclus dans ce commit`);
    stage(root, file);
    for (const f of plan.produced) stage(root, f);
  } catch {
    // Un hook ne doit jamais gêner un commit, hors refus.
  }
  return 0;
}

function postCommit(load: (() => Plan) | null, newsDir: string, root: string, today: Day, io: Io, mode?: 'warn' | 'refuse' | 'start', verbose?: boolean): number {
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
      else io.err(`raf: ${r.lot} (${lot.status}) ${shortTitle(lot.title, verbose)}`);
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

/** Le plan, relatif à la racine du dépôt git (comme les fichiers d'un commit), séparateurs `/`. */
function planFileIn(root: string, planPath: string): string {
  return relative(gitRoot(root) ?? root, planPath).split('\\').join('/');
}

/**
 * `raf hook pre-push` (L405), appelé par le hook que la vague pose : refuse (code 3) un push qui emporte un commit d'un lot pas prêt de la vague vivante
 * du dépôt, ou dont un lot pas prêt a des commits illisibles (la garde de `deliver --sha`). Puis (L426), quand le projet déclare une porte, refuse un push dont
 * le sha de tête n'a pas de verdict vert de `cadence verify --gate` (`CADENCE_PUSH_UNGATED=1` passe outre, et le dit) ; un commit qui ne change que le plan reprend le verdict de son parent (L432). Sans vague qui tient le dépôt, ou avec un état de vague illisible
 * (avertissement), la première garde ne gêne jamais un push ; une config illisible laisse passer la seconde.
 */
function prePush(root: string, io: Io, remoteName: string | undefined, configPath: string, planFile: string): number {
  let input = '';
  try {
    input = io.stdin ? io.stdin() : readFileSync(0, 'utf8');
  } catch {
    return 0;
  }
  const holding = waveHolding(root);
  if (holding) {
    const lots = waveLotsIn(cadenceHome(), holding.pid, root);
    if (lots === null) {
      io.err(`raf: vague ${holding.wave} : état illisible, push non vérifié`);
    } else {
      const refusal = pushRefusal(root, holding.wave, lots, input, remoteName || undefined);
      if (refusal) {
        io.err(`raf: ${refusal}`);
        return REFUSED;
      }
    }
  }
  // La porte du projet (L426) : une config illisible ne gêne pas un push, comme un état de vague illisible.
  let gate = false;
  try {
    const config = readOrchestrateConfig(configPath);
    gate = Boolean(config.test || config.build);
  } catch {
    return 0;
  }
  const refusal = gateRefusal(root, gate, input, planFile);
  if (!refusal) return 0;
  if (io.env[UNGATED_ENV] === '1') {
    io.err(`raf: ${refusal.replace(/^push refusé/, 'push passé outre')} — ${UNGATED_ENV}=1 est posée`);
    return 0;
  }
  io.err(`raf: ${refusal}`);
  return REFUSED;
}

/**
 * Avertit (stderr, sans refuser) quand une intégration du dépôt est en cours (L425) : le plan écrit dans l'arbre principal est un fichier suivi modifié, et
 * l'intégration en cours le voit et refuse son lot (« arbre du dépôt modifié »). Seul l'arbre principal est concerné : dans le worktree d'un lot, l'écriture
 * ne change pas l'arbre que l'intégration contrôle.
 */
function warnIntegrating(root: string, err: (line: string) => void): void {
  const top = gitRoot(root);
  if (!top || !statSync(join(top, '.git')).isDirectory()) return;
  const holder = activeLock(join(sharedStateDir(root), INTEGRATION_LOCK));
  if (holder) err(`avertissement : intégration en cours (vague ${holder.wave}, pid ${holder.pid}) — ce plan est un fichier suivi modifié de l'arbre principal, l'intégration en cours peut refuser son lot (arbre du dépôt modifié) : committer le plan sans attendre`);
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
function openWavesRefusal(open: OpenWave[], command: 'spec reseal' | 'spec green'): string {
  const lines = open.map((w) => {
    const where = [w.live ? 'vivante' : 'arrêtée', ...(w.live && w.pid !== undefined ? [`pid ${w.pid}`] : []), ...(w.launchDir ? [`lancée depuis ${w.launchDir}`] : [])].join(', ');
    return `  - vague ${w.wave} (${where}) : ${w.lots.length ? [...w.lots.map((l) => `${l.key} (${l.status})`), ...w.others.map((l) => `${l.key} (${l.status}, pas en cours au plan)`)].join(', ') : 'lots illisibles'}`;
  });
  const how = open.map((w) =>
    w.live
      ? `  vague ${w.wave} : orchestration en cours, à attendre (le verrou du dépôt tombe dès que tous ses lots y sont prêts ou rendus)`
      : `  cd ${shellPath(w.launchDir)} && ${resumeCommand(w.wave, ...[...w.lots, ...w.others].flatMap((l) => ['--drop', l.key]))}`,
  );
  return [
    `${command} : refusé — ${open.length > 1 ? `${open.length} vagues non terminées gardent` : 'une vague non terminée garde'} ouvert au moins un lot en cours de ce dépôt (${command === 'spec green' ? 'le commit de spec green posé' : 'un rescellé commité'} maintenant lui serait rendu comme « premier commit fautif » à la reprise de la vague) :`,
    ...lines,
    `Marche à suivre : clore chacun de ces lots dans sa vague (attendre les vivantes, retirer les lots des arrêtées), puis relancer ${command === 'spec green' ? 'spec green' : 'le rescellé'} :`,
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

/**
 * `cadence spec green <lot>` (L366) : un lot mené ou clos à la main (raf done) dont l'acceptation est restée à `vert: false` bloque toutes les vagues suivantes du dépôt.
 * Lance la commande dédiée (`orchestrate.accept`) comme le cycle ; verte, rescelle les tests mis au point depuis le commit rouge (`resealForGreen`), pose `vert: true` et commite le seul fichier, en citant le lot. Rouge : rien n'est changé, code 1.
 */
function specGreen(args: string[], ctx: { root: string; loadPlan: () => Plan; configPath: string; today: Day }, io: Io): number {
  if (args.length !== 1) throw new RafError('usage : cadence spec green <lot>');
  if (io.env.CADENCE_ORCHESTRATED) throw new RafError(`spec green refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead, hors session`);
  refuseWhileWaveHolds(ctx, 'spec green');
  const lotId = args[0]!;
  const plan = ctx.loadPlan();
  const lot = plan.lot(lotId);
  if (lot.status === 'todo') throw new RafError(`${lotId} n'est pas commencé (todo) : il n'a rien livré dont l'acceptation puisse passer au vert`);
  const repo = gitRoot(ctx.root) ?? ctx.root;
  const config = readOrchestrateConfig(ctx.configPath);
  if (!config.accept) throw new RafError(`orchestrate.accept absent de ${ctx.configPath} : sans la commande dédiée, il n'y a rien à lancer pour ${lotId}`);
  const json = findAcceptation(repo, config.spec.dir, lotId);
  if (!json) throw new RafError(`${lotId} : aucune acceptation sous ${config.spec.dir} (le lot n'a pas passé l'étape accept)`);
  const doc = parseAcceptation(readFileSync(join(repo, json), 'utf8'));
  if (typeof doc === 'string') throw new RafError(`${json} : ${doc}`);
  if (doc.vert) {
    io.out(`${lotId} : ${json} est déjà vert, rien à faire`);
    return 0;
  }
  const open = unfinishedWaves(ctx.root, repo, plan);
  if (open.length) throw new RafError(openWavesRefusal(open, 'spec green'));
  const dirty = git(repo, ['status', '--porcelain', '-z', '--', ...doc.fichiers]).split('\0').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) throw new RafError(`${lotId} : test(s) listé(s) modifié(s) sans être commités : ${dirty.join(', ')} — les commiter (en citant ${lotId}) avant de poser vert: true`);
  const { runs, orphans } = runAcceptation(repo, json, config.accept);
  if (orphans.length) throw new RafError(`fichiers listés dans ${json} sous la racine d'aucune commande de orchestrate.accept : ${orphans.join(', ')}`);
  const failed = runs.filter((r) => r.code !== 0);
  if (failed.length) {
    io.err(`${lotId} : tests d'acceptation encore rouges (${failed.map((r) => `${r.command}, code ${r.code}`).join(' ; ')}), ${json} reste à vert: false`);
    for (const r of failed) io.err(r.output.trim().split('\n').slice(-40).join('\n'));
    return 1;
  }
  const before = readFileSync(join(repo, json), 'utf8');
  let resceles: string[];
  try {
    resceles = resealForGreen(repo, json, ctx.today);
  } catch (e) {
    throw new RafError(`${lotId} : ${(e as Error).message}`);
  }
  setVert(repo, json);
  try {
    git(repo, ['add', '--', json]);
    // Le sujet reste court et fixe (le gabarit `plan.commit` du projet s'il y en a un, comme tout commit écrit par cadence, L343) ; les tests rescellés, sans borne, vont dans le corps, une ligne chacun.
    const template = readPlanConfig(join(repo, 'cadence.yaml'), repo)?.commit;
    const subject = template ? planCommitMessage(template, { lot: lotId, action: PLAN_ACTIONS.specGreen }) : `chore(${lotId}): ${PLAN_ACTIONS.specGreen}`;
    const body = resceles.length ? ['empreintes rescellées (tests mis au point depuis le commit rouge) :', ...resceles.map((f) => `- ${f}`)].join('\n') : null;
    git(repo, ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : []), '--', json]);
  } catch (e) {
    // Atomique, comme le rescellé : un commit refusé (hook pre-commit, ...) laisse le fichier tel qu'avant.
    writeFileSync(join(repo, json), before);
    try {
      git(repo, ['reset', '-q', '--', json]);
    } catch {
      // rien d'indexé : rien à défaire
    }
    const out = e as { stderr?: string; stdout?: string; message: string };
    throw new RafError(`spec green : le commit a échoué, ${json} est revenu tel qu'avant la commande — ${(out.stderr || out.stdout || out.message).trim().split('\n').slice(-5).join(' | ')}`);
  }
  io.out(`${lotId} : ${json} → vert: true, commit ${git(repo, ['rev-parse', '--short', 'HEAD']).trim()}${resceles.length ? ` ; empreintes rescellées (tests mis au point depuis le commit rouge) : ${resceles.join(', ')}` : ''}`);
  return 0;
}

/** Un commit du lead en pleine passe ferait signaler au lot suivant un écart qui n'est pas le sien : tant qu'une vague tient le verrou du dépôt, `spec reseal` et `spec green` refusent. */
function refuseWhileWaveHolds(ctx: { root: string; loadPlan: () => Plan }, command: 'spec reseal' | 'spec green'): void {
  // Comme `deliver` : la vague tient le verrou du dépôt tant qu'un de ses lots y travaille (état illisible : on refuse).
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
    throw new RafError(openWavesRefusal(withHolder(open, orchestrating, repo), command));
  }
}

function specReseal(args: string[], reason: string | undefined, porteur: string | undefined, ctx: { root: string; loadPlan: () => Plan; configPath: string; today: Day }, io: Io): number {
  if (args.length !== 2 || !reason?.trim()) throw new RafError('usage : cadence spec reseal <lot> <test> --reason "pourquoi le test contredit la fiche" [--porteur <lot en cours>, pour un lot livré]');
  if (io.env.CADENCE_ORCHESTRATED) throw new RafError(`spec reseal refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead, hors session`);
  refuseWhileWaveHolds(ctx, 'spec reseal');
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
  if (open.length) throw new RafError(openWavesRefusal(open, 'spec reseal'));
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
  try {
    plan.save();
  } catch (e) {
    // Le rescellé est commité (sha) : seul le plan est refusé (plan.onWrite en échec), il reste inchangé et la note n'est pas écrite ; dire « écriture refusée » seul laisserait croire que rien n'a été fait.
    throw new RafError(`spec reseal : le rescellé a eu lieu (commit ${sha}) mais la note du lot n’a pas été écrite, le plan est inchangé — ${(e as Error).message} — relancer la commande dit « rien à resceller » : ajouter la note à la main (raf note ${cite}) une fois le plan réparé`);
  }
  // La note du lot rejoint le dépôt dans la foulée (un dépôt sale arrêterait la vague suivante) ; un plan hors du dépôt ou non suivi reste à la main du lead.
  const planRel = relative(repo, plan.path);
  const produced = plan.produced;
  const tracked = !planRel.startsWith('..') && git(repo, ['ls-files', '--', planRel]).trim() !== '';
  if (tracked) {
    try {
      // Les fichiers de plan.onWrite (L346) partent avec la note : la commande a tourné à l'écriture du plan.
      const withPlan = [planRel, ...dirtyPaths(repo, produced)];
      git(repo, ['add', '--', ...withPlan]);
      git(repo, ['commit', '-q', '-m', planCommitMessage(readPlanConfig(join(repo, 'cadence.yaml'), repo)?.commit, { lot: cite, action: PLAN_ACTIONS.resealed(norm) }), '--', ...withPlan]);
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

/** `cadence lead priority <projet> --before|--after <projet> [dossier]` (L449) : range un projet dans la liste `priority:` du cadence.yaml du dossier (celui du tour), sans modèle ni commit. */
function leadPriority(rest: string[], before: string | undefined, after: string | undefined, depth: string | undefined, io: Io): number {
  const usage = 'usage : cadence lead priority <projet> --before|--after <projet> [dossier] [--depth n]';
  if (rest.length < 2 || rest.length > 3 || (before === undefined) === (after === undefined)) throw new RafError(usage);
  const place = before !== undefined ? 'before' : 'after';
  const levels = depth === undefined ? undefined : Number(depth);
  if (levels !== undefined && !(Number.isInteger(levels) && levels >= 1)) throw new RafError(`--depth invalide : ${depth} (un entier ≥ 1)`);
  const parent = resolve(io.cwd, rest[2] ?? '.');
  if (!existsSync(parent)) throw new RafError(`lead priority : dossier introuvable : ${parent}`);
  const target = (before ?? after)!;
  const moved = movePriority(parent, rest[1]!, place, target, levels);
  io.out(moved.changed ? `${rest[1]} placé ${place === 'before' ? 'avant' : 'après'} ${target} dans priority: de ${join(parent, 'cadence.yaml')} (ordre : ${moved.order.join(' > ')}) — le fichier est modifié, à commiter` : `${rest[1]} est déjà ${place === 'before' ? 'avant' : 'après'} ${target} : rien à changer`);
  return 0;
}

/** `cadence lead hold <étiquette> [--ttl minutes]` / `lead release <étiquette>` (L255) : inscrit, ou rend, une session lancée à la main par le lead, qui compte dans les créneaux libres. */
function leadHold(rest: string[], ttl: string | undefined, io: Io, today: Day): number {
  const [verb, label] = rest;
  const usage = verb === 'hold' ? 'usage : cadence lead hold <étiquette> [--ttl minutes]' : 'usage : cadence lead release <étiquette>';
  if (rest.length !== 2 || !label!.trim()) throw new RafError(usage);
  if (verb === 'release') {
    if (ttl !== undefined) throw new RafError(`--ttl ne va qu'avec lead hold (${usage})`);
    io.out(releaseHold(cadenceHome(), label!) ? `session « ${label} » rendue` : `aucune session « ${label} » inscrite`);
    // ce que la libération laisse (L416) : les créneaux, les lots prêts qui peuvent les prendre, et un ⚠ tant qu'un créneau reste vide
    const { line, free } = slotsLine(configuredCap(io.env), io.now());
    io.out(line);
    const ready = tourFreeLine(leadTour(resolve(io.cwd), today));
    if (ready) io.out(ready);
    if (free > 0) io.out(`⚠ ${free} ${free === 1 ? 'créneau libre' : 'créneaux libres'} sur ${configuredCap(io.env)} : lancer un lot prêt ou une session, un créneau vide ne sert à rien`);
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
async function corrections(rest: string[], values: { classify?: boolean; model?: string; cache?: string; 'cache-sous-causes'?: string; sample?: string; until?: string; since?: string; json?: boolean }, io: Io): Promise<number> {
  if (rest.length > 1) throw new RafError('usage : cadence corrections [dossier] [--classify [--model m]] [--cache fichier] [--cache-sous-causes fichier] [--sample n] [--until date] [--since date] [--json]');
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
  const sousFile = resolve(io.cwd, values['cache-sous-causes'] ?? join(parent, '.cadence', 'corrections-sous-causes.json'));
  const cache = readCache(cacheFile);
  // R5 (L447) : le cache des sous-causes illisible sort avec le code 1 de la fiche (corrections.json illisible sort avec 2, par `failure`).
  let sousCache: ReturnType<typeof readSousCache>;
  try {
    sousCache = readSousCache(sousFile);
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    io.err(`raf: ${e.message}`);
    return 1;
  }
  if (values.classify) {
    const url = io.env.OLLAMA_HOST ?? 'http://localhost:11434';
    await classifyAll(data.passes, cache, ollamaClassifier({ url, model }), model, (done, total) => {
      if (done % 25 === 0 || done === total) io.err(`classement : ${done}/${total}`);
    }, { every: 10, save: () => writeFileSync(cacheFile, serializeCache(cache)) });
    writeFileSync(cacheFile, serializeCache(cache));
    const saveSous = () => writeFileSync(sousFile, serializeSousCache(sousCache));
    const added = await classifySous(data.passes, cache, sousCache, ollamaSousClassifier({ url, model }), model, (done, total) => {
      if (done % 25 === 0 || done === total) io.err(`sous-causes : ${done}/${total}`);
    }, { every: 10, save: saveSous });
    if (added > 0) saveSous();
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
  const bugCode = bugCodeOf(bugCodePasses(data.passes, cache), sousCache);
  io.out(values.json ? JSON.stringify(bugCode ? { ...m, bugCode } : m, null, 2) : renderReport(m, bugCode));
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
  // Les sous-causes (L447) n'arrêtent pas perf : un cache illisible avertit et la ligne est omise.
  const sousFile = join(parent, '.cadence', 'corrections-sous-causes.json');
  let sousCache: ReturnType<typeof readSousCache> | undefined;
  let sousWarning: string | undefined;
  try {
    sousCache = readSousCache(sousFile);
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    sousWarning = `perf : ${sousFile} illisible, sous-causes n/d`;
  }
  const plans = readPlans(parent, (l) => warnings.push(l));
  if (plans.size === 0 && warnings.length === 0) warnings.push(`perf : aucun plan sous ${parent}, indicateurs du plan n/d`);
  const deliveries = readProjectDeliveries(parent, [...plans.keys()]);
  const failures = readProjectFailedEntries(parent, [...plans.keys()]);
  const failedDeliveries = new Map([...failures].map(([name, entries]) => [name, entries.map((e) => e.day)]));
  const result = computePerf({ journals, plans, cache, ...(sousCache ? { sousCache } : {}), deliveries, failedDeliveries, failures, prices, windows: perfWindows(today, since), today, since });
  if (!prices) warnings.push('perf : aucune grille de prix (cadence.yaml perf.prices), coût en euros n/d');
  for (const [model, lots] of Object.entries(result.cost.withoutPrice)) warnings.push(`perf : modèle sans prix dans perf.prices : ${model}, coût n/d pour ${lots} lot(s)`);
  if (sousWarning) warnings.push(sousWarning);
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

/** `verify --gate --sha rév [--project dossier]` (L348) : la porte du projet rejouée au sha ; `--project` est un sous-dossier du dossier courant qui a son propre dépôt. */
async function verifyGateCommand(values: { sha?: string; project?: string; retry?: string; config?: string }, io: Io): Promise<number> {
  if (values.sha === undefined) throw new RafError('verify --gate : --sha obligatoire (le sha à re-vérifier, jamais la tête mouvante d\'une vague)');
  if (values.retry !== undefined) throw new RafError('verify --gate : --retry ne va qu\'à verify seul (deliver.verify)');
  const dir = values.project === undefined ? io.cwd : resolve(io.cwd, values.project);
  if (values.project !== undefined && !existsSync(dir)) throw new RafError(`verify --gate : --project ${values.project} : dossier introuvable sous ${io.cwd}`);
  const top = gitRoot(dir);
  if (!top) throw new RafError('verify --gate : à lancer dans un dépôt git (ou --project vers le dossier d\'un projet)');
  if (values.project !== undefined && realpathSync(top) !== realpathSync(dir)) throw new RafError(`verify --gate : ${values.project} n'a pas son propre dépôt git (dépôt parent : ${top})`);
  const configPath = resolve(io.cwd, values.config ?? join(top, 'cadence.yaml'));
  const sha = resolveCommit(top, values.sha);
  if (!sha) throw new RafError(`verify --gate : --sha ${values.sha} : commit introuvable dans ${top}`);
  // Le plan du projet (L444) : les commits qui ne changent que lui au-dessus du sha reprennent la porte du sha dessous. Illisible, il n'est pas cherché : la porte se rejoue.
  let planFile: string | undefined;
  try {
    const configured = readPlanConfig(configPath, top)?.path;
    planFile = planFileIn(top, configured !== undefined ? resolve(top, configured) : defaultPlan(top).path);
  } catch {
    planFile = undefined;
  }
  return verifyGate({ repo: top, sha, config: readOrchestrateConfig(configPath), verify: readVerifyConfig(configPath), launchDirs: [io.cwd, top, dirname(top)], planFile, now: io.now, out: io.out });
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

/** Le contexte (et sa position par rapport à `lead.contextThreshold`, en tokens) de la session de `--session <id>`, sinon de `CLAUDE_CODE_SESSION_ID`, sinon (variable absente) de la seule session du dossier courant, tel que la bande cadence-hud le publie ; illisible = code 2, à lire comme « au seuil ». */
function sessionContext(io: Io, session?: string): number {
  const r = readHudContext(io.env, io.now().getTime(), { cwd: io.cwd, session });
  if (!r.ok) throw new RafError(`session context : contexte illisible — ${r.reason} ; à traiter comme au seuil`);
  io.out(`ctx ${Math.round(r.ctx.percent)} % (${r.ctx.tokens}/${r.ctx.window})`);
  const threshold = readLeadContextThreshold(io.cwd);
  io.out(`seuil ${threshold} tokens : ${r.ctx.tokens >= threshold ? 'atteint' : 'sous le seuil'}`);
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
