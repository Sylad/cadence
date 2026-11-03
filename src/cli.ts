import { readFileSync } from 'node:fs';
import { isDay, toDay, type Day } from './dates.js';
import { gitRoot } from './git.js';
import { RafError, setPlanNotice } from './plan.js';
import { cmdAdd, cmdArchive, cmdDid, cmdDocsOk, cmdEstimate, cmdIgnore, cmdMove, cmdNote, cmdPublic, cmdScreen, cmdSetStatus, cmdStatus, cmdTitle, cmdTodo, cmdUses, cmdVisible } from './cli/lot-commands.js';
import { cmdPlan } from './cli/plan-commands.js';
import { cmdCheck, cmdCommits, cmdGantt, cmdList, cmdNews, cmdNow, cmdQuickwins, cmdRef, cmdShow } from './cli/read-commands.js';
import { cmdGate, cmdHook } from './cli/gates.js';
import { cmdInit, cmdMigrate, cmdSkills } from './cli/setup-commands.js';
import { cmdSpec, cmdSpecChecks } from './cli/spec-commands.js';
import { cmdSession, cmdSessionAll } from './cli/session-commands.js';
import { cmdDeliver, cmdLocal, cmdVerify } from './cli/deliver-commands.js';
import { corrections, perf } from './cli/stats-commands.js';
import { cmdConfig, cmdLead } from './cli/lead-commands.js';
import { claudeHook } from './claude-hook.js';
import { refCommand } from './ref/command.js';
import { release } from './release.js';
import { orchestrate, realOrchestrateDeps } from './orchestrate/command.js';
import { buildCtx, parseCli, type Ctx, type EarlyCtx, type Io } from './cli/context.js';

export type { Io } from './cli/context.js';
export { ensureGitignore } from './cli/setup-commands.js';

const HELP = `raf — plan « reste à faire » versionné dans le dépôt, relié aux commits

  raf init [--project nom] [--prefix L] [--no-hook]
  raf add "titre" [--estimate j] [--quickwin] [--visible [--screen page|component|journey]] [--spec] [--local] [--public "titre public"] [--every jours] [--after L2,L4] [--uses banc,passerelle] [--planned AAAA-MM-JJ..AAAA-MM-JJ] [--set champ=valeur]… [--parent L3] [--id AB-1.2 [--under AB-1]]
  raf estimate <id> <jours>   remplace l'estimation d'un lot existant (archivé compris) ; --id pose un identifiant libre conforme à plan.idPattern (cadence.yaml), --under en fait un sous-lot à plat (parent: AB-1, hors préfixe), --parent une sous-tâche
  raf public <id> "titre public" | --clear   titre du lot dans le langage du public (pages Nouveautés et Plan)
  raf screen <id> page|component|journey|none   pose, remplace ou retire screen: d'un lot visible existant (seule la valeur page adopte l'étape spec d'orchestrate)
  raf visible <id> on|off   pose ou retire visible: d'un lot existant (changement visible : entrée Nouveautés et étape UX d'orchestrate) ; off est refusé tant que le lot a un screen:
  raf spec <id> on|off   pose ou retire spec: d'un lot existant (le lot change un comportement : étape spec back d'orchestrate)
  raf move <id> --before|--after <id>   réordonne un lot (ou une sous-tâche) dans le plan, parmi ceux du même parent ; refusé pendant une vague du dépôt, sur un lot archivé et sur un plan en lecture seule
  raf uses <lot> [<ressource>…]   remplace les ressources partagées du lot (uses:, déclarées par resources: dans le cadence.yaml du dossier parent ; raf check refuse un nom non déclaré) ; sans nom, retire la clé
  raf plan <lot> AAAA-MM-JJ..AAAA-MM-JJ | <lot> --clear   pose, remplace ou retire la fenêtre prévue d'un lot (planned: from..to ; un seul jour vaut une fenêtre d'un jour) ; un sous-lot sans fenêtre propre hérite de celle de son parent ; lue par session start (retards, échéances), raf show et le Gantt
  raf plan --propose [--per-day n] [--from AAAA-MM-JJ] [--apply]   propose une fenêtre par lot à faire sans fenêtre (jours ouvrés à partir de --from, aujourd'hui par défaut ; n jours d'estimation par jour ouvré, 1 par défaut ; lots prêts d'abord) ; --apply les écrit d'un coup et dit la commande du commit ; plan.requirePlanned: true (cadence.yaml) fait refuser raf add sans --planned
  cadence local start <lot> [--ttl minutes] | local done <lot> | local abort <lot>   tâche locale du lead (lot posé par raf add --local) : start verrouille le dépôt comme une vague (aucune vague n'y démarre, --add y est refusé) et passe le lot à doing, refusé si une orchestration ou un autre lot du dépôt est en cours ; le verrou est déclaré (60 min par défaut), tenu sans processus jusqu'à done ou abort, signalé en ⚠ par lead tour et orchestrate --status au-delà du délai ; done joue la porte du projet UNE fois, libère le dépôt si elle est verte (la capture, la revue du diff, cadence deliver et raf done restent au lead) et le garde verrouillé sinon ; abort libère sans porte
  raf start <id>        raf done <id> [--force]        raf drop <id> [--reason texte]
  raf status [<id> <état> ["message"] | <id> --back ["message"]]   états détaillés du projet (cadence.yaml : plan.states) : pose l'état d'un lot sous la garde de plan.transitions et note le message ; --back sort de l'état bloqué vers l'état d'avant ; sans argument, liste les états. start / done / drop / todo posent eux-mêmes l'état de leur statut
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
  raf quickwins [--by champ] [--max j]   les gains rapides prêts (estimation ≤ 0,25 j, ou ⚡), groupés par un champ d'extension déclaré (plan.extras) ; à part, les prêts sans estimation
  raf list [--status todo|doing|done|dropped] [--json]   les lots, une ligne chacun ; --json : un tableau JSON des lots (clés du fichier du plan, champs d'extension sous extras)
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
  cadence verify [--retry s] [--sha rév]   rejoue deliver.verify hors livraison : 0 vert (et, au sha de la dernière livraison rouge, l’inscrit au journal des livraisons), 1 effet rouge, 2 rien à vérifier
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

/** Les commandes qui ne lisent pas le plan (ni le cadence.yaml du dossier courant) : rendent `null` quand l'appel en particulier, lui, en a besoin et passe à la table suivante. */
const BEFORE_PLAN: Record<string, (c: EarlyCtx) => number | Promise<number> | null> = {
  lead: cmdLead,
  config: cmdConfig,
  corrections: (c) => corrections(c.rest, c.values, c.io),
  perf: (c) => perf(c.rest, c.values, c.today, c.io),
  ref: (c) => (c.rest[0] === 'coverage' ? null : refCommand(c.rest, c.values, c.root, c.io)),
  // Prépare le commit de version : écrit les fichiers de version, ne commite ni ne publie rien (L341).
  release: (c) => release(c.rest, !!c.values['dry-run'], c.root, c.today, c.io.out),
  migrate: cmdMigrate,
  // Le hook du plugin « retour → geste » (L556) : sort toujours en 0, avant toute lecture du plan.
  'claude-hook': (c) => claudeHook(c.rest[0], () => (c.io.stdin ? c.io.stdin() : readFileSync(0, 'utf8')), c.io.out),
  spec: cmdSpecChecks,
  session: (c) => cmdSessionAll(c, run),
};

/** Les commandes qui lisent le plan. */
const WITH_PLAN: Record<string, (c: Ctx) => number | Promise<number>> = {
  init: cmdInit,
  add: cmdAdd,
  start: cmdSetStatus,
  done: cmdSetStatus,
  drop: cmdSetStatus,
  archive: cmdArchive,
  status: cmdStatus,
  todo: cmdTodo,
  note: cmdNote,
  did: cmdDid,
  title: cmdTitle,
  uses: cmdUses,
  plan: cmdPlan,
  move: cmdMove,
  public: cmdPublic,
  screen: cmdScreen,
  estimate: cmdEstimate,
  visible: cmdVisible,
  spec: cmdSpec,
  ux: cmdGate,
  review: cmdGate,
  commits: cmdCommits,
  show: cmdShow,
  list: cmdList,
  now: cmdNow,
  quickwins: cmdQuickwins,
  ignore: cmdIgnore,
  'docs-ok': cmdDocsOk,
  check: cmdCheck,
  gantt: cmdGantt,
  hook: cmdHook,
  session: cmdSession,
  deliver: cmdDeliver,
  verify: cmdVerify,
  skills: cmdSkills,
  local: cmdLocal,
  news: cmdNews,
  ref: cmdRef,
};

// Une session d'orchestration ne ferme pas un lot, n'enregistre pas de verdict à la place du lead et ne livre pas.
const LEAD_ONLY = new Set(['done', 'ux', 'review', 'deliver']);

function dispatch(argv: string[], io: Io): number | Promise<number> {
  const { values, positionals } = parseCli(argv);
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    io.out(HELP);
    return 0;
  }
  if (command !== 'session' && command !== 'config' && !(command === 'lead' && !values.all) && (values.all || values.depth !== undefined)) throw new RafError(`${values.all ? '--all' : '--depth'} ne va qu'avec session start ou session close`);
  const today: Day = io.env.RAF_TODAY ?? toDay(io.now());
  if (!isDay(today)) throw new RafError(`RAF_TODAY invalide : ${today} (attendu AAAA-MM-JJ)`);
  const base = { rest, values, io, today, root: gitRoot(io.cwd) ?? io.cwd };
  // Object.hasOwn : « constructor » ou « toString » ne sont pas des commandes.
  const early = Object.hasOwn(BEFORE_PLAN, command) ? BEFORE_PLAN[command]!(base) : null;
  if (early !== null) return early;
  const ctx = buildCtx({ ...base, command });
  if (io.env.CADENCE_ORCHESTRATED && LEAD_ONLY.has(command)) {
    throw new RafError(`${command} refusé pendant une vague orchestrée (${io.env.CADENCE_ORCHESTRATED}) : c'est le travail du lead`);
  }
  if (!Object.hasOwn(WITH_PLAN, command)) throw new RafError(`commande inconnue : ${command} (raf --help)`);
  return WITH_PLAN[command]!(ctx);
}
