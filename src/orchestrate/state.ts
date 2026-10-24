import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gitCommonDir, gitRoot } from '../git.js';
import type { Model, SessionKind, StepKind, StepModel } from './launch.js';
import type { Screen } from '../plan.js';
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
  kind: SessionKind;
  model: StepModel;
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
  /** Objectif donné au lancement (`--goal`, ou clé `goal:` du lot, L258) : remplace le titre dans les briefs, rendu au tableau. Absent : le titre. */
  goal?: string;
  visible: boolean;
  small: boolean;
  /** Estimate du plan, en jours (L298) : le délai des étapes d'écriture en est proportionné. Absent (état antérieur) : le délai de base. */
  estimate?: number;
  /** Seuil de l'étape spec (clé de lot `screen:`, L169) : le lot passe par `spec` avant `implement`. Absent : chemin actuel. */
  screen?: Screen;
  /** Lot à `spec: true` sans écran (L188) : il passe par `spec` avant `implement`, sa fiche est back seule. Jamais posé sur un lot à `screen:` : un lot mixte est un lot à écran dont la fiche a un bloc `sujet` (le cycle lit la fiche). */
  specLot?: true;
  /** Issue de l'étape spec : la fiche écrite (et le nombre de ses hypothèses), ou la raison d'une sortie sous le seuil. */
  spec?: { fiche: string; hypotheses: number } | { sousSeuil: string };
  /** Issue de l'étape accept (L173) : l'acceptation.json du lot (chemin relatif au dépôt) et le commit rouge scellé par le programme, rangé ici et dans git, jamais dans le fichier. */
  accept?: { acceptation: string; rouge: string };
  /** Revue UX de la maquette (L172) : nombre de revues jouées (2 au plus), la dernière conforme ou non, son verdict. */
  maquette?: { passes: number; conforme: boolean; verdict: string };
  /** Constats bloquants et majeurs de la revue de maquette, rendus à la seconde passe `spec` (une seule). */
  maquetteConstats?: Constat[];
  /** Revue de la fiche back (L188) : nombre de revues jouées (2 au plus), la dernière conforme ou non, son verdict. */
  fiche?: { passes: number; conforme: boolean; verdict: string };
  /** Constats bloquants et majeurs de la revue de fiche, rendus à la seconde passe `spec` (une seule, avec ceux de la maquette d'un lot mixte). */
  ficheConstats?: Constat[];
  /** Hypothèses de la fiche d'un lot sans écran, une ligne chacune (`R3 : … ; sinon …`) : posées en note du lot, reprises par le tableau de fin de vague (L188). */
  hypotheses?: string[];
  /** Écarts de l'étape accept relevés par le programme, rendus à la seconde passe `accept` (une seule). */
  acceptProblems?: string[];
  /** Écarts de la spec relevés par le programme, rendus à la seconde passe `spec` (une seule). */
  specProblems?: string[];
  /** Sessions spec jouées depuis la dernière question (2 au plus, tous chemins confondus : écarts du programme et constats des revues partagent ce budget). */
  specRuns?: number;
  /** Questions posées par le programme sur des hypothèses coûteuses de la fiche (--answer vide `questions` : elles restent là pour le brief de reprise). */
  specAsked?: string[];
  /** Ids des règles `hypothese` dont `specAsked` pose la question : la réponse du lead les passe en `sourcee` (L297). */
  specAskedRules?: string[];
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
  /** Plafond des tokens comptés par les sessions de ce lot, dérivé de l'estimate (L78), plus l'allocation de l'étape spec pour un lot à écran (L191). Absent : seul le budget de la vague borne. */
  budget?: number;
  status: LotStatus;
  /** Passes de correction faites. */
  pass: number;
  /** Bloquants+majeurs de chaque revue de code non conforme, dans l'ordre : une passe de plus si ça baisse jusqu'à un seul (L205). */
  reviewCounts?: number[];
  /** Vrai une fois la porte « code modifié sans test » jouée (L287) : elle ne se rejoue pas, que la correction ait ajouté un test ou non. */
  testGate?: boolean;
  /** Vrai une fois le bibliothécaire appelé avant la revue (L306), ou écarté faute de passe ou de budget : il ne se rappelle pas. */
  docsGate?: boolean;
  /** Vrai entre la décision de la passe du bibliothécaire et la fin de sa session `fix` : celle-ci reçoit le brief de la documentation et l'agent doc-keeper. */
  docsFix?: boolean;
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
  checks?: { head: string; runs: { label: 'tests' | 'build'; command: string; code: number; /** Tests rouges dont tous les échecs l'étaient déjà au sha de départ (L213) : nombre d'échecs, pas un défaut du lot. */ dejaRouges?: number }[] };
  /** Ligne de base des tests (L213) : échecs déjà présents au sha de départ du lot, listés à part dans le tableau de fin de vague. `verified` : rejoués par le programme à ce sha ; sinon annoncés par la session, non vérifiés. */
  baseline?: { sha: string; command?: string; failures: string[]; verified: boolean };
  /** Dossier où le Playwright d'une étape (ux, ou implement/fix d'un lot visible) a rangé captures et snapshots (dans le dossier de la vague, hors du dépôt). */
  uxCaptures?: string;
  /** Vague d'où le lot reprend sa branche conservée (L301, L311) : le lot repart de ses commits, sans contrôle préalable, à la correction des constats de sa dernière revue (ou à la revue s'il n'en a pas). */
  resumedFrom?: string;
  /** Constat du contrôle préalable (livrable en partie présent), joint au brief de la première implémentation. */
  precheck?: string;
  /** Verdict du contrôle préalable une fois lu (« oui » sans preuve = « partiel »), gardé au journal pour mesurer la part de « oui » (L288). Absent : pas de contrôle. */
  precheckVerdict?: 'oui' | 'partiel' | 'non';
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

/** Début de l'avertissement d'un rapport de précheck illisible (Sonnet) : le journal le garde, `cadence perf` s'en sert pour ne pas compter ce lot « non » (L293). */
export const PRECHECK_UNREADABLE = 'contrôle préalable illisible, implémentation lancée';

export interface NewLot {
  project: string;
  repo: string;
  lot: string;
  title: string;
  goal?: string;
  visible: boolean;
  small: boolean;
  screen?: Screen;
  specLot?: true;
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
/** Nom de dossier d'un lot dans la vague : le « / » d'un id de sous-tâche (`Q4/accueil-4-ux12`) ou d'un projet imbriqué (`groupe/gamma`) devient « __ » ; sans « / » le nom est inchangé. */
/** Racine des TMPDIR de session : `os.tmpdir()`, ou `/tmp` quand celui-ci est trop long pour laisser 60 caractères sous la limite de 107 des sockets Unix. */
const shortTmpBase = () => (join(tmpdir(), 'cadence-xxxxxxxx').length + 60 < 108 ? tmpdir() : '/tmp');
export const lotSlug = (project: string, lot: string) => `${project.split('/').join('__')}--${lot.split('/').join('__')}`;
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

  /** Les vagues du dossier, la plus récente d'abord (par date de lancement : un identifiant libre comme `ol-gains-1` ne se range pas par ordre alphabétique). */
  private static all(launchDir: string): { store: RunStore; wave: WaveState | null }[] {
    const base = RunStore.runsDir(launchDir);
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .filter((n) => existsSync(join(base, n, 'wave.json')))
      .map((id) => new RunStore(launchDir, id))
      .map((store) => ({ store, wave: store.readWave() }))
      // lancement le plus récent d'abord ; à date égale (ou illisible), l'identifiant le plus grand
      .sort((a, b) => (b.wave?.created ?? '').localeCompare(a.wave?.created ?? '') || b.store.id.localeCompare(a.store.id));
  }

  /** La dernière vague lancée. */
  static last(launchDir: string): RunStore | null {
    return RunStore.all(launchDir)[0]?.store ?? null;
  }

  /** Les vagues qui ne sont pas terminées (une vague illisible compte : elle n'est pas `done`), la plus récente d'abord (L309). */
  static unfinished(launchDir: string): RunStore[] {
    return RunStore.all(launchDir).filter((x) => x.wave?.status !== 'done').map((x) => x.store);
  }

  static find(launchDir: string, id: string): RunStore | null {
    return existsSync(join(RunStore.runsDir(launchDir), id, 'wave.json')) ? new RunStore(launchDir, id) : null;
  }

  lotDir(project: string, lot: string): string {
    const d = join(this.dir, lotSlug(project, lot));
    mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * Dossier temporaire des sessions d'un lot (L243) : `<tmpdir>/cadence-<hash court du dossier du lot>`, hors du dépôt et hors de la vague, jamais suivi par git.
   * Il est COURT à dessein : Chrome (Playwright MCP) range ses sockets Unix sous `TMPDIR` et refuse au-delà de 107 caractères
   * (sous `.cadence/runs/<vague>/<projet>--<lot>/tmp`, L242, la revue UX échouait « Socket path too long »).
   * Un lien `<lotDir>/tmp` y renvoie, pour le retrouver depuis le dossier de la vague.
   */
  tmpDir(project: string, lot: string): string {
    const lotDir = this.lotDir(project, lot);
    const d = join(shortTmpBase(), `cadence-${createHash('sha1').update(lotDir).digest('hex').slice(0, 8)}`);
    mkdirSync(d, { recursive: true });
    const link = join(lotDir, 'tmp');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(d, link);
    return d;
  }

  /** Supprime le dossier temporaire du lot et son lien (fin de lot) ; sans effet s'ils n'existent pas. */
  removeTmpDir(project: string, lot: string): void {
    const link = join(this.lotDir(project, lot), 'tmp');
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(readlinkSync(link), { recursive: true, force: true });
    rmSync(link, { recursive: true, force: true });
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

/**
 * Ajoute `.cadence/runs/` (états de vague) et `.cadence/corrections.json` (cache de `cadence corrections`) à `.git/info/exclude`
 * quand le dossier de lancement est dans un dépôt : l'état ne salit jamais un arbre. Le reste de `.cadence/` (le plan, ses notes)
 * est versionné. L'ancienne ligne `/.cadence/`, écrite par une version précédente, est remplacée : elle cacherait aussi le plan.
 */
export function excludeState(launchDir: string): void {
  const root = gitRoot(launchDir);
  if (!root) return;
  const base = `/${relative(root, join(launchDir, '.cadence')).split('\\').join('/')}/`;
  const wanted = [`${base}runs/`, `${base}corrections.json`];
  const file = join(gitCommonDir(launchDir), 'info', 'exclude');
  mkdirSync(join(gitCommonDir(launchDir), 'info'), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  const missing = wanted.filter((w) => !lines.includes(w));
  if (!lines.includes(base) && missing.length === 0) return;
  const kept = lines.filter((l) => l !== base);
  const body = kept.join('\n');
  writeFileSync(file, `${body}${body === '' || body.endsWith('\n') ? '' : '\n'}${missing.map((m) => `${m}\n`).join('')}`);
}
