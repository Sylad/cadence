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
  ux?: { date: Day; verdict: string };
  /** Champs écrits à la main illisibles (dates mal formées…), remontés par check. */
  problems: string[];
}

export class RafError extends Error {}

export function isOpen(status: Status): boolean {
  return status === 'todo' || status === 'doing';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `L3` or `L3/t1` as whole words. Group 1 = lot id, group 2 = task id. */
export function refPattern(prefix: string): RegExp {
  return new RegExp(`(?<![\\w/])(${escapeRe(prefix)}\\d+)(?:/(t\\d+))?(?![\\w])`, 'g');
}

export function extractRefs(text: string, prefix: string): { lot: string; task?: string }[] {
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
  ) {}

  static create(path: string, project: string, prefix = 'L', since?: Day): Plan {
    if (existsSync(path)) throw new RafError(`${path} existe déjà`);
    if (!/^[A-Za-z][A-Za-z_-]*$/.test(prefix)) throw new RafError(`préfixe invalide : ${prefix} (lettres uniquement)`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, initialContent(project, prefix, since ?? toDay(new Date())));
    return Plan.load(path);
  }

  static load(path: string): Plan {
    if (!existsSync(path)) throw new RafError(`pas de plan à ${path} — lancer « raf init »`);
    const text = readFileSync(path, 'utf8');
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new RafError(`${path} : ${doc.errors[0].message}`);
    if (!isMap(doc.contents)) throw new RafError(`${path} : la racine doit être un objet`);
    const lots = doc.get('lots');
    if (!isSeq(lots)) doc.set('lots', doc.createNode([]));
    else lots.flow = false; // « lots: [] » écrit par init : passer en style bloc
    return new Plan(path, doc, !/^lots:[^\n]*\n(?:#[^\n]*\n)*- /m.test(text));
  }

  save(): void {
    writeFileSync(this.path, this.doc.toString({ lineWidth: 0, indentSeq: this.indentSeq }));
  }

  get project(): string {
    return String(this.doc.get('project') ?? '');
  }

  get prefix(): string {
    return String(this.doc.get('prefix') ?? 'L');
  }

  /** Date d'adoption de raf : les commits plus anciens ne sont pas audités. */
  get since(): Day | undefined {
    const v = this.doc.get('since');
    return v == null ? undefined : String(v);
  }

  /** Date d'activation de la revue UX obligatoire des lots visibles ; absente = règle inactive. */
  get uxSince(): Day | undefined {
    const v = this.doc.get('uxSince');
    return v == null ? undefined : String(v);
  }

  /** Active la revue UX ; false si elle l'était déjà. */
  enableUx(today: Day): boolean {
    if (this.uxSince) return false;
    this.doc.set('uxSince', today);
    // Placer la clé avant « lots » pour garder les réglages groupés en tête.
    const map = this.doc.contents as YAMLMap;
    const idx = map.items.findIndex((p) => String((p.key as { value?: unknown })?.value ?? p.key) === 'uxSince');
    const lotsIdx = map.items.findIndex((p) => String((p.key as { value?: unknown })?.value ?? p.key) === 'lots');
    if (idx > lotsIdx && lotsIdx >= 0) map.items.splice(lotsIdx, 0, ...map.items.splice(idx, 1));
    return true;
  }

  recordUx(lotId: string, verdict: string, today: Day): void {
    if (lotId.includes('/')) throw new RafError('la revue UX se note sur un lot, pas une sous-tâche');
    const node = this.doc.createNode({ date: today, verdict }) as YAMLMap;
    node.flow = true;
    this.lotNode(lotId).set('ux', node);
  }

  lots(): Lot[] {
    const raw = (this.doc.get('lots') as YAMLSeq).toJSON() as Record<string, unknown>[];
    return raw.map(normalizeLot);
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

  /** `ref` is `L3` or `L3/t1`. */
  setStatus(ref: string, status: Status, today: Day, opts: { force?: boolean } = {}): void {
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
    }
    node.set('status', status);
    if (!lot.started && status !== 'dropped') node.set('started', today);
    if (status === 'done' || status === 'dropped') node.set('finished', today);
  }

  note(ref: string, text: string, today: Day): void {
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

function normalizeLot(raw: Record<string, unknown>): Lot {
  const status = STATUSES.includes(raw.status as Status) ? (raw.status as Status) : 'todo';
  const problems: string[] = [];
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
    ...(raw.ux && typeof raw.ux === 'object'
      ? { ux: { date: String((raw.ux as Record<string, unknown>).date ?? ''), verdict: String((raw.ux as Record<string, unknown>).verdict ?? '') } }
      : {}),
    problems,
  };
}
