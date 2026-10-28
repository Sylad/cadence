import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { isDay, toDay, type Day } from './dates.js';
import { ARCHIVE_DIR, archiveFiles, archiveLots, archiveYear, mergeArchived, newArchiveDoc, readArchiveDoc, selectArchivable, type Kept } from './archive.js';

/** Délai de la commande `plan.onWrite` : une republication du plan, pas un build. */
const ON_WRITE_TIMEOUT_MS = 120_000;

/** Où va un avertissement de `save()` (la commande a réussi mais quelque chose cloche) : stderr, ou le `err` du CLI qui a lancé l'écriture. */
let notice: (line: string) => void = (line) => void process.stderr.write(`${line}\n`);
export function setPlanNotice(fn: (line: string) => void): void {
  notice = fn;
}

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
  /**
   * Revue de code d'un lot qui travaille aussi dans des dépôts voisins (`repos:`) : pour chacun, clé = chemin déclaré par
   * le lot, sha du dernier commit du lot lu dans ce dépôt (null s'il n'y en avait aucun). Absent sans dépôt voisin.
   */
  repos?: Record<string, string | null>;
  /**
   * Verdict reporté au sha intégré (L279, D5) : l'intégration d'un lot en worktree a rebasé ses commits sans changer son diff (même patch-id) ; `de` est le sha relu
   * avant le rebase, `vers` le dernier commit de travail intégré — celui que porte `commit`. Écrit par le seul programme, purement informatif : la porte
   * de `raf done` ne le lit pas.
   */
  reporte?: { de: string; vers: string; patchId: string };
}

export interface Task {
  id: string;
  title: string;
  status: Status;
}

export interface Lot {
  id: string;
  /** Lot parent d'un sous-lot d'un plan tenu par un autre outil (clé mappée `parent`) ; absent sur un lot de premier niveau. */
  parent?: string;
  title: string;
  status: Status;
  estimate: number;
  quickwin: boolean;
  /** Changement visible par l'utilisateur : une entrée Nouveautés est attendue à la livraison. */
  visible: boolean;
  /** Écran que le lot crée ou change (L169, étape spec) : exige `visible`. Absent = pas d'étape spec. */
  screen?: Screen;
  /** Le lot change un comportement (étape spec back) : posé à la planification, jamais déduit du titre. Absent = pas de spec. */
  spec?: true;
  /** Titre public du lot, en langage du public (pages Nouveautés et Plan) ; absent = pas de titre public. */
  public?: string;
  /** Objectif du lot (clé `goal:`, L258) : remplace le titre comme objectif des briefs d'orchestrate quand le titre est périmé ; absent = le titre. */
  goal?: string;
  /** Périodicité en jours : le lot est récurrent, il reste `todo` et se refait (`raf did`). */
  every?: number;
  /** Dernier passage d'un lot récurrent ; absent = jamais fait. */
  last?: Day;
  after: string[];
  /** Ressources partagées que le lot occupe (clé `uses:`, L251) ; absente sans clé, ou si la clé est mal formée (remontée par check). */
  uses?: string[];
  created?: Day;
  started?: Day;
  finished?: Day;
  notes: Note[];
  tasks: Task[];
  /** Dépôts voisins où le lot travaille (clé de lot `repos:`), chemins relatifs au dossier du projet ; vide : le dépôt du projet seul. */
  repos?: LotRepoDecl[];
  /** Revue d'ergonomie enregistrée par `raf ux`. */
  ux?: Verdict;
  /** Revue de code enregistrée par `raf review`. */
  review?: Verdict;
  /** Écart `docs.sync` acquitté et motivé par `raf docs-ok` (L317) : le lot n'est plus compté en retard de documentation. Absent = aucun acquittement. */
  docsOk?: { date: Day; reason: string };
  /** Condition de tirage (L219) : pas avant `count` lots done portant le critère. Absente sans champ `gate`. */
  gate?: Gate;
  /** Champs écrits à la main illisibles (dates mal formées…), remontés par check. */
  problems: string[];
}

/**
 * Un dépôt voisin déclaré par un lot : son chemin, et pour un voisin partagé entre projets une chaîne `cite` que les commits
 * du lot doivent contenir en plus de l'id du lot (sous-chaîne, sans tenir compte de la casse, sujet et corps).
 */
export interface LotRepoDecl {
  path: string;
  cite?: string;
}

/** Condition de tirage d'un lot : `count` lots done portant `spec: true` ou `screen: page`. Mal formée (`invalid`), elle n'est jamais remplie. */
export type Gate = { count: number; criterion: 'spec' | 'screen'; invalid?: undefined } | { invalid: true };

export const GATE_INVALID = 'gate invalide : count: entier ≥ 1 et un critère spec: true ou screen: page attendus';

export class RafError extends Error {}

/** Un nom de ressource partagée (L251) : un mot de lettres minuscules, chiffres, « - » et « _ ». */
export const RESOURCE_NAME = /^[a-z0-9_-]+$/;
export const RESOURCES_BAD_LIST = 'doit être une liste de noms de ressources';

export const invalidResource = (name: string) => `ressource invalide : ${name === '' ? '(vide)' : name} (lettres minuscules, chiffres, - et _)`;

/** Les noms de ressources de `--uses` ou de `raf uses` : chacun valide (`RafError` sinon), sans doublon, dans l'ordre donné. */
export function cleanUses(names: string[]): string[] {
  for (const n of names) if (!RESOURCE_NAME.test(n)) throw new RafError(invalidResource(n));
  return [...new Set(names)];
}

export type Ref = { lot: string; task?: string };

export const FIELDS = ['id', 'title', 'status', 'estimate', 'quickwin', 'visible', 'screen', 'spec', 'public', 'every', 'last', 'after', 'created', 'started', 'finished', 'notes', 'repos', 'parent', 'gate', 'goal'] as const;
/** Nature de l'écran d'un lot visible : nouvelle page, nouveau composant, parcours modifié. */
export const SCREENS = ['page', 'component', 'journey'] as const;
export type Screen = (typeof SCREENS)[number];

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
  /**
   * `plan.onWrite` (L346) : commande lancée à la racine du dépôt (`cwd`, le dossier de cadence.yaml) après chaque écriture du plan, et fichiers qu'elle produit.
   * Ils sont tenus avec le plan (mêmes règles que `files`) et commités avec lui. Un échec de la commande refuse l'écriture.
   */
  onWrite?: { command: string; files: string[]; cwd: string; timeoutMs?: number };
  /** Fichier d'attendus QA (clé `qa.expectations` de cadence.yaml) : tenu avec le plan, docs/qa/expectations.md par défaut. */
  qaExpectations?: string;
  format?: PlanFormat;
  /** Fichier de configuration effectivement lu (--config), absolu ; cadence.yaml à la racine par défaut. */
  config?: string;
}

export function isOpen(status: Status): boolean {
  return status === 'todo' || status === 'doing';
}

export function escapeRe(s: string): string {
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

/** Exemption d'un commit : `sha` complet ou `subject` exact (au moins l'un), datée et motivée. */
export interface Acknowledged {
  sha?: string;
  subject?: string;
  date: Day;
  reason?: string;
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

  /**
   * Un plan en lecture seule dont `fields` ne déclare pas de champ `public` n'a pas de titre public à poser ni à lire,
   * sauf si l'outil écrit déjà la clé `public` sous son propre nom sur un lot.
   */
  get hasPublicField(): boolean {
    return !this.settings.format || !!this.settings.format.fields.public || this.read().lots.some((l) => l.public !== undefined);
  }

  /** Un plan en lecture seule porte `visible` seulement si cadence.yaml le mappe (`plan.fields.visible`) ou si un lot l'écrit déjà sous ce nom. */
  get hasVisibleField(): boolean {
    return !this.settings.format || !!this.settings.format.fields.visible || this.read().lots.some((l) => l.visible);
  }

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

  /** Le plan tel qu'il est maintenant sur le disque (un script a pu l'écrire depuis la lecture), mêmes réglages. */
  reloaded(): Plan {
    return Plan.load(this.path, this.settings);
  }

  /**
   * Écrit le plan, puis lance `plan.onWrite` s'il est déclaré. Chemin unique de toutes les écritures (raf, orchestrate, deliver, config set).
   * Sans perte, quelle que soit l'exception : les fichiers d'année (L396) sont écrits AVANT le plan — si le plan ne s'écrit pas ensuite, un lot
   * déplacé est au pire en double, ce que le chargement refuse en le nommant, jamais perdu — et toute exception d'écriture (EACCES, disque plein,
   * commande `plan.onWrite` en échec, L346) remet le plan, les fichiers d'année et les fichiers déclarés tels qu'avant ; l'erreur le dit.
   */
  save(): void {
    this.writable();
    const hook = this.settings.onWrite;
    // L396 : chaque lot est réécrit dans le fichier d'où il vient — le plan, ou son fichier d'année si un lot archivé a été touché.
    this.reopened();
    const archives = (this.archives ?? []).filter((a) => a.dirty);
    const hadDir = existsSync(this.archiveDir);
    const written = [...archives.map((a) => a.file), this.path, ...(hook ? hook.files.map((f) => resolve(hook.cwd, f)) : [])];
    const kept = written.map((p) => [p, existsSync(p) ? readFileSync(p) : null] as const);
    // « Plan inchangé » vaut pour l'archive aussi : un fichier d'année né de cette écriture disparaît, le dossier avec. Un fichier qui n'a pas bougé
    // (l'écriture a échoué avant lui, ou sur lui) n'est pas réécrit : le remettre échouerait de la même façon.
    const restore = () => {
      for (const [p, content] of kept) {
        const now = existsSync(p) ? readFileSync(p) : null;
        if (now === content || (now && content && now.equals(content))) continue;
        try {
          if (content === null) rmSync(p, { force: true });
          else writeFileSync(p, content);
        } catch {
          /* le fichier d'origine est intact ou le même : rien de plus à faire */
        }
      }
      if (!hadDir) rmSync(this.archiveDir, { recursive: true, force: true });
      for (const a of archives) a.dirty = true;
    };
    try {
      if (archives.length > 0) mkdirSync(this.archiveDir, { recursive: true });
      for (const a of archives) writeFileSync(a.file, a.doc.toString({ lineWidth: 0 }));
      writeFileSync(this.path, this.doc.toString({ lineWidth: 0, indentSeq: this.indentSeq }));
    } catch (e) {
      restore();
      const code = (e as NodeJS.ErrnoException).code;
      throw new RafError(`écriture du plan refusée (${code ? `${code}, ` : ''}${(e as Error).message}) — plan et archive inchangés`);
    }
    for (const a of archives) a.dirty = false;
    if (!hook) return;
    const limit = hook.timeoutMs ?? ON_WRITE_TIMEOUT_MS;
    const r = spawnSync('sh', ['-c', hook.command], { cwd: hook.cwd, encoding: 'utf8', timeout: limit, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) {
      // Un chemin mal déclaré laisse le vrai fichier produit hors du commit du plan (le constat d'origine du lot) : le dire.
      const missing = hook.files.filter((f) => !existsSync(resolve(hook.cwd, f)));
      if (missing.length > 0) notice(`raf: plan.onWrite a réussi mais le fichier déclaré est absent : ${missing.join(', ')} — vérifier plan.onWrite.files dans cadence.yaml`);
      return;
    }
    restore();
    const why = r.error ? (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `délai de ${limit / 1000} s dépassé` : r.error.message : `code ${r.status ?? r.signal}`;
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join(' | ');
    throw new RafError(`plan.onWrite en échec (${hook.command}, ${why})${tail ? ` : ${tail}` : ''} — écriture refusée, plan inchangé`);
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

  /** Commits acquittés (`raf ignore`) : exemptés de « sans lot » et d'« inconnu », par sha complet ou par sujet exact. */
  get acknowledged(): Acknowledged[] {
    const raw = this.doc.get('acknowledged');
    if (!isSeq(raw)) return [];
    return (raw.toJSON() as unknown[]).flatMap((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      const sha = o.sha == null ? undefined : String(o.sha);
      const subject = o.subject == null ? undefined : String(o.subject);
      if (!sha && !subject) return [];
      return [{ sha, subject, date: String(o.date ?? ''), reason: o.reason == null ? undefined : String(o.reason) }];
    });
  }

  /** Acquitte un commit : une ligne datée dans la section `acknowledged:` du plan. */
  acknowledge(entry: Acknowledged): void {
    this.writable();
    // Déjà acquitté (même sha, ou même sujet pour une entrée par sujet) : on garde la première ligne et son motif.
    if (this.acknowledged.some((a) => (entry.sha ? a.sha === entry.sha : a.sha === undefined && a.subject === entry.subject))) return;
    let list = this.doc.get('acknowledged');
    if (!isSeq(list)) {
      list = this.doc.createNode([]);
      this.doc.set('acknowledged', list);
    }
    const node = this.doc.createNode(Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))) as YAMLMap;
    node.flow = true;
    (list as YAMLSeq).add(node);
  }

  /** Fichier de configuration lu pour ce plan, null quand on n'en connaît pas (cadence.yaml à la racine alors). */
  get configFile(): string | null {
    return this.settings.config ?? null;
  }

  /** Fichiers tenus avec le plan, relatifs à la racine du dépôt (le fichier d'acquittement docs-ok d'un plan en lecture seule en est un, L386). */
  get files(): string[] {
    return [...(this.settings.files ?? []), ...(this.readonly && this.settings.config ? [DOCS_OK_FILE] : [])];
  }

  /** Fichiers que produit `plan.onWrite` (L346), relatifs à la racine du dépôt : à commiter avec le plan, même s'ils n'étaient pas encore suivis. */
  get produced(): string[] {
    return this.settings.onWrite?.files ?? [];
  }

  /** Fichier d'attendus QA du `qa-reviewer`, relatif à la racine du dépôt. */
  get qaExpectations(): string {
    return this.settings.qaExpectations ?? 'docs/qa/expectations.md';
  }

  /** Tout ce qui est tenu avec le plan sans être du travail : plan.files et le fichier d'attendus QA. Source unique de l'audit et de l'orchestrateur. */
  get maintained(): string[] {
    return [...new Set([...this.files, ...this.produced, this.qaExpectations, ...this.archiveFiles().map((f) => this.shown(f))])];
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
  recordReview(lotId: string, verdict: string, today: Day, commit: string | null, repos?: Record<string, string | null>, reporte?: Verdict['reporte']): void {
    this.recordVerdict('review', 'la revue de code', lotId, { date: today, verdict, commit, ...(repos && Object.keys(repos).length ? { repos } : {}), ...(reporte ? { reporte } : {}) });
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

  /** Chemin du fichier d'acquittement docs-ok d'un plan en lecture seule : `.cadence/docs-ok.yaml` à côté du cadence.yaml lu (L386) ; null sans cadence.yaml. */
  private get docsOkFile(): string | null {
    return this.settings.config ? join(dirname(this.settings.config), DOCS_OK_FILE) : null;
  }

  lots(): Lot[] {
    if (this.settings.format) {
      const ack = readDocsOkFile(this.docsOkFile);
      return this.read().lots.map((l) => (l.docsOk || !ack[l.id] ? l : { ...l, docsOk: ack[l.id] }));
    }
    // L396 : l'archive est un détail de stockage — les lots archivés reprennent leur place parmi ceux du fichier actif, comme un seul plan.
    const archived = this.loadArchives().flatMap((a) => archiveLots(a.doc).toJSON() as Record<string, unknown>[]);
    return mergeArchived(archived.map((r) => normalizeLot(r)), this.activeRaw().map((r) => normalizeLot(r)));
  }

  lot(id: string): Lot {
    const found = this.lots().find((l) => l.id === id);
    if (!found) throw new RafError(`lot inconnu : ${id}`);
    return found;
  }

  /** Les lots du fichier du plan seul : ce que `raf archive` peut déplacer. */
  private activeRaw(): Record<string, unknown>[] {
    return (this.doc.get('lots') as YAMLSeq).toJSON() as Record<string, unknown>[];
  }

  /** Dossier des lots archivés (L396), à côté du plan : `.cadence/archive/` pour `.cadence/raf.yaml`. */
  get archiveDir(): string {
    return join(dirname(this.path), ARCHIVE_DIR);
  }

  /** Vrai quand `plan.onWrite` republie une copie du plan à chaque écriture (L346) : elle ne voit que le fichier actif, jamais l'archive. */
  get republishes(): boolean {
    return !!this.settings.onWrite;
  }

  /** Fichiers `<année>.yaml` de l'archive, absolus ; vide pour un plan en lecture seule (son outil tient son propre historique). */
  archiveFiles(): string[] {
    return this.readonly ? [] : archiveFiles(this.archiveDir);
  }

  /** Un fichier d'année chargé ; `dirty` quand un de ses lots a été touché ou ajouté depuis la lecture : `save()` le réécrit. */
  private archives?: { file: string; doc: Document; dirty: boolean }[];

  /** Un chemin tel que l'utilisateur le voit : relatif à la racine du dépôt (le dossier du cadence.yaml, à défaut le parent du dossier du plan). */
  private shown(file: string): string {
    return relative(this.settings.config ? dirname(this.settings.config) : dirname(dirname(this.path)), file);
  }

  /**
   * Les fichiers d'archive, lus une fois. Un même identifiant dans deux fichiers (plan et archive confondus) est une erreur nommée,
   * jamais un choix silencieux : on ne saurait pas quelle copie lire ni dans laquelle écrire.
   */
  private loadArchives(): NonNullable<Plan['archives']> {
    if (!this.archives) {
      const archives = this.archiveFiles().map((file) => {
        try {
          return { file, doc: readArchiveDoc(file), dirty: false };
        } catch (e) {
          throw new RafError((e as Error).message);
        }
      });
      const idsOf = (seq: YAMLSeq) => new Set(seq.items.filter(isMap).map((n) => String(n.get('id'))));
      const files: { file: string; ids: Set<string> }[] = [...archives.map((a) => ({ file: a.file, ids: idsOf(archiveLots(a.doc)) })), { file: this.path, ids: idsOf(this.doc.get('lots') as YAMLSeq) }];
      for (let i = 1; i < files.length; i++) {
        for (const id of files[i].ids) {
          const other = files.slice(0, i).find((f) => f.ids.has(id));
          if (other) throw new RafError(`identifiant en double : ${id} est dans ${this.shown(other.file)} et dans ${this.shown(files[i].file)} — un lot ne vit que dans un fichier, en retirer une copie à la main`);
        }
      }
      this.archives = archives;
    }
    return this.archives;
  }

  /** Le fichier de l'année, créé en mémoire s'il n'existe pas encore (écrit par `save()`). */
  private archiveFor(year: string): NonNullable<Plan['archives']>[number] {
    const archives = this.loadArchives();
    const file = join(this.archiveDir, `${year}.yaml`);
    let found = archives.find((a) => a.file === file);
    if (!found) {
      found = { file, doc: newArchiveDoc(year), dirty: true };
      archives.push(found);
      archives.sort((a, b) => (a.file < b.file ? -1 : 1));
    }
    return found;
  }

  /**
   * Un lot archivé qui n'est plus clos (`raf todo` sur un lot done archivé) revient à la fin du fichier du plan à l'écriture :
   * l'archive ne porte que des lots done ou dropped, et le plan actif reste le seul fichier à porter du travail ouvert.
   */
  private reopened(): void {
    const active = this.doc.get('lots') as YAMLSeq;
    for (const a of this.archives ?? []) {
      const seq = archiveLots(a.doc);
      const back = seq.items.filter((n): n is YAMLMap => isMap(n) && !['done', 'dropped'].includes(String(n.get('status'))));
      if (back.length === 0) continue;
      seq.items = seq.items.filter((n) => !back.includes(n as YAMLMap));
      for (const n of back) active.add(n);
      a.dirty = true;
    }
  }

  /**
   * `raf archive` : déplace les lots done et dropped du fichier du plan (terminés avant `before` s'il est donné) vers le fichier de leur année
   * de fin, puis écrit le tout par `save()` : si l'écriture échoue (toute exception — EACCES, `plan.onWrite` en échec, L346), plan et archive
   * reviennent tels qu'avant, sur le disque (`save()`) comme en mémoire (ici). `blocked` : la raison pour laquelle un lot reste (un écart ouvert que `raf check` signale), null sinon.
   * `dryRun` : rend ce qui serait déplacé, sans rien écrire.
   */
  archive(today: Day, opts: { before?: Day; dryRun?: boolean; blocked?: (lot: Lot) => string | null } = {}): { moved: { lot: Lot; file: string }[]; kept: Kept[] } {
    this.writable();
    const { move, kept } = selectArchivable(this.activeRaw().map((r) => normalizeLot(r)), opts.before, opts.blocked);
    const files = (lot: Lot) => join(this.archiveDir, `${archiveYear(lot, today)}.yaml`);
    const result = { moved: move.map((lot) => ({ lot, file: files(lot) })), kept };
    if (opts.dryRun || move.length === 0) return result;
    const seq = this.doc.get('lots') as YAMLSeq;
    const ids = new Set(move.map((l) => l.id));
    const nodes = seq.items.filter((n): n is YAMLMap => isMap(n) && ids.has(String(n.get('id'))));
    // De quoi revenir en arrière en mémoire : les items du plan, ceux de chaque archive déjà chargée, et le nombre d'archives (les nouvelles s'ajoutent à la fin).
    const archives = this.loadArchives();
    const snapshot = { items: [...seq.items], archives: archives.map((a) => ({ a, items: [...archiveLots(a.doc).items], dirty: a.dirty })) };
    for (const n of nodes) {
      const lot = move.find((l) => l.id === String(n.get('id')))!;
      const target = this.archiveFor(archiveYear(lot, today));
      archiveLots(target.doc).add(n);
      target.dirty = true;
    }
    seq.items = seq.items.filter((n) => !nodes.includes(n as YAMLMap));
    try {
      this.save();
    } catch (e) {
      seq.items = snapshot.items;
      for (const { a, items, dirty } of snapshot.archives) {
        archiveLots(a.doc).items = items;
        a.dirty = dirty;
      }
      this.archives = snapshot.archives.map(({ a }) => a);
      throw e;
    }
    return result;
  }

  /** Le nœud d'un lot, dans le fichier du plan ou dans son fichier d'année ; une archive dont on prend un nœud sera réécrite (les appelants modifient). */
  private lotNode(id: string): YAMLMap {
    const find = (seq: YAMLSeq) => seq.items.find((n) => isMap(n) && String(n.get('id')) === id) as YAMLMap | undefined;
    const archives = this.loadArchives(); // avant toute écriture : un identifiant en double est refusé ici aussi
    const own = find(this.doc.get('lots') as YAMLSeq);
    if (own) return own;
    for (const a of archives) {
      const node = find(archiveLots(a.doc));
      if (node) {
        a.dirty = true;
        return node;
      }
    }
    throw new RafError(`lot inconnu : ${id}`);
  }

  private taskNode(lotId: string, taskId: string): YAMLMap {
    const tasks = this.lotNode(lotId).get('tasks');
    const node = isSeq(tasks) ? tasks.items.find((n) => isMap(n) && String(n.get('id')) === taskId) : undefined;
    if (!node) throw new RafError(`sous-tâche inconnue : ${lotId}/${taskId}`);
    return node as YAMLMap;
  }

  add(title: string, today: Day, opts: { estimate?: number; quickwin?: boolean; visible?: boolean; screen?: Screen; spec?: boolean; public?: string; every?: number; after?: string[]; uses?: string[] } = {}): string {
    this.writable();
    if (opts.screen !== undefined) {
      if (!SCREENS.includes(opts.screen)) throw new RafError(`screen inconnu : ${String(opts.screen)} (${SCREENS.join(', ')})`);
      if (!opts.visible) throw new RafError('--screen exige --visible : un écran est un changement visible');
    }
    // Les lots archivés sont dans `lots()` : leur identifiant n'est jamais réutilisé.
    const known = new Set(this.lots().map((l) => l.id));
    for (const dep of opts.after ?? []) if (!known.has(dep)) throw new RafError(`dépendance inconnue : ${dep}`);
    const re = new RegExp(`^${escapeRe(this.prefix)}(\\d+)$`);
    const max = Math.max(0, ...[...known].map((id) => Number(re.exec(id)?.[1] ?? 0)));
    const id = `${this.prefix}${max + 1}`;
    const pub = opts.public === undefined ? undefined : cleanPublic(opts.public);
    if (opts.every !== undefined && !(Number.isInteger(opts.every) && opts.every > 0)) {
      throw new RafError(`périodicité invalide : ${opts.every} (un nombre entier de jours, 1 au moins)`);
    }
    const entry: Record<string, unknown> = { id, title };
    if (pub !== undefined) entry.public = pub;
    Object.assign(entry, { status: 'todo', estimate: opts.estimate ?? 1 });
    if (opts.quickwin) entry.quickwin = true;
    if (opts.visible) entry.visible = true;
    if (opts.screen) entry.screen = opts.screen;
    if (opts.spec) entry.spec = true;
    if (opts.every !== undefined) entry.every = opts.every;
    if (opts.after?.length) entry.after = opts.after;
    if (opts.uses?.length) entry.uses = cleanUses(opts.uses);
    entry.created = today;
    const node = this.doc.createNode(entry) as YAMLMap;
    for (const key of ['after', 'uses']) {
      const seq = node.get(key);
      if (isSeq(seq)) seq.flow = true;
    }
    (this.doc.get('lots') as YAMLSeq).add(node);
    return id;
  }

  /** Déclare les dépôts voisins d'un lot (clé `repos:`) : un chemin seul, ou `{ path, cite }` quand le voisin est partagé. */
  setRepos(lotId: string, repos: LotRepoDecl[]): void {
    this.writable();
    const node = this.doc.createNode(repos.map((r) => (r.cite === undefined ? r.path : { path: r.path, cite: r.cite }))) as YAMLSeq;
    node.flow = true;
    this.lotNode(lotId).set('repos', node);
  }

  /** Acquitte l'écart `docs.sync` d'un lot (L317) : clé `docs_ok: { date, reason }`, la raison est obligatoire. Jamais sur une sous-tâche. */
  setDocsOk(ref: string, reason: string, today: Day): void {
    if (ref.includes('/')) throw new RafError(`docs-ok se pose sur un lot, pas sur une sous-tâche : ${ref}`);
    const why = reason.trim();
    if (!why) throw new RafError('docs-ok exige une raison : raf docs-ok <lot> --reason "pourquoi la documentation reste telle quelle"');
    if (this.readonly) {
      // Le plan est tenu par un autre outil : l'acquittement va dans un fichier de cadence, le plan n'est pas touché (L386).
      const file = this.docsOkFile;
      if (!file) throw new RafError(`plan en lecture seule : ${this.path} est tenu par un autre outil — pas de cadence.yaml lu, donc pas de ${DOCS_OK_FILE} où acquitter`);
      if (!this.lots().some((l) => l.id === ref)) throw new RafError(`lot inconnu : ${ref}`);
      const doc = existsSync(file) ? parseDocument(readFileSync(file, 'utf8')) : new Document({});
      if (doc.errors.length > 0) throw new RafError(`${file} : ${doc.errors[0].message}`);
      if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
      const entry = doc.createNode({ date: today, reason: why }) as YAMLMap;
      entry.flow = true;
      doc.set(ref, entry);
      if (!existsSync(file)) doc.commentBefore = ' Écarts docs.sync acquittés (raf docs-ok) pour un plan tenu par un autre outil, lu par raf check et cadence orchestrate.';
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, doc.toString({ lineWidth: 0 }));
      return;
    }
    const node = this.doc.createNode({ date: today, reason: why }) as YAMLMap;
    node.flow = true;
    this.lotNode(ref).set('docs_ok', node);
  }

  /** Remplace les ressources partagées d'un lot de tout statut (clé `uses:` en flow, avant `created:`) ; sans nom, retire la clé. Jamais sur une sous-tâche. */
  setUses(ref: string, names: string[]): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`uses se pose sur un lot, pas sur une sous-tâche : ${ref}`);
    const node = this.lotNode(ref);
    const uses = cleanUses(names);
    if (uses.length === 0) {
      node.delete('uses');
      return;
    }
    const list = this.doc.createNode(uses) as YAMLSeq;
    list.flow = true;
    if (node.has('uses')) {
      node.set('uses', list);
      return;
    }
    const keys = node.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key));
    const created = keys.indexOf('created');
    const after = keys.indexOf('after');
    node.items.splice(created >= 0 ? created : after >= 0 ? after + 1 : keys.length, 0, this.doc.createPair('uses', list));
  }

  /**
   * Place un lot (ou une sous-tâche) juste avant ou juste après un autre du même parent (L400) : les lots entre eux, les sous-tâches d'un même lot entre elles.
   * Seul l'ordre du fichier change — le nœud voyage avec ses clés et ses commentaires. Un lot archivé n'a pas de place dans le fichier du plan
   * (l'archive se présente dans l'ordre d'avant l'archivage, jamais déplacée) : refusé. Déjà à sa place : rien à écrire.
   */
  move(ref: string, place: 'before' | 'after', target: string): void {
    this.writable();
    if (ref === target) throw new RafError(`move : ${ref} ne peut pas être placé par rapport à lui-même`);
    const parent = (r: string) => (r.includes('/') ? r.slice(0, r.indexOf('/')) : null);
    const siblings = (r: string): YAMLSeq => {
      const owner = parent(r);
      const top = this.doc.get('lots') as YAMLSeq;
      const lotId = owner ?? r;
      if (!top.items.some((n) => isMap(n) && String(n.get('id')) === lotId)) {
        this.lotNode(lotId); // inconnu : « lot inconnu », même dans l'archive
        throw new RafError(`move : ${lotId} est archivé — l'ordre du plan ne compte que les lots du fichier du plan`);
      }
      if (!owner) return top;
      this.taskNode(owner, r.slice(owner.length + 1)); // sous-tâche inconnue
      return this.lotNode(owner).get('tasks') as YAMLSeq;
    };
    const from = siblings(ref);
    const to = siblings(target);
    if (parent(ref) !== parent(target)) throw new RafError(`move : ${ref} et ${target} n'ont pas le même parent — un lot se place parmi les lots, une sous-tâche parmi celles de son lot`);
    const idOf = (r: string) => (parent(r) ? r.slice(r.indexOf('/') + 1) : r);
    const at = (seq: YAMLSeq, r: string) => seq.items.findIndex((n) => isMap(n) && String(n.get('id')) === idOf(r));
    const node = from.items[at(from, ref)];
    const without = from.items.filter((n) => n !== node);
    const wanted = without.findIndex((n) => n === to.items[at(to, target)]) + (place === 'after' ? 1 : 0);
    if (at(from, ref) === wanted) return;
    without.splice(wanted, 0, node);
    from.items = without;
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
      throw new RafError(`${lotId} est ${lot.status} ; le rouvrir si c'est voulu : raf todo ${lotId}`);
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

  /**
   * Remet en attente un lot démarré (doing → todo, `started` retiré, note datée) — `raf todo` (L220). Les refus passent dans
   * l'ordre : plan modifiable, lot et non sous-tâche, lot connu, lot doing ; `commits` n'est lu qu'ensuite (il lit git) et un lot
   * qui a du travail est refusé. Les sous-tâches et les autres clés du lot ne bougent pas.
   * Rouvre aussi un lot clos (done ou dropped → todo, `finished` retiré, note datée « rouvert ») : c'est LA commande pour le faire,
   * jamais le YAML — un lot archivé rouvert revient dans le fichier du plan à l'écriture (L396). Ses commits restent les siens : `started` est gardé.
   */
  putBack(ref: string, today: Day, reason: string, commits: () => number): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`raf todo se pose sur un lot, pas une sous-tâche : ${ref}`);
    const lot = this.lot(ref);
    if (lot.status === 'todo') throw new RafError(`${ref} est déjà todo`);
    if (lot.status === 'done' || lot.status === 'dropped') {
      const node = this.lotNode(ref);
      node.set('status', 'todo');
      node.delete('finished');
      this.note(ref, reason.trim() ? `rouvert (était ${lot.status}) : ${reason.trim()}` : `rouvert (était ${lot.status})`, today);
      return;
    }
    const n = commits();
    if (n > 0) throw new RafError(`${ref} a ${n} commit(s) qui le citent : le remettre en attente perdrait leur lien — raf drop ou le laisser doing`);
    const node = this.lotNode(ref);
    node.set('status', 'todo');
    node.delete('started');
    this.note(ref, reason.trim() ? `remis en attente : ${reason.trim()}` : 'remis en attente', today);
  }

  /** Remplace le titre d'un lot, de tout statut, et note l'ancien titre ; refuse un titre vide ou identique. */
  setTitle(ref: string, text: string, today: Day): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`raf title se pose sur un lot, pas une sous-tâche : ${ref}`);
    const title = text.trim();
    if (title === '') throw new RafError('titre vide — raf title <id> "nouveau titre"');
    const node = this.lotNode(ref);
    const old = String(node.get('title') ?? '');
    if (old === title) throw new RafError(`${ref} porte déjà ce titre`);
    node.set('title', title);
    this.note(ref, `titre remplacé : « ${old} »`, today);
  }

  /** Pose, remplace (texte) ou efface (null) le titre public d'un lot ; la clé suit `title`. */
  setPublic(ref: string, text: string | null): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`le titre public se pose sur un lot, pas une sous-tâche : ${ref}`);
    const node = this.lotNode(ref);
    if (text === null) {
      node.delete('public');
      return;
    }
    const value = cleanPublic(text);
    if (node.has('public')) {
      node.set('public', value);
      return;
    }
    const at = node.items.findIndex((p) => String((p.key as { value?: unknown })?.value ?? p.key) === 'title');
    node.items.splice(at + 1, 0, this.doc.createPair('public', value));
  }

  /** Pose, remplace (nature) ou retire (null) le `screen:` d'un lot existant ; exige `visible`, comme `add`. */
  setScreen(ref: string, screen: Screen | null): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`l'écran se pose sur un lot, pas une sous-tâche : ${ref}`);
    const node = this.lotNode(ref);
    if (screen === null) {
      node.delete('screen');
      return;
    }
    if (!SCREENS.includes(screen)) throw new RafError(`screen inconnu : ${String(screen)} (${SCREENS.join(', ')}, none)`);
    if (this.lot(ref).visible !== true) throw new RafError(`${ref} n'est pas visible : un écran est un changement visible (raf add --visible)`);
    if (node.has('screen')) {
      node.set('screen', screen);
      return;
    }
    const keys = node.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key));
    node.items.splice(keys.indexOf('visible') + 1, 0, this.doc.createPair('screen', screen));
  }

  /** Pose (true) ou retire (false) le `visible:` d'un lot existant ; retirer est refusé tant que le lot a un `screen:` (un écran est un changement visible). */
  setVisible(ref: string, on: boolean): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`visible se pose sur un lot, pas une sous-tâche : ${ref}`);
    const node = this.lotNode(ref);
    const lot = this.lot(ref);
    if (!on) {
      if (lot.screen) throw new RafError(`${ref} a screen: ${lot.screen} — retirer d'abord screen: (raf screen ${ref} none), un écran est un changement visible`);
      node.delete('visible');
      return;
    }
    if (node.has('visible')) {
      node.set('visible', true);
      return;
    }
    const keys = node.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key));
    const at = Math.max(...['quickwin', 'estimate', 'status'].map((k) => keys.indexOf(k)));
    node.items.splice(at + 1, 0, this.doc.createPair('visible', true));
  }

  /** Pose (true) ou retire (false) le `spec:` d'un lot existant ; `screen: page` l'implique, donc on ne retire pas la spec d'un lot à page (`component` et `journey` suivent le chemin ordinaire depuis L209 : leur `spec: true` est la spec back). Renvoie false quand `screen: page` rendait la pose sans objet. */
  setSpec(ref: string, on: boolean): boolean {
    this.writable();
    if (ref.includes('/')) throw new RafError(`la spec se pose sur un lot, pas une sous-tâche : ${ref}`);
    const node = this.lotNode(ref);
    if (this.lot(ref).screen === 'page') {
      if (!on) throw new RafError(`${ref} a screen: page — retirer d'abord screen: (raf screen ${ref} none), l'écran implique la spec`);
      return false;
    }
    if (!on) {
      node.delete('spec');
      return true;
    }
    if (node.has('spec')) {
      node.set('spec', true);
      return true;
    }
    const keys = node.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key));
    const at = Math.max(...['screen', 'visible', 'quickwin', 'estimate'].map((k) => keys.indexOf(k)));
    node.items.splice(at + 1, 0, this.doc.createPair('spec', true));
    return true;
  }

  /** Un lot récurrent a été refait : `last` passe à aujourd'hui, avec une note si `text` est donné. */
  did(ref: string, today: Day, text?: string): void {
    this.writable();
    if (ref.includes('/')) throw new RafError(`la périodicité se pose sur un lot, pas une sous-tâche : ${ref}`);
    const lot = this.lot(ref);
    if (lot.every === undefined) throw new RafError(`${ref} n'est pas récurrent — raf add --every <jours> pour en créer un`);
    if (!isOpen(lot.status)) throw new RafError(`${ref} est ${lot.status}`);
    this.lotNode(ref).set('last', today);
    if (text?.trim()) this.note(ref, text.trim(), today);
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
/** Fichier d'acquittement docs-ok d'un plan en lecture seule, relatif à la racine du dépôt (L386). */
const DOCS_OK_FILE = '.cadence/docs-ok.yaml';

/** Les acquittements du fichier : lot → { date, reason }. Une entrée sans raison n'acquitte rien ; un fichier illisible est une erreur qui le nomme. */
function readDocsOkFile(file: string | null): Record<string, { date: Day; reason: string }> {
  if (!file || !existsSync(file)) return {};
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new RafError(`${file} : ${doc.errors[0].message}`);
  const raw = doc.toJSON() as unknown;
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RafError(`${file} : la racine doit être un objet (lot → { date, reason })`);
  const out: Record<string, { date: Day; reason: string }> = {};
  for (const [id, v] of Object.entries(raw)) {
    const e = v as { date?: unknown; reason?: unknown } | null;
    if (e && typeof e === 'object' && typeof e.reason === 'string' && e.reason.trim() !== '') out[id] = { date: String(e.date ?? ''), reason: e.reason.trim() };
  }
  return out;
}

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
        screen: pick('screen'),
        // Le `spec:` d'un plan tenu par un autre outil n'est à nous que s'il est mappé, et seul `true` compte : ailleurs c'est souvent un chemin de document (L198).
        spec: format.fields.spec && pick('spec') === true ? true : undefined,
        public: pick('public'),
        every: pick('every'),
        last: day('last'),
        after: pick('after'),
        created: day('created'),
        started: day('started'),
        finished: day('finished'),
        notes: typeof notes === 'string' ? [{ text: notes }] : notes,
        repos: pick('repos'),
        gate: pick('gate'),
        goal: pick('goal'),
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
      lots.push(parent ? { ...lot, parent } : lot);
    }
  }
  return lots;
}

/** Lit `gate: { count: N, spec: true }` ou `{ count: N, screen: page }` ; toute autre forme est un problème du lot et une condition jamais remplie. */
function readGate(raw: unknown, problems: string[]): Gate | undefined {
  if (raw == null) return undefined;
  const invalid = (): Gate => {
    problems.push(GATE_INVALID);
    return { invalid: true };
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const g = raw as Record<string, unknown>;
  if (!Number.isInteger(g.count) || (g.count as number) < 1) return invalid();
  const criteria = [...(g.spec === true ? ['spec' as const] : []), ...(g.screen === 'page' ? ['screen' as const] : [])];
  const others = Object.keys(g).filter((k) => k !== 'count' && k !== 'spec' && k !== 'screen');
  if (criteria.length !== 1 || others.length || ('spec' in g && g.spec !== true) || ('screen' in g && g.screen !== 'page')) return invalid();
  return { count: g.count as number, criterion: criteria[0]! };
}

/** Un titre public vide ne dirait rien au public : refusé plutôt qu'écrit. */
function cleanPublic(text: string): string {
  const t = text.trim();
  if (t === '') throw new RafError('titre public vide — raf public <id> "titre" (ou --clear pour l\'effacer)');
  return t;
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
  const last = asDay('last');
  let uses: string[] | undefined;
  if (raw.uses != null) {
    if (Array.isArray(raw.uses) && raw.uses.every((n) => typeof n === 'string' && RESOURCE_NAME.test(n))) uses = [...new Set(raw.uses as string[])];
    else problems.push(`uses ${RESOURCES_BAD_LIST}`);
  }
  let screen: Screen | undefined;
  if (raw.screen != null) {
    if (SCREENS.includes(raw.screen as Screen)) screen = raw.screen as Screen;
    else problems.push(`screen « ${String(raw.screen)} » inconnu (${SCREENS.join(', ')})`);
    if (screen && raw.visible !== true) problems.push(`screen « ${screen} » sans visible : un écran est un changement visible`);
  }
  let spec: true | undefined;
  if (raw.spec != null) {
    if (raw.spec === true) spec = true;
    else if (raw.spec !== false) problems.push(`spec : true ou false attendu (reçu « ${String(raw.spec)} »)`);
  }
  const gate = readGate(raw.gate, problems);
  const okRaw = raw.docs_ok as Record<string, unknown> | undefined;
  const docsOk = okRaw && typeof okRaw === 'object' && typeof okRaw.reason === 'string' && okRaw.reason.trim() !== '' ? { date: String(okRaw.date ?? ''), reason: okRaw.reason.trim() } : undefined;
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    status,
    estimate: typeof raw.estimate === 'number' && raw.estimate > 0 ? raw.estimate : 1,
    quickwin: raw.quickwin === true,
    visible: raw.visible === true,
    ...(screen ? { screen } : {}),
    ...(spec ? { spec } : {}),
    ...(gate ? { gate } : {}),
    ...(typeof raw.public === 'string' && raw.public.trim() !== '' ? { public: raw.public.trim() } : {}),
    ...(typeof raw.goal === 'string' && raw.goal.trim() !== '' ? { goal: raw.goal.trim() } : {}),
    ...(Number.isInteger(raw.every) && (raw.every as number) > 0 ? { every: raw.every as number } : {}),
    ...(last ? { last } : {}),
    after,
    ...(uses?.length ? { uses } : {}),
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
    ...(repoList(raw.repos).length ? { repos: repoList(raw.repos) } : {}),
    ...(asVerdict(raw.ux) ? { ux: asVerdict(raw.ux) } : {}),
    ...(asVerdict(raw.review) ? { review: asVerdict(raw.review) } : {}),
    ...(docsOk ? { docsOk } : {}),
    problems,
  };
}

/**
 * Dépôts voisins déclarés : une chaîne (le chemin) ou un objet `{ path, cite }`, seuls ou en liste (une valeur seule vaut une
 * liste d'un dépôt). Une entrée sans chemin textuel est écartée ; un `cite` vide ou non textuel vaut pas de `cite`.
 */
function repoList(raw: unknown): LotRepoDecl[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: LotRepoDecl[] = [];
  for (const item of items) {
    const path = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string' ? ((item as Record<string, unknown>).path as string) : '';
    if (path.trim() === '') continue;
    const cite = item && typeof item === 'object' ? (item as Record<string, unknown>).cite : undefined;
    out.push({ path: path.trim(), ...(typeof cite === 'string' && cite.trim() !== '' ? { cite: cite.trim() } : {}) });
  }
  return out;
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
  if (v.repos && typeof v.repos === 'object' && !Array.isArray(v.repos)) {
    const repos = Object.entries(v.repos as Record<string, unknown>).map(([k, sha]) => [k, sha == null || String(sha).trim() === '' ? null : String(sha).trim()] as const);
    if (repos.length) verdict.repos = Object.fromEntries(repos);
  }
  const r = v.reporte as Record<string, unknown> | null | undefined;
  if (r && typeof r === 'object' && !Array.isArray(r) && r.de != null && r.vers != null) verdict.reporte = { de: String(r.de), vers: String(r.vers), patchId: String(r.patchId ?? '') };
  return verdict;
}
