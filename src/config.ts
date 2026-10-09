import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { isDay, type Day } from './dates.js';
import type { ArticleRule } from './articles.js';
import type { DocSyncRule } from './docsync.js';
import { gitRoot } from './git.js';
import { FIELDS, RafError, STATUSES, type Field, type PlanFormat, type PlanSettings, type Status } from './plan.js';

export interface PlanConfig {
  /** Chemin du plan, relatif à la racine du dépôt. */
  path?: string;
  settings: PlanSettings;
}

const KEYS = ['path', 'project', 'since', 'ignore', 'files', 'lots', 'fields', 'statuses', 'estimates'];
const FORMAT_KEYS = ['lots', 'fields', 'statuses', 'estimates'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Chemin réel (liens symboliques résolus) du plus proche ancêtre existant, le reste rattaché tel quel. */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(realish(up), basename(p));
  }
}

/**
 * Clé `qa:` : le fichier d'attendus QA, ramené à la forme que git rapporte (relatif à la racine du dépôt,
 * séparateurs posix, sans `./`). Un chemin absolu est lu depuis la racine du dépôt de travail que donne le CLI, à défaut la racine git du dossier du fichier (hors dépôt git, ce dossier). Une valeur vide vaut absente ; un type faux ou un chemin hors du dépôt est refusé.
 */
function readQa(qa: unknown, file: string, workRoot?: string): string | undefined {
  if (qa == null) return undefined;
  if (!isObject(qa)) throw new RafError(`${file} : qa doit être un objet`);
  const v = qa.expectations;
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new RafError(`${file} : qa.expectations doit être un chemin`);
  const raw = v.trim().replace(/\\/g, '/');
  if (raw === '') return undefined;
  const root = workRoot ?? gitRoot(dirname(resolve(file))) ?? dirname(resolve(file));
  const rel = posix.normalize(isAbsolute(raw) ? relative(realish(root), realish(raw)).replace(/\\/g, '/') : raw);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new RafError(`${file} : qa.expectations « ${v.trim()} » est hors du dépôt`);
  return rel;
}

/**
 * Clé `plan:` de cadence.yaml : où est le plan et, s'il est tenu par un autre outil, comment le lire.
 * `root` : la racine du dépôt de travail (celle du CLI), d'où se résout un chemin absolu de `qa.expectations`.
 * Null quand le fichier ou la clé manque — le plan est alors docs/plan/raf.yaml au format de raf.
 */
export function readPlanConfig(file: string, root?: string): PlanConfig | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const doc = raw as { plan?: unknown; qa?: unknown } | null;
  const qa = readQa(doc?.qa, file, root);
  const p = doc?.plan;
  if (p == null) return qa ? { settings: { qaExpectations: qa } } : null;
  const bad = (what: string) => new RafError(`${file} : plan.${what}`);
  if (typeof p === 'string' && p.trim() !== '') return { path: p, settings: { ...(qa ? { qaExpectations: qa } : {}) } };
  if (!isObject(p)) throw new RafError(`${file} : plan doit être un chemin ou un objet`);
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) throw bad(`${k} inconnu (attendu : ${KEYS.join(', ')})`);

  const settings: PlanSettings = {};
  if (qa) settings.qaExpectations = qa;
  if (p.project != null) settings.project = String(p.project);
  if (p.since != null) {
    if (!isDay(p.since)) throw bad(`since « ${String(p.since)} » n'est pas une date AAAA-MM-JJ`);
    settings.since = p.since;
  }
  if (p.ignore != null) settings.ignore = list(p.ignore);
  if (p.files != null) settings.files = list(p.files);
  if (FORMAT_KEYS.some((k) => p[k] != null)) settings.format = parseFormat(p, bad);
  if (p.path != null && String(p.path).trim() === '') throw bad('path est vide');
  return { ...(p.path != null ? { path: String(p.path) } : {}), settings };
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
  return format;
}

export interface NewsConfig {
  /** Longueur maximale (caractères) d'un titre public, celle que la page Plan du site applique au build. Absente : aucune limite déclarée. */
  publicTitleMax?: number;
}

/** Clé `news:` de cadence.yaml. */
export function readNewsConfig(file: string): NewsConfig {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const n = (raw as { news?: unknown } | null)?.news;
  if (n == null) return {};
  if (!isObject(n)) throw new RafError(`${file} : news doit être un objet { publicTitleMax }`);
  for (const k of Object.keys(n)) if (k !== 'publicTitleMax') throw new RafError(`${file} : news.${k} inconnu (attendu : publicTitleMax)`);
  const max = n.publicTitleMax;
  if (max == null) return {};
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) throw new RafError(`${file} : news.publicTitleMax : nombre entier de caractères (≥ 1) attendu`);
  return { publicTitleMax: max };
}

export interface HookConfig {
  /** Que faire d'un commit qui cite un lot encore todo : l'avertir (défaut), le refuser, ou démarrer le lot dans le commit. */
  autostart?: 'warn' | 'refuse' | 'start';
}

const AUTOSTART = ['warn', 'refuse', 'start'];

/** Clé `hook:` de cadence.yaml. */
export function readHookConfig(file: string): HookConfig {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const h = (raw as { hook?: unknown } | null)?.hook;
  if (h == null) return {};
  if (!isObject(h)) throw new RafError(`${file} : hook doit être un objet { autostart }`);
  for (const k of Object.keys(h)) if (k !== 'autostart') throw new RafError(`${file} : hook.${k} inconnu (attendu : autostart)`);
  const a = h.autostart;
  if (a == null) return {};
  if (typeof a !== 'string' || !AUTOSTART.includes(a)) throw new RafError(`${file} : hook.autostart : ${AUTOSTART.join(', ')} attendu`);
  return { autostart: a as HookConfig['autostart'] };
}

export interface SessionConfig {
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
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const s = (raw as { session?: unknown } | null)?.session;
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
  /** Commande de tests du projet, lancée par l'orchestrateur après une implémentation ou une correction. */
  test?: string;
  /** Commande de build du projet, lancée par l'orchestrateur après les tests, et dont le résultat est passé au relecteur. */
  build?: string;
  /**
   * Comment voir l'application pour une revue UX : une URL, une commande de lancement, ou les deux. Avec les deux, c'est
   * l'orchestrateur qui lance la commande (depuis la racine du dépôt) et attend l'URL, `timeout` secondes (300 par défaut).
   */
  ux?: { url?: string; command?: string; timeout?: number };
  /** Contrôle préalable « livrable déjà présent ? » avant la première implémentation d'un lot sans commit (défaut : vrai). */
  precheck: boolean;
  /**
   * Revue proportionnée à la taille du lot (L108) : un lot dont l'estimate est ≤ `threshold` jours reçoit une seule revue
   * (modèle `light`), sans passe des mineurs ; les autres, la chaîne complète (modèle `full`). Un bloquant ou un majeur sur
   * un lot léger déclenche quand même une correction puis une revue `full`.
   */
  review: { threshold: number; light: ReviewModel; full: ReviewModel };
  /** Niveau d'effort (`claude -p --effort`) de chaque passe (L137). `default` : pas de `--effort`, le niveau de la session. `review` vaut aussi pour `review-small`. */
  effort: Record<EffortStep, Effort>;
  permissionMode: string;
  addDirs: string[];
  /** Millisecondes. */
  timeouts: { work: number; review: number };
}

const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_STEPS = ['precheck', 'implement', 'fix', 'review', 'ux'] as const;
export type EffortStep = (typeof EFFORT_STEPS)[number];

const MODELS = ['haiku', 'sonnet', 'opus'] as const;
export type ReviewModel = (typeof MODELS)[number];
const REVIEW_KEYS = ['threshold', 'light', 'full'];

const ORCH_KEYS = ['start', 'verdict', 'test', 'build', 'ux', 'precheck', 'review', 'effort', 'permissionMode', 'addDirs', 'timeouts'];

/** Clé `orchestrate:` de cadence.yaml. Absente : les défauts (auto, 45 min d'implémentation, 25 min de revue). */
export function readOrchestrateConfig(file: string): OrchestrateConfig {
  const config: OrchestrateConfig = { precheck: true, review: { threshold: 0.25, light: 'sonnet', full: 'opus' }, effort: { precheck: 'low', implement: 'medium', fix: 'medium', review: 'high', ux: 'high' }, permissionMode: 'auto', addDirs: [], timeouts: { work: 45 * 60_000, review: 25 * 60_000 } };
  if (!existsSync(file)) return config;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const o = (raw as { orchestrate?: unknown } | null)?.orchestrate;
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
  for (const k of ['start', 'verdict', 'test', 'build'] as const) {
    if (o[k] == null) continue;
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw bad(`${k} : commande non vide attendue`);
    config[k] = (o[k] as string).trim();
  }
  if (o.precheck != null) {
    if (typeof o.precheck !== 'boolean') throw bad('precheck : true ou false attendu');
    config.precheck = o.precheck;
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
      if (!MODELS.includes(m as ReviewModel)) throw bad(`review.${k} : ${MODELS.join(', ')} attendu`);
      config.review[k] = m as ReviewModel;
    }
  }
  if (o.effort != null) {
    if (!isObject(o.effort)) throw bad('effort doit être un objet { precheck, implement, fix, review, ux }');
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

export interface DocsConfig {
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
  if (!existsSync(file)) return none;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
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
