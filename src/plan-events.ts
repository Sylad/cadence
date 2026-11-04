// Le plan en JSON stable et le flux d'événements (L470, M8) : ce que lit un tableau de bord ou un miroir externe sans parcourir le YAML.
import { parse } from 'yaml';
import { type Day } from './dates.js';
import { blobs, type Commit, tryGit } from './git.js';
import { workCommits } from './audit.js';
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

/** Un événement commit par lot que cite le commit de travail : le rattachement et le filtre de `raf commits` (ni plan seul, ni acquitté, ni release, ni d'avant l'adoption). */
function commitEvents(plan: Plan, root: string, commits: Commit[]): PlanEvent[] {
  const { byLot } = linkCommits(plan.lots(), commits, plan.refs);
  // Le filtre ne dépend pas du lot : une seule passe sur l'union des commits rattachés, pas une par lot (un commit qui cite deux lots n'est examiné qu'une fois).
  const work = new Set(workCommits(plan, root, [...new Set([...byLot.values()].flat())]).map((c) => c.sha));
  return [...byLot].flatMap(([lot, list]) => list.filter((c) => work.has(c.sha)).map((c): PlanEvent => ({ day: c.day, type: 'commit', lot, sha: c.sha, subject: c.subject })));
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
  for (const l of lots as { id?: unknown; state?: unknown }[]) if (l && l.id !== undefined) states.set(String(l.id), l.state === undefined || l.state === null ? '' : String(l.state));
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

/** Le motif `git log -G` d'une ligne `state:` ajoutée ou retirée (clé de bloc, ou de mapping en accolades) ; `state_before:` n'en est pas une. */
const STATE_LINE = '(^|[{,])[[:space:]]*state:';

/**
 * Les changements d'état de l'historique git du fichier du plan (première parenté : un merge se compare à la branche où il est fait ; le fichier est suivi à travers ses déplacements), au jour et au sha du commit.
 * Seuls les commits dont le diff ajoute ou retire une ligne `state:` sont relus (`-G`) : les autres ne peuvent changer aucun état, et un plan de deux mille versions sans changement d'état ne coûte aucune lecture.
 * Chaque commit retenu se compare à sa version d'avant (son premier parent) ; les blobs se lisent en une passe. `since` borne le parcours. Un plan que git ne suit pas n'a pas d'historique : aucun événement.
 * Une version illisible est sautée et signalée par `warn` ; le changement suivant part du dernier état lisible (ou d'aucun).
 */
function stateEvents(root: string, planFile: string, since: Day | undefined, warn: (line: string) => void): PlanEvent[] {
  // `--follow` suit le fichier à travers ses déplacements (raf migrate, `plan:` changé) : git ne combine pas `--follow` et `--reverse` (l'historique s'arrête au déplacement) : l'ordre est inversé ici. `--raw` donne les blobs d'avant et d'après de chaque commit (`:<mode> <mode> <avant> <après> <statut>\t<chemin>`), un déplacement pur ne change aucun état.
  const log = tryGit(root, ['log', '--first-parent', '--follow', '--raw', '--no-abbrev', `-G${STATE_LINE}`, '--format=%x01%H %cs', ...(since ? [`--since=${since}T00:00:00`] : []), '--', planFile]);
  if (!log) return [];
  const versions = log
    .split('\x01')
    .filter(Boolean)
    .reverse()
    .flatMap((block) => {
      const [head, ...files] = block.trim().split('\n');
      const [sha, day] = head.split(' ') as [string, Day];
      const cols = files.find((f) => f.startsWith(':'))?.split(/\s+/);
      return cols ? [{ sha, day, parent: cols[2], blob: cols[3] }] : [];
    });
  const texts = blobs(root, [...new Set(versions.flatMap((v) => [v.parent, v.blob]))].filter((id) => !/^0+$/.test(id)));
  const parsed = new Map<string, Map<string, string> | null>();
  const statesAt = (id: string): Map<string, string> | null => {
    if (/^0+$/.test(id)) return new Map();
    if (!parsed.has(id)) {
      const text = texts.get(id);
      parsed.set(id, text === undefined ? null : statesOf(text));
    }
    return parsed.get(id)!;
  };
  const out: PlanEvent[] = [];
  let lastGood = new Map<string, string>();
  for (const { sha, day, parent, blob } of versions) {
    const after = statesAt(blob);
    if (after === null) {
      if (texts.has(blob)) warn(`historique du plan illisible au commit ${sha.slice(0, 7)} : ses changements d'état sont sautés`);
      continue;
    }
    out.push(...stateChanges(statesAt(parent) ?? lastGood, after, day, sha));
    lastGood = after;
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

/** `raf events` : les événements du plan, du plus ancien au plus récent, ordre stable (jour, type, lot, détail ; les changements d'état d'un lot le même jour dans l'ordre de l'historique git). */
export function planEvents(plan: Plan, root: string, planFile: string, commits: Commit[], opts: { since?: Day; warn: (line: string) => void }): PlanEvent[] {
  // Sans `plan.states`, aucun lot ne porte de `state:` : l'historique du plan n'est pas parcouru. Un plan lu dans le format d'un autre outil (readonly) n'a pas d'états non plus.
  const native = !plan.readonly && plan.stateModel !== undefined;
  const all = [...lotEvents(plan), ...commitEvents(plan, root, commits), ...(native ? stateEvents(root, planFile, opts.since, opts.warn) : [])];
  const kept = opts.since ? all.filter((e) => e.day >= opts.since!) : all;
  // Les `etat` d'un même lot et d'un même jour gardent l'ordre de l'historique git (le tri est stable) : le détail commence par `from → to`, l'alphabet n'est pas l'ordre des commits.
  const key = (e: PlanEvent) => `${e.day}\0${String(RANK.indexOf(e.type)).padStart(2, '0')}\0${e.lot}\0${e.type === 'etat' ? '' : detail(e)}`;
  return kept.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Une ligne par événement : « jour  type  lot  détail ». */
export function eventLine(e: PlanEvent): string {
  return `${e.day}  ${e.type}  ${e.lot}  ${detail(e)}`.trimEnd();
}
