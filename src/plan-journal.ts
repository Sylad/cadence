// plan.journal (L582, M10) : le journal d'événements d'un plan tenu par un autre outil (ndjson, une ligne par fait), lu dans cadence.yaml et réécrit par `raf import --to-config`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Day } from './dates.js';
import { RafError, type PlanFormat } from './plan.js';
import { isObject, readYamlKey } from './yaml-keys.js';

type Entry = Record<string, unknown>;

/** Les faits du natif que le journal sait dire ; un fait dont le type n'est pas déclaré ne s'écrit pas. */
const JOURNAL_KINDS = ['created', 'started', 'state', 'note', 'closed', 'delivered'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
const KEY_NAMES = ['at', 'task', 'type', 'message', 'sha'] as const;
type KeyName = (typeof KEY_NAMES)[number];

export interface JournalFormat {
  /** Chemin du fichier, relatif à la racine du dépôt ; `journal.ndjson` à la racine par défaut. */
  path: string;
  /** Clé de chaque donnée d'une ligne ; le nom de la donnée par défaut (`at`, `task`, `type`, `message`) ; `sha` n'est écrit que pour les livraisons, et seulement s'il est déclaré. */
  keys: Partial<Record<KeyName, string>>;
  /** Fait du natif → type d'événement de l'autre outil. */
  types: Partial<Record<JournalKind, string>>;
  /** Clés constantes ajoutées à chaque ligne écrite (`source`, `sha: null`…), après les quatre clés de base ; aucune ne porte le nom d'une clé de base (refusé à la lecture). */
  extra: Entry;
}

/** Une table de noms (`types`, `keys`) : chaque clé dans `allowed`, chaque valeur un texte non vide ; le refus nomme `journal.<what>.<clé>`. */
function names<K extends string>(value: unknown, allowed: readonly K[], what: string, bad: (what: string) => RafError): Partial<Record<K, string>> {
  if (!isObject(value)) throw bad(`journal.${what} doit être un objet`);
  const out: Partial<Record<K, string>> = {};
  for (const [k, name] of Object.entries(value)) {
    if (!(allowed as readonly string[]).includes(k)) throw bad(`journal.${what}.${k} inconnu (attendu : ${allowed.join(', ')})`);
    if (typeof name !== 'string' || name === '') throw bad(`journal.${what}.${k} doit être un nom (texte non vide)`);
    out[k as K] = name;
  }
  return out;
}

/** La clé `plan.journal` de cadence.yaml (`file`) ; absente : undefined. Elle n'est lue que par `raf import --to-config`, qui refuse déjà un cadence.yaml sans plan d'un autre format. */
export function readJournalConfig(file: string): JournalFormat | undefined {
  const plan = readYamlKey(file, 'plan');
  const raw = isObject(plan) ? plan.journal : undefined;
  if (raw == null) return undefined;
  const bad = (what: string) => new RafError(`${file} : plan.${what}`);
  return readJournalFormat(raw, bad);
}

/** Une constante d'`extra` qui porte le nom d'une clé de base l'écraserait sur chaque ligne (et `known` ne retrouverait plus le lot). */
function refuseBaseKeys(extra: Entry, keys: JournalFormat['keys'], bad: (what: string) => RafError): void {
  const base = KEY_NAMES.filter((k) => k !== 'sha' || keys.sha !== undefined).map((k) => keys[k] ?? k);
  for (const k of Object.keys(extra)) if (base.includes(k)) throw bad(`journal.extra.${k} est déjà une clé de base du journal (${base.join(', ')}) : une constante ne la remplace pas`);
}

function readJournalFormat(raw: unknown, bad: (what: string) => RafError): JournalFormat {
  if (!isObject(raw)) throw bad('journal doit être un objet');
  for (const k of Object.keys(raw)) if (!['path', 'keys', 'types', 'extra'].includes(k)) throw bad(`journal.${k} inconnu (attendu : path, keys, types, extra)`);
  if (raw.path != null && (typeof raw.path !== 'string' || raw.path.trim() === '')) throw bad('journal.path doit être un chemin');
  if (raw.extra != null && !isObject(raw.extra)) throw bad('journal.extra doit être un objet (clé → valeur constante)');
  const types = names(raw.types ?? {}, JOURNAL_KINDS, 'types', bad);
  if (Object.keys(types).length === 0) throw bad(`journal.types est requis : fait du plan → type d'événement (${JOURNAL_KINDS.join(', ')})`);
  const keys = names(raw.keys ?? {}, KEY_NAMES, 'keys', bad);
  const extra = (raw.extra ?? {}) as Entry;
  refuseBaseKeys(extra, keys, bad);
  return { path: typeof raw.path === 'string' ? raw.path : 'journal.ndjson', keys, types, extra };
}

const keyOf = (j: JournalFormat, name: KeyName): string => j.keys[name] ?? name;

/** Le journal tel qu'il est : une ligne par événement, dans l'ordre. Absent : vide. Une ligne illisible est refusée en la citant, jamais sautée. */
export function readJournal(path: string, j: JournalFormat): Entry[] {
  if (!existsSync(path)) return [];
  const out: Entry[] = [];
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch (e) { throw new RafError(`${path} : ligne ${i + 1} illisible (${(e as Error).message})`); }
    if (!isObject(ev) || typeof ev[keyOf(j, 'task')] !== 'string' || typeof ev[keyOf(j, 'type')] !== 'string') throw new RafError(`${path} : ligne ${i + 1} sans « ${keyOf(j, 'task')} » ni « ${keyOf(j, 'type')} » texte : ce n'est pas un événement du format déclaré`);
    out.push(ev);
  });
  return out;
}

/** L'état d'une entrée au format d'origine, par identifiant : la première clé présente de plan.fields (id, status). */
export function statesById(entries: Entry[], format: PlanFormat): Map<string, string> {
  const pick = (e: Entry, field: 'id' | 'status') => (format.fields[field] ?? [field]).map((k) => e[k]).find((v) => v != null);
  const out = new Map<string, string>();
  for (const e of entries) {
    const id = pick(e, 'id');
    const state = pick(e, 'status');
    if (id != null && state != null) out.set(String(id), String(state));
  }
  return out;
}

const atDay = (day: Day): string => `${day}T00:00:00+00:00`;
const atNow = (now: Date): string => `${now.toISOString().slice(0, 19)}+00:00`;

interface Ctx { journal: JournalFormat; existing: Entry[]; now: Date; noteSeen: Set<string>; states: { before: Map<string, string>; after: Map<string, string> } }

/** Un événement au format déclaré : les quatre clés de base, les constantes de `extra`, puis le sha (livraison, si la clé est déclarée) ; rien si le fait n'a pas de type. */
function event(n: Ctx, kind: JournalKind, task: string, fact: { at: string; message: string; sha?: string }): Entry[] {
  const { at, message, sha } = fact;
  const [j, type] = [n.journal, n.journal.types[kind]];
  if (type === undefined) return [];
  return [{ [keyOf(j, 'at')]: at, [keyOf(j, 'task')]: task, [keyOf(j, 'type')]: type, [keyOf(j, 'message')]: message, ...j.extra, ...(sha !== undefined && j.keys.sha !== undefined ? { [keyOf(j, 'sha')]: sha } : {}) }];
}

/** Le journal a-t-il déjà un événement de ce fait pour ce lot (livraison : de ce sha, si la clé du sha est déclarée) ? */
function known(n: Ctx, kind: JournalKind, task: string, sha?: string): boolean {
  const j = n.journal;
  return n.existing.some((e) => e[keyOf(j, 'task')] === task && e[keyOf(j, 'type')] === j.types[kind] && (sha === undefined || j.keys.sha === undefined || e[keyOf(j, 'sha')] === sha));
}

/** Le dernier événement « état » du lot au journal dit-il déjà cet état ? Un état revenu (teste → todo → teste) s'écrit de nouveau ; deux lectures du même plan, jamais deux fois. */
function stateKnown(n: Ctx, task: string, state: string): boolean {
  const j = n.journal;
  const last = n.existing.filter((e) => e[keyOf(j, 'task')] === task && e[keyOf(j, 'type')] === j.types.state).at(-1);
  return last !== undefined && last[keyOf(j, 'message')] === state;
}

/** Les notes datées du lot que le journal n'a pas (même texte pour ce lot, quel que soit le jour). */
function noteEvents(n: Ctx, lot: Entry, task: string): Entry[] {
  const out: Entry[] = [];
  for (const note of Array.isArray(lot.notes) ? (lot.notes as { date: Day; text: string }[]) : []) {
    if (n.noteSeen.has(`${task}\0${note.text}`)) continue;
    n.noteSeen.add(`${task}\0${note.text}`);
    out.push(...event(n, 'note', task, { at: atDay(note.date), message: note.text }));
  }
  return out;
}

/** Fermeture d'un lot abandonné (datée de son `finished`, sinon `now`), livraison, changement d'état (sans date propre : `now`). */
function endEvents(n: Ctx, lot: Entry, task: string): Entry[] {
  // Un lot abandonné se ferme (si le format a ce type), il ne « change pas d'état » en plus.
  const closes = lot.status === 'dropped' && n.journal.types.closed !== undefined;
  const d = lot.delivered as { date: Day; sha: string } | undefined;
  const [was, is] = [n.states.before.get(task), n.states.after.get(task)];
  return [
    ...(closes && !known(n, 'closed', task) ? event(n, 'closed', task, { at: lot.finished ? atDay(lot.finished as Day) : atNow(n.now), message: '' }) : []),
    ...(d && !known(n, 'delivered', task, d.sha) ? event(n, 'delivered', task, { at: atDay(d.date), message: '', sha: d.sha }) : []),
    ...(!closes && was !== undefined && is !== undefined && was !== is && !stateKnown(n, task, is) ? event(n, 'state', task, { at: atNow(n.now), message: is }) : []),
  ];
}

/**
 * Les événements que le journal n'a pas et que le plan natif dit : création, démarrage, notes, fermeture d'un lot abandonné, livraison (une ligne par fait, jamais deux fois)
 * et, pour un lot déjà dans `states.before` (le plan d'origine qu'on remplace), un changement d'état. Les sous-tâches (`tasks:`) n'ont ni date ni livraison : sans événement. Les faits datés prennent leur jour (minuit UTC) ; la fermeture d'un lot abandonné son `finished` ; ceux sans date (état, fermeture sans `finished`) l'heure de `now`.
 */
export function missingEvents(native: Entry[], existing: Entry[], journal: JournalFormat, states: Ctx['states'], now: Date): Entry[] {
  const [taskKey, typeKey, messageKey] = [keyOf(journal, 'task'), keyOf(journal, 'type'), keyOf(journal, 'message')];
  const noteSeen = new Set(existing.filter((e) => e[typeKey] === journal.types.note).map((e) => `${String(e[taskKey])}\0${String(e[messageKey])}`));
  const n: Ctx = { journal, existing, now, noteSeen, states };
  return native.flatMap((lot) => {
    const task = String(lot.id);
    return [
      ...(typeof lot.created === 'string' && !known(n, 'created', task) ? event(n, 'created', task, { at: atDay(lot.created), message: String(lot.title) }) : []),
      ...(typeof lot.started === 'string' && !known(n, 'started', task) ? event(n, 'started', task, { at: atDay(lot.started), message: '' }) : []),
      ...noteEvents(n, lot, task),
      ...endEvents(n, lot, task),
    ];
  });
}

/** Ajoute les lignes en fin de fichier (créé, dossiers compris, s'il manque) ; une dernière ligne sans saut de ligne en reçoit un d'abord. */
export function appendEvents(path: string, events: Entry[]): void {
  if (events.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, `${current}${current !== '' && !current.endsWith('\n') ? '\n' : ''}${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}
