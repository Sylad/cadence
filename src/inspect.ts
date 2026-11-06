// `cadence inspect` (L627) : l'inspection des travaux d'une vague, sans modèle ni écriture. Le temps de chaque lot par étape, les pertes classées par cause,
// la cause déjà vue dans une vague d'avant (récidive) et le lot du plan qui la traite, ou la commande `raf add` qui l'ouvrirait. Base : l'agent inspecteur-travaux du 05-11.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Category = 'refus d\'intégration' | 'reprise du lead' | 'attente de créneau' | 'attente de ressource' | 'conflit';
/** Où l'erreur a été détectée (L627, indicateur du 05-11, plus « revue » pour une correction demandée par la revue de code) ; null : l'attente de créneau n'est pas une erreur, une reprise lue dans git ne dit pas son niveau, et une revue non conforme ou un budget atteint ne sont détectés à aucun de ces niveaux. */
type Level = 'écriture' | 'commit' | 'porte' | 'revue' | 'intégration' | null;

interface Loss {
  lot: string;
  category: Category;
  /** Étiquette courte et stable : c'est elle que la récidive compare d'une vague à l'autre. */
  cause: string;
  minutes: number;
  level: Level;
  /** Les lots qui tiennent la ressource attendue (L644) ; absent hors attente de ressource. */
  holders?: string[];
}

export interface LotTime {
  lot: string;
  /** Minutes passées dans chaque état du lot (implementing, reviewing, fixing, question, suspended…), de son entrée au changement suivant. */
  states: Record<string, number>;
  /** Minutes de porte (début → fin du journal, portes imbriquées comptées une fois) et nombre de portes jouées. */
  gateMinutes: number;
  gates: number;
  /** Minutes de la première revue à la fin de ce que le journal sait du lot ; null sans revue. */
  afterFirstReview: number | null;
  /** Sessions lancées (lignes « session N <genre> »). */
  sessions: number;
  /** Passages en correction (`→ fixing`) par niveau de détection : la porte (une « porte : fin » du lot le précède, sans revue entre les deux), la revue (une `→ reviewing` le précède), sinon aucun des deux. */
  fixes: { porte: number; revue: number; autre: number };
}

/** Une reprise à la main du lead, lue dans git (L627) : un commit « correctif du lead » ou « rebase du lead » d'un lot, à sa date. */
export interface Retake {
  lot: string;
  cause: 'correctif du lead' | 'rebase du lead';
  at: number;
}

export interface Cause {
  category: Category;
  cause: string;
  minutes: number;
  lots: string[];
  count: number;
  level: Level;
  /** Les lots qui tenaient la ressource (L644), vide hors attente de ressource. */
  holders: string[];
  /** Vagues d'avant où la même cause est déjà passée (les plus récentes d'abord). */
  seenIn: string[];
  /** Un lot du plan qui la traite, ou rien. */
  planLot: { id: string; status: string } | null;
  /** Récidive : déjà vue, et aucun lot du plan ne l'a supprimée (aucun lot, ou un lot qui n'est pas terminé n'est pas une suppression livrée). */
  recidive: boolean;
  proposal: string | null;
}

export interface Inspection {
  wave: string;
  lots: LotTime[];
  causes: Cause[];
  totalMinutes: number;
  lostMinutes: number;
}

export interface PlanLot {
  project: string;
  id: string;
  title: string;
  status: string;
}

interface Entry {
  at: number;
  /** Le lot cité en tête de ligne (« cadence:L626 »), ou null pour une ligne de la vague. */
  lot: string | null;
  text: string;
}

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/;
// L'id d'un lot peut porter un « / » : une sous-tâche (`maritime-atlas:Q4/accueil-4-ux12`, src/orchestrate/state.ts).
const LOT_PREFIX = /^([^\s:]+:[A-Za-z0-9._/-]+) (?:· |→ |: |intégré|intégration différée|verdict|tests|CHANGELOG)/;
const TRANSITION = /^→ ([a-z-]+)(?: — (.*))?$/;
/** Les états où le lot travaille : l'attente du lead (handed-back, question, suspended) n'est pas du temps actif. */
const WORK_STATES = ['implementing', 'reviewing', 'fixing'];
/** L'état où l'on compte l'attente d'un lot avant son intégration, parce qu'un lot plus ancien de la vague tient une ressource qu'il touche (L558, L644) ; pas un état du journal, une mesure. */
const RESOURCE_WAIT = 'attente de ressource';
const DEFERRED = /^intégration différée : (\S+) touche la ressource « (.+?) » \(/;
const FINAL_STATES = new Set(['ready', 'failed']);

export function parseJournal(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    if (Number.isNaN(at)) continue;
    const rest = m[2]!;
    const lot = LOT_PREFIX.exec(rest);
    entries.push(lot ? { at, lot: lot[1]!, text: rest.slice(lot[1]!.length + 1).replace(/^· /, '') } : { at, lot: null, text: rest });
  }
  return entries;
}

const minutesOf = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

/** Les reprises du lead dans un `git log --format='%aI %s'` d'un projet : le sujet d'un commit de plan « plan: <lot> … » qui dit « correctif du lead » ou « rebase du lead » ; tout autre commit est ignoré. */
export function parseRetakes(log: string, project: string): Retake[] {
  const out: Retake[] = [];
  for (const line of log.split('\n')) {
    const m = /^(\S+) plan: (\S+) .*\b(correctif du lead|rebase du lead)\b/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    if (!Number.isNaN(at)) out.push({ lot: `${project}:${m[2]!}`, cause: m[3] as Retake['cause'], at });
  }
  return out;
}

/** « 2 min 5 s », « 40 s » → minutes. */
function waited(min: string | undefined, sec: string | undefined): number {
  return Number(min ?? 0) + Number(sec ?? 0) / 60;
}

/** L'étiquette d'un refus d'intégration : le motif sans ses détails (« tests rouges au sommet intégré (npx vitest… » → « tests rouges au sommet intégré »). */
function refusLabel(reason: string): string {
  const after = reason.replace(/^intégration (?:refusée|impossible)\s*:?\s*/, '');
  const head = after.split(/ \(|;|:/)[0]!.trim();
  return head === '' ? 'refus sans motif' : head.slice(0, 60);
}

interface Result {
  lots: LotTime[];
  losses: Loss[];
  end: number;
}

/** L'étiquette d'un lot rendu au lead hors intégration : le motif sans ses détails (« revue non conforme après 3 passe(s) de correction ; … » → « revue non conforme »). */
function handedBackLabel(reason: string): string {
  const head = reason.split(/ \(|;| :/)[0]!.replace(/ après \d+ passe\(s\) de correction/, '').trim();
  return head === '' ? 'rendu sans motif' : head.slice(0, 60);
}

/** Le niveau où un lot rendu au lead a été détecté, d'après son motif : le commit manquant, le verrou des tests écrits, la porte (tests rouges, correction non jouée) ; sinon aucun des quatre. */
function handedBackLevel(reason: string): Level {
  if (/^implement sans commit/.test(reason)) return 'commit';
  if (/^verrou des tests d'acceptation/.test(reason)) return 'écriture';
  if (/^(tests rouges|correction non jouée)/.test(reason)) return 'porte';
  return null;
}

/** La perte que laisse un lot dans un état de `min` minutes : un refus ou un conflit d'intégration, un lot rendu au lead (hors retrait `--drop`, le geste du lead), une intégration reprise, une question ; sinon aucune. */
function lossOfState(lot: string, state: string, reason: string, min: number): Loss | null {
  if (state === 'handed-back' && /^intégration (refusée|impossible)/.test(reason)) {
    const conflit = /conflit/.test(reason);
    return { lot, category: conflit ? 'conflit' : 'refus d\'intégration', cause: conflit ? 'conflit de rebase' : refusLabel(reason), minutes: min, level: 'intégration' };
  }
  if (state === 'handed-back' && !/^retiré de la vague/.test(reason)) return { lot, category: 'reprise du lead', cause: handedBackLabel(reason), minutes: min, level: handedBackLevel(reason) };
  if (state === 'suspended' && /intégration reprise/.test(reason)) return { lot, category: 'reprise du lead', cause: 'intégration reprise par le lead', minutes: min, level: 'intégration' };
  if (state === 'question') return { lot, category: 'reprise du lead', cause: 'réponse du lead à une question', minutes: min, level: null };
  return null;
}

/** Le niveau où une correction a été demandée : la dernière ligne « porte : fin » ou `→ reviewing` du lot avant son `→ fixing` (à l'index `index` des entrées). */
function fixLevel(es: Entry[], index: number): keyof LotTime['fixes'] {
  for (let j = index - 1; j >= 0; j--) {
    if (/^porte : fin/.test(es[j]!.text)) return 'porte';
    if (TRANSITION.exec(es[j]!.text)?.[1] === 'reviewing') return 'revue';
  }
  return 'autre';
}

/** Les minutes de chaque état d'un lot (de sa transition à la suivante, la dernière jusqu'à `end`), ses pertes d'état, ses corrections par niveau et l'instant de sa première revue. */
function stateTimes(lot: string, es: Entry[], end: number): { states: Record<string, number>; losses: Loss[]; fixes: LotTime['fixes']; firstReview: number | null } {
  const states: Record<string, number> = {};
  const losses: Loss[] = [];
  const fixes: LotTime['fixes'] = { porte: 0, revue: 0, autre: 0 };
  const transitions = es.flatMap((e, index) => {
    const t = TRANSITION.exec(e.text);
    return t ? [{ state: t[1]!, reason: t[2] ?? '', at: e.at, index }] : [];
  });
  transitions.forEach((cur, i) => {
    if (cur.state === 'fixing') fixes[fixLevel(es, cur.index)]++;
    // Un refus rendu sans suite (dernière transition) n'a pas de fin mesurable : 0 minute, mais il est compté.
    const to = transitions[i + 1]?.at ?? (cur.state === 'handed-back' ? cur.at : end);
    const min = minutesOf(to - cur.at);
    if (!FINAL_STATES.has(cur.state)) states[cur.state] = Math.round(((states[cur.state] ?? 0) + min) * 10) / 10;
    const loss = lossOfState(lot, cur.state, cur.reason, min);
    if (loss) losses.push(loss);
  });
  for (const w of resourceWaits(lot, es, end)) {
    const cur = transitions.filter((t) => t.at <= w.start).pop();
    if (cur && !FINAL_STATES.has(cur.state)) states[cur.state] = Math.max(0, Math.round(((states[cur.state] ?? 0) - w.loss.minutes) * 10) / 10);
    states[RESOURCE_WAIT] = Math.round(((states[RESOURCE_WAIT] ?? 0) + w.loss.minutes) * 10) / 10;
    losses.push(w.loss);
  }
  return { states, losses, fixes, firstReview: transitions.find((t) => t.state === 'reviewing')?.at ?? null };
}

/**
 * Les attentes d'intégration différée d'un lot (L644) : de la première ligne « intégration différée » à la reprise du lot (transition) ou à son « intégré », ou à la fin du journal ;
 * les lignes différées suivantes (un autre lot qui tient) restent dans la même attente. Une attente de zéro minute n'est pas une perte.
 */
function resourceWaits(lot: string, es: Entry[], end: number): Array<{ start: number; loss: Loss }> {
  const out: Array<{ start: number; loss: Loss }> = [];
  let open: { start: number; resource: string; holders: string[] } | null = null;
  const close = (at: number): void => {
    if (!open) return;
    const minutes = minutesOf(at - open.start);
    if (minutes > 0) out.push({ start: open.start, loss: { lot, category: 'attente de ressource', cause: `ressource « ${open.resource} »`, minutes, level: null, holders: open.holders } });
    open = null;
  };
  for (const e of es) {
    const d = DEFERRED.exec(e.text);
    if (d) {
      if (!open) open = { start: e.at, resource: d[2]!, holders: [] };
      if (!open.holders.includes(d[1]!)) open.holders.push(d[1]!);
    } else if (TRANSITION.test(e.text) || /^intégré : /.test(e.text)) close(e.at);
  }
  close(end);
  return out;
}

/** Le temps de porte d'un lot : de « porte : début » à « porte : fin », les portes imbriquées comptées une fois ; un début sans fin, une fin sans début ne comptent pas. */
function gateTimes(es: Entry[]): { gateMs: number; gates: number } {
  let depth = 0;
  let start = 0;
  let gateMs = 0;
  let gates = 0;
  for (const e of es) {
    if (/^porte : début/.test(e.text)) {
      if (depth === 0) start = e.at;
      depth++;
      gates++;
    } else if (/^porte : fin/.test(e.text) && depth > 0) {
      depth--;
      if (depth === 0) gateMs += e.at - start;
    }
  }
  return { gateMs, gates };
}

/** Les attentes de créneau d'un lot : celui d'une session (durée dite par la ligne) et celui d'une porte (jusqu'à la ligne qui dit où elle se joue). */
function slotWaits(lot: string, es: Entry[]): Loss[] {
  const losses: Loss[] = [];
  let doorWait: number | null = null;
  for (const e of es) {
    const got = /^créneau de session obtenu après (?:(\d+) min )?(?:(\d+) s )?d'attente/.exec(e.text);
    if (got) losses.push({ lot, category: 'attente de créneau', cause: 'créneau de session', minutes: Math.round(waited(got[1], got[2]) * 10) / 10, level: null });
    if (/^porte du lot \S+ : en attente d'un créneau de porte/.test(e.text)) doorWait = e.at;
    else if (doorWait !== null && /^porte du lot \S+ : (porte jouée|porte déportée|cache de dépendances|worktree non validé|sha invalide)/.test(e.text)) {
      losses.push({ lot, category: 'attente de créneau', cause: 'créneau de porte', minutes: minutesOf(e.at - doorWait), level: null });
      doorWait = null;
    }
  }
  return losses.filter((l) => l.minutes > 0);
}

/** Le temps par état, la porte et les pertes de chaque lot, lus dans le journal d'une vague ; `retakes` : les reprises du lead tombées dans la vague, une perte chacune (durée non mesurée : git ne la dit pas). */
export function measureWave(entries: Entry[], retakes: Retake[] = []): Result {
  const end = entries.reduce((m, e) => Math.max(m, e.at), 0);
  const byLot = new Map<string, Entry[]>();
  for (const e of entries) if (e.lot) byLot.set(e.lot, [...(byLot.get(e.lot) ?? []), e]);
  const lots: LotTime[] = [];
  const losses: Loss[] = [];
  for (const [lot, es] of byLot) {
    const { states, losses: stateLosses, fixes, firstReview } = stateTimes(lot, es, end);
    const { gateMs, gates } = gateTimes(es);
    losses.push(...stateLosses, ...slotWaits(lot, es));
    lots.push({ lot, states, gateMinutes: minutesOf(gateMs), gates, afterFirstReview: firstReview === null ? null : minutesOf(es.reduce((m, e) => Math.max(m, e.at), firstReview) - firstReview), sessions: es.filter((e) => /^session \d+ /.test(e.text)).length, fixes });
  }
  for (const r of retakes) losses.push({ lot: r.lot, category: 'reprise du lead', cause: r.cause, minutes: 0, level: null });
  return { lots, losses, end };
}

/** Les reprises tombées dans la fenêtre d'une vague : de sa première ligne de journal à la première ligne de la vague suivante (sans suivante : sans fin). */
function retakesBetween(retakes: Retake[], start: number, next: number | null): Retake[] {
  return retakes.filter((r) => r.at >= start && (next === null || r.at < next));
}

/** La première ligne du journal d'une vague, ou null (journal absent ou vide). */
function waveStart(runsDir: string, wave: string): number | null {
  const file = join(runsDir, wave, 'journal.log');
  if (!existsSync(file)) return null;
  const start = parseJournal(readFileSync(file, 'utf8')).reduce((m, e) => Math.min(m, e.at), Number.POSITIVE_INFINITY);
  return Number.isFinite(start) ? start : null;
}

/** Les causes de plus de zéro occurrence, regroupées par catégorie et étiquette. */
function groupCauses(losses: Loss[]): Array<Pick<Cause, 'category' | 'cause' | 'minutes' | 'lots' | 'count' | 'level' | 'holders'>> {
  const map = new Map<string, Loss[]>();
  for (const l of losses) map.set(`${l.category}\u0000${l.cause}`, [...(map.get(`${l.category}\u0000${l.cause}`) ?? []), l]);
  return [...map.values()].map((ls) => ({
    category: ls[0]!.category,
    cause: ls[0]!.cause,
    minutes: Math.round(ls.reduce((s, l) => s + l.minutes, 0) * 10) / 10,
    lots: [...new Set(ls.map((l) => l.lot))],
    count: ls.length,
    level: ls[0]!.level,
    holders: [...new Set(ls.flatMap((l) => l.holders ?? []))],
  }));
}

/** Ce qu'un titre du plan dit quand son lot traite la cause : « conflit » seul ne suffit pas (le lot de l'inspection les énumère toutes), « conflit de … » oui. */
function keywords(c: { category: Category; cause: string }): RegExp[] {
  if (c.cause === 'créneau de porte') return [/créneau de porte/i, /maxparallel/i];
  if (c.cause === 'créneau de session') return [/créneau de session/i];
  if (c.category === 'attente de ressource') return [/attente de ressource/i, /intégration différée/i];
  if (c.cause === 'conflit de rebase') return [/conflits? (de|d'|sur|en|entre)\b/i];
  return [new RegExp(c.cause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')];
}

const MECHANISM: Record<Category, string> = {
  'refus d\'intégration': 'le brief donne au lot, dès le départ, ce que l\'intégration refuse (niveau : source)',
  'reprise du lead': 'la vague fait elle-même le geste que le lead reprend à la main (niveau : source)',
  'attente de créneau': 'le plafond ou l\'ordre de lancement évite que des lots attendent (niveau : source)',
  'attente de ressource': 'les lots qui touchent la même ressource ne sont plus lancés ensemble, ou le plus ancien intègre avant que l\'autre soit relu (niveau : source)',
  conflit: 'les fichiers en conflit sont déclarés en ressource, deux lots n\'y écrivent plus ensemble (niveau : source)',
};

/** Le lot du plan qui traite la cause, en préférant un lot terminé (un mécanisme livré) puis le plus récent. */
function planLotFor(c: { category: Category; cause: string }, plan: PlanLot[]): PlanLot | null {
  const words = keywords(c);
  const hits = plan.filter((p) => p.status !== 'dropped' && words.some((w) => w.test(p.title)));
  return hits.find((p) => p.status !== 'done') ?? hits[hits.length - 1] ?? null;
}

function proposalFor(c: { category: Category; cause: string; minutes: number }): string {
  return `raf add --estimate 0.25 -- "${c.cause} : ${MECHANISM[c.category]} ; mesure : 0 ${c.category} « ${c.cause} » par vague"`;
}

/** Les vagues d'avant (par nom, les plus récentes d'abord, au plus `limit`) dont le journal existe. */
function previousWaves(runsDir: string, wave: string, limit = 30): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((w) => w < wave && existsSync(join(runsDir, w, 'journal.log'))).sort().reverse().slice(0, limit);
}

/** Les vagues datées du dossier qui ont un journal, par nom (l'ordre des dates) : les fenêtres des reprises. */
function datedWaves(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((w) => /^\d{4}-\d{2}-\d{2}-\d{4}/.test(w) && existsSync(join(runsDir, w, 'journal.log'))).sort();
}

export function inspectWave(runsDir: string, wave: string, plan: PlanLot[], retakes: Retake[] = []): Inspection {
  const file = join(runsDir, wave, 'journal.log');
  const dated = datedWaves(runsDir);
  // Les reprises d'une vague : celles tombées entre sa première ligne de journal et celle de la vague datée suivante ; une vague à nom libre n'a pas de fenêtre.
  const retakesOf = (w: string): Retake[] => {
    const start = dated.includes(w) ? waveStart(runsDir, w) : null;
    if (start === null) return [];
    const next = dated.find((d) => d > w);
    return retakesBetween(retakes, start, next === undefined ? null : waveStart(runsDir, next));
  };
  const { lots, losses } = measureWave(parseJournal(existsSync(file) ? readFileSync(file, 'utf8') : ''), retakesOf(wave));
  const earlier = previousWaves(runsDir, wave).map((w) => ({ wave: w, causes: groupCauses(measureWave(parseJournal(readFileSync(join(runsDir, w, 'journal.log'), 'utf8')), retakesOf(w)).losses) }));
  // Le plan qui traite une cause est celui du projet de la vague : les lots des autres projets du dossier n'en disent rien.
  const projects = new Set([...lots.map((l) => l.lot), ...losses.map((l) => l.lot)].map((l) => l.split(':')[0]!));
  const ownPlan = plan.filter((p) => projects.has(p.project) || projects.has(p.project.split('/').pop()!));
  const causes: Cause[] = groupCauses(losses).map((c) => {
    const seenIn = earlier.filter((e) => e.causes.some((x) => x.category === c.category && x.cause === c.cause)).map((e) => e.wave);
    const planLot = planLotFor(c, ownPlan);
    const recidive = seenIn.length > 0;
    return { ...c, seenIn, planLot: planLot ? { id: `${planLot.project}:${planLot.id}`, status: planLot.status } : null, recidive, proposal: planLot && planLot.status !== 'done' ? null : proposalFor(c) };
  });
  causes.sort((a, b) => Number(b.recidive) - Number(a.recidive) || b.minutes - a.minutes);
  const active = lots.reduce((s, l) => s + WORK_STATES.reduce((a, k) => a + (l.states[k] ?? 0), 0), 0);
  return { wave, lots, causes, totalMinutes: Math.round(active * 10) / 10, lostMinutes: Math.round(causes.reduce((s, c) => s + c.minutes, 0) * 10) / 10 };
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const RETAKE_CAUSES: ReadonlySet<string> = new Set<Retake['cause']>(['correctif du lead', 'rebase du lead']);

/** La ligne d'une cause, et la suite qu'elle appelle (lot du plan ou commande proposée). */
function causeLines(c: Cause): string[] {
  const more = c.seenIn.length > 3 ? `, +${c.seenIn.length - 3}` : '';
  const seen = c.seenIn.length > 0 ? ` · RÉCIDIVE (déjà vue : ${c.seenIn.slice(0, 3).join(', ')}${more})` : '';
  const level = c.level ? ` · détectée à : ${c.level}` : '';
  const holders = c.holders.length > 0 ? ` · tenue par ${c.holders.join(', ')}` : '';
  const minutes = RETAKE_CAUSES.has(c.cause) ? 'durée dans git, non mesurée' : `${c.minutes} min`;
  const head = `${c.recidive ? '⚠' : '-'} ${c.category} · ${c.cause} : ${minutes}, ${c.count} fois, ${c.lots.length} lot(s)${holders}${level}${seen}`;
  if (c.proposal) return [head, `    ${c.planLot ? `lot du plan à relire : ${c.planLot.id} (${c.planLot.status}) ; ` : ''}proposition : ${c.proposal}`];
  return c.planLot ? [head, `    au plan : ${c.planLot.id} (${c.planLot.status})`] : [head];
}

/** Le tableau imprimé en fin de vague et par `cadence inspect`. */
export function renderInspection(i: Inspection): string[] {
  const out = [`inspection de la vague ${i.wave} : ${i.lots.length} lot(s), ${i.totalMinutes} min actives, ${i.lostMinutes} min perdues`];
  // La colonne du lot s'élargit au plus long id (une sous-tâche « projet:Q4/… » dépasse 16 caractères).
  const width = Math.max(16, ...i.lots.map((l) => l.lot.length + 2));
  out.push(`${pad('lot', width)}${pad('écriture', 10)}${pad('revue', 8)}${pad('correction', 12)}${pad('porte', 8)}${pad('après revue', 12)}sessions`);
  for (const l of i.lots) {
    out.push(`${pad(l.lot, width)}${pad(l.states.implementing ?? 0, 10)}${pad(l.states.reviewing ?? 0, 8)}${pad(l.states.fixing ?? 0, 12)}${pad(l.gateMinutes, 8)}${pad(l.afterFirstReview ?? '—', 12)}${l.sessions}`);
  }
  const fixes = i.lots.reduce((s, l) => ({ porte: s.porte + l.fixes.porte, revue: s.revue + l.fixes.revue, autre: s.autre + l.fixes.autre }), { porte: 0, revue: 0, autre: 0 });
  const total = fixes.porte + fixes.revue + fixes.autre;
  if (total > 0) out.push(`corrections : ${total}, détectées à la porte : ${fixes.porte}, à la revue : ${fixes.revue}, sans niveau : ${fixes.autre}`);
  return [...out, ...(i.causes.length === 0 ? ['aucune perte mesurée'] : i.causes.flatMap(causeLines))];
}

/** Le résumé du tour du lead (une ligne) : la première récidive de la dernière vague, avec sa proposition ; null sans récidive. */
export function tourSummary(i: Inspection): string | null {
  const c = i.causes.find((x) => x.recidive);
  if (!c) return null;
  return `⚠ inspect ${i.wave} : récidive « ${c.cause} » (${c.category}, ${c.minutes} min, déjà vue dans ${c.seenIn.length} vague(s)) · ${c.proposal ?? `au plan : ${c.planLot?.id} (${c.planLot?.status})`}`;
}
