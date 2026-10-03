import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { isDay, toDay, type Day } from './dates.js';

export const STATUSES = ['todo', 'doing', 'done', 'dropped'] as const;
export type Status = (typeof STATUSES)[number];

export interface Note {
  date: Day;
  text: string;
}

export interface Verdict {
  date: Day;
  verdict: string;
  /**
   * Revue de code : sha du dernier commit compté du lot au moment du verdict, null s'il n'y en avait
   * aucun. Absent d'un verdict écrit à la main : rien ne dit ce qui a été relu, rien n'est contrôlé.
   */
  commit?: string | null;
}

export interface Task {
  id: string;
  title: string;
  status: Status;
}

export interface Lot {
  id: string;
  title: string;
  status: Status;
  estimate: number;
  quickwin: boolean;
  /** Changement visible par l'utilisateur : une entrée Nouveautés est attendue à la livraison. */
  visible: boolean;
  after: string[];
  created?: Day;
  started?: Day;
  finished?: Day;
  notes: Note[];
  tasks: Task[];
  /** Revue d'ergonomie enregistrée par `raf ux`. */
  ux?: Verdict;
  /** Revue de code enregistrée par `raf review`. */
  review?: Verdict;
  /** Champs écrits à la main illisibles (dates mal formées…), remontés par check. */
  problems: string[];
}

export class RafError extends Error {}

export type Ref = { lot: string; task?: string };

export const FIELDS = ['id', 'title', 'status', 'estimate', 'quickwin', 'visible', 'after', 'created', 'started', 'finished', 'notes', 'parent'] as const;
export type Field = (typeof FIELDS)[number];

/**
 * Plan tenu par un autre outil, lu sans le migrer (cadence.yaml : plan.lots, fields, statuses,
 * estimates). Un tel plan est en lecture seule : raf ne sait pas l'écrire dans son format.
 */
export interface PlanFormat {
  /** Clé racine qui porte la liste. */
  lots: string;
  /** Champ de raf → clés du fichier, la première présente l'emporte. */
  fields: Partial<Record<Field, string[]>>;
  /** État du fichier → statut de raf. */
  statuses: Record<string, Status>;
  /** Libellé d'effort du fichier → jours. */
  estimates: Record<string, number>;
}

/** Réglages venus de cadence.yaml ; ceux du plan lui-même l'emportent quand il les porte. */
export interface PlanSettings {
  project?: string;
  since?: Day;
  ignore?: string[];
  /** Fichiers tenus avec le plan (journal…), relatifs à la racine : les toucher n'est pas travailler à un lot. */
  files?: string[];
  format?: PlanFormat;
}

export function isOpen(status: Status): boolean {
  return status === 'todo' || status === 'doing';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ce qui ne peut pas suivre un identifiant cité : un point suivi d'un caractère de mot — « L1.4 » n'est
 * pas le lot L1, « NC2.4 » n'est pas NC2 — alors que le point qui finit une phrase (« voir L1. ») passe.
 * Même garde pour le format de raf et pour les identifiants d'un plan en lecture seule.
 */
const DOTTED = '\\.\\w';

/** Matches `L3` or `L3/t1` as whole words. Group 1 = lot id, group 2 = task id. */
export function refPattern(prefix: string): RegExp {
  return new RegExp(`(?<![\\w/])(${escapeRe(prefix)}\\d+)(?:/(t\\d+))?(?!\\w|${DOTTED})`, 'g');
}

export function extractRefs(text: string, prefix: string): Ref[] {
  return [...text.matchAll(refPattern(prefix))].map((m) => ({ lot: m[1], task: m[2] }));
}

function initialContent(project: string, prefix: string, since: Day): string {
  return `# Plan « reste à faire » tenu par raf (https://github.com/Sylad/cadence).
# Édité par le CLI, mais les modifications à la main et les commentaires sont préservés.
# Un commit appartient à un lot quand son message cite l'identifiant (${prefix}3, ${prefix}3/t1).
version: 1
project: ${JSON.stringify(project)}
prefix: ${prefix}
since: ${since}       # raf check ignore les commits antérieurs à l'adoption
lots: []
`;
}

export class Plan {
  private constructor(
    readonly path: string,
    private readonly doc: Document,
    /** false quand le fichier écrit à la main met les « - » en colonne de la clé parente. */
    private readonly indentSeq: boolean,
    private readonly settings: PlanSettings = {},
  ) {}

  /** Un plan lu dans un autre format ne change pas : sa lecture et le motif de ses références sont gardés. */
  private foreign?: { lots: Lot[]; refs: RegExp | null; tasks: Set<string>; ids: Set<string> };

  get readonly(): boolean {
    return !!this.settings.format;
  }

  private writable(): void {
    if (this.readonly) {
      throw new RafError(`plan en lecture seule : ${this.path} est tenu par un autre outil (cadence.yaml : plan) — le modifier avec l'outil du projet`);
    }
  }

  static create(path: string, project: string, prefix = 'L', since?: Day): Plan {
    if (existsSync(path)) throw new RafError(`${path} existe déjà`);
    if (!/^[A-Za-z][A-Za-z_-]*$/.test(prefix)) throw new RafError(`préfixe invalide : ${prefix} (lettres uniquement)`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, initialContent(project, prefix, since ?? toDay(new Date())));
    return Plan.load(path);
  }

  static load(path: string, settings: PlanSettings = {}): Plan {
    if (!existsSync(path)) throw new RafError(`pas de plan à ${path} — lancer « raf init »`);
    const text = readFileSync(path, 'utf8');
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new RafError(`${path} : ${doc.errors[0].message}`);
    if (!isMap(doc.contents)) throw new RafError(`${path} : la racine doit être un objet`);
    if (settings.format) {
      const key = settings.format.lots;
      if (!isSeq(doc.get(key))) throw new RafError(`${path} : la clé « ${key} » doit porter la liste des lots (cadence.yaml : plan.lots)`);
      return new Plan(path, doc, true, settings);
    }
    const lots = doc.get('lots');
    if (!isSeq(lots)) doc.set('lots', doc.createNode([]));
    else lots.flow = false; // « lots: [] » écrit par init : passer en style bloc
    return new Plan(path, doc, !/^lots:[^\n]*\n(?:#[^\n]*\n)*- /m.test(text), settings);
  }

  save(): void {
    this.writable();
    writeFileSync(this.path, this.doc.toString({ lineWidth: 0, indentSeq: this.indentSeq }));
  }

  get project(): string {
    return String(this.doc.get('project') ?? this.settings.project ?? '');
  }

  get prefix(): string {
    return String(this.doc.get('prefix') ?? 'L');
  }

  /** Date d'adoption de raf : les commits plus anciens ne sont pas audités. */
  get since(): Day | undefined {
    const v = this.doc.get('since') ?? this.settings.since;
    return v == null ? undefined : String(v);
  }

  /** Motifs (expressions régulières sur le sujet) des commits automatiques à ne pas auditer. */
  get ignore(): { patterns: RegExp[]; invalid: string[] } {
    const raw = this.doc.get('ignore');
    const own = isSeq(raw) ? (raw.toJSON() as unknown[]).map(String) : raw == null ? [] : [String(raw)];
    const list = [...own, ...(this.settings.ignore ?? [])];
    const patterns: RegExp[] = [];
    const invalid: string[] = [];
    for (const src of list) {
      try {
        patterns.push(new RegExp(src));
      } catch {
        invalid.push(src);
      }
    }
    return { patterns, invalid };
  }

  /** Fichiers tenus avec le plan, relatifs à la racine du dépôt. */
  get files(): string[] {
    return this.settings.files ?? [];
  }

  /**
   * Références citées par un texte. Format de raf : préfixe et numéro (`L3`, `L3/t1`). Autre format :
   * les identifiants du plan eux-mêmes, quelle que soit leur forme (`E-A2`, `NC2.4`, `B33/t1-fusion`).
   */
  readonly refs = (text: string): Ref[] => {
    if (!this.settings.format) return extractRefs(text, this.prefix);
    const { refs, tasks, ids } = this.read();
    if (!refs) return [];
    return [...text.matchAll(refs)].flatMap((m): Ref[] => {
      if (!m[2]) return [{ lot: m[1] }];
      if (tasks.has(`${m[1]}/${m[2]}`)) return [{ lot: m[1], task: m[2] }];
      // « B33/E-A2 » : deux lots séparés par une barre, pas une sous-tâche.
      return ids.has(m[2]) ? [{ lot: m[1] }, { lot: m[2] }] : [{ lot: m[1] }];
    });
  };

  private read(): NonNullable<Plan['foreign']> {
    if (!this.foreign) {
      const raw = (this.doc.get(this.settings.format!.lots) as YAMLSeq).toJSON() as Record<string, unknown>[];
      const lots = foreignLots(raw, this.settings.format!);
      const ids = lots.map((l) => l.id).sort((a, b) => b.length - a.length);
      this.foreign = {
        lots,
        ids: new Set(ids),
        tasks: new Set(lots.flatMap((l) => l.tasks.map((t) => `${l.id}/${t.id}`))),
        refs: ids.length
          ? new RegExp(`(?<![\\w/.-])(${ids.map(escapeRe).join('|')})(?:/([\\w-]+(?:\\.[\\w-]+)*))?(?![\\w-]|${DOTTED})`, 'g')
          : null,
      };
    }
    return this.foreign;
  }

  /** Date d'activation de la revue UX obligatoire des lots visibles ; absente = règle inactive. */
  get uxSince(): Day | undefined {
    const v = this.doc.get('uxSince');
    return v == null ? undefined : String(v);
  }

  /** Active la revue UX ; false si elle l'était déjà. */
  enableUx(today: Day): boolean {
    return this.enableGate('uxSince', today);
  }

  recordUx(lotId: string, verdict: string, today: Day): void {
    this.recordVerdict('ux', 'la revue UX', lotId, { date: today, verdict });
  }

  /** Date d'activation de la revue de code obligatoire des lots à commits ; absente = règle inactive. */
  get reviewSince(): Day | undefined {
    const v = this.doc.get('reviewSince');
    return v == null ? undefined : String(v);
  }

  /** Active la revue de code ; false si elle l'était déjà. */
  enableReview(today: Day): boolean {
    return this.enableGate('reviewSince', today);
  }

  /** `commit` : sha du dernier commit compté du lot (le plan ne lit pas git), null s'il n'en a aucun. */
  recordReview(lotId: string, verdict: string, today: Day, commit: string | null): void {
    this.recordVerdict('review', 'la revue de code', lotId, { date: today, verdict, commit });
  }

  private enableGate(key: 'uxSince' | 'reviewSince', today: Day): boolean {
    this.writable();
    if (this[key]) return false;
    this.doc.set(key, today);
    // Placer la clé avant « lots » pour garder les réglages groupés en tête.
    const map = this.doc.contents as YAMLMap;
    const idx = map.items.findIndex((p) => String((p.key as { value?: unknown })?.value ?? p.key) === key);
    const lotsIdx = map.items.findIndex((p) => String((p.key as { value?: unknown })?.value ?? p.key) === 'lots');
    if (idx > lotsIdx && lotsIdx >= 0) map.items.splice(lotsIdx, 0, ...map.items.splice(idx, 1));
    return true;
  }

  private recordVerdict(key: 'ux' | 'review', label: string, lotId: string, entry: Verdict): void {
    this.writable();
    if (lotId.includes('/')) throw new RafError(`${label} se note sur un lot, pas une sous-tâche`);
    // Un verdict vide ouvrirait la porte sans rien dire de la revue.
    if (entry.verdict.trim() === '') throw new RafError(`verdict vide : ${label} attend son verdict — raf ${key} ${lotId} "verdict"`);
    const node = this.doc.createNode(entry) as YAMLMap;
    node.flow = true;
    this.lotNode(lotId).set(key, node);
  }

  lots(): Lot[] {
    if (this.settings.format) return this.read().lots;
    const raw = (this.doc.get('lots') as YAMLSeq).toJSON() as Record<string, unknown>[];
    return raw.map((r) => normalizeLot(r));
  }

  lot(id: string): Lot {
    const found = this.lots().find((l) => l.id === id);
    if (!found) throw new RafError(`lot inconnu : ${id}`);
    return found;
  }

  private lotNode(id: string): YAMLMap {
    const seq = this.doc.get('lots') as YAMLSeq;
    const node = seq.items.find((n) => isMap(n) && String(n.get('id')) === id);
    if (!node) throw new RafError(`lot inconnu : ${id}`);
    return node as YAMLMap;
  }

  private taskNode(lotId: string, taskId: string): YAMLMap {
    const tasks = this.lotNode(lotId).get('tasks');
    const node = isSeq(tasks) ? tasks.items.find((n) => isMap(n) && String(n.get('id')) === taskId) : undefined;
    if (!node) throw new RafError(`sous-tâche inconnue : ${lotId}/${taskId}`);
    return node as YAMLMap;
  }

  add(title: string, today: Day, opts: { estimate?: number; quickwin?: boolean; visible?: boolean; after?: string[] } = {}): string {
    this.writable();
    const known = new Set(this.lots().map((l) => l.id));
    for (const dep of opts.after ?? []) if (!known.has(dep)) throw new RafError(`dépendance inconnue : ${dep}`);
    const re = new RegExp(`^${escapeRe(this.prefix)}(\\d+)$`);
    const max = Math.max(0, ...[...known].map((id) => Number(re.exec(id)?.[1] ?? 0)));
    const id = `${this.prefix}${max + 1}`;
    const entry: Record<string, unknown> = { id, title, status: 'todo', estimate: opts.estimate ?? 1 };
    if (opts.quickwin) entry.quickwin = true;
    if (opts.visible) entry.visible = true;
    if (opts.after?.length) entry.after = opts.after;
    entry.created = today;
    const node = this.doc.createNode(entry) as YAMLMap;
    const after = node.get('after');
    if (isSeq(after)) after.flow = true;
    (this.doc.get('lots') as YAMLSeq).add(node);
    return id;
  }

  addTask(lotId: string, title: string): string {
    this.writable();
    const lot = this.lotNode(lotId);
    let tasks = lot.get('tasks');
    if (!isSeq(tasks)) {
      tasks = this.doc.createNode([]);
      lot.set('tasks', tasks);
    }
    const seq = tasks as YAMLSeq;
    const max = Math.max(0, ...seq.items.map((n) => Number(/^t(\d+)$/.exec(String((n as YAMLMap).get('id')))?.[1] ?? 0)));
    const id = `t${max + 1}`;
    const node = this.doc.createNode({ id, title, status: 'todo' }) as YAMLMap;
    node.flow = true;
    seq.add(node);
    return `${lotId}/${id}`;
  }

  /**
   * `ref` is `L3` or `L3/t1`. `unreviewed` : nombre de commits du lot que sa revue de code ne couvre
   * pas (le plan ne lit pas git) — tous sans verdict, ceux postérieurs au commit relu sinon ; sans lui,
   * la revue de code n'est pas exigée.
   */
  setStatus(ref: string, status: Status, today: Day, opts: { force?: boolean; unreviewed?: number } = {}): void {
    this.writable();
    const [lotId, taskId] = ref.split('/');
    if (taskId) {
      const task = this.taskNode(lotId, taskId);
      if (String(task.get('status')) === status) throw new RafError(`${ref} est déjà ${status}`);
      task.set('status', status);
      return;
    }
    const lot = this.lot(lotId);
    const node = this.lotNode(lotId);
    if (lot.status === status) throw new RafError(`${lotId} est déjà ${status}`);
    if (!isOpen(lot.status)) {
      throw new RafError(`${lotId} est ${lot.status} ; le rouvrir à la main dans le YAML si c'est voulu`);
    }
    if (status === 'done') {
      const open = lot.tasks.filter((t) => isOpen(t.status)).map((t) => `${lotId}/${t.id}`);
      if (open.length > 0 && !opts.force) {
        throw new RafError(`sous-tâches encore ouvertes : ${open.join(', ')} (--force pour passer outre)`);
      }
      if (this.uxSince && lot.visible && !lot.ux && !opts.force) {
        throw new RafError(`${lotId} est visible : revue UX attendue avant done — raf ux ${lotId} "verdict" (--force pour passer outre)`);
      }
      if (this.reviewSince && opts.unreviewed && !opts.force) {
        throw new RafError(
          lot.review
            ? `${lotId} : la revue de code précède ${opts.unreviewed} commit(s) du lot, elle est à refaire — raf review ${lotId} "verdict" (--force pour passer outre)`
            : `${lotId} a ${opts.unreviewed} commit(s) : revue de code attendue avant done — raf review ${lotId} "verdict" (--force pour passer outre)`,
        );
      }
    }
    node.set('status', status);
    if (!lot.started && status !== 'dropped') node.set('started', today);
    if (status === 'done' || status === 'dropped') node.set('finished', today);
  }

  note(ref: string, text: string, today: Day): void {
    this.writable();
    const [lotId, taskId] = ref.split('/');
    const lot = this.lotNode(lotId);
    if (taskId) this.taskNode(lotId, taskId);
    let notes = lot.get('notes');
    if (!isSeq(notes)) {
      notes = this.doc.createNode([]);
      lot.set('notes', notes);
    }
    const entry = this.doc.createNode({ date: today, text: ref === lotId ? text : `[${ref}] ${text}` }) as YAMLMap;
    entry.flow = true;
    (notes as YAMLSeq).add(entry);
  }
}

/** Lit une liste écrite dans un autre format : champs traduits, entrées à parent repliées en sous-tâches. */
function foreignLots(raw: Record<string, unknown>[], format: PlanFormat): Lot[] {
  const entries = raw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new RafError(`entrée n° ${i + 1} du plan : un objet est attendu`);
    const pick = (field: Field): unknown => {
      for (const key of format.fields[field] ?? [field]) if (r[key] != null) return r[key];
      return undefined;
    };
    // Un horodatage vaut pour son jour.
    const day = (field: Field): unknown => {
      const v = pick(field);
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v;
    };
    const id = pick('id');
    if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
      throw new RafError(`entrée n° ${i + 1} du plan : identifiant absent`);
    }
    const problems: string[] = [];
    const theirs = pick('status');
    const mapped = Object.keys(format.statuses).length > 0;
    if (mapped && theirs != null && !Object.hasOwn(format.statuses, String(theirs))) {
      problems.push(`état « ${String(theirs)} » sans correspondance (cadence.yaml : plan.statuses)`);
    }
    const effort = pick('estimate');
    if (typeof effort === 'string' && !(effort in format.estimates)) {
      problems.push(`effort « ${effort} » sans correspondance (cadence.yaml : plan.estimates)`);
    }
    const notes = pick('notes');
    const lot = normalizeLot(
      {
        id,
        title: pick('title'),
        status: mapped ? (Object.hasOwn(format.statuses, String(theirs)) ? format.statuses[String(theirs)] : undefined) : theirs,
        estimate: typeof effort === 'string' ? format.estimates[effort] : effort,
        quickwin: pick('quickwin'),
        visible: pick('visible'),
        after: pick('after'),
        created: day('created'),
        started: day('started'),
        finished: day('finished'),
        notes: typeof notes === 'string' ? [{ text: notes }] : notes,
      },
      problems,
    );
    const parent = pick('parent');
    return { lot, parent: parent == null ? undefined : String(parent) };
  });
  const top = new Map(entries.filter((e) => !e.parent).map((e) => [e.lot.id, e.lot]));
  const lots: Lot[] = [];
  for (const { lot, parent } of entries) {
    const into = parent ? top.get(parent) : undefined;
    if (into && lot.id.startsWith(`${into.id}/`)) {
      into.tasks.push({ id: lot.id.slice(into.id.length + 1), title: lot.title, status: lot.status });
      into.problems.push(...lot.problems.map((p) => `${lot.id} : ${p}`));
    } else {
      lots.push(lot);
    }
  }
  return lots;
}

function normalizeLot(raw: Record<string, unknown>, problems: string[] = []): Lot {
  const status = STATUSES.includes(raw.status as Status) ? (raw.status as Status) : 'todo';
  const asDay = (field: string): Day | undefined => {
    const v = raw[field];
    if (v == null) return undefined;
    if (isDay(v)) return v;
    problems.push(`${field} « ${String(v)} » n'est pas une date AAAA-MM-JJ`);
    return undefined;
  };
  const after = raw.after == null ? [] : Array.isArray(raw.after) ? raw.after.map(String) : [String(raw.after)];
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    status,
    estimate: typeof raw.estimate === 'number' && raw.estimate > 0 ? raw.estimate : 1,
    quickwin: raw.quickwin === true,
    visible: raw.visible === true,
    after,
    created: asDay('created'),
    started: asDay('started'),
    finished: asDay('finished'),
    notes: Array.isArray(raw.notes)
      ? raw.notes.map((n: Record<string, unknown>) => ({ date: String(n.date ?? ''), text: String(n.text ?? '') }))
      : [],
    tasks: Array.isArray(raw.tasks)
      ? raw.tasks.map((t: Record<string, unknown>) => ({
          id: String(t.id),
          title: String(t.title ?? ''),
          status: STATUSES.includes(t.status as Status) ? (t.status as Status) : 'todo',
        }))
      : [],
    ...(asVerdict(raw.ux) ? { ux: asVerdict(raw.ux) } : {}),
    ...(asVerdict(raw.review) ? { review: asVerdict(raw.review) } : {}),
    problems,
  };
}

function asVerdict(raw: unknown): Verdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  // Écrit à la main sans verdict (clé absente, vide ou blanche) : rien n'a été dit de la revue, la porte
  // reste fermée — comme `raf ux` et `raf review` refusent d'enregistrer un verdict vide.
  if (String(v.verdict ?? '').trim() === '') return undefined;
  const verdict: Verdict = { date: String(v.date ?? ''), verdict: String(v.verdict) };
  // Champ présent mais vide : relu « jusqu'à rien », comme un verdict noté sans commit.
  if ('commit' in v) verdict.commit = v.commit == null || String(v.commit).trim() === '' ? null : String(v.commit).trim();
  return verdict;
}
