import { join, relative, sep } from 'node:path';
import { planLoader } from './config.js';
import { CAUSES, isReview as isReviewKind, type Cause, type Classification, type Journal, type JournalPass } from './corrections.js';
import { addDays, diffDays, isDay, toDay, type Day } from './dates.js';
import { gitCommonDir } from './git.js';
import { findProjects } from './lead.js';
import type { Lot } from './plan.js';
import { readDeliveries } from './state.js';

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
/** Goulot net (R19) : une cause pèse au moins cette part des passes classées, avec au moins MIN_CLASSIFIED passes classées. */
const BOTTLENECK_SHARE = 0.5;
const MIN_CLASSIFIED = 10;

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
}

/** Les indicateurs de L226 : tokens par lot, délais, durées de mur. */
export interface TokensBlock {
  /** Par valeur exacte de l'estimate du plan (« 0.5 », « 1 »…) : médiane des tokens comptés par journal rendu ; `lots` = journaux. */
  byEstimate: Record<string, Indicator>;
  reviewShare: Indicator;
}
export interface DelaysBlock {
  createdToDone: Indicator;
  doneToDelivered: Indicator;
}

export interface PerfResult {
  since: string | null;
  today: Day;
  windows: Windows;
  throughput: { ready: Indicator; rendered: Indicator; delivered: Indicator; onBudget: Indicator; escaped: Indicator };
  corrections: { medianPasses: Indicator; atLeast2: Indicator; firstTime: Indicator; causes: { current: CauseWindow; previous: CauseWindow } };
  interventions: { handedOut: Indicator & { count: { current: number | null; previous: number | null } }; ux: Indicator };
  tokens: TokensBlock;
  delays: DelaysBlock;
  /** Médiane de la durée de mur en minutes, par sorte d'étape ; `lots` = étapes. */
  durations: Record<string, Indicator>;
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
  ux: 'la revue d\'ergonomie coûte plus d\'un tour : renforcer la maquette',
  tokens: 'l\'estimate est mal calibrée : redécouper le lot ou recaler l\'estimate et les budgets',
  reviewShare: 'la revue pèse trop face à l\'écriture : alléger (seuil du lot léger, orchestrate.review.threshold)',
  createdToDone: 'la file de lots s\'allonge : chercher le goulot de priorisation avant d\'ajouter des lots',
  doneToDelivered: 'on livre trop rarement : livrer par lots plus petits',
  duration: 'cette étape est lente : revoir ses timeouts, son effort ou son modèle',
} as const;
export type DecisionKey = keyof typeof DECISIONS;

function indicator(current: number | null, previous: number | null, lots: { current: number; previous: number }, windows: Windows, dir: Direction | null, twin: string | null, nullNote: string | null = null): Indicator {
  const change = current !== null && previous !== null && previous !== 0 ? (current - previous) / previous : null;
  const worse = current !== null && previous !== null && dir !== null && (dir === 'down' ? current < previous : current > previous);
  const truncated = windows.current.truncated || windows.previous.truncated;
  let note: string | null = current === null && previous === null ? nullNote : null;
  let warn = false;
  if (dir !== null && current !== null && previous !== null) {
    const degraded = worse && (previous === 0 || Math.abs(change!) > DEGRADATION + 1e-9);
    if (truncated) note = 'fenêtre tronquée';
    else if (degraded && (lots.current < MIN_SAMPLE || lots.previous < MIN_SAMPLE)) note = 'pas de tendance : échantillon';
    else if (degraded && previous === 0) note = 'pas de tendance : précédente nulle';
    else warn = degraded;
  }
  return { current, previous, change, warn, twin, lots, note };
}

/** Les deux valeurs d'un indicateur, calculées fenêtre par fenêtre. */
const both = <T>(windows: Windows, f: (w: Window) => T): { current: T; previous: T } => ({ current: f(windows.current), previous: f(windows.previous) });

function causeWindow(passes: { pass: JournalPass; day: Day }[], w: Window, cache: Map<string, Classification>): CauseWindow {
  const counts = new Map<Cause, number>();
  let unclassified = 0;
  let withoutFindings = 0;
  for (const { pass, day } of passes) {
    if (!inWindow(day, w)) continue;
    if (pass.findings.length === 0) {
      withoutFindings++;
      continue;
    }
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
  return { top, classified, unclassified, withoutFindings, unclassifiedShare: withFindings === 0 ? null : unclassified / withFindings };
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
    return set.length === 0 ? null : set.filter((d) => d.j.steps.reduce((sum, s) => sum + (s.counted ?? 0), 0) <= d.j.budget!).length / set.length;
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
  const ux = both(windows, (w) => {
    const set = visibleRendered(w);
    return set.length === 0 ? null : set.reduce((sum, d) => sum + d.j.steps.filter((s) => s.kind === 'ux' && s.status === 'ok').length, 0) / set.length;
  });
  const visibleCounts = both(windows, (w) => visibleRendered(w).length);
  const budgetCounts = both(windows, (w) => withBudget(w).length);

  const mk = (vals: { current: number | null; previous: number | null }, lots: { current: number; previous: number }, dir: Direction | null, twin: string | null, nullNote: string | null = null) => indicator(vals.current, vals.previous, lots, windows, dir, twin, nullNote);
  const planNote = hasPlans ? null : 'plan illisible ou absent';

  // Tokens par estimate et part de revue (R2, R3)
  const twinFirstTime = 'corrections.firstTime';
  const tokensByClass = (w: Window): Map<string, number[]> => {
    const classes = new Map<string, number[]>();
    for (const d of rendered(w)) {
      const p = planLot(plans, d.j.project, d.j.lot);
      const counted = d.j.steps.filter((x) => x.counted !== undefined);
      if (!p || counted.length === 0) continue;
      const key = String(p.estimate);
      classes.set(key, [...(classes.get(key) ?? []), counted.reduce((sum, x) => sum + x.counted!, 0)]);
    }
    return classes;
  };
  const byClass = both(windows, tokensByClass);
  const byEstimate: Record<string, Indicator> = {};
  const classKeys = [...new Set([...byClass.current.keys(), ...byClass.previous.keys()])].sort((a, b) => Number(a) - Number(b));
  for (const key of classKeys) {
    const vals = both(windows, (w) => median((w === windows.current ? byClass.current : byClass.previous).get(key) ?? []));
    byEstimate[key] = mk(vals, { current: byClass.current.get(key)?.length ?? 0, previous: byClass.previous.get(key)?.length ?? 0 }, 'up', twinFirstTime);
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
    durations[kind] = mk({ current: median(v.current), previous: median(v.previous) }, sizes(v), 'up', twinFirstTime);
  }

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
  const interventions = { handedOut: { ...handed, count: handedCount }, ux: mk(ux, visibleCounts, 'up', twinEscaped) };

  const tokens: TokensBlock = { byEstimate, reviewShare: mk(reviewShare, both(windows, (w) => rendered(w).length), 'up', twinFirstTime) };
  const delays: DelaysBlock = {
    createdToDone: mk({ current: median(createdToDone.current), previous: median(createdToDone.previous) }, sizes(createdToDone), 'up', twinFirstTime, planNote),
    doneToDelivered: mk({ current: median(doneToDelivered.current), previous: median(doneToDelivered.previous) }, sizes(doneToDelivered), 'up', twinFirstTime, planNote),
  };
  const result: PerfResult = { since: input.since ?? null, today, windows, throughput, corrections: correctionsInd, interventions, tokens, delays, durations, orphans, warnings: [] };
  const bottleneck = bottleneckOf(causes.current);
  for (const [key, ind] of indicatorLines(result)) if (ind.warn) result.warnings.push(`⚠ ${key.label} : ${describe(ind, key.kind)} → ${DECISIONS[key.decision]}`);
  if (bottleneck) result.warnings.push(bottleneck);
  return result;
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

/** Les dix premières lignes de `indicatorLines` sont celles de L225. */
const LEGACY_LINES = 10;

type Kind = 'count' | 'rate' | 'share' | 'num' | 'tokens' | 'days' | 'min';
interface Line {
  label: string;
  kind: Kind;
  decision: DecisionKey;
}

/** Les indicateurs imprimés, dans l'ordre du tableau, avec leur étiquette et la décision qu'ils éclairent. */
function indicatorLines(r: PerfResult): [Line, Indicator][] {
  const speed: [Line, Indicator][] = [
    ...Object.entries(r.tokens.byEstimate).map(([k, ind]): [Line, Indicator] => [{ label: `tokens par lot (estimate ${k})`, kind: 'tokens', decision: 'tokens' }, ind]),
    [{ label: 'part des tokens de revue', kind: 'share', decision: 'reviewShare' }, r.tokens.reviewShare],
    [{ label: 'délai création → done', kind: 'days', decision: 'createdToDone' }, r.delays.createdToDone],
    [{ label: 'délai done → livraison', kind: 'days', decision: 'doneToDelivered' }, r.delays.doneToDelivered],
    ...Object.entries(r.durations).map(([k, ind]): [Line, Indicator] => [{ label: `durée de mur ${k}`, kind: 'min', decision: 'duration' }, ind]),
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
    [{ label: 'part conforme du premier coup', kind: 'share', decision: 'firstTime' }, r.corrections.firstTime],
    [{ label: 'défauts échappés', kind: 'count', decision: 'escaped' }, r.throughput.escaped],
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
  return num(v);
}
const signed = (c: number) => `${c >= 0 ? '+' : '−'}${Math.round(100 * Math.abs(c))} %`;

/** « courante (précédente prev, variation) » d'un indicateur. */
function describe(ind: Indicator, kind: Kind): string {
  return `${value(ind.current, kind)} (précédente ${value(ind.previous, kind)}${ind.change === null ? '' : `, ${signed(ind.change)}`})`;
}

/** Le tableau en texte : chaque indicateur de vitesse sur la même ligne que son jumeau de qualité (R8). */
export function renderPerf(r: PerfResult): string[] {
  const lines = indicatorLines(r);
  const byPath = new Map<string, [Line, Indicator]>([
    ['throughput.escaped', lines.find(([l]) => l.label === 'défauts échappés')!],
    ['corrections.firstTime', lines.find(([l]) => l.label === 'part conforme du premier coup')!],
  ]);
  const w = r.windows;
  const win = (x: Window) => `${x.from} → ${x.to} (${x.days} j${x.truncated ? ', tronquée par --since' : ''})`;
  const out = [`cadence perf · aujourd'hui ${r.today}${r.since ? ` · depuis ${r.since}` : ''}`, `fenêtre courante : ${win(w.current)}`, `fenêtre précédente : ${win(w.previous)}`];
  const row = ([line, ind]: [Line, Indicator]): string => {
    const twin = ind.twin ? byPath.get(ind.twin)! : null;
    const parts = [`${ind.warn ? '⚠' : ' '} ${line.label} : ${describe(ind, line.kind)}`];
    if (twin) parts.push(`${twin[0].label} : ${describe(twin[1], twin[0].kind)}${twin[1].note && twin[1].current === null ? ` — ${twin[1].note}` : ''}`);
    if (ind.note) parts.push(ind.note);
    if (ind.warn) parts.push(`→ ${DECISIONS[line.decision]}`);
    return parts.join(' · ');
  };
  const section = (title: string, labels: string[]) => {
    out.push('', title);
    for (const l of lines.filter(([x]) => labels.includes(x.label))) out.push(row(l));
  };
  section('Débit', ['prêts', 'rendus par jour', 'livrés', 'part des rendus sur budget', 'défauts échappés']);
  section('Passes de correction', ['médiane de passes de correction par lot', 'part des lots à au moins 2 passes', 'part conforme du premier coup']);
  const c = r.corrections.causes.current;
  const top = c.top.map((t, i) => `${i + 1}. ${LABELS[t.cause]} ${t.passes} (${pct(t.share)})`).join(' · ');
  out.push(`  causes dominantes (${c.classified} passes classées) : ${top || 'aucune'} · non classé : ${c.unclassifiedShare === null ? 'n/d' : pct(c.unclassifiedShare)} · sans revue (tests rouges) : ${c.withoutFindings}`);
  section('Interventions du lead', ['lots terminés hors vague', 'sessions ux par lot visible']);
  const h = r.interventions.handedOut.count;
  out.push(`  lots rendus puis terminés hors vague : ${h.current ?? 'n/d'} (précédente ${h.previous ?? 'n/d'})`);
  out.push('', 'Tokens, délais et durées (médianes par lot ou par étape)');
  for (const l of lines.slice(LEGACY_LINES)) out.push(row(l));
  for (const wr of r.warnings.filter((x) => x.startsWith('⚠ goulot'))) out.push('', wr);
  if (r.orphans > 0) out.push('', `${r.orphans} lot(s) de journal sans plan`);
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
