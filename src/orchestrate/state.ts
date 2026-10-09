import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gitCommonDir, gitRoot } from '../git.js';
import type { Model, StepKind } from './launch.js';
import type { Tokens } from './result.js';

export type WaveStatus = 'running' | 'suspended-budget' | 'suspended-quota' | 'done' | 'interrupted';
export type LotStatus = 'queued' | 'implementing' | 'reviewing' | 'fixing' | 'question' | 'ready' | 'handed-back' | 'failed' | 'suspended';
export type StepStatus = 'running' | 'ok' | 'failed' | 'interrupted';

export interface WaveState {
  id: string;
  created: string;
  cwd: string;
  /** Plafond des tokens comptés (entrée + écriture de cache + sortie). */
  budget: number;
  consumed: number;
  /** Lecture de cache cumulée : affichée à part, jamais comptée. */
  cacheRead: number;
  status: WaveStatus;
  /** Pid de l'orchestrateur. */
  pid: number;
  /** "projet:lot", dans l'ordre donné. */
  lots: string[];
}

export interface StepState {
  n: number;
  kind: StepKind;
  model: Model;
  /** Niveau d'effort demandé à la session (`--effort`, L137) ; absent : celui de la session (`default`, ou une vague d'avant L137). */
  effort?: string;
  status: StepStatus;
  pid?: number;
  sessionId?: string;
  started: string;
  ended?: string;
  tokens?: Tokens;
  peakContext?: number | null;
  headBefore?: string;
  headAfter?: string;
  commits?: string[];
  /** Fichier de la sortie JSON de la session, dans le dossier du lot. */
  report?: string;
  cause?: string;
  /** Vrai quand la sortie structurée vient de la relance de mise en forme (jetons de la relance compris dans `tokens`). */
  formatRetry?: boolean;
}

export interface Constat {
  source: 'code' | 'ux' | 'tests';
  gravite: string;
  fichier?: string;
  ligne?: number;
  texte: string;
}

export interface ReviewSummary {
  conforme: boolean;
  bloquants: number;
  majeurs: number;
  mineurs: number;
  verdict: string;
  sousTaches: string[];
  nonVerifie: string[];
  /** HEAD que la revue a lu. */
  head: string;
  /** HEAD lu de chaque dépôt voisin du lot (L62), sous le chemin déclaré ; absent sans dépôt voisin. */
  repoHeads?: Record<string, string>;
}

export interface LotState {
  project: string;
  repo: string;
  lot: string;
  title: string;
  visible: boolean;
  small: boolean;
  /** Lot léger (estimate ≤ orchestrate.review.threshold, L108) : une revue légère, pas de passe des mineurs. Absent : lot ordinaire. */
  light?: boolean;
  model: Model;
  readOnlyPlan: boolean;
  /** Dépôts voisins du lot (clé de lot `repos:`, L62), résolus au lancement : chemin déclaré et racine git. Absent : le dépôt du projet seul. */
  repos?: { rel: string; path: string; cite?: string }[];
  /** Node imposé par le `.nvmrc` du projet : ses sessions l'ont en tête du PATH. Absent sans .nvmrc. */
  node?: { version: string; wanted: string; bin: string; /** Versions plus hautes écartées (pas de node exécutable), pour le dry-run. */ skipped?: string[]; /** Dossier de liens (node, npm, npx, corepack) en tête du PATH des sessions. */ link?: string };
  /** Lots du même projet, plus tôt dans la vague, dont celui-ci dépend (`after`) : il attend qu'ils soient prêts. */
  dependsOn?: string[];
  /** Plafond des tokens comptés par les sessions de ce lot, dérivé de l'estimate (L78). Absent : seul le budget de la vague borne. */
  budget?: number;
  status: LotStatus;
  /** Passes de correction faites. */
  pass: number;
  /** Vrai une fois la passe unique de correction des mineurs lancée (revue conforme avec mineurs) ; elle ne se rejoue pas. */
  minorPass?: boolean;
  /** Passes de correction faites quand la passe des mineurs a été décidée : sert à nommer la dernière passe d'écriture jouée. */
  minorPassAt?: number;
  /** Vrai entre la décision de la passe des mineurs et la fin de sa session `fix` : celle-ci reçoit le brief des mineurs, pas celui des défauts. */
  minorFix?: boolean;
  /** Mineurs confiés à la passe des mineurs (lignes de proposition) : retirés des propositions si la revue courte qui la suit est conforme. */
  minorLines?: string[];
  /** Prochaine étape à jouer ; null = cycle terminé. Relue à la reprise. */
  next: StepKind | null;
  startedSha?: string;
  steps: StepState[];
  /** Constats à corriger par la prochaine session `fix`. */
  constats: Constat[];
  code?: ReviewSummary;
  ux?: ReviewSummary;
  uxNote?: string;
  /** Contrôles lancés par le programme (tests, build) au `head` indiqué, passés au relecteur tant que HEAD n'a pas bougé. */
  checks?: { head: string; runs: { label: 'tests' | 'build'; command: string; code: number }[] };
  /** Dossier où le Playwright d'une étape (ux, ou implement/fix d'un lot visible) a rangé captures et snapshots (dans le dossier de la vague, hors du dépôt). */
  uxCaptures?: string;
  /** Constat du contrôle préalable (livrable en partie présent), joint au brief de la première implémentation. */
  precheck?: string;
  /** Réponse de l'humain à une question, jointe au brief de la prochaine session puis effacée. */
  pendingAnswer?: string | null;
  verdict: string | null;
  uxVerdict: string | null;
  questions: string[];
  /** Choix d'interprétation faits par les sessions d'écriture, relus par la revue et rendus au lead. */
  choix: string[];
  answers: string[];
  /** Mineurs et sous-tâches proposées, rendus au lead (pas ajoutés au plan). */
  proposals: string[];
  warnings: string[];
  /** Commit du plan qui porte le verdict enregistré. */
  outcome: string | null;
}

export interface NewLot {
  project: string;
  repo: string;
  lot: string;
  title: string;
  visible: boolean;
  small: boolean;
  model: Model;
  readOnlyPlan: boolean;
}

export function newLot(o: NewLot): LotState {
  return { ...o, status: 'queued', pass: 0, next: null, steps: [], constats: [], verdict: null, uxVerdict: null, questions: [], choix: [], answers: [], proposals: [], warnings: [], outcome: null };
}

/** Un lot fini ne travaille plus dans son dépôt : prêt, rendu ou échoué. */
export const lotFinished = (l: Pick<LotState, 'status'>): boolean => l.status === 'ready' || l.status === 'handed-back' || l.status === 'failed';

/** Tous les dépôts où les sessions du lot travaillent : celui du projet, puis ses voisins. */
export const lotRepoPaths = (l: Pick<LotState, 'repo' | 'repos'>): string[] => [l.repo, ...(l.repos ?? []).map((r) => r.path)];

/** Les dépôts voisins du lot, donnés en `--add-dir` à ses sessions. */
export const neighbourDirs = (l: Pick<LotState, 'repos'>): string[] => (l.repos ?? []).map((r) => r.path);

export const lotKey = (project: string, lot: string) => `${project}:${lot}`;
/** Nom de dossier d'un lot dans la vague : le « / » d'un id de sous-tâche (`Q4/accueil-4-ux12`) devient « __ » ; un id sans « / » est inchangé. */
export const lotSlug = (project: string, lot: string) => `${project}--${lot.split('/').join('__')}`;
const lotFile = (project: string, lot: string) => `${lotSlug(project, lot)}.json`;

function atomicWrite(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** `.cadence/runs/<vague>/` du dossier de lancement. */
export class RunStore {
  readonly dir: string;

  constructor(
    readonly launchDir: string,
    readonly id: string,
  ) {
    this.dir = join(launchDir, '.cadence', 'runs', id);
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Réserve l'identifiant de vague : `mkdir` sans `recursive` échoue (EEXIST) si une autre vague l'a pris, même à
   * la même seconde. Sans identifiant demandé, on passe au suffixe suivant (`-2`, `-3`…) ; avec un identifiant
   * demandé, null (refus : jamais deux vagues dans le même dossier d'état).
   */
  static reserve(launchDir: string, base: string, opts: { exact?: boolean } = {}): RunStore | null {
    mkdirSync(RunStore.runsDir(launchDir), { recursive: true });
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base}-${i}`;
      try {
        mkdirSync(join(RunStore.runsDir(launchDir), id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (opts.exact) return null;
        continue;
      }
      return new RunStore(launchDir, id);
    }
  }

  static runsDir(launchDir: string): string {
    return join(launchDir, '.cadence', 'runs');
  }

  /** La dernière vague lancée (par date de lancement : un identifiant libre comme `ol-gains-1` ne se range pas par ordre alphabétique) ; avec `unfinished`, la dernière qui n'est pas terminée. */
  static last(launchDir: string, opts: { unfinished?: boolean } = {}): RunStore | null {
    const base = RunStore.runsDir(launchDir);
    if (!existsSync(base)) return null;
    const stores = readdirSync(base)
      .filter((n) => existsSync(join(base, n, 'wave.json')))
      .map((id) => new RunStore(launchDir, id))
      .map((store) => ({ store, wave: store.readWave() }))
      // lancement le plus récent d'abord ; à date égale (ou illisible), l'identifiant le plus grand
      .sort((a, b) => (b.wave?.created ?? '').localeCompare(a.wave?.created ?? '') || b.store.id.localeCompare(a.store.id));
    for (const { store, wave } of stores) {
      if (!opts.unfinished || wave?.status !== 'done') return store;
    }
    return null;
  }

  static find(launchDir: string, id: string): RunStore | null {
    return existsSync(join(RunStore.runsDir(launchDir), id, 'wave.json')) ? new RunStore(launchDir, id) : null;
  }

  lotDir(project: string, lot: string): string {
    const d = join(this.dir, lotSlug(project, lot));
    mkdirSync(d, { recursive: true });
    return d;
  }

  writeWave(w: WaveState): void {
    atomicWrite(join(this.dir, 'wave.json'), w);
  }

  readWave(): WaveState | null {
    const f = join(this.dir, 'wave.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as WaveState) : null;
  }

  writeLot(l: LotState): void {
    atomicWrite(join(this.dir, lotFile(l.project, l.lot)), l);
  }

  readLot(project: string, lot: string): LotState | null {
    const f = join(this.dir, lotFile(project, lot));
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as LotState) : null;
  }

  /** Les lots de la vague, dans l'ordre donné au lancement (`wave.lots`) : une reprise rejoue les dépendances avant les dépendants. */
  lots(): LotState[] {
    const all = readdirSync(this.dir)
      .filter((n) => n.endsWith('.json') && n !== 'wave.json')
      .sort()
      .map((n) => JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as LotState);
    const order = this.readWave()?.lots ?? [];
    const rank = (l: LotState) => {
      const i = order.indexOf(lotKey(l.project, l.lot));
      return i < 0 ? order.length : i;
    };
    return all.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
  }

  /** Demandes faites à une vague vivante (`--drop`, `--stop-after-current`, L79) : un fichier de lignes, en ajout seul, que la vague relit avant chaque session. Pas de `.json` : `lots()` le prendrait pour un lot. */
  control(): { drops: string[]; stopAfterCurrent: boolean } {
    const f = join(this.dir, 'control.log');
    const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').map((l) => l.trim()) : [];
    return { drops: lines.filter((l) => l.startsWith('drop ')).map((l) => l.slice(5)), stopAfterCurrent: lines.includes('stop-after-current') };
  }

  requestDrop(key: string): void {
    appendFileSync(join(this.dir, 'control.log'), `drop ${key}\n`);
  }

  requestStopAfterCurrent(): void {
    appendFileSync(join(this.dir, 'control.log'), 'stop-after-current\n');
  }

  /** Efface l'arrêt demandé (`--resume`) ; les retraits restent. */
  clearStopRequest(): void {
    const f = join(this.dir, 'control.log');
    if (!existsSync(f)) return;
    const kept = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '' && l.trim() !== 'stop-after-current');
    writeFileSync(f, kept.map((l) => `${l}\n`).join(''));
  }

  journal(line: string): void {
    appendFileSync(join(this.dir, 'journal.log'), `${new Date().toISOString()} ${line}\n`);
  }
}

/** Ajoute `.cadence/` à `.git/info/exclude` quand le dossier de lancement est dans un dépôt : l'état ne salit jamais un arbre. */
export function excludeState(launchDir: string): void {
  const root = gitRoot(launchDir);
  if (!root) return;
  const rel = relative(root, join(launchDir, '.cadence')).split('\\').join('/');
  const pattern = `/${rel}/`;
  const file = join(gitCommonDir(launchDir), 'info', 'exclude');
  mkdirSync(join(gitCommonDir(launchDir), 'info'), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(pattern)) return;
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${pattern}\n`);
}
