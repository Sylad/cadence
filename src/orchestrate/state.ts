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
}

export interface LotState {
  project: string;
  repo: string;
  lot: string;
  title: string;
  visible: boolean;
  small: boolean;
  model: Model;
  readOnlyPlan: boolean;
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

export const lotKey = (project: string, lot: string) => `${project}:${lot}`;
const lotFile = (project: string, lot: string) => `${project}--${lot}.json`;

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

  /** La dernière vague (par identifiant) ; avec `unfinished`, la dernière qui n'est pas terminée. */
  static last(launchDir: string, opts: { unfinished?: boolean } = {}): RunStore | null {
    const base = RunStore.runsDir(launchDir);
    if (!existsSync(base)) return null;
    const ids = readdirSync(base).filter((n) => existsSync(join(base, n, 'wave.json'))).sort().reverse();
    for (const id of ids) {
      const store = new RunStore(launchDir, id);
      if (!opts.unfinished || store.readWave()?.status !== 'done') return store;
    }
    return null;
  }

  static find(launchDir: string, id: string): RunStore | null {
    return existsSync(join(RunStore.runsDir(launchDir), id, 'wave.json')) ? new RunStore(launchDir, id) : null;
  }

  lotDir(project: string, lot: string): string {
    const d = join(this.dir, `${project}--${lot}`);
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
