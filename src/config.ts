import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { parse } from 'yaml';
import { isDay, type Day } from './dates.js';
import type { ArticleRule } from './articles.js';
import type { DocSyncRule } from './docsync.js';
import { readGate } from './gate-config.js';
import { DEFAULT_TEST_PATTERNS, type TestGateConfig } from './testgate.js';
import { readExtras, readRequirePlanned } from './plan-extras.js';
import { readQaSettings } from './qa-keys.js';
import { planCommitProblem } from './plan-commit.js';
import { readOnWrite } from './config-onwrite.js';
import { parseStates } from './plan-states.js';
import { checkTestRelated, checkTestReplay, readGateTest, type GateTest } from './orchestrate/gate-parts.js';
import { booleanKey, isObject, list, readYamlFile, readYamlKey } from './yaml-keys.js';
import { FIELDS, Plan, RafError, readIdPattern, STATUSES, type Field, type PlanFormat, type PlanSettings, type Status } from './plan.js';

interface PlanConfig {
  /** Chemin du plan, relatif à la racine du dépôt. */
  path?: string;
  /** Commande qui crée un lot dans un plan en lecture seule (`plan.add`) : `{title}` y est remplacé par le titre, entre guillemets. */
  add?: string;
  /** Gabarit du message des commits de plan écrits par cadence (`plan.commit`, L343) : {lot}, {action}, {vague}. Absent : le message d'avant. */
  commit?: string;
  settings: PlanSettings;
}

const KEYS = ['path', 'project', 'since', 'ignore', 'files', 'lots', 'fields', 'statuses', 'estimates', 'deliveredStatuses', 'add', 'onWrite', 'commit', 'states', 'transitions', 'doneState', 'deliveredState', 'blockedState', 'extras', 'idPattern', 'requirePlanned', 'journal'];
const FORMAT_KEYS = ['lots', 'fields', 'statuses', 'estimates', 'deliveredStatuses'];


/**
 * Clé `plan:` de cadence.yaml : où est le plan et, s'il est tenu par un autre outil, comment le lire.
 * `root` : la racine du dépôt de travail (celle du CLI), d'où se résout un chemin absolu de `qa.expectations`.
 * Null quand le fichier ou la clé manque — le plan est alors .cadence/raf.yaml (ou docs/plan/raf.yaml hérité) au format de raf.
 */
export function readPlanConfig(file: string, root?: string): PlanConfig | null {
  const raw = readYamlFile(file);
  if (raw === undefined) return null;
  const doc = raw as { plan?: unknown; qa?: unknown } | null;
  const qaSettings = readQaSettings(doc?.qa, file, root);
  const p = doc?.plan;
  if (p == null) return Object.keys(qaSettings).length ? { settings: qaSettings } : null;
  const bad = (what: string) => new RafError(`${file} : plan.${what}`);
  if (typeof p === 'string' && p.trim() !== '') return { path: p, settings: qaSettings };
  if (!isObject(p)) throw new RafError(`${file} : plan doit être un chemin ou un objet`);
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) throw bad(`${k} inconnu (attendu : ${KEYS.join(', ')})`);

  const settings: PlanSettings = { ...qaSettings };
  if (p.project != null) settings.project = String(p.project);
  if (p.since != null) {
    if (!isDay(p.since)) throw bad(`since « ${String(p.since)} » n'est pas une date AAAA-MM-JJ`);
    settings.since = p.since;
  }
  if (p.ignore != null) settings.ignore = list(p.ignore);
  if (p.files != null) settings.files = list(p.files);
  if (p.onWrite != null) settings.onWrite = readOnWrite(p.onWrite, root ?? dirname(resolve(file)), bad);
  if (FORMAT_KEYS.some((k) => p[k] != null)) settings.format = parseFormat(p, bad);
  Object.assign(settings, parseStates(p, bad, settings.format !== undefined), readExtras(p.extras, !!settings.format, bad), readIdPattern(p.idPattern, bad), readRequirePlanned(p.requirePlanned, settings.format !== undefined, bad));
  if (p.path != null && String(p.path).trim() === '') throw bad('path est vide');
  if (p.add != null && (typeof p.add !== 'string' || !p.add.includes('{title}'))) throw bad('add doit être une commande qui contient {title}');
  if (p.commit != null) {
    const problem = typeof p.commit === 'string' ? planCommitProblem(p.commit) : 'doit être un gabarit de message';
    if (problem) throw bad(`commit ${problem}`);
  }
  return { ...(p.path != null ? { path: String(p.path) } : {}), ...(p.add != null ? { add: String(p.add) } : {}), ...(p.commit != null ? { commit: String(p.commit) } : {}), settings };
}

export const PLAN_DEFAULT = '.cadence/raf.yaml';
export const PLAN_LEGACY = 'docs/plan/raf.yaml';

/**
 * Le plan par défaut d'un projet (L246) : .cadence/raf.yaml, versionné et jamais publié avec docs/ ; un docs/plan/raf.yaml hérité
 * reste le plan tant qu'il n'est pas déplacé et que .cadence/raf.yaml n'existe pas. `legacy` : le plan hérité existe (lu, ou ignoré
 * quand les deux existent) — c'est à l'appelant d'en parler.
 */
export function defaultPlan(root: string): { path: string; legacy: 'read' | 'ignored' | null } {
  const legacy = existsSync(join(root, PLAN_LEGACY));
  if (existsSync(join(root, PLAN_DEFAULT))) return { path: join(root, PLAN_DEFAULT), legacy: legacy ? 'ignored' : null };
  return { path: join(root, legacy ? PLAN_LEGACY : PLAN_DEFAULT), legacy: legacy ? 'read' : null };
}

/**
 * Le chargeur du plan du projet dont `root` est la racine : le `cadence.yaml` est lu tout de suite (une erreur sort ici), le plan à
 * chaque appel. Une seule lecture de « où est le plan et comment le lire » pour l'orchestrateur, `lead tour` et le tirage de `--continue`.
 */
export function planLoader(root: string): () => Plan {
  const configPath = join(root, 'cadence.yaml');
  const planConfig = readPlanConfig(configPath, root);
  // Le défaut est résolu à chaque appel : un plan déplacé (git mv) pendant une vague est suivi.
  return () => Plan.load(planConfig?.path ? resolve(root, planConfig.path) : defaultPlan(root).path, { ...planConfig?.settings, config: configPath });
}

function parseFormat(p: Record<string, unknown>, bad: (what: string) => RafError): PlanFormat {
  const format: PlanFormat = { lots: p.lots == null ? 'lots' : String(p.lots), fields: {}, statuses: {}, estimates: {} };
  for (const key of ['fields', 'statuses', 'estimates']) if (p[key] != null && !isObject(p[key])) throw bad(`${key} doit être un objet`);

  for (const [field, keys] of Object.entries((p.fields ?? {}) as Record<string, unknown>)) {
    if (!FIELDS.includes(field as Field)) throw bad(`fields.${field} inconnu (attendu : ${FIELDS.join(', ')})`);
    format.fields[field as Field] = list(keys);
  }
  for (const [status, theirs] of Object.entries((p.statuses ?? {}) as Record<string, unknown>)) {
    if (!STATUSES.includes(status as Status)) throw bad(`statuses.${status} inconnu (attendu : ${STATUSES.join(', ')})`);
    for (const s of list(theirs)) {
      if (format.statuses[s] && format.statuses[s] !== status) throw bad(`statuses : « ${s} » correspond à deux statuts`);
      format.statuses[s] = status as Status;
    }
  }
  for (const [label, days] of Object.entries((p.estimates ?? {}) as Record<string, unknown>)) {
    if (typeof days !== 'number' || !(days > 0)) throw bad(`estimates.${label} doit être un nombre de jours positif`);
    format.estimates[label] = days;
  }
  const delivered = list(p.deliveredStatuses);
  for (const s of delivered) if (!Object.hasOwn(format.statuses, s)) throw bad(`deliveredStatuses : « ${s} » n'est pas un état de plan.statuses`);
  if (delivered.length) format.deliveredStatuses = delivered;
  return format;
}

interface NewsConfig {
  /** Longueur maximale (caractères) d'un titre public, celle que la page Plan du site applique au build. Absente : aucune limite déclarée. */
  publicTitleMax?: number;
}

/** Clé `news:` de cadence.yaml. */
export function readNewsConfig(file: string): NewsConfig {
  const n = readYamlKey(file, 'news');
  if (n == null) return {};
  if (!isObject(n)) throw new RafError(`${file} : news doit être un objet { publicTitleMax }`);
  for (const k of Object.keys(n)) if (k !== 'publicTitleMax') throw new RafError(`${file} : news.${k} inconnu (attendu : publicTitleMax)`);
  if (n.publicTitleMax == null) return {};
  if (typeof n.publicTitleMax !== 'number' || !Number.isInteger(n.publicTitleMax) || n.publicTitleMax < 1) throw new RafError(`${file} : news.publicTitleMax : nombre entier de caractères (≥ 1) attendu`);
  return { publicTitleMax: n.publicTitleMax };
}

interface HookConfig {
  /** Que faire d'un commit qui cite un lot encore todo : l'avertir (défaut), le refuser, ou démarrer le lot dans le commit. */
  autostart?: 'warn' | 'refuse' | 'start';
}

const AUTOSTART = ['warn', 'refuse', 'start'];

/** Clé `hook:` de cadence.yaml. */
export function readHookConfig(file: string): HookConfig {
  const h = readYamlKey(file, 'hook');
  if (h == null) return {};
  if (!isObject(h)) throw new RafError(`${file} : hook doit être un objet { autostart }`);
  for (const k of Object.keys(h)) if (k !== 'autostart') throw new RafError(`${file} : hook.${k} inconnu (attendu : autostart)`);
  const a = h.autostart;
  if (a == null) return {};
  if (typeof a !== 'string' || !AUTOSTART.includes(a)) throw new RafError(`${file} : hook.autostart : ${AUTOSTART.join(', ')} attendu`);
  return { autostart: a as HookConfig['autostart'] };
}

interface SessionConfig {
  /** Commande sh, à la racine du dépôt, dont la sortie complète « cadence session start ». */
  start?: string;
  /** Idem pour « cadence session close ». */
  close?: string;
  /** Motifs (chemin ou `*` dans un nom ; `~` et chemins relatifs à la racine admis) des fichiers de travail à proposer au nettoyage de clôture. */
  clean?: string[];
  /** Âge, en jours, au-delà duquel un élément de `clean` est jugé périmé (7 par défaut). */
  cleanDays?: number;
}

/**
 * Clé `session:` de cadence.yaml : les faits propres au projet (son script de reprise, de clôture),
 * joués par cadence au lieu d'être remplacés.
 */
export function readSessionConfig(file: string): SessionConfig {
  const s = readYamlKey(file, 'session');
  if (s == null) return {};
  if (!isObject(s)) throw new RafError(`${file} : session doit être un objet { start, close, clean, cleanDays }`);
  const config: SessionConfig = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'clean') {
      if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !p.trim())) throw new RafError(`${file} : session.clean : liste de motifs non vides attendue`);
      config.clean = v.map((p: string) => p.trim());
    } else if (k === 'cleanDays') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new RafError(`${file} : session.cleanDays : nombre entier de jours (≥ 1) attendu`);
      config.cleanDays = v;
    } else if (k === 'start' || k === 'close') {
      if (typeof v !== 'string' || !v.trim()) throw new RafError(`${file} : session.${k} : commande non vide attendue`);
      config[k] = v.trim();
    } else throw new RafError(`${file} : session.${k} inconnu (attendu : start, close, clean, cleanDays)`);
  }
  return config;
}

export interface OrchestrateConfig {
  /** Plan en lecture seule : commande (sh, racine du dépôt) qui démarre un lot ; `{lot}` y est remplacé. */
  start?: string;
  /** Commande qui note le verdict de la revue de code ; `{lot}` et `{verdict}` y sont remplacés. */
  verdict?: string;
  /** Commande de tests du projet, lancée par l'orchestrateur après une implémentation ou une correction ; ou la liste de ses parties `{ dir, run, replay? }` (L512), chacune jouée dans son dossier, chaque rouge attribué à la partie qui l'a imprimé. */
  test?: GateTest;
  /**
   * Commande de rejeu seul d'un test rouge de la porte (L354), où `{files}` est remplacé par les fichiers des tests rouges. Absente : aucun rejeu, un rouge est compté tel quel
   * et rien n'est tenu pour instable (cadence ne devine pas comment rejouer un fichier sur le lanceur du projet, une porte composée comprise).
   */
  testReplay?: string;
  /**
   * Commande des tests liés aux fichiers modifiés du lot (L590), où `{files}` est remplacé par ces fichiers : jouée à la place de `orchestrate.test` après chaque écriture (implement, fix, sonde) ;
   * la suite complète n'est jouée qu'à l'intégration. Absente : dérivée de `orchestrate.test` quand c'est `[npx ]vitest run[ options]`, sinon la suite complète est jouée à chaque porte, comme avant.
   */
  testRelated?: string;
  /** Commande de build du projet, lancée par l'orchestrateur après les tests, et dont le résultat est passé au relecteur. */
  build?: string;
  /**
   * Dépendances non suivies à copier dans le worktree jetable de `cadence verify --gate` (L348, L389) et à lier dans l'arbre d'essai de la porte « test vert sans le code » (L646, `testsVertsSansCode`), chemins relatifs au dépôt (`node_modules`, `.venv`, `front/node_modules`…).
   * Absente : pour `verify --gate`, les `node_modules` de tout niveau et le `.venv` sont copiés ; les autres dossiers ignorés sont reliés, comme pour les worktrees de vague. Pour l'arbre d'essai, seul le `node_modules` de la racine est lié.
   */
  worktreeDeps?: string[];
  /**
   * `gate.readsPlan` (L450) : un test de la porte lit le plan du projet (`true`, ou la liste des chemins des tests qui le lisent : avec `testReplay` et une porte de vague enregistrée dessous, ces chemins et les tests détectés hors liste sont les seuls fichiers rejoués sous un commit de plan seul, L566, sauf si du code hors tests cite le plan). `cadence verify --gate` ne reprend alors plus le verdict
   * d'une vague sous des commits qui ne changent que le plan (L444) : un `raf done` change ce que ce test lit, la porte est rejouée. Absente : ces commits sont traversés.
   */
  gate?: {
    readsPlan?: true | string[];
    /**
     * `gate.host` (L403) : destination ssh où jouer la porte (`machine`, `user@machine`), au sha poussé, avec repli local. Absente, la porte est locale, inchangée.
     * Le déclarer seul ne vaut pas `readsPlan`.
     */
    host?: string;
    /**
     * `gate.overflow` (L639) : destination ssh de l'hôte de débordement. La porte joue d'abord en local quand aucune porte locale ne tient la machine, sinon sur cet hôte s'il répond
     * (décision prise une fois par lot, sonde ConnectTimeout 3) ; injoignable, elle attend le tour local. Refusée avec `host` : l'une ou l'autre.
     */
    overflow?: string;
    /** `gate.install` (L403) : commande qui installe les dépendances, jouée sur l'hôte dans un worktree au sha pour remplir le cache de l'empreinte des lockfiles. */
    install?: string;
    /** `gate.refs` (L617) : références git (`main`, `origin/main`…) poussées avec le sha, pour qu'une commande de la porte qui les lit (merge-base, diff contre main) les trouve sur l'hôte. */
    refs?: string[];
    /** `gate.maxParallel` (L624) : portes simultanées au plus sur l'hôte (entier positif ; défaut 2) ; la suivante attend qu'une porte libère l'hôte. Sans effet sans `host` ni `overflow` (L639 : borne alors les portes de l'hôte de débordement). */
    maxParallel?: number;
  };
  /**
   * Commande dédiée de l'étape accept (L173, spec etape-spec S5) : ne lance QUE les tests d'acceptation du lot (config du lanceur
   * `*.acceptation.config.*` qui lit `CADENCE_ACCEPTATION`, chemin de l'acceptation-<lot>.json du lot, aussi substitué à `{acceptation}`).
   * Une LISTE de commandes (L189, spec etape-spec-back B4) pour un projet à plusieurs lanceurs (front Vitest, back Jest) : chacune ne prend que les
   * fichiers listés sous sa racine (le dossier de son `cd <dossier> &&` initial, sinon le dépôt), `CADENCE_ACCEPTATION_ROOT` la lui donne.
   * Absente : l'étape accept n'a pas lieu (un lot avec fiche passe de spec à implement).
   */
  accept?: string | string[];
  /**
   * Comment voir l'application pour une revue UX : une URL, une commande de lancement, ou les deux. Avec les deux, c'est
   * l'orchestrateur qui lance la commande (depuis la racine du dépôt) et attend l'URL, `timeout` secondes (300 par défaut).
   */
  ux?: { url?: string; command?: string; timeout?: number };
  /**
   * Porte « code modifié sans test » (L287), avant la revue : le diff du lot touche du code (`code`, hors `except`) sans aucun fichier de
   * test (`tests`) → une passe de correction directe, sans session de revue. Une seule fois par lot. Absente : pas de porte.
   */
  testGate?: TestGateConfig;
  /** Contrôle préalable « livrable déjà présent ? » avant la première implémentation d'un lot sans commit (défaut : vrai). */
  precheck: boolean;
  /** Revue UX de la maquette (L172, spec etape-spec S4) entre spec et accept ; `maquette: false` la saute (défaut : vrai). */
  maquette: boolean;
  /** Nombre de revues de la maquette par lot (L230), entier ≥ 1 ; c'est aussi le plafond de sessions `spec` d'un lot à écran (défaut : 3). */
  maquetteReviews: number;
  /** Revue de la fiche back (L188, spec etape-spec-back B3) entre spec et accept par `code-reviewer` en mode fiche ; `fiche: false` la saute (défaut : vrai). */
  fiche: boolean;
  /** `precheck: local` (L146) : le contrôle préalable part sur `claude-local` (Ollama de Big-Blue) ; Sonnet reste le repli. */
  precheckLocal: boolean;
  /** Sonde de cas limites (L497) entre l'écriture et la revue : une session Sonnet neuve cherche à casser le lot par des tests aux bornes. Absente ou `false` : rien ne change. */
  probe?: boolean;
  /**
   * Les sessions de vague ont accès à la production (L168) ? Défaut : non, elles partent sans kubeconfig
   * (`KUBECONFIG=/dev/null`) ni jeton de prod. `true` lève la restriction pour ce projet.
   */
  prodAccess: boolean;
  /**
   * Un worktree par lot (L279) : deux lots indépendants d'un même dépôt jouent en parallèle, chacun dans son worktree, intégrés un par un à la
   * branche du dépôt. Défaut : non (une file par dépôt, lots à la suite dans le dépôt).
   */
  worktrees: boolean;
  /**
   * Étape spec (L169, spec etape-spec) : `dir` = dossier des specs d'écran du projet cible, relatif à la racine du dépôt
   * (défaut `docs/specs`, un sous-dossier par écran) ; `render` = commande de rendu des maquettes, donnée à la session de l'étape spec (L171).
   */
  spec: { dir: string; render?: string };
  /**
   * Revue proportionnée à la taille du lot (L108) : un lot dont l'estimate est ≤ `threshold` jours reçoit une seule revue
   * (modèle `light`), sans passe des mineurs ; les autres, la chaîne complète (modèle `full`). Un bloquant ou un majeur sur
   * un lot léger déclenche quand même une correction puis une revue `full`.
   */
  /** `light` et `full` : un alias (haiku, sonnet, opus) ou un nom de modèle libre, passé tel quel à `claude --model` (L345). */
  review: { threshold: number; light: string; full: string };
  /**
   * Escalade de modèle (L337) : quand la revue reste non conforme après les passes prévues (ou que les tests restent rouges), la vague joue UNE correction puis UNE revue neuve
   * avec ce modèle avant de rendre le lot. `model` est passé tel quel à `claude --model` (pas de liste fermée : le compte n'a pas forcément tous les modèles). Absent : pas d'escalade.
   */
  escalation?: { model: string };
  /**
   * Prélèvement de budget à la dernière passe (L584) : quand un lot dont la revue converge n'a plus de quoi payer « correction + revue courte », la vague relève son budget du manque,
   * dans la limite de ce plafond (tokens comptés, cumulé sur le lot). `0` désactive : le lot est rendu « correction non jouée (budget) » comme avant (défaut : 300000).
   */
  budgetTopUp: number;
  /**
   * Réglage du tirage de `--continue` pour ce projet (L390) : `maxEstimate` (en jours) écarte les lots dont l'estimate le dépasse, `exclude` écarte les lots listés (leurs numéros).
   * Ne touche que le tirage : un lot donné sur la ligne de commande se joue quoi qu'il en soit. Absent : tout lot prêt est tirable.
   */
  continue?: { maxEstimate?: number; exclude?: string[] };
  /** Niveau d'effort (`claude -p --effort`) de chaque passe (L137). `default` : pas de `--effort`, le niveau de la session. `review` vaut aussi pour `review-small`. */
  effort: Record<EffortStep, Effort>;
  permissionMode: string;
  addDirs: string[];
  /** Millisecondes. */
  timeouts: { work: number; review: number };
}

const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
const EFFORT_STEPS = ['precheck', 'spec', 'maquette', 'fiche', 'accept', 'implement', 'probe', 'fix', 'review', 'ux'] as const;
export type EffortStep = (typeof EFFORT_STEPS)[number];

/** Clé `verify:` de cadence.yaml (L389). */
export interface VerifyConfig {
  /**
   * Où `cadence verify --gate` joue la porte : absent, dans l'arbre principal quand il est propre et à ce sha, sinon dans une copie jetable aux dépendances copiées ;
   * `true` exige l'arbre principal (refus s'il n'est pas propre au sha), `false` joue toujours dans la copie jetable.
   */
  inPlace?: boolean;
}

/** Clé `verify:` de cadence.yaml. Absente : `{}`. */
export function readVerifyConfig(file: string): VerifyConfig {
  const v = readYamlKey(file, 'verify');
  if (v == null) return {};
  if (!isObject(v)) throw new RafError(`${file} : verify doit être un objet { inPlace }`);
  for (const k of Object.keys(v)) if (k !== 'inPlace') throw new RafError(`${file} : verify.${k} inconnu (attendu : inPlace)`);
  if (v.inPlace == null) return {};
  if (typeof v.inPlace !== 'boolean') throw new RafError(`${file} : verify.inPlace : true ou false attendu`);
  return { inPlace: v.inPlace };
}

const REVIEW_KEYS = ['threshold', 'light', 'full'];

const ORCH_KEYS = ['start', 'verdict', 'test', 'testReplay', 'testRelated', 'build', 'worktreeDeps', 'gate', 'accept', 'maquette', 'maquetteReviews', 'fiche', 'ux', 'precheck', 'probe', 'prodAccess', 'worktrees', 'testGate', 'spec', 'review', 'escalation', 'budgetTopUp', 'continue', 'effort', 'permissionMode', 'addDirs', 'timeouts'];

/** Un entier d'au moins `min`, sinon l'erreur donnée. */
const integerAtLeast = (v: unknown, min: number, error: RafError): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw error;
  return v;
};

/** Clé `orchestrate:` de cadence.yaml. Absente : les défauts (auto, 45 min d'implémentation, 25 min de revue). */
export function readOrchestrateConfig(file: string): OrchestrateConfig {
  const config: OrchestrateConfig = { precheck: true, maquette: true, maquetteReviews: 3, budgetTopUp: 300_000, fiche: true, precheckLocal: false, prodAccess: false, worktrees: false, spec: { dir: 'docs/specs' }, review: { threshold: 0.25, light: 'sonnet', full: 'opus' }, effort: { precheck: 'low', spec: 'medium', maquette: 'high', fiche: 'medium', accept: 'medium', implement: 'medium', probe: 'medium', fix: 'medium', review: 'high', ux: 'high' }, permissionMode: 'auto', addDirs: [], timeouts: { work: 45 * 60_000, review: 25 * 60_000 } };
  const o = readYamlKey(file, 'orchestrate');
  if (o == null) return config;
  const bad = (what: string) => new RafError(`${file} : orchestrate.${what}`);
  const checkUxUrl = (url: string) => {
    try {
      new URL(url);
    } catch {
      throw bad(`ux.url : URL invalide (reçu « ${url} »)`);
    }
  };
  if (!isObject(o)) throw new RafError(`${file} : orchestrate doit être un objet`);
  for (const k of Object.keys(o)) if (!ORCH_KEYS.includes(k)) throw bad(`${k} inconnu (attendu : ${ORCH_KEYS.join(', ')})`);
  if (o.accept != null && Array.isArray(o.accept)) {
    if (!o.accept.length || o.accept.some((x) => typeof x !== 'string' || !x.trim())) throw bad('accept : commande non vide attendue (chaîne ou liste de commandes non vides)');
    config.accept = o.accept.map((x: string) => x.trim());
  }
  if (o.test != null) config.test = readGateTest(o.test, bad);
  for (const k of ['start', 'verdict', 'testReplay', 'testRelated', 'build', 'accept'] as const) {
    if (k === 'accept' && Array.isArray(o.accept)) continue;
    if (o[k] == null) continue;
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw bad(`${k} : commande non vide attendue`);
    config[k] = (o[k] as string).trim();
  }
  checkTestReplay(config.test, config.testReplay, bad);
  checkTestRelated(config.test, config.testRelated, bad);
  if (o.worktreeDeps != null) {
    const deps = o.worktreeDeps;
    if (!Array.isArray(deps) || !deps.length || deps.some((x) => typeof x !== 'string' || !x.trim() || isAbsolute(x) || x.split(/[\\/]/).includes('..'))) throw bad('worktreeDeps : liste de chemins relatifs au dépôt, sans « .. » (node_modules, .venv…)');
    config.worktreeDeps = deps.map((x: string) => x.trim().replace(/\/$/, ''));
  }
  if (o.gate != null) config.gate = readGate(o.gate, bad);
  if (o.maquette != null) {
    if (typeof o.maquette !== 'boolean') throw bad('maquette : true ou false attendu');
    config.maquette = o.maquette;
  }
  if (o.maquetteReviews != null) config.maquetteReviews = integerAtLeast(o.maquetteReviews, 1, bad('maquetteReviews : entier supérieur ou égal à 1 attendu'));
  if (o.budgetTopUp != null) config.budgetTopUp = integerAtLeast(o.budgetTopUp, 0, bad('budgetTopUp : entier de tokens supérieur ou égal à 0 attendu (0 désactive le prélèvement)'));
  for (const k of ['fiche', 'probe'] as const) if (o[k] != null) config[k] = booleanKey(o[k], bad(`${k} : true ou false attendu`));
  if (o.precheck != null) {
    if (typeof o.precheck !== 'boolean' && o.precheck !== 'local') throw bad('precheck : true, false ou local attendu');
    config.precheck = o.precheck !== false;
    config.precheckLocal = o.precheck === 'local';
  }
  if (o.prodAccess != null) {
    if (typeof o.prodAccess !== 'boolean') throw bad('prodAccess : true ou false attendu');
    config.prodAccess = o.prodAccess;
  }
  if (o.worktrees != null) {
    if (typeof o.worktrees !== 'boolean') throw bad('worktrees doit être true ou false');
    config.worktrees = o.worktrees;
  }
  if (o.testGate != null && o.testGate !== false) {
    const g = o.testGate;
    if (!isObject(g)) throw bad('testGate doit être false ou un objet { code, tests, except, threshold }');
    for (const k of Object.keys(g)) if (!['code', 'tests', 'except', 'threshold'].includes(k)) throw bad(`testGate.${k} inconnu (attendu : code, tests, except, threshold)`);
    const patterns = (key: 'code' | 'tests' | 'except', fallback: string[] | null): string[] => {
      if (g[key] == null) {
        if (fallback) return fallback;
        throw bad(`testGate.${key} : au moins un motif de chemin attendu`);
      }
      const v = list(g[key]);
      if (v.some((x) => !x.trim()) || (key !== 'except' && !v.length)) throw bad(`testGate.${key} : motifs de chemin non vides attendus`);
      return v.map((x) => x.trim());
    };
    const threshold = g.threshold ?? 1;
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) throw bad('testGate.threshold : entier supérieur ou égal à 1 attendu');
    config.testGate = { code: patterns('code', null), tests: patterns('tests', DEFAULT_TEST_PATTERNS), except: patterns('except', []), threshold };
  }
  if (o.spec != null) {
    if (!isObject(o.spec)) throw bad('spec doit être un objet { dir, render }');
    for (const k of Object.keys(o.spec)) if (k !== 'dir' && k !== 'render') throw bad(`spec.${k} inconnu (attendu : dir, render)`);
    if (o.spec.dir != null) {
      const raw = typeof o.spec.dir === 'string' ? o.spec.dir.trim().replace(/\/+$/, '') : '';
      const d = raw === '' ? '' : posix.normalize(raw).replace(/\/+$/, '');
      if (d === '' || isAbsolute(d) || d.split(/[\\/]/).includes('..')) throw bad('spec.dir : chemin relatif non vide au dépôt attendu, sans « .. »');
      config.spec.dir = d;
    }
    if (o.spec.render != null) {
      if (typeof o.spec.render !== 'string' || !o.spec.render.trim()) throw bad('spec.render : commande non vide attendue');
      config.spec.render = o.spec.render.trim();
    }
  }
  if (o.review != null) {
    if (!isObject(o.review)) throw bad('review doit être un objet { threshold, light, full }');
    for (const k of Object.keys(o.review)) if (!REVIEW_KEYS.includes(k)) throw bad(`review.${k} inconnu (attendu : ${REVIEW_KEYS.join(', ')})`);
    const t = o.review.threshold;
    if (t != null) {
      if (typeof t !== 'number' || !(t >= 0)) throw bad('review.threshold : nombre de jours positif ou nul attendu');
      config.review.threshold = t;
    }
    for (const k of ['light', 'full'] as const) {
      const m = o.review[k];
      if (m == null) continue;
      if (typeof m !== 'string' || !m.trim()) throw bad(`review.${k} : nom de modèle non vide attendu (haiku, sonnet, opus ou un nom passé tel quel à claude --model)`);
      config.review[k] = m.trim();
    }
  }
  if (o.escalation != null) {
    if (!isObject(o.escalation)) throw bad('escalation doit être un objet { model }');
    for (const k of Object.keys(o.escalation)) if (k !== 'model') throw bad(`escalation.${k} inconnu (attendu : model)`);
    const m = o.escalation.model;
    if (typeof m !== 'string' || !m.trim()) throw bad('escalation.model : nom de modèle non vide attendu (passé tel quel à claude --model)');
    config.escalation = { model: m.trim() };
  }
  if (o.continue != null) {
    if (!isObject(o.continue)) throw bad('continue doit être un objet { maxEstimate, exclude }');
    for (const k of Object.keys(o.continue)) if (!['maxEstimate', 'exclude'].includes(k)) throw bad(`continue.${k} inconnu (attendu : maxEstimate, exclude)`);
    const { maxEstimate, exclude } = o.continue;
    const setting: NonNullable<OrchestrateConfig['continue']> = {};
    if (maxEstimate != null) {
      if (typeof maxEstimate !== 'number' || !(maxEstimate > 0)) throw bad('continue.maxEstimate : nombre de jours strictement positif attendu');
      setting.maxEstimate = maxEstimate;
    }
    if (exclude != null) {
      if (!Array.isArray(exclude) || exclude.some((x) => typeof x !== 'string' || !x.trim())) throw bad('continue.exclude : liste de numéros de lots non vides attendue (ex. [L12, L40])');
      setting.exclude = exclude.map((x: string) => x.trim());
    }
    config.continue = setting;
  }
  if (o.effort != null) {
    if (!isObject(o.effort)) throw bad('effort doit être un objet { precheck, spec, maquette, fiche, accept, implement, probe, fix, review, ux }');
    for (const [k, v] of Object.entries(o.effort)) {
      if (!(EFFORT_STEPS as readonly string[]).includes(k)) throw bad(`effort.${k} inconnu (attendu : ${EFFORT_STEPS.join(', ')})`);
      if (!EFFORTS.includes(v as Effort)) throw bad(`effort.${k} : ${EFFORTS.join(', ')} attendu`);
      config.effort[k as EffortStep] = v as Effort;
    }
  }
  if (o.ux != null) {
    if (typeof o.ux === 'string' && o.ux.trim()) {
      const u = o.ux.trim();
      if (/^https?:\/\//.test(u)) checkUxUrl(u);
      config.ux = /^https?:\/\//.test(u) ? { url: u } : { command: u };
    }
    else if (isObject(o.ux) && (o.ux.url != null || o.ux.command != null)) {
      for (const k of Object.keys(o.ux)) if (k !== 'url' && k !== 'command' && k !== 'timeout') throw bad(`ux.${k} inconnu (attendu : url, command, timeout)`);
      config.ux = {};
      for (const k of ['url', 'command'] as const) if (o.ux[k] != null) config.ux[k] = String(o.ux[k]);
      if (config.ux.url != null && !/^https?:\/\//.test(config.ux.url)) throw bad(`ux.url : une URL http(s) attendue (reçu « ${config.ux.url} »)`);
      if (config.ux.url != null) checkUxUrl(config.ux.url);
      if (o.ux.timeout != null) {
        if (config.ux.url == null || config.ux.command == null) throw bad('ux.timeout : réservé à la forme { command ET url } (le programme n\'attend la réponse que quand il lance l\'application)');
        if (typeof o.ux.timeout !== 'number' || !(o.ux.timeout > 0)) throw bad('ux.timeout : nombre de secondes positif attendu');
        config.ux.timeout = o.ux.timeout;
      }
    } else throw bad('ux : une URL, une commande, ou { url, command }');
  }
  if (o.permissionMode != null) {
    if (typeof o.permissionMode !== 'string' || !o.permissionMode.trim()) throw bad('permissionMode : texte non vide attendu');
    config.permissionMode = o.permissionMode.trim();
  }
  if (o.addDirs != null) config.addDirs = list(o.addDirs);
  if (o.timeouts != null) {
    if (!isObject(o.timeouts)) throw bad('timeouts doit être un objet { implement, review } (minutes)');
    for (const [k, v] of Object.entries(o.timeouts)) {
      if (k !== 'implement' && k !== 'review') throw bad(`timeouts.${k} inconnu (attendu : implement, review)`);
      if (typeof v !== 'number' || !(v > 0)) throw bad(`timeouts.${k} : nombre de minutes positif attendu`);
      config.timeouts[k === 'implement' ? 'work' : 'review'] = v * 60_000;
    }
  }
  return config;
}

interface DocsConfig {
  /** Paires « chemins modifiés → documents à toucher » (L143). */
  sync: DocSyncRule[];
  /** Articles d'un dépôt voisin rafraîchis à la livraison (L144) ; absent : aucun. */
  articles?: ArticleRule[];
  /** Jour à partir duquel (inclus) un lot terminé est audité (les lots en cours le sont toujours). Absent : aucun lot terminé. */
  since?: Day;
}

const DOCS_KEYS = ['sync', 'since', 'articles'];

/** Clé `docs:` de cadence.yaml : `docs.sync`, la documentation qui doit suivre le code. */
export function readDocsConfig(file: string): DocsConfig {
  const none: DocsConfig = { sync: [] };
  const raw = readYamlFile(file);
  if ((raw as { describedBy?: unknown } | null)?.describedBy != null) {
    throw new RafError(`${file} : describedBy n'existe plus (L308) : les documents hors dépôt se déclarent dans docs.articles, { repo, file } relatif au projet`);
  }
  const d = (raw as { docs?: unknown } | null)?.docs;
  if (d == null) return none;
  const bad = (what: string) => new RafError(`${file} : docs.${what}`);
  if (!isObject(d)) throw new RafError(`${file} : docs doit être un objet { sync, since, articles }`);
  for (const k of Object.keys(d)) if (!DOCS_KEYS.includes(k)) throw bad(`${k} inconnu (attendu : ${DOCS_KEYS.join(', ')})`);
  const config: DocsConfig = { sync: [] };
  if (d.since != null) {
    if (!isDay(d.since)) throw bad(`since « ${String(d.since)} » n'est pas une date AAAA-MM-JJ`);
    config.since = d.since;
  }
  if (d.sync != null) {
    if (!Array.isArray(d.sync)) throw bad('sync doit être une liste de { paths, docs }');
    d.sync.forEach((r: unknown, i: number) => {
      if (!isObject(r)) throw bad(`sync[${i}] doit être un objet { paths, docs }`);
      for (const k of Object.keys(r)) if (k !== 'paths' && k !== 'docs') throw bad(`sync[${i}].${k} inconnu (attendu : paths, docs)`);
      const entry = (key: 'paths' | 'docs') => {
        const v = list(r[key]);
        if (!v.length || v.some((x) => !x.trim())) throw bad(`sync[${i}].${key} : au moins un chemin non vide attendu`);
        return v.map((x) => x.trim());
      };
      config.sync.push({ paths: entry('paths'), docs: entry('docs') });
    });
  }
  if (d.articles != null) {
    if (!Array.isArray(d.articles)) throw bad('articles doit être une liste de { repo, file }');
    config.articles = d.articles.map((r: unknown, i: number) => {
      if (!isObject(r)) throw bad(`articles[${i}] doit être un objet { repo, file }`);
      for (const k of Object.keys(r)) if (!['repo', 'file', 'name'].includes(k)) throw bad(`articles[${i}].${k} inconnu (attendu : repo, file, name)`);
      const text = (key: 'repo' | 'file' | 'name') => {
        const v = r[key];
        if (typeof v !== 'string' || !v.trim()) throw bad(`articles[${i}].${key} : texte non vide attendu`);
        return v.trim();
      };
      return { repo: text('repo'), file: text('file'), ...(r.name != null ? { name: text('name') } : {}) };
    });
  }
  return config;
}

interface ReferencesConfig {
  /** Dossier des documents de référence (cadence ref), relatif au dossier du cadence.yaml. */
  dir?: string;
}

/** Clé `references:` de cadence.yaml. */
export function readReferencesConfig(file: string): ReferencesConfig {
  const r = readYamlKey(file, 'references');
  if (r == null) return {};
  if (!isObject(r)) throw new RafError(`${file} : references doit être un objet { dir }`);
  for (const k of Object.keys(r)) if (k !== 'dir') throw new RafError(`${file} : references.${k} inconnu (attendu : dir)`);
  if (r.dir == null) return {};
  if (typeof r.dir !== 'string' || r.dir.trim() === '') throw new RafError(`${file} : references.dir : chemin attendu`);
  return { dir: r.dir.trim() };
}

interface MigrateConfig {
  /** Motifs de chemins (comme docs.sync) des fichiers que `raf migrate` laisse tels quels : ils citent docs/plan/raf.yaml sans le lire. */
  keep: string[];
}

/** Clé `migrate:` de cadence.yaml (L284) : `migrate.keep`. */
export function readMigrateConfig(file: string): MigrateConfig {
  const none: MigrateConfig = { keep: [] };
  const m = readYamlKey(file, 'migrate');
  if (m == null) return none;
  if (!isObject(m)) throw new RafError(`${file} : migrate doit être un objet { keep }`);
  for (const k of Object.keys(m)) if (k !== 'keep') throw new RafError(`${file} : migrate.${k} inconnu (attendu : keep)`);
  if (m.keep == null) return none;
  if (!Array.isArray(m.keep) || m.keep.some((x) => typeof x !== 'string' || !x.trim())) throw new RafError(`${file} : migrate.keep doit être une liste de chemins ou de motifs non vides`);
  return { keep: m.keep.map((x: string) => x.trim()) };
}
