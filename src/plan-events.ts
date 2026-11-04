// Le plan en JSON stable et le flux d'événements (L470, M8) : ce que lit un tableau de bord ou un miroir externe sans parcourir le YAML.
import { parse } from 'yaml';
import { type Day } from './dates.js';
import { fileAt, type Commit, tryGit } from './git.js';
import { linkCommits } from './link.js';
import { lotJson } from './lot-lines.js';
import type { Plan } from './plan.js';

/** Version du schéma de `raf export` et de `raf events` : un champ retiré ou renommé la change, un champ ajouté non. */
export const EXPORT_SCHEMA = 1;

type PlanEvent =
  | { day: Day; type: 'cree' | 'demarre' | 'termine' | 'abandonne'; lot: string }
  | { day: Day; type: 'livre'; lot: string; sha: string }
  | { day: Day; type: 'note'; lot: string; text: string }
  | { day: Day; type: 'etat'; lot: string; from: string | null; to: string | null; sha: string }
  | { day: Day; type: 'commit'; lot: string; sha: string; subject: string };

/** `raf export` : le plan entier, sans date de génération (deux exports d'un même plan sont identiques). */
export function exportPlan(plan: Plan): Record<string, unknown> {
  return { schema: EXPORT_SCHEMA, project: plan.project, prefix: plan.prefix, ...(plan.since ? { since: plan.since } : {}), lots: plan.lots().map(lotJson) };
}

/** Les événements que portent les champs des lots : création, démarrage, fin ou abandon, livraison, notes datées. */
function lotEvents(plan: Plan): PlanEvent[] {
  const out: PlanEvent[] = [];
  for (const l of plan.lots()) {
    if (l.created) out.push({ day: l.created, type: 'cree', lot: l.id });
    if (l.started) out.push({ day: l.started, type: 'demarre', lot: l.id });
    if (l.finished) out.push({ day: l.finished, type: l.status === 'dropped' ? 'abandonne' : 'termine', lot: l.id });
    if (l.delivered) out.push({ day: l.delivered.date, type: 'livre', lot: l.id, sha: l.delivered.sha });
    for (const n of l.notes) out.push({ day: n.date, type: 'note', lot: l.id, text: n.text });
  }
  return out;
}

/** Un événement commit par lot que cite le commit (la règle de rattachement de `raf commits`). */
function commitEvents(plan: Plan, commits: Commit[]): PlanEvent[] {
  const { byLot } = linkCommits(plan.lots(), commits, plan.refs);
  return [...byLot].flatMap(([lot, list]) => list.map((c): PlanEvent => ({ day: c.day, type: 'commit', lot, sha: c.sha, subject: c.subject })));
}

/** L'état détaillé (`state:`) de chaque lot d'une version du fichier du plan ; null quand le texte n'est pas un plan lisible. */
function statesOf(text: string): Map<string, string> | null {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return null;
  }
  const lots = (doc as { lots?: unknown } | null)?.lots;
  if (!Array.isArray(lots)) return null;
  const states = new Map<string, string>();
  for (const l of lots as { id?: unknown; state?: unknown }[]) if (l && l.id !== undefined) states.set(String(l.id), l.state === undefined ? '' : String(l.state));
  return states;
}

/** Un événement `etat` par lot dont `state:` diffère entre deux versions du plan ; un lot absent d'avant n'avait pas d'état. */
function stateChanges(before: Map<string, string>, after: Map<string, string>, day: Day, sha: string): PlanEvent[] {
  const out: PlanEvent[] = [];
  for (const [lot, to] of after) {
    const from = before.get(lot) ?? '';
    if (from !== to) out.push({ day, type: 'etat', lot, from: from || null, to: to || null, sha });
  }
  return out;
}

/**
 * Les changements d'état de l'historique git du fichier du plan, au jour et au sha du commit. `since` borne le parcours : la version qui
 * précède le premier commit retenu sert de point de départ. Un plan que git ne suit pas n'a pas d'historique : aucun événement.
 * Une version illisible est sautée et signalée par `warn`.
 */
function stateEvents(root: string, planFile: string, since: Day | undefined, warn: (line: string) => void): PlanEvent[] {
  const log = tryGit(root, ['log', '--reverse', '--format=%H %cs', ...(since ? [`--since=${since}`] : []), '--', planFile]);
  if (!log) return [];
  const versions = log.split('\n').map((l) => l.split(' ') as [string, Day]);
  const parent = since ? fileAt(root, `${versions[0][0]}^`, planFile) : null;
  let before: Map<string, string> | null = parent === null ? new Map() : statesOf(parent);
  const out: PlanEvent[] = [];
  for (const [sha, day] of versions) {
    const text = fileAt(root, sha, planFile);
    const after = text === null ? null : statesOf(text);
    if (after === null) {
      if (text !== null) warn(`historique du plan illisible au commit ${sha.slice(0, 7)} : ses changements d'état sont sautés`);
      continue;
    }
    if (before !== null) out.push(...stateChanges(before, after, day, sha));
    before = after;
  }
  return out;
}

const RANK = ['cree', 'demarre', 'etat', 'commit', 'note', 'termine', 'abandonne', 'livre'];

function detail(e: PlanEvent): string {
  switch (e.type) {
    case 'note':
      return e.text;
    case 'etat':
      return `${e.from ?? '∅'} → ${e.to ?? '∅'}  ${e.sha.slice(0, 7)}`;
    case 'commit':
      return `${e.sha.slice(0, 7)} ${e.subject}`;
    case 'livre':
      return e.sha.slice(0, 7);
    default:
      return '';
  }
}

/** `raf events` : les événements du plan, du plus ancien au plus récent, ordre total stable (jour, type, lot, détail). */
export function planEvents(plan: Plan, root: string, planFile: string, commits: Commit[], opts: { since?: Day; warn: (line: string) => void }): PlanEvent[] {
  const native = !plan.readonly;
  const all = [...lotEvents(plan), ...commitEvents(plan, commits), ...(native ? stateEvents(root, planFile, opts.since, opts.warn) : [])];
  const kept = opts.since ? all.filter((e) => e.day >= opts.since!) : all;
  const key = (e: PlanEvent) => `${e.day}\0${String(RANK.indexOf(e.type)).padStart(2, '0')}\0${e.lot}\0${detail(e)}`;
  return kept.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Une ligne par événement : « jour  type  lot  détail ». */
export function eventLine(e: PlanEvent): string {
  return `${e.day}  ${e.type}  ${e.lot}  ${detail(e)}`.trimEnd();
}
