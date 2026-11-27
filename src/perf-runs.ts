// L795 (issue #69) : `cadence perf` lit aussi les fichiers d'état de `cadence run` (`<dossier du dépôt>/.cadence-run/<dépôt>-<id>.json`, v2/src/run/run.ts),
// à côté des journaux de vague : depuis 2.0.0 les lots se font par run, et un perf qui ne lit que les vagues rend n/d sur toutes les lignes sauf « livrés ».
// Les runs d'un même lot font un seul journal de lot ; un lot qui a aussi un journal de vague est fondu dans le dernier, pour n'être compté qu'une fois.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Journal, JournalPass, JournalStep } from './corrections.js';
import type { PriceGrid } from './perf-config.js';
import type { Lot } from './plan.js';

/** Ce que perf lit d'un état de run (sous-ensemble de `Etat`, v2/src/run/run.ts). */
interface RunState {
  id: string;
  repo: string;
  lot?: string;
  etat: string;
  debut: string;
  cout_usd?: number;
  modele?: string;
  correction_revue?: boolean;
  corrections?: unknown[];
  passes?: { quoi?: string; modele?: string }[];
  lot_visible?: boolean;
  clos?: { date?: string };
  /** Fin du run : la date de dernière écriture du fichier (le run écrit son état final en dernier, `sauver` de `fin`) ; absente pour un run clos, que --clore a réécrit plus tard. */
  fin?: string;
}
type ProjectRun = RunState & { project: string };
/** Une étape de journal qui porte son coût déjà chiffré (`cout_usd` d'un run) : `stepEuros` le prend tel quel, sans la grille. */
type CostedStep = JournalStep & { amount?: number };

/** Le journal de lot d'un lot fait par run seulement porte ce nom de vague. */
const RUN_WAVE = 'cadence-run';
/** Préfixe de la clé d'une passe lue dans un état de run : elle n'a pas de constat à classer (le run ne garde que la sortie de la porte, la revue est hors du run). */
const RUN_PASS = 'run:';
export const isRunPass = (p: JournalPass): boolean => p.key.startsWith(RUN_PASS);

/** Un run fini : intégré, ou rendu au lead (porte rouge, conflit, sans commit…), ou en échec. Un run en cours, en attente d'une réponse ou du quota ne compte pas encore. */
const STATUS: Record<string, string> = {
  integre: 'ready',
  'porte-rouge': 'handed-back',
  'sans-commit': 'handed-back',
  conflit: 'handed-back',
  'sans-porte': 'handed-back',
  'refus-integration': 'handed-back',
  'environnement-perime': 'handed-back',
  echec: 'failed',
};
/** Les fins où la session a commité un travail (la porte l'a jugé, ou l'intégration l'a tenté) : l'équivalent d'une étape implement aboutie. */
const IMPLEMENTED = new Set(['integre', 'porte-rouge', 'conflit', 'sans-porte', 'refus-integration', 'environnement-perime']);

const statusOf = (s: RunState): string | null => STATUS[s.etat] ?? (s.clos ? 'handed-back' : null);

/** Les dossiers `.cadence-run` où les runs des projets de `parent` écrivent leur état : celui du dossier parent de chaque dépôt (`dossierRuns`, run.ts). */
function runDirs(parent: string, projects: string[]): string[] {
  return [...new Set([join(parent, '.cadence-run'), ...projects.map((p) => join(dirname(join(parent, p)), '.cadence-run'))])].filter((d) => existsSync(d));
}

/** Un état de run lisible, ou null (JSON illisible, champs attendus absents). */
function readState(path: string): RunState | null {
  let s: RunState;
  try {
    s = JSON.parse(readFileSync(path, 'utf8')) as RunState;
  } catch {
    return null;
  }
  const ok = !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.repo === 'string' && typeof s.etat === 'string' && typeof s.debut === 'string';
  return ok && !Number.isNaN(Date.parse(s.debut)) ? s : null;
}

/** Le projet (chemin relatif à `parent`, séparateurs « / ») du dépôt d'un run, ou null hors du dossier. */
function projectOf(parent: string, repo: string): string | null {
  const rel = relative(parent, repo);
  return isAbsolute(repo) && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : null;
}

/** Les états de run lisibles des projets de `parent`, chacun avec son projet ; un état illisible ou d'un dépôt hors des projets est sauté. */
export function readRunStates(parent: string, projects: string[]): ProjectRun[] {
  const known = new Set(projects);
  return runDirs(parent, projects).flatMap((dir) => readdirSync(dir).sort().filter((f) => f.endsWith('.json')).flatMap((file): ProjectRun[] => {
    const path = join(dir, file);
    const s = readState(path);
    const project = s && projectOf(parent, s.repo);
    if (!s || !project || !known.has(project)) return [];
    return [{ ...s, project, ...(s.clos ? {} : { fin: statSync(path).mtime.toISOString() }) }];
  }));
}

/** Le dernier état de run de chaque lot du dépôt `repo` (`<dossier du dépôt>/.cadence-run`, comme run.ts) ; `fini` : intégré, rendu ou en échec (revue L931). */
export function lastRunByLot(repo: string): Map<string, { id: string; etat: string; fini: boolean }> {
  const dir = join(dirname(repo), '.cadence-run');
  const out = new Map<string, { id: string; etat: string; fini: boolean; debut: string }>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const s = readState(join(dir, file));
    if (!s?.lot || resolve(s.repo) !== resolve(repo)) continue;
    const prev = out.get(s.lot);
    if (!prev || s.debut >= prev.debut) out.set(s.lot, { id: s.id, etat: s.etat, fini: statusOf(s) !== null, debut: s.debut });
  }
  return out;
}

/** Le lot du plan qu'un run cite, pour sa visibilité et sa revue d'ergonomie. */
type PlanLot = Pick<Lot, 'id'> & Partial<Pick<Lot, 'visible' | 'ux'>>;

/** Une étape `run` : début, fin, coût rapporté par Claude Code, modèle de la dernière session. */
const runStep = (s: RunState, n: number): CostedStep => ({
  n,
  kind: 'run',
  status: 'ok',
  model: s.passes?.at(-1)?.modele ?? s.modele ?? 'opus',
  started: s.debut,
  ...(s.fin ? { ended: s.fin } : {}),
  ...(typeof s.cout_usd === 'number' && Number.isFinite(s.cout_usd) ? { amount: s.cout_usd } : {}),
});

/** Les passes de correction d'un run : une par run de correction après revue (`correction_revue`), une par porte rouge rendue à la session (`corrections`). */
function runPasses(s: RunState, project: string, lot: string, visible: boolean): JournalPass[] {
  const pass = (k: string): JournalPass => ({ key: `${RUN_PASS}${s.id}/${k}`, project, lot, visible, findings: [], commits: [], ...(s.fin ? { fixEnded: s.fin } : {}) });
  const gates = Array.isArray(s.corrections) ? s.corrections.map((_, i) => pass(`porte-${i + 1}`)) : [];
  return [...(s.correction_revue ? [pass('revue')] : []), ...gates];
}

/**
 * Le journal de lot des runs finis d'un même lot : une étape `run` par run et les passes de correction que le run connaît — le plan ne garde
 * que la dernière revue. Sans run fini : null.
 */
function runJournal(project: string, lot: string, states: RunState[], planLot?: PlanLot): Journal | null {
  const runs = states.filter((s) => statusOf(s) !== null).sort((a, b) => a.debut.localeCompare(b.debut));
  if (runs.length === 0) return null;
  const steps: JournalStep[] = runs.map((s, i) => runStep(s, i + 1));
  const visible = !!planLot?.visible || runs.some((s) => s.lot_visible === true);
  // La revue d'ergonomie d'un lot fait par run est un `raf ux` hors du run : le plan en garde le verdict, qui compte une session ux.
  if (visible && planLot?.ux) steps.push({ n: steps.length + 1, kind: 'ux', status: 'ok' });
  return {
    wave: RUN_WAVE, waveCreated: runs[0].debut, waveReadable: true, decisions: [], project, lot, visible, small: false,
    status: statusOf(runs.at(-1)!)!, steps, implemented: runs.some((s) => IMPLEMENTED.has(s.etat)), passes: runs.flatMap((s) => runPasses(s, project, lot, visible)),
  };
}

/** La fin (dernière étape terminée, à défaut la création) d'un journal, pour choisir le dernier journal de vague d'un lot. */
const endOf = (j: Journal): number => Math.max(Date.parse(j.waveCreated ?? '') || 0, ...j.steps.map((s) => Date.parse(s.ended ?? '') || 0));

/** Fond les runs d'un lot dans son dernier journal de vague : étapes, passes, session implement ; le journal garde son statut s'il était fini. */
function merge(target: Journal, rj: Journal): void {
  const runSteps = rj.steps.filter((s) => s.kind === 'run');
  target.steps = [...target.steps, ...runSteps.map((s, i) => ({ ...s, n: target.steps.length + i + 1 }))];
  target.passes = [...target.passes, ...rj.passes];
  target.implemented = target.implemented || rj.implemented;
  if (!['ready', 'handed-back', 'failed'].includes(target.status)) target.status = rj.status;
}

/**
 * Les journaux de vague et ceux des runs ensemble, chaque lot compté une fois : les runs d'un lot qui a un journal de vague s'ajoutent au dernier
 * (« rendu par la vague puis fini par run » reste un lot rendu) ; un lot fait par run seulement donne son journal de run.
 */
export function withRunJournals(journals: Journal[], states: ProjectRun[], planLots: (project: string, lot: string) => PlanLot | undefined): Journal[] {
  const byLot = new Map<string, RunState[]>();
  for (const s of states.filter((x) => x.lot)) byLot.set(`${s.project}\0${s.lot}`, [...(byLot.get(`${s.project}\0${s.lot}`) ?? []), s]);
  const out = journals.map((j) => ({ ...j }));
  for (const [key, runs] of byLot) {
    const [project, lot] = key.split('\0');
    const rj = runJournal(project, lot, runs, planLots(project, lot));
    const waves = out.filter((j) => j.project === project && j.lot === lot);
    if (rj && waves.length === 0) out.push(rj);
    else if (rj) merge(waves.reduce((a, b) => (endOf(b) >= endOf(a) ? b : a)), rj);
  }
  return out;
}

/** Sans grille de prix, un lot ne se chiffre que si chaque étape porte son montant (les runs) ou ne compte rien ; avec une grille, toujours. */
export const costedWithoutGrid = (prices: PriceGrid | null, steps: CostedStep[]): boolean =>
  prices !== null || steps.every((x) => x.amount !== undefined || (x.usage === undefined && x.counted === undefined));

/** Les lots rendus d'une fenêtre selon leur source : journal de vague seul, états de run seuls, ou les deux fondus en un lot. */
export interface SourceCounts {
  vague: number;
  run: number;
  both: number;
}
export function sourceCounts(set: { j: Journal }[]): SourceCounts {
  const run = set.filter((d) => d.j.wave === RUN_WAVE).length;
  const both = set.filter((d) => d.j.wave !== RUN_WAVE && d.j.steps.some((s) => s.kind === 'run')).length;
  return { vague: set.length - run - both, run, both };
}
/** La ligne « sources des lots rendus » sous Débit ; aucune quand aucun run n'a été lu dans la fenêtre courante. */
export function sourceLines(s: { current: SourceCounts; previous: SourceCounts }): string[] {
  const t = (c: SourceCounts) => `vague ${c.vague} · cadence run ${c.run} · les deux ${c.both}`;
  return s.current.run + s.current.both > 0 ? [`  sources des lots rendus : ${t(s.current)} (précédente : ${t(s.previous)})`] : [];
}

/** Les avertissements du coût : sans grille, coût n/d (sauf les lots faits par run seulement, qui ont leur `cout_usd`) ; coût en dollars sous une grille d'une autre monnaie. */
export function costWarnings(states: RunState[], prices: PriceGrid | null, currency?: string): string[] {
  if (!prices) return [states.length === 0 ? 'perf : aucune grille de prix (cadence.yaml perf.prices), coût n/d' : 'perf : aucune grille de prix (cadence.yaml perf.prices), coût n/d sauf pour les lots faits par cadence run seulement (cout_usd)'];
  const dollars = states.some((s) => typeof s.cout_usd === 'number' && s.cout_usd > 0);
  return currency && dollars && !/^(\$|US\$|USD)$/i.test(currency) ? [`perf : le coût d'un run est en dollars (cout_usd de Claude Code), la grille en ${currency} : coût par lot livré mêlé`] : [];
}
