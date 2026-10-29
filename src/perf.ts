import { join, relative, sep } from 'node:path';
import { planLoader, type ModelPrice, type PriceGrid } from './config.js';
import { CAUSES, isReview as isReviewKind, type Cause, type Classification, type Journal, type JournalPass, type JournalStep } from './corrections.js';
import { addDays, diffDays, isDay, toDay, type Day } from './dates.js';
import { gitCommonDir } from './git.js';
import { findProjects } from './lead.js';
import type { Lot } from './plan.js';
import { FAIL_CLASSES, readDeliveries, readFailedEntries, type FailClass, type FailedDelivery } from './state.js';

/** Le lot d'un plan tel que `cadence perf` le lit. */
export type PlanLot = Pick<Lot, 'id' | 'status' | 'created' | 'finished' | 'estimate' | 'notes'>;
/** Les plans lisibles du dossier : nom du projet (chemin relatif au dossier, séparateurs « / ») → ses lots. */
export type Plans = Map<string, PlanLot[]>;

export interface Window {
  from: Day;
  to: Day;
  /** Jours couverts (moins de 7 quand `--since` tronque la fenêtre, 0 quand elle est entière avant `--since`). */
  days: number;
  truncated: boolean;
}

export interface Windows {
  current: Window;
  previous: Window;
}

/** Au-delà de cette dégradation relative, un indicateur porte un ⚠ (R12). */
const DEGRADATION = 0.25;
/** Sous ce nombre de lots dans l'une des deux fenêtres, pas de tendance (R13). */
const MIN_SAMPLE = 5;
/** Durées de mur : sous ce nombre d'étapes dans l'une des deux fenêtres, pas de tendance (L280). Mesuré sur 12–18-10 contre 05–11 et 17–23-10 contre 10–16 : sous 10 étapes, la variation d'une fenêtre à l'autre n'est pas interprétable (`accept` −61 % sur 7, `ux` +31 % sur 5, sans changement du travail). */
const MIN_STEPS = 10;
/** Goulot net (R19) : une cause pèse au moins cette part des passes classées, avec au moins MIN_CLASSIFIED passes classées. */
const BOTTLENECK_SHARE = 0.5;
const MIN_CLASSIFIED = 10;
/** Les étapes de la chaîne spec : un lot qui en a une est mesuré à part pour ses tokens (L240). */
const SPEC_CHAIN = new Set(['spec', 'fiche', 'maquette', 'accept']);

/**
 * Les deux fenêtres de 7 jours calendaires locaux : la courante finit à `today` inclus, la précédente la précède.
 * `since` (jour ISO ou instant) ignore tout ce qui le précède : la fenêtre qui commence avant lui est tronquée à lui.
 */
export function perfWindows(today: Day, since?: string): Windows {
  const sinceDay = since === undefined ? undefined : isDay(since) ? since : toDay(new Date(since));
  const make = (from: Day, to: Day): Window => {
    if (sinceDay === undefined || sinceDay <= from) return { from, to, days: 7, truncated: false };
    return { from: sinceDay, to, days: sinceDay > to ? 0 : diffDays(sinceDay, to) + 1, truncated: true };
  };
  return { current: make(addDays(today, -6), today), previous: make(addDays(today, -13), addDays(today, -7)) };
}

export interface Indicator {
  current: number | null;
  previous: number | null;
  /** Variation relative (courante − précédente) ÷ précédente ; null si l'une des valeurs est n/d ou si la précédente est nulle. */
  change: number | null;
  warn: boolean;
  /** Chemin (`throughput.escaped`) du jumeau de qualité de cet indicateur de vitesse ; null pour un indicateur de qualité. */
  twin: string | null;
  /** Lots de chaque fenêtre qui portent l'indicateur (le seuil d'échantillon de R13). */
  lots: { current: number; previous: number };
  /** Pourquoi la tendance n'est pas jugée, ou pourquoi la valeur est n/d. */
  note: string | null;
}

export interface CauseShare {
  cause: Cause;
  passes: number;
  /** Part des passes classées de la fenêtre. */
  share: number;
}

export interface CauseWindow {
  /** Les trois premières causes. */
  top: CauseShare[];
  classified: number;
  /** Passes à constats absentes du cache. */
  unclassified: number;
  /** Passes sans constat de revue à lire (tests rouges), à part. */
  withoutFindings: number;
  /** Part des passes à constats que le cache ne classe pas ; null sans passe à constats. */
  unclassifiedShare: number | null;
  /** Passes à constats de la fenêtre par sorte de revue qui les a levées (`review`, `review-small`, `ux`) : lu dans les journaux, sans modèle ni cache. */
  byReview: Record<string, number>;
}

/** L'étape qui porte la hausse des tokens d'une classe d'estimate (L312) : la sorte d'étape dont la somme des jetons par lot, en moyenne sur les lots de la classe, monte le plus d'une fenêtre à l'autre. */
export interface Carrier {
  kind: string;
  /** Hausse en jetons par lot ; toujours positive. */
  delta: number;
}

/** Les indicateurs de L226 : tokens par lot, délais, durées de mur. */
export interface TokensBlock {
  /** Par valeur exacte de l'estimate du plan (« 0.5 », « 1 »…) : médiane des tokens comptés par journal rendu ; `lots` = journaux. `carrier` : l'étape qui porte la hausse (L312). */
  byEstimate: Record<string, Indicator & { carrier: Carrier | null }>;
  reviewShare: Indicator;
}
export interface DelaysBlock {
  createdToDone: Indicator;
  doneToDelivered: Indicator;
}

export interface CostBlock {
  /** Médiane du coût en euros des lots livrés de la fenêtre, étapes de tous leurs journaux ; `lots` = lots calculés. */
  perDelivered: Indicator;
  /** Modèle sans prix dans la grille (ou « inconnu ») → nombre de lots livrés écartés du coût, les deux fenêtres ensemble. */
  withoutPrice: Record<string, number>;
  /** Lots livrés sans aucun journal, écartés du coût. */
  withoutJournal: { current: number; previous: number };
}

/** Les livraisons rouges d'une fenêtre ventilées (L282) ; `inconnue` : une ligne sans classe écrite dont le libellé n'est pas reconnu (L331). */
export type RedClass = FailClass | 'inconnue';
export interface RedBreakdown {
  count: number;
  byClass: Record<RedClass, number>;
  /** Par projet, les seules classes présentes. */
  byProject: Record<string, Partial<Record<RedClass, number>>>;
}

export interface PrecheckVerdicts {
  oui: number;
  partiel: number;
  non: number;
}

/** Ce que coûte le contrôle préalable dans une fenêtre (L322) : durées de mur en minutes, tokens comptés au quota (le local n'en compte aucun). */
export interface PrecheckCost {
  /** Sessions sur le modèle local, dont celles en échec (repli sur Sonnet). */
  local: { runs: number; failed: number; minutes: number };
  /** Sessions Sonnet du contrôle : repli d'un échec local ou confirmation d'un « oui » local. */
  sonnet: { runs: number; minutes: number; tokens: number };
  /** Gain des « oui » : lots rendus sans implémentation, et ce que cette implémentation aurait coûté (médiane des étapes `implement` de la fenêtre ; null sans étape implement). */
  avoided: { sessions: number; tokens: number | null };
}

/** Le contrôle préalable d'un lot rendu : verdict, session locale et session Sonnet (minutes, tokens) quand elles ont eu lieu. */
export interface PrecheckLot {
  project: string;
  lot: string;
  verdict: 'oui' | 'partiel' | 'non' | null;
  local: { status: string; minutes: number } | null;
  sonnet: { minutes: number; tokens: number } | null;
}

/** Les escalades de modèle des lots rendus d'une fenêtre (L337) : lots escaladés et leur issue (`conforme` : la revue neuve l'était ; `rendu` : lot rendu malgré l'escalade ; `nonJouee` : budget du lot ; `echec` : une session escaladée n'a rien rendu, le modèle n'a pas jugé le lot). */
export interface EscalationCounts {
  lots: number;
  conforme: number;
  rendu: number;
  nonJouee: number;
  echec: number;
}

/** Tests « instables sous charge » des lots rendus d'une fenêtre (L354) : lots qui en portent et tests distincts par lot, additionnés. */
export interface InstableCounts {
  lots: number;
  tests: number;
}

export interface PerfResult {
  since: string | null;
  today: Day;
  windows: Windows;
  throughput: { ready: Indicator; rendered: Indicator; delivered: Indicator; onBudget: Indicator; escaped: Indicator };
  corrections: { medianPasses: Indicator; atLeast2: Indicator; firstTime: Indicator; causes: { current: CauseWindow; previous: CauseWindow } };
  /** `ux` : sessions qui voient l'application par lot visible (étape ux, et review-small d'un petit lot visible) ; `dedicatedUx` : part des lots visibles revus par au moins une étape ux dédiée (information, sans ⚠ ni jumeau). */
  interventions: { handedOut: Indicator & { count: { current: number | null; previous: number | null } }; ux: Indicator; dedicatedUx: Indicator };
  /**
   * Contrôle préalable (L288) : `yes` = part de « oui » parmi les lots rendus qui portent un verdict (information, sans ⚠ ni jumeau) ; `lots` = lots avec verdict.
   * L322 : `verdicts` (répartition oui / partiel / non des lots rendus de chaque fenêtre), `cost` (durée et tokens des sessions du contrôle, local et repli Sonnet, et gain des « oui »),
   * `lots` (une ligne par lot rendu de la fenêtre courante qui a une session de contrôle ou un verdict).
   */
  precheck: { yes: Indicator; verdicts: { current: PrecheckVerdicts; previous: PrecheckVerdicts }; cost: { current: PrecheckCost; previous: PrecheckCost }; lots: PrecheckLot[] };
  /** Escalades de modèle (L337) : les lots terminés de chaque fenêtre dont le journal porte une escalade. */
  escalations: { current: EscalationCounts; previous: EscalationCounts };
  /** Tests rouges dans la suite de la porte, verts rejoués seuls (L354) : ni comptés ni corrigés. Une hausse dit que la machine est trop chargée pour la suite (`CADENCE_TEST_WORKERS`). */
  instables: { current: InstableCounts; previous: InstableCounts };
  tokens: TokensBlock;
  /** Médiane de la durée de mur d'un lot rendu, en minutes (début de sa première étape → fin de sa dernière), par classe d'estimate comme `tokens.byEstimate` (L414) : le temps habituel que le panneau des lots compare à celui d'un lot en cours. */
  lotMinutes: Record<string, Indicator>;
  delays: DelaysBlock;
  /** Médiane de la durée de mur en minutes, par sorte d'étape ; `lots` = étapes. */
  durations: Record<string, Indicator>;
  cost: CostBlock;
  /** La qualité de livraison (L227) : livraisons rouges (jumeau de « livrés ») et constats QA bloquants (jumeau des défauts échappés). */
  quality: { redDeliveries: Indicator; qaBlocking: Indicator; reds: { current: RedBreakdown; previous: RedBreakdown } };
  /** Lots de journal rendus dans les deux fenêtres qui n'ont pas de lot dans les plans du dossier (R15). */
  orphans: number;
  warnings: string[];
}

export interface PerfInput {
  journals: Journal[];
  /** Les plans lisibles ; vide : les indicateurs qui lisent le plan sont n/d (R16). */
  plans: Plans;
  cache: Map<string, Classification>;
  /** Jours de deliveries.log par projet ; un projet absent (pas un dépôt git, pas de journal de livraison) donne un délai de livraison n/d (R5). */
  deliveries?: Map<string, Day[]>;
  /** Jours de deliveries-failed.log par projet (L227) ; un projet absent compte 0 livraison rouge. */
  failedDeliveries?: Map<string, Day[]>;
  /** Les mêmes livraisons rouges avec leur classe (L282) : de quoi les ventiler ; absent, la ventilation est vide. */
  failures?: Map<string, FailedDelivery[]>;
  /** La grille de prix de cadence.yaml ; absente : coût n/d (R7). */
  prices?: PriceGrid | null;
  windows: Windows;
  today: Day;
  since?: string;
}

interface Dated {
  j: Journal;
  /** Instant de fin du dernier pas (à défaut la création de la vague). */
  at: number;
  day: Day;
}

const FINISHED = new Set(['ready', 'handed-back', 'failed']);
const finished = (j: Journal) => FINISHED.has(j.status);

/** Un journal est daté par la fin de sa dernière étape, à défaut par la création de sa vague ; sans date lisible il est écarté (R4). */
function dated(j: Journal): Dated | null {
  const ends = j.steps.map((s) => Date.parse(s.ended ?? '')).filter((t) => !Number.isNaN(t));
  const at = ends.length ? Math.max(...ends) : Date.parse(j.waveCreated ?? '');
  return Number.isNaN(at) ? null : { j, at, day: toDay(new Date(at)) };
}

const inWindow = (day: Day, w: Window) => w.days > 0 && day >= w.from && day <= w.to;

/** Le lot d'un plan qui correspond à l'id du journal : l'id lui-même, à défaut le lot parent d'un id « <lot>/<sous-tâche> » (R10). */
function planLot(plans: Plans, project: string, lot: string): PlanLot | undefined {
  const lots = plans.get(project);
  if (!lots) return undefined;
  return lots.find((l) => l.id === lot) ?? (lot.includes('/') ? lots.find((l) => l.id === lot.slice(0, lot.indexOf('/'))) : undefined);
}

/** Rang d'affichage d'une sorte d'étape : l'ordre du cycle, les sortes inconnues après. */
const KIND_ORDER = ['spec', 'maquette', 'fiche', 'precheck', 'implement', 'review', 'review-small', 'ux', 'fix', 'accept'];
const kindRank = (kind: string) => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);

/** Part de `counted` rangée en entrée quand une étape ne porte que ce compteur (journal ancien) : le reste est en sortie (R8 b). */
const COUNTED_INPUT_SHARE = 0.9;

/** Coût en euros d'une étape (R8) ; le nom du modèle sans prix quand il en faudrait un. */
function stepEuros(step: JournalStep, prices: PriceGrid): number | { missing: string } {
  if (step.model === 'local') return 0;
  const usage = step.usage ?? (step.counted === undefined ? null : { input: COUNTED_INPUT_SHARE * step.counted, cacheWrite: 0, cacheRead: 0, output: (1 - COUNTED_INPUT_SHARE) * step.counted });
  if (!usage) return 0;
  const price: ModelPrice | undefined = step.model === 'sonnet' || step.model === 'opus' || step.model === 'haiku' ? prices[step.model] : undefined;
  if (!price) return { missing: step.model === 'sonnet' || step.model === 'opus' || step.model === 'haiku' ? step.model : 'inconnu' };
  return ((usage.input + usage.cacheWrite) * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead) / 1_000_000;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Ce qu'on lit d'une note de plan : sans le préfixe de date « JJ-MM », « JJ-MM hh:mm » et le séparateur « : ». */
const NOTE_PREFIX = /^\s*\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?\s*:?\s*/;
const QA_DEFECT = /(?<!\b0\s)(?<!\baucun\s)\b(?:bloquant|majeur)/i;
/** Une note « QA … bloquant/majeur » (R9) : commence par QA et contient bloquant ou majeur non précédé de « 0 » ou « aucun ». */
export function isQaDefectNote(text: string): boolean {
  const body = text.replace(NOTE_PREFIX, '');
  return body.startsWith('QA') && QA_DEFECT.test(body);
}

const QA_BLOCKING = /(?<!\b0\s)(?<!\baucun\s)\bbloquant/i;
/** Une note « QA … bloquant » (L227) : commence par QA et contient bloquant non précédé de « 0 » ou « aucun » ; « majeur » seul ne compte pas. */
export function isQaBlockingNote(text: string): boolean {
  const body = text.replace(NOTE_PREFIX, '');
  return body.startsWith('QA') && QA_BLOCKING.test(body);
}

type Direction = 'down' | 'up';

/** Les décisions que chaque indicateur éclaire (commentaire de la fiche), dites au bout d'une ligne ⚠. */
const DECISIONS = {
  rendered: 'le flux baisse : chercher le goulot avant d\'ajouter des lots',
  delivered: 'le flux baisse : chercher le goulot avant d\'ajouter des lots',
  onBudget: 'les budgets sont-ils justes ? relever le plancher (L218)',
  escaped: 'la vitesse se paie en qualité : durcir la revue avant d\'accélérer',
  medianPasses: 'la première écriture n\'est pas assez bonne : durcir la fiche ou le brief',
  atLeast2: 'la première écriture n\'est pas assez bonne : durcir la fiche ou le brief',
  firstTime: 'la première écriture n\'est pas assez bonne : durcir la fiche ou le brief',
  handedOut: 'la vague s\'arrête trop tôt ou le lead la rattrape à la main : revoir la fin de cycle',
  precheck: 'le précheck livre peu de « oui » : le restreindre ou le confier au modèle local',
  ux: 'la revue d\'ergonomie coûte plus d\'un tour : renforcer la maquette',
  tokens: 'l\'estimate est mal calibrée : redécouper le lot ou recaler l\'estimate et les budgets',
  reviewShare: 'la revue pèse trop face à l\'écriture : alléger (seuil du lot léger, orchestrate.review.threshold)',
  createdToDone: 'la file de lots s\'allonge : chercher le goulot de priorisation avant d\'ajouter des lots',
  doneToDelivered: 'on livre trop rarement : livrer par lots plus petits',
  cost: 'le modèle ou l\'effort d\'une étape est-il juste ? changer le modèle de cette étape',
  redDeliveries: 'la livraison casse : corriger CI, déploiement ou vérification avant d\'ajouter des lots',
  qaBlocking: 'la revue laisse passer des défauts graves : durcir la revue avant de livrer davantage',
  duration: 'cette étape est lente : revoir ses timeouts, son effort ou son modèle',
} as const;
export type DecisionKey = keyof typeof DECISIONS;

function indicator(current: number | null, previous: number | null, lots: { current: number; previous: number }, windows: Windows, dir: Direction | null, twin: string | null, nullNote: string | null = null, minSample = MIN_SAMPLE): Indicator {
  const change = current !== null && previous !== null && previous !== 0 ? (current - previous) / previous : null;
  const worse = current !== null && previous !== null && dir !== null && (dir === 'down' ? current < previous : current > previous);
  const truncated = windows.current.truncated || windows.previous.truncated;
  let note: string | null = current === null && previous === null ? nullNote : null;
  let warn = false;
  if (dir !== null && current !== null && previous !== null) {
    const degraded = worse && (previous === 0 || Math.abs(change!) > DEGRADATION + 1e-9);
    if (truncated) note = 'fenêtre tronquée';
    else if (degraded && (lots.current < minSample || lots.previous < minSample)) note = 'pas de tendance : échantillon';
    else if (degraded && previous === 0) note = 'pas de tendance : précédente nulle';
    else warn = degraded;
  }
  return { current, previous, change, warn, twin, lots, note };
}

/** Ordre des classes de tokens : estimate croissant, la classe « +spec » après la classe ordinaire du même estimate. */
const byEstimateKey = (a: string, b: string): number => parseFloat(a) - parseFloat(b) || a.length - b.length;

/** Les deux valeurs d'un indicateur, calculées fenêtre par fenêtre. */
const both = <T>(windows: Windows, f: (w: Window) => T): { current: T; previous: T } => ({ current: f(windows.current), previous: f(windows.previous) });

function causeWindow(passes: { pass: JournalPass; day: Day }[], w: Window, cache: Map<string, Classification>): CauseWindow {
  const counts = new Map<Cause, number>();
  let unclassified = 0;
  let withoutFindings = 0;
  const byReview: Record<string, number> = {};
  for (const { pass, day } of passes) {
    if (!inWindow(day, w)) continue;
    if (pass.findings.length === 0) {
      withoutFindings++;
      continue;
    }
    if (pass.reviewKind) byReview[pass.reviewKind] = (byReview[pass.reviewKind] ?? 0) + 1;
    const c = cache.get(pass.key);
    if (!c) {
      unclassified++;
      continue;
    }
    const cause = c.manual ?? c.cause;
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  const classified = [...counts.values()].reduce((a, b) => a + b, 0);
  const top = CAUSES.filter((c) => counts.has(c))
    .map((cause) => ({ cause, passes: counts.get(cause)!, share: counts.get(cause)! / classified }))
    .sort((a, b) => b.passes - a.passes)
    .slice(0, 3);
  const withFindings = classified + unclassified;
  return { top, classified, unclassified, withoutFindings, unclassifiedShare: withFindings === 0 ? null : unclassified / withFindings, byReview };
}

/** La sorte d'étape sous laquelle la hausse se compte : `review` et `review-small` ne font qu'une (la taille du lot choisit l'une ou l'autre, `orchestrate.review.threshold` : le passage de l'une à l'autre n'est pas une hausse). */
const carrierKind = (kind: string): string => (kind === 'review-small' ? 'review' : kind);

/** L'étape qui porte la hausse (L312) : la sorte d'étape dont la moyenne des jetons par lot monte le plus ; null sans hausse nette du total par lot, ou sans lot dans l'une des fenêtres. */
function carrierOf(current: Map<string, number>[], previous: Map<string, number>[]): Carrier | null {
  if (current.length === 0 || previous.length === 0) return null;
  const mean = (lots: Map<string, number>[], kind: string) => lots.reduce((sum, l) => sum + (l.get(kind) ?? 0), 0) / lots.length;
  const kinds = new Set([...current, ...previous].flatMap((l) => [...l.keys()]));
  const rises = [...kinds].map((kind) => ({ kind, delta: mean(current, kind) - mean(previous, kind) }));
  const net = rises.reduce((sum, r) => sum + r.delta, 0);
  const top = rises.sort((a, b) => b.delta - a.delta || a.kind.localeCompare(b.kind))[0];
  return net > 0 && top && top.delta > 0 ? top : null;
}

export function computePerf(input: PerfInput): PerfResult {
  const { plans, cache, windows, today } = input;
  const hasPlans = plans.size > 0;
  // --since (R3) : une vague créée avant ce jour n'est pas lue, même si ses lots finissent après.
  const sinceDay = input.since === undefined ? undefined : isDay(input.since) ? input.since : toDay(new Date(input.since));
  const readable = (j: Journal) => j.waveReadable && (sinceDay === undefined || (j.waveCreated !== undefined && toDay(new Date(j.waveCreated)) >= sinceDay));
  const all = input.journals.filter(readable).map(dated).filter((d): d is Dated => d !== null);
  const rendered = (w: Window) => all.filter((d) => finished(d.j) && inWindow(d.day, w));
  const twinEscaped = 'throughput.escaped';

  // Débit (R4, R5, R9)
  const rendus = both(windows, rendered);
  const ready = both(windows, (w) => (rendered(w).length === 0 ? null : rendered(w).filter((d) => d.j.status === 'ready').length));
  const perDay = (w: Window) => (w.days === 0 || rendered(w).length === 0 ? null : rendered(w).length / w.days);
  const deliveredCount = (w: Window) => [...plans.values()].flat().filter((l) => l.status === 'done' && l.finished !== undefined && inWindow(l.finished, w)).length;
  const delivered = both(windows, (w) => (hasPlans && deliveredCount(w) > 0 ? deliveredCount(w) : null));
  const withBudget = (w: Window) => rendered(w).filter((d) => d.j.budget !== undefined);
  const onBudget = both(windows, (w) => {
    const set = withBudget(w);
    // Les passes ordinaires s'arrêtent avant la part d'escalade (L349) : sans escalade engagée, elles se comptent contre le budget moins cette part. Une escalade engagée libère la part à l'exécution : le lot se compte alors tout entier contre son budget. Une escalade « non jouée » n'a rien engagé (les passes ordinaires ont mangé la part) : la part reste retenue.
    const within = (j: (typeof set)[number]['j']) => j.steps.reduce((sum, s) => sum + (s.counted ?? 0), 0) <= j.budget! - (j.escalation && j.escalation.issue !== 'non jouée' ? 0 : j.escalationReserve ?? 0);
    return set.length === 0 ? null : set.filter((d) => within(d.j)).length / set.length;
  });

  // Défauts échappés (R9)
  const recognised = [...plans.values()].some((lots) => lots.some((l) => l.notes.some((n) => isQaDefectNote(n.text))));
  const escapedOf = (w: Window): number | null => {
    if (!recognised || w.days === 0) return null;
    const keys = new Set<string>();
    for (const [project, lots] of plans) {
      for (const l of lots) {
        if (l.status !== 'done' || l.finished === undefined) continue;
        if (l.notes.some((n) => isDay(n.date) && inWindow(n.date, w) && l.finished! <= n.date && isQaDefectNote(n.text))) keys.add(`${project}\0${l.id}`);
      }
    }
    return keys.size;
  };
  const escapedNote = recognised ? null : 'aucune note QA reconnue : convention à fixer (L227)';
  const lotsOf = both(windows, (w) => rendered(w).length);

  // Passes de correction (R6, R7, R23)
  const withPasses = all.filter((d) => finished(d.j) && d.j.implemented);
  const lotsIn = (w: Window) => withPasses.filter((d) => inWindow(d.day, w));
  const medianPasses = both(windows, (w) => median(lotsIn(w).map((d) => d.j.passes.length)));
  const share = (w: Window, pred: (passes: number) => boolean): number | null => {
    const set = lotsIn(w);
    return set.length === 0 ? null : set.filter((d) => pred(d.j.passes.length)).length / set.length;
  };
  const lotCounts = both(windows, (w) => lotsIn(w).length);
  const passDays = withPasses.flatMap((d) => d.j.passes.map((pass) => ({ pass, day: pass.fixEnded && !Number.isNaN(Date.parse(pass.fixEnded)) ? toDay(new Date(pass.fixEnded)) : d.day })));
  const causes = { current: causeWindow(passDays, windows.current, cache), previous: causeWindow(passDays, windows.previous, cache) };

  // Interventions du lead (R10, R15)
  const lastOf = new Map<string, Dated>();
  for (const d of all) {
    const key = `${d.j.project}\0${d.j.lot}`;
    const prev = lastOf.get(key);
    if (!prev || d.at >= prev.at) lastOf.set(key, d);
  }
  const handedOutOf = (w: Window) =>
    rendered(w).filter((d) => {
      if (d.j.status !== 'handed-back' && d.j.status !== 'failed') return false;
      if (lastOf.get(`${d.j.project}\0${d.j.lot}`) !== d) return false;
      const p = planLot(plans, d.j.project, d.j.lot);
      return p !== undefined && p.status === 'done' && p.finished !== undefined && p.finished >= d.day;
    }).length;
  const handedCount = both(windows, (w) => (hasPlans && rendered(w).length > 0 ? handedOutOf(w) : null));
  const handedOut = both(windows, (w) => {
    const n = rendered(w).length;
    return !hasPlans || n === 0 ? null : handedOutOf(w) / n;
  });
  const visibleRendered = (w: Window) => rendered(w).filter((d) => d.j.visible);
  // Une session qui voit l'application : l'étape ux, et la review-small d'un petit lot visible (sa seule revue d'ergonomie, `seesApp` du cycle) ; celle d'un lot plus gros n'est qu'une revue de code (L283).
  const seesApp = (j: Journal, s: JournalStep) => s.status === 'ok' && (s.kind === 'ux' || (s.kind === 'review-small' && j.small));
  const ux = both(windows, (w) => {
    const set = visibleRendered(w);
    return set.length === 0 ? null : set.reduce((sum, d) => sum + d.j.steps.filter((s) => seesApp(d.j, s)).length, 0) / set.length;
  });
  const dedicatedUx = both(windows, (w) => {
    const set = visibleRendered(w);
    return set.length === 0 ? null : set.filter((d) => d.j.steps.some((s) => s.kind === 'ux' && s.status === 'ok')).length / set.length;
  });
  const prechecked = (w: Window) => rendered(w).filter((d) => d.j.precheck !== undefined);
  const precheckYes = both(windows, (w) => {
    const set = prechecked(w);
    return set.length === 0 ? null : set.filter((d) => d.j.precheck === 'oui').length / set.length;
  });
  const visibleCounts = both(windows, (w) => visibleRendered(w).length);
  const budgetCounts = both(windows, (w) => withBudget(w).length);

  const mk = (vals: { current: number | null; previous: number | null }, lots: { current: number; previous: number }, dir: Direction | null, twin: string | null, nullNote: string | null = null, minSample = MIN_SAMPLE) => indicator(vals.current, vals.previous, lots, windows, dir, twin, nullNote, minSample);
  const planNote = hasPlans ? null : 'plan illisible ou absent';

  // Tokens par estimate et part de revue (R2, R3)
  const twinFirstTime = 'corrections.firstTime';
  const tokensByClass = (w: Window): Map<string, { total: number; kinds: Map<string, number> }[]> => {
    const classes = new Map<string, { total: number; kinds: Map<string, number> }[]>();
    for (const d of rendered(w)) {
      const p = planLot(plans, d.j.project, d.j.lot);
      const counted = d.j.steps.filter((x) => x.counted !== undefined);
      if (!p || counted.length === 0) continue;
      // Un lot passé par la chaîne spec (écran ou back) coûte plus que le lot ordinaire de même estimate (mesuré le 12–18-10 : +150 k à l'estimate 0,5, +30 k à 1 ; 450 k est l'écart de budget, pas l'écart mesuré) : classe à part, sinon l'arrivée de ces lots dans une fenêtre passe pour un lot ordinaire plus lourd (L240).
      const key = `${p.estimate}${d.j.steps.some((x) => SPEC_CHAIN.has(x.kind)) ? '+spec' : ''}`;
      const kinds = new Map<string, number>();
      for (const x of counted) kinds.set(carrierKind(x.kind), (kinds.get(carrierKind(x.kind)) ?? 0) + x.counted!);
      classes.set(key, [...(classes.get(key) ?? []), { total: counted.reduce((sum, x) => sum + x.counted!, 0), kinds }]);
    }
    return classes;
  };
  const byClass = both(windows, tokensByClass);
  const byEstimate: TokensBlock['byEstimate'] = {};
  const classKeys = [...new Set([...byClass.current.keys(), ...byClass.previous.keys()])].sort(byEstimateKey);
  for (const key of classKeys) {
    const lotsOfClass = both(windows, (w) => (w === windows.current ? byClass.current : byClass.previous).get(key) ?? []);
    const vals = both(windows, (w) => median((w === windows.current ? lotsOfClass.current : lotsOfClass.previous).map((l) => l.total)));
    byEstimate[key] = { ...mk(vals, { current: lotsOfClass.current.length, previous: lotsOfClass.previous.length }, 'up', twinFirstTime), carrier: carrierOf(lotsOfClass.current.map((l) => l.kinds), lotsOfClass.previous.map((l) => l.kinds)) };
  }
  // Durée de mur d'un lot rendu par classe d'estimate (L414) : la même clé que les tokens ; un journal sans début ni fin lisibles, ou à fin avant début, n'est pas compté
  const minutesByClass = (w: Window): Map<string, number[]> => {
    const classes = new Map<string, number[]>();
    for (const d of rendered(w)) {
      const p = planLot(plans, d.j.project, d.j.lot);
      const starts = d.j.steps.map((x) => Date.parse(x.started ?? '')).filter((t) => !Number.isNaN(t));
      const ends = d.j.steps.map((x) => Date.parse(x.ended ?? '')).filter((t) => !Number.isNaN(t));
      if (!p || starts.length === 0 || ends.length === 0 || Math.max(...ends) < Math.min(...starts)) continue;
      const key = `${p.estimate}${d.j.steps.some((x) => SPEC_CHAIN.has(x.kind)) ? '+spec' : ''}`;
      classes.set(key, [...(classes.get(key) ?? []), (Math.max(...ends) - Math.min(...starts)) / 60_000]);
    }
    return classes;
  };
  const minutesClasses = both(windows, minutesByClass);
  const lotMinutes: Record<string, Indicator> = {};
  for (const key of classKeys) {
    const v = both(windows, (w) => (w === windows.current ? minutesClasses.current : minutesClasses.previous).get(key) ?? []);
    lotMinutes[key] = mk({ current: median(v.current), previous: median(v.previous) }, { current: v.current.length, previous: v.previous.length }, 'up', twinFirstTime);
  }
  const reviewShare = both(windows, (w) => {
    let review = 0;
    let all = 0;
    for (const d of rendered(w)) for (const x of d.j.steps) {
      all += x.counted ?? 0;
      if (isReviewKind(x.kind)) review += x.counted ?? 0;
    }
    return all === 0 ? null : review / all;
  });

  // Délais création → done et done → livraison (R4, R5) : les lots du plan done dont finished tombe dans la fenêtre
  const doneIn = (w: Window) => [...plans].flatMap(([project, lots]) => lots.filter((l) => l.status === 'done' && l.finished !== undefined && inWindow(l.finished, w)).map((lot) => ({ project, lot })));
  const timed = (w: Window) => doneIn(w).filter(({ lot }) => isDay(lot.created) && lot.finished! >= lot.created!);
  const createdToDone = both(windows, (w) => timed(w).map(({ lot }) => diffDays(lot.created!, lot.finished!)));
  const doneToDelivered = both(windows, (w) =>
    timed(w).flatMap(({ project, lot }) => {
      const next = (input.deliveries?.get(project) ?? []).filter((d) => d >= lot.finished!).sort()[0];
      return next === undefined ? [] : [diffDays(lot.finished!, next)];
    }));
  const sizes = <T>(v: { current: T[]; previous: T[] }) => ({ current: v.current.length, previous: v.previous.length });

  // Durée de mur par sorte d'étape (R6) : rangée par le jour de la fin de l'étape
  const walls = all.filter((d) => finished(d.j)).flatMap((d) => d.j.steps.flatMap((x) => {
    const from = Date.parse(x.started ?? '');
    const to = Date.parse(x.ended ?? '');
    return x.status === 'ok' && !Number.isNaN(from) && !Number.isNaN(to) && to >= from ? [{ kind: x.kind, minutes: (to - from) / 60_000, day: toDay(new Date(to)) }] : [];
  }));
  const wallsOf = (kind: string, w: Window) => walls.filter((x) => x.kind === kind && inWindow(x.day, w)).map((x) => x.minutes);
  const durations: Record<string, Indicator> = {};
  const wallKinds = [...new Set(walls.filter((x) => inWindow(x.day, windows.current) || inWindow(x.day, windows.previous)).map((x) => x.kind))].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
  for (const kind of wallKinds) {
    const v = both(windows, (w) => wallsOf(kind, w));
    durations[kind] = mk({ current: median(v.current), previous: median(v.previous) }, sizes(v), 'up', twinFirstTime, null, MIN_STEPS);
  }

  // Coût par lot livré (R8 à R10)
  const prices = input.prices ?? null;
  const journalsOf = new Map<string, Dated[]>();
  for (const d of all) {
    const p = planLot(plans, d.j.project, d.j.lot);
    if (p) journalsOf.set(`${d.j.project}\0${p.id}`, [...(journalsOf.get(`${d.j.project}\0${p.id}`) ?? []), d]);
  }
  const costOf = (w: Window) => {
    const euros: number[] = [];
    const missing = new Map<string, number>();
    let withoutJournal = 0;
    for (const { project, lot } of doneIn(w)) {
      const journals = journalsOf.get(`${project}\0${lot.id}`);
      if (!journals) {
        withoutJournal++;
        continue;
      }
      if (!prices) continue;
      let sum = 0;
      const lacking = new Set<string>();
      for (const step of journals.flatMap((d) => d.j.steps)) {
        const e = stepEuros(step, prices);
        if (typeof e === 'number') sum += e;
        else lacking.add(e.missing);
      }
      for (const m of lacking) missing.set(m, (missing.get(m) ?? 0) + 1);
      if (lacking.size === 0) euros.push(sum);
    }
    return { euros, missing, withoutJournal };
  };
  const costs = both(windows, costOf);
  const withoutPrice: Record<string, number> = {};
  for (const m of [...costs.current.missing.keys(), ...costs.previous.missing.keys()]) withoutPrice[m] = (costs.current.missing.get(m) ?? 0) + (costs.previous.missing.get(m) ?? 0);

  const orphans = [...rendus.current, ...rendus.previous].filter((d) => planLot(plans, d.j.project, d.j.lot) === undefined).length;

  const throughput = {
    ready: mk(ready, lotsOf, null, twinEscaped),
    rendered: mk(both(windows, perDay), lotsOf, 'down', twinEscaped),
    delivered: mk(delivered, both(windows, deliveredCount), 'down', twinEscaped, planNote),
    onBudget: mk(onBudget, budgetCounts, 'down', twinEscaped),
    escaped: mk(both(windows, escapedOf), lotsOf, 'up', null, escapedNote),
  };
  const firstTime = both(windows, (w) => share(w, (n) => n === 0));
  const correctionsInd = {
    medianPasses: mk(medianPasses, lotCounts, 'up', 'corrections.firstTime'),
    atLeast2: mk(both(windows, (w) => share(w, (n) => n >= 2)), lotCounts, 'up', 'corrections.firstTime'),
    firstTime: mk(firstTime, lotCounts, 'down', null),
    causes,
  };
  const handed = mk(handedOut, lotsOf, 'up', twinEscaped, planNote);
  const interventions = { handedOut: { ...handed, count: handedCount }, ux: mk(ux, visibleCounts, 'up', twinEscaped), dedicatedUx: mk(dedicatedUx, visibleCounts, null, null) };

  const precheck = { yes: mk(precheckYes, both(windows, (w) => prechecked(w).length), null, null), ...precheckMeasure(windows, rendered) };
  const tokens: TokensBlock = { byEstimate, reviewShare: mk(reviewShare, both(windows, (w) => rendered(w).length), 'up', twinFirstTime) };
  const delays: DelaysBlock = {
    createdToDone: mk({ current: median(createdToDone.current), previous: median(createdToDone.previous) }, sizes(createdToDone), 'up', twinFirstTime, planNote),
    doneToDelivered: mk({ current: median(doneToDelivered.current), previous: median(doneToDelivered.previous) }, sizes(doneToDelivered), 'up', twinFirstTime, planNote),
  };
  const cost: CostBlock = {
    perDelivered: mk({ current: median(costs.current.euros), previous: median(costs.previous.euros) }, { current: costs.current.euros.length, previous: costs.previous.euros.length }, 'up', twinFirstTime, prices ? planNote : 'aucune grille de prix'),
    withoutPrice,
    withoutJournal: { current: costs.current.withoutJournal, previous: costs.previous.withoutJournal },
  };

  // Qualité de livraison (L227) : livraisons rouges (l'échantillon est celui des livraisons, vertes + rouges) et notes QA bloquantes
  const daysIn = (byProject: Map<string, Day[]> | undefined, w: Window) => [...(byProject?.values() ?? [])].flat().filter((d) => inWindow(d, w)).length;
  const reds = both(windows, (w) => daysIn(input.failedDeliveries, w));
  const deliveriesOf = both(windows, (w) => daysIn(input.deliveries, w) + daysIn(input.failedDeliveries, w));
  const blockingRecognised = [...plans.values()].some((lots) => lots.some((l) => l.notes.some((n) => isQaBlockingNote(n.text))));
  const blockingOf = (w: Window): number | null => {
    if (!blockingRecognised || w.days === 0) return null;
    return [...plans.values()].flat().filter((l) => l.status === 'done' && l.finished !== undefined).reduce((sum, l) => sum + l.notes.filter((n) => isDay(n.date) && inWindow(n.date, w) && l.finished! <= n.date && isQaBlockingNote(n.text)).length, 0);
  };
  const breakdown = (w: Window): RedBreakdown => {
    const b: RedBreakdown = { count: 0, byClass: { refus: 0, ci: 0, deploiement: 0, verification: 0, inconnue: 0 }, byProject: {} };
    for (const [project, entries] of input.failures ?? []) {
      for (const e of entries.filter((x) => inWindow(x.day, w))) {
        const cls: RedClass = e.cls ?? 'inconnue';
        b.count += 1;
        b.byClass[cls] += 1;
        const p = (b.byProject[project] ??= {});
        p[cls] = (p[cls] ?? 0) + 1;
      }
    }
    return b;
  };
  const quality = {
    reds: both(windows, breakdown),
    redDeliveries: mk(reds, deliveriesOf, 'up', 'throughput.delivered'),
    qaBlocking: mk(both(windows, blockingOf), both(windows, deliveredCount), 'up', twinEscaped, escapedNote),
  };
  const result: PerfResult = { since: input.since ?? null, today, windows, throughput, corrections: correctionsInd, interventions, precheck, escalations: both(windows, (w) => escalationCounts(rendered(w))), instables: both(windows, (w) => instableCounts(rendered(w))), tokens, lotMinutes, delays, durations, cost, quality, orphans, warnings: [] };
  const bottleneck = bottleneckOf(causes.current);
  for (const [key, ind] of indicatorLines(result)) if (ind.warn) result.warnings.push(`⚠ ${key.label} : ${describe(ind, key.kind)} → ${decisionOf(key, ind, result)}`);
  if (bottleneck) result.warnings.push(bottleneck);
  return result;
}

/** Les escalades de modèle des lots donnés (L337), par issue ; une escalade engagée dont le journal n'a pas d'issue (lot interrompu) n'est classée dans aucune. */
function escalationCounts(set: Dated[]): EscalationCounts {
  const escalated = set.filter((d) => d.j.escalation);
  const by = (issue: 'conforme' | 'rendu' | 'non jouée' | 'échec') => escalated.filter((d) => d.j.escalation!.issue === issue).length;
  return { lots: escalated.length, conforme: by('conforme'), rendu: by('rendu'), nonJouee: by('non jouée'), echec: by('échec') };
}

/** Les tests instables sous charge des lots donnés (L354). */
function instableCounts(set: Dated[]): InstableCounts {
  const withTests = set.filter((d) => (d.j.instables?.length ?? 0) > 0);
  return { lots: withTests.length, tests: withTests.reduce((n, d) => n + d.j.instables!.length, 0) };
}

const minutesOf = (s: JournalStep): number => {
  const from = Date.parse(s.started ?? '');
  const to = Date.parse(s.ended ?? '');
  return Number.isNaN(from) || Number.isNaN(to) || to < from ? 0 : (to - from) / 60_000;
};

/** Le contrôle préalable mesuré (L322) : répartition des verdicts, durée et tokens des sessions (local, Sonnet), gain des « oui », une ligne par lot de la fenêtre courante. */
function precheckMeasure(windows: Windows, rendered: (w: Window) => Dated[]): Pick<PerfResult['precheck'], 'verdicts' | 'cost' | 'lots'> {
  const verdicts = (w: Window): PrecheckVerdicts => {
    const out = { oui: 0, partiel: 0, non: 0 };
    for (const d of rendered(w)) if (d.j.precheck) out[d.j.precheck]++;
    return out;
  };
  const cost = (w: Window): PrecheckCost => {
    const set = rendered(w);
    const steps = set.flatMap((d) => d.j.steps.filter((s) => s.kind === 'precheck'));
    const local = steps.filter((s) => s.model === 'local');
    const sonnet = steps.filter((s) => s.model !== 'local');
    // Un échec du local = une étape qui n'a pas fini `ok`, ou finie `ok` mais au rapport illisible (docs/perf.md : « ended without a usable report »).
    const unusable = new Set(set.filter((d) => d.j.localUnreadable).flatMap((d) => d.j.steps.filter((s) => s.kind === 'precheck' && s.model === 'local')));
    const implement = set.flatMap((d) => d.j.steps.filter((s) => s.kind === 'implement' && s.counted !== undefined).map((s) => s.counted!));
    const avoided = set.filter((d) => d.j.precheck === 'oui' && d.j.status === 'handed-back').length;
    const typical = median(implement);
    return {
      local: { runs: local.length, failed: local.filter((s) => s.status !== 'ok' || unusable.has(s)).length, minutes: local.reduce((n, s) => n + minutesOf(s), 0) },
      sonnet: { runs: sonnet.length, minutes: sonnet.reduce((n, s) => n + minutesOf(s), 0), tokens: sonnet.reduce((n, s) => n + (s.counted ?? 0), 0) },
      avoided: { sessions: avoided, tokens: avoided === 0 ? 0 : typical === null ? null : avoided * typical },
    };
  };
  const lots = rendered(windows.current).flatMap((d): PrecheckLot[] => {
    const steps = d.j.steps.filter((s) => s.kind === 'precheck');
    if (steps.length === 0 && !d.j.precheck) return [];
    const local = steps.find((s) => s.model === 'local');
    const sonnet = steps.filter((s) => s.model !== 'local');
    return [{
      project: d.j.project,
      lot: d.j.lot,
      verdict: d.j.precheck ?? null,
      local: local ? { status: local.status === 'ok' && d.j.localUnreadable ? 'illisible' : local.status, minutes: minutesOf(local) } : null,
      sonnet: sonnet.length ? { minutes: sonnet.reduce((n, s) => n + minutesOf(s), 0), tokens: sonnet.reduce((n, s) => n + (s.counted ?? 0), 0) } : null,
    }];
  });
  return { verdicts: both(windows, verdicts), cost: both(windows, cost), lots };
}

/** Goulot net (R19) : une cause pèse au moins la moitié des passes classées de la fenêtre courante, avec au moins dix passes classées. */
function bottleneckOf(w: CauseWindow): string | null {
  const first = w.top[0];
  if (!first || w.classified < MIN_CLASSIFIED || first.share < BOTTLENECK_SHARE) return null;
  return `⚠ goulot : ${LABELS[first.cause]} pèse ${first.passes} passes classées sur ${w.classified} → quel maillon corriger`;
}

const LABELS: Record<Cause, string> = {
  'spec-floue': 'spec floue ou critère absent',
  'regle-inventee': 'règle de gestion inventée',
  'derive-architecture': "dérive d'architecture",
  'donnees-sql': 'données / SQL',
  'bug-code': 'bug de code',
  'test-manquant': 'test manquant',
  'faux-constat': 'faux constat de revue',
};

/** Les quatorze premières lignes de `indicatorLines` sont celles de L225 (dont la part des lots visibles revus par une étape ux, L283, et la part de « oui » du précheck, L288) et les deux de qualité de livraison de L227 ; les suivantes sont celles de L226. */
const LEGACY_LINES = 14;

type Kind = 'count' | 'rate' | 'share' | 'num' | 'tokens' | 'days' | 'min' | 'eur';
interface Line {
  label: string;
  kind: Kind;
  decision: DecisionKey;
}

/** Les indicateurs imprimés, dans l'ordre du tableau, avec leur étiquette et la décision qu'ils éclairent. */
function indicatorLines(r: PerfResult): [Line, Indicator][] {
  const speed: [Line, Indicator][] = [
    ...Object.entries(r.tokens.byEstimate).sort(([a], [b]) => byEstimateKey(a, b)).map(([k, ind]): [Line, Indicator] => [{ label: `tokens par lot (estimate ${k})`, kind: 'tokens', decision: 'tokens' }, ind]),
    [{ label: 'part des tokens de revue', kind: 'share', decision: 'reviewShare' }, r.tokens.reviewShare],
    [{ label: 'délai création → done', kind: 'days', decision: 'createdToDone' }, r.delays.createdToDone],
    [{ label: 'délai done → livraison', kind: 'days', decision: 'doneToDelivered' }, r.delays.doneToDelivered],
    ...Object.entries(r.durations).map(([k, ind]): [Line, Indicator] => [{ label: `durée de mur ${k}`, kind: 'min', decision: 'duration' }, ind]),
    [{ label: 'coût par lot livré', kind: 'eur', decision: 'cost' }, r.cost.perDelivered],
  ];
  return [
    [{ label: 'prêts', kind: 'count', decision: 'rendered' }, r.throughput.ready],
    [{ label: 'rendus par jour', kind: 'rate', decision: 'rendered' }, r.throughput.rendered],
    [{ label: 'livrés', kind: 'count', decision: 'delivered' }, r.throughput.delivered],
    [{ label: 'part des rendus sur budget', kind: 'share', decision: 'onBudget' }, r.throughput.onBudget],
    [{ label: 'médiane de passes de correction par lot', kind: 'num', decision: 'medianPasses' }, r.corrections.medianPasses],
    [{ label: 'part des lots à au moins 2 passes', kind: 'share', decision: 'atLeast2' }, r.corrections.atLeast2],
    [{ label: 'lots terminés hors vague', kind: 'share', decision: 'handedOut' }, r.interventions.handedOut],
    [{ label: 'sessions ux par lot visible', kind: 'num', decision: 'ux' }, r.interventions.ux],
    [{ label: 'part des lots visibles revus par une étape ux', kind: 'share', decision: 'ux' }, r.interventions.dedicatedUx],
    [{ label: 'part de « oui » du précheck', kind: 'share', decision: 'precheck' }, r.precheck.yes],
    [{ label: 'part conforme du premier coup', kind: 'share', decision: 'firstTime' }, r.corrections.firstTime],
    [{ label: 'défauts échappés', kind: 'count', decision: 'escaped' }, r.throughput.escaped],
    [{ label: 'livraisons rouges', kind: 'count', decision: 'redDeliveries' }, r.quality.redDeliveries],
    [{ label: 'constats QA bloquants', kind: 'count', decision: 'qaBlocking' }, r.quality.qaBlocking],
    ...speed,
  ];
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','));
const pct = (v: number) => `${Math.round(100 * v)} %`;
function value(v: number | null, kind: Kind): string {
  if (v === null) return 'n/d';
  if (kind === 'share') return pct(v);
  if (kind === 'tokens') return `${num(v / 1000)} k`;
  if (kind === 'days') return `${num(v)} j`;
  if (kind === 'min') return `${num(v)} min`;
  if (kind === 'eur') return `${v.toFixed(2).replace('.', ',')} €`;
  return num(v);
}
const signed = (c: number) => `${c >= 0 ? '+' : '−'}${Math.round(100 * Math.abs(c))} %`;

/** « courante (précédente prev, variation) » d'un indicateur. */
function describe(ind: Indicator, kind: Kind): string {
  return `${value(ind.current, kind)} (précédente ${value(ind.previous, kind)}${ind.change === null ? '' : `, ${signed(ind.change)}`})`;
}

/**
 * La décision d'un ⚠ (L312). Celle des tokens par lot cite l'étape qui porte la hausse : quand la part conforme du premier coup monte en même temps,
 * la hausse est de la qualité payée à cette étape, plus une estimate fausse ; sinon l'estimate reste suspecte, avec l'étape.
 */
function decisionOf(line: Line, ind: Indicator, r: PerfResult): string {
  const carrier = (ind as { carrier?: Carrier | null }).carrier;
  if (line.decision !== 'tokens' || !carrier) return DECISIONS[line.decision];
  const where = `la hausse est portée par l'étape ${carrier.kind} (+${value(carrier.delta, 'tokens')} par lot)`;
  const { current, previous } = r.corrections.firstTime;
  if (current !== null && previous !== null && current > previous) return `${where} alors que la part conforme du premier coup monte : de la qualité payée, pas une estimate fausse ; juger cette étape (modèle, effort, passes) avant de recaler l'estimate`;
  return `l'estimate est mal calibrée : ${where} : redécouper le lot ou recaler l'estimate et les budgets`;
}

/** Les lignes que désigne le chemin `twin` d'un indicateur. */
function twinsByPath(lines: [Line, Indicator][]): Map<string, [Line, Indicator]> {
  const at = (label: string) => lines.find(([l]) => l.label === label)!;
  return new Map([
    ['throughput.escaped', at('défauts échappés')],
    ['throughput.delivered', at('livrés')],
    ['corrections.firstTime', at('part conforme du premier coup')],
  ]);
}

/**
 * L'en-tête perf du tour (L227) : une ligne par ⚠ de `result.warnings`, dans le même ordre. La ligne d'un ⚠ de tendance dit la valeur
 * de son jumeau de qualité (vitesse et qualité côte à côte) et finit par sa décision ; le goulot net est repris tel quel.
 */
export function perfHeader(r: PerfResult): string[] {
  const lines = indicatorLines(r);
  const byPath = twinsByPath(lines);
  const header: string[] = [];
  for (const [line, ind] of lines) {
    if (!ind.warn) continue;
    const twin = ind.twin ? byPath.get(ind.twin) : undefined;
    header.push(`⚠ ${line.label} : ${describe(ind, line.kind)}${twin ? ` · ${twin[0].label} : ${describe(twin[1], twin[0].kind)}` : ''} → ${decisionOf(line, ind, r)}`);
  }
  header.push(...r.warnings.filter((w) => w.startsWith('⚠ goulot')));
  return header;
}

const RED_LABELS: Record<RedClass, string> = { refus: 'refus avant action', ci: 'CI', deploiement: 'déploiement', verification: 'vérification', inconnue: 'non classée' };

/** Deux lignes (par classe, par projet) des livraisons rouges de la fenêtre courante, la plus grosse d'abord ; aucune sans livraison rouge. */
function redBreakdownLines(b: RedBreakdown): string[] {
  if (b.count === 0) return [];
  const order = (a: [string, number], c: [string, number]) => c[1] - a[1] || a[0].localeCompare(c[0]);
  // À égalité, l'ordre des étapes de la livraison (refus, CI, déploiement, vérification), les lignes sans classe en dernier.
  const rank = (k: RedClass) => (k === 'inconnue' ? FAIL_CLASSES.length : FAIL_CLASSES.indexOf(k));
  const classes = (counts: Partial<Record<RedClass, number>>) =>
    (Object.entries(counts) as [RedClass, number][]).filter(([, n]) => n > 0).sort((a, c) => c[1] - a[1] || rank(a[0]) - rank(c[0])).map(([k, n]) => [RED_LABELS[k], n] as [string, number]);
  const byProject = Object.entries(b.byProject)
    .map(([name, counts]) => [name, Object.values(counts).reduce((a, n) => a + n, 0), classes(counts)] as const)
    .sort((a, c) => order([a[0], a[1]], [c[0], c[1]]));
  return [
    `  livraisons rouges par classe (fenêtre courante) : ${classes(b.byClass).map(([k, n]) => `${k} ${n}`).join(' · ')}`,
    `  livraisons rouges par projet : ${byProject.map(([name, n, cl]) => `${name} ${n} (${cl.map(([k, c]) => `${k} ${c}`).join(', ')})`).join(' · ')}`,
  ];
}

/** Le tableau en texte : chaque indicateur de vitesse sur la même ligne que son jumeau de qualité (R8). */
export function renderPerf(r: PerfResult): string[] {
  const lines = indicatorLines(r);
  const byPath = twinsByPath(lines);
  // Second jumeau d'affichage (L227) : la ligne « livrés » dit aussi les livraisons rouges, celle des défauts échappés les constats QA bloquants.
  const quality = new Map<string, [Line, Indicator]>([
    ['livrés', lines.find(([l]) => l.label === 'livraisons rouges')!],
    ['défauts échappés', lines.find(([l]) => l.label === 'constats QA bloquants')!],
  ]);
  const w = r.windows;
  const win = (x: Window) => `${x.from} → ${x.to} (${x.days} j${x.truncated ? ', tronquée par --since' : ''})`;
  const out = [`cadence perf · aujourd'hui ${r.today}${r.since ? ` · depuis ${r.since}` : ''}`, `fenêtre courante : ${win(w.current)}`, `fenêtre précédente : ${win(w.previous)}`];
  const row = ([line, ind]: [Line, Indicator]): string => {
    const twin = ind.twin ? byPath.get(ind.twin)! : null;
    const extra = quality.get(line.label);
    const parts = [`${ind.warn || extra?.[1].warn ? '⚠' : ' '} ${line.label} : ${describe(ind, line.kind)}`];
    if (twin) parts.push(`${twin[0].label} : ${describe(twin[1], twin[0].kind)}${twin[1].note && twin[1].current === null ? ` — ${twin[1].note}` : ''}`);
    if (extra) parts.push(`${extra[0].label} : ${describe(extra[1], extra[0].kind)}${extra[1].note ? ` — ${extra[1].note}` : ''}`);
    if (ind.note) parts.push(ind.note);
    if (ind.warn) parts.push(`→ ${decisionOf(line, ind, r)}`);
    if (extra?.[1].warn) parts.push(`→ ${DECISIONS[extra[0].decision]}`);
    return parts.join(' · ');
  };
  const section = (title: string, labels: string[]) => {
    out.push('', title);
    for (const l of lines.filter(([x]) => labels.includes(x.label))) out.push(row(l));
  };
  section('Débit', ['prêts', 'rendus par jour', 'livrés', 'part des rendus sur budget', 'défauts échappés']);
  out.push(...redBreakdownLines(r.quality.reds.current));
  section('Passes de correction', ['médiane de passes de correction par lot', 'part des lots à au moins 2 passes', 'part conforme du premier coup']);
  const c = r.corrections.causes.current;
  const top = c.top.map((t, i) => `${i + 1}. ${LABELS[t.cause]} ${t.passes} (${pct(t.share)})`).join(' · ');
  out.push(`  causes dominantes (${c.classified} passes classées) : ${top || 'aucune'} · non classé : ${c.unclassifiedShare === null ? 'n/d' : pct(c.unclassifiedShare)} · sans revue (tests rouges) : ${c.withoutFindings}${c.unclassified > 0 ? ' · à classer : cadence corrections --classify' : ''}`);
  const origins = Object.entries(c.byReview).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  if (origins.length > 0) out.push(`  origine des passes à constats : ${origins.map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  section('Interventions du lead', ['lots terminés hors vague', 'sessions ux par lot visible', 'part des lots visibles revus par une étape ux']);
  const h = r.interventions.handedOut.count;
  out.push(`  lots rendus puis terminés hors vague : ${h.current ?? 'n/d'} (précédente ${h.previous ?? 'n/d'})`);
  section('Contrôle préalable', ['part de « oui » du précheck']);
  out.push(...precheckLines(r.precheck));
  const e = r.escalations.current;
  if (e.lots > 0) out.push('', 'Escalade de modèle', `  escalades de modèle : ${plural(e.lots, 'lot', 'lots')} · ${e.conforme} conforme · ${e.rendu} rendu malgré l'escalade · ${e.nonJouee} non jouée · ${e.echec} en échec`);
  const ins = r.instables.current;
  if (ins.lots > 0) out.push('', 'Porte de tests sous charge', `  tests instables sous charge : ${plural(ins.tests, 'test', 'tests')} dans ${plural(ins.lots, 'lot', 'lots')} (rouges dans la suite, verts rejoués seuls ; précédente ${r.instables.previous.tests})`);
  out.push('', 'Tokens, délais et durées (médianes par lot ou par étape)');
  for (const l of lines.slice(LEGACY_LINES)) out.push(row(l));
  for (const wr of r.warnings.filter((x) => x.startsWith('⚠ goulot'))) out.push('', wr);
  const noJournal = r.cost.withoutJournal.current + r.cost.withoutJournal.previous;
  if (noJournal > 0) out.push('', `${noJournal} lot(s) livré(s) sans journal`);
  if (r.orphans > 0) out.push('', `${r.orphans} lot(s) de journal sans plan`);
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Le contrôle préalable de la fenêtre courante (L322) : répartition, coût local puis Sonnet, gain des « oui », une ligne par lot. Rien sans session de contrôle ni verdict. */
function precheckLines(p: PerfResult['precheck']): string[] {
  const v = p.verdicts.current;
  const c = p.cost.current;
  if (v.oui + v.partiel + v.non + c.local.runs + c.sonnet.runs === 0) return [];
  const out = [`  précheck : oui ${v.oui} · partiel ${v.partiel} · non ${v.non}`];
  if (c.local.runs > 0) out.push(`  précheck local : ${plural(c.local.runs, 'session', 'sessions')}, ${plural(c.local.failed, 'échec', 'échecs')}, ${num(Math.round(c.local.minutes))} min`);
  if (c.sonnet.runs > 0) out.push(`  précheck Sonnet : ${plural(c.sonnet.runs, 'session', 'sessions')}, ${value(c.sonnet.tokens, 'tokens')} tokens, ${num(Math.round(c.sonnet.minutes))} min`);
  if (c.avoided.sessions > 0) out.push(`  gain des « oui » : ${plural(c.avoided.sessions, "session d'implémentation évitée", "sessions d'implémentation évitées")}${c.avoided.tokens === null ? ' (gain en tokens : n/d)' : ` (≈ ${value(c.avoided.tokens, 'tokens')} tokens)`}`);
  for (const l of p.lots) {
    const parts = [`${l.project}:${l.lot}`, l.verdict ?? 'sans verdict'];
    if (l.local) parts.push(`local ${l.local.status === 'ok' ? 'ok' : 'échec'} ${num(Math.round(l.local.minutes))} min`);
    if (l.sonnet) parts.push(`Sonnet ${num(Math.round(l.sonnet.minutes))} min, ${value(l.sonnet.tokens, 'tokens')} tokens`);
    out.push(`    ${parts.join(' · ')}`);
  }
  return out;
}

/** Les plans des projets de `parent` (un niveau d'imbrication, R22) ; un plan illisible est sauté avec un avertissement (R16). */
export function readPlans(parent: string, warn: (line: string) => void): Plans {
  const plans: Plans = new Map();
  for (const dir of findProjects(parent, 2)) {
    const name = relative(parent, dir).split(sep).join('/');
    try {
      plans.set(name, planLoader(dir)().lots());
    } catch {
      warn(`perf : plan illisible, projet ${name} sauté`);
    }
  }
  return plans;
}

/** Les jours de livraison de chaque projet du dossier, lus dans `<gitCommonDir>/cadence/deliveries.log` de son dépôt (R5). Sans dépôt git ni journal de livraison, le projet est absent de la carte ; rien n'est créé. */
export function readProjectDeliveries(parent: string, projects: string[]): Map<string, Day[]> {
  const deliveries = new Map<string, Day[]>();
  for (const name of projects) {
    try {
      const days = readDeliveries(join(gitCommonDir(join(parent, name)), 'cadence'));
      if (days) deliveries.set(name, days);
    } catch {
      // pas un dépôt git : délai de livraison n/d pour ce projet
    }
  }
  return deliveries;
}

/** Les livraisons rouges (jour, classe, raison) de chaque projet du dossier, lues dans `<gitCommonDir>/cadence/deliveries-failed.log` (L227). Un projet sans journal compte 0 rouge ; un projet qui n'est pas un dépôt git est absent de la carte ; rien n'est créé. */
export function readProjectFailedEntries(parent: string, projects: string[]): Map<string, FailedDelivery[]> {
  const failed = new Map<string, FailedDelivery[]>();
  for (const name of projects) {
    try {
      failed.set(name, readFailedEntries(join(gitCommonDir(join(parent, name)), 'cadence')));
    } catch {
      // pas un dépôt git : aucune livraison rouge pour ce projet
    }
  }
  return failed;
}
