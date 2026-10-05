import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative } from 'node:path';
import { parse } from 'yaml';
import { isDay } from './dates.js';
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

/**
 * Clé `qa:` : le fichier d'attendus QA, ramené à la forme que git rapporte (relatif à la racine du dépôt,
 * séparateurs posix, sans `./`). Une valeur vide vaut absente ; un type faux ou un chemin hors du dépôt est refusé.
 */
function readQa(qa: unknown, file: string): string | undefined {
  if (qa == null) return undefined;
  if (!isObject(qa)) throw new RafError(`${file} : qa doit être un objet`);
  const v = qa.expectations;
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new RafError(`${file} : qa.expectations doit être un chemin`);
  const raw = v.trim().replace(/\\/g, '/');
  if (raw === '') return undefined;
  const root = dirname(file);
  const rel = posix.normalize(isAbsolute(raw) ? relative(root, raw).replace(/\\/g, '/') : raw);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new RafError(`${file} : qa.expectations « ${v.trim()} » est hors du dépôt`);
  return rel;
}

/**
 * Clé `plan:` de cadence.yaml : où est le plan et, s'il est tenu par un autre outil, comment le lire.
 * Null quand le fichier ou la clé manque — le plan est alors docs/plan/raf.yaml au format de raf.
 */
export function readPlanConfig(file: string): PlanConfig | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RafError(`${file} illisible : ${(e as Error).message.split('\n')[0]}`);
  }
  const doc = raw as { plan?: unknown; qa?: unknown } | null;
  const qa = readQa(doc?.qa, file);
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
  /** Comment voir l'application pour une revue UX : une URL, une commande de lancement, ou les deux. */
  ux?: { url?: string; command?: string };
  permissionMode: string;
  addDirs: string[];
  /** Millisecondes. */
  timeouts: { work: number; review: number };
}

const ORCH_KEYS = ['start', 'verdict', 'test', 'ux', 'permissionMode', 'addDirs', 'timeouts'];

/** Clé `orchestrate:` de cadence.yaml. Absente : les défauts (auto, 45 min d'implémentation, 25 min de revue). */
export function readOrchestrateConfig(file: string): OrchestrateConfig {
  const config: OrchestrateConfig = { permissionMode: 'auto', addDirs: [], timeouts: { work: 45 * 60_000, review: 25 * 60_000 } };
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
  if (!isObject(o)) throw new RafError(`${file} : orchestrate doit être un objet`);
  for (const k of Object.keys(o)) if (!ORCH_KEYS.includes(k)) throw bad(`${k} inconnu (attendu : ${ORCH_KEYS.join(', ')})`);
  for (const k of ['start', 'verdict', 'test'] as const) {
    if (o[k] == null) continue;
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw bad(`${k} : commande non vide attendue`);
    config[k] = (o[k] as string).trim();
  }
  if (o.ux != null) {
    if (typeof o.ux === 'string' && o.ux.trim()) config.ux = /^https?:\/\//.test(o.ux.trim()) ? { url: o.ux.trim() } : { command: o.ux.trim() };
    else if (isObject(o.ux) && (o.ux.url != null || o.ux.command != null)) {
      for (const k of Object.keys(o.ux)) if (k !== 'url' && k !== 'command') throw bad(`ux.${k} inconnu (attendu : url, command)`);
      config.ux = {};
      for (const k of ['url', 'command'] as const) if (o.ux[k] != null) config.ux[k] = String(o.ux[k]);
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
