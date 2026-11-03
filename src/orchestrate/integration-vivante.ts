import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planLoader } from '../config.js';
import { leadReviewedHandBack, type LotCtx, type WaveCtx } from './cycle.js';
import { trackedDirty } from './depot.js';
import { cadenceHome, liveWaves } from './registry.js';
import { waveReadsIntegrateQueue } from './snapshot.js';
import { lotKey, type LotState, type RunStore } from './state.js';
import { namesLot } from './ajout.js';
import { gestureSuffix, resumeCommand } from './geste.js';
import { lotTreeDir } from './worktree.js';
import type { OrchestrateIo } from './command.js';

type LeadReview = { head: string; verdict: string };

/**
 * Un lot rendu que `--integrate` peut reprendre (L279, L370) : rendu à l'étape d'intégration (`next: integrate`), ou rendu ailleurs puis corrigé et revu conforme par le lead dans son worktree (la revue porte le dernier commit).
 * Rend le verdict du lead dans ce second cas (`lead`), `{ lead: null }` dans le premier, null si le lot n'est pas reprenable.
 */
export function integrationHandBack(store: RunStore, l: LotState): { lead: LeadReview | null } | null {
  if (l.status !== 'handed-back') return null;
  if (l.next === 'integrate') return { lead: null };
  // La revue du lead est écrite par `raf review` lancé dans le worktree : c'est le plan du worktree qui la porte, pas celui du dépôt principal.
  const tree = lotTreeDir(store.dir, l.project, l.lot, l.repo);
  const lead = existsSync(join(tree, '.git')) ? leadReviewedHandBack(l, planLoader(tree)(), tree) : null;
  return lead ? { lead } : null;
}

/** La revue du lead tient lieu de revue du lot : le rebase reporte son verdict (même patch-id) ou joue la revue courte du diff rebasé. */
export function adoptLeadReview(l: LotState, lead: LeadReview): void {
  l.next = 'integrate';
  l.code = { conforme: true, bloquants: 0, majeurs: 0, mineurs: 0, verdict: lead.verdict, sousTaches: [], nonVerifie: [], head: lead.head };
  l.verdict = lead.verdict;
  l.constats = [];
}

/** La ligne de journal d'une intégration reprise (à la reprise comme sur la vague vivante). */
export const integrationText = (lead: { head: string } | null): string => (lead ? `intégration reprise (--resume --integrate) : revue conforme du lead hors vague, ${lead.head.slice(0, 7)}` : 'intégration reprise (--resume --integrate)');

/** Le contrôle d'une cible de `--integrate` : sa clé `projet:lot`, ou le refus. */
function checkTarget(store: RunStore, t: { project?: string; lot: string }, seen: string[]): { key: string } | { refusal: string } {
  const matches = store.lots().filter((l) => namesLot(store.launchDir, t, l));
  const where = `${t.project ? `${t.project}:` : ''}${t.lot}`;
  if (matches.length !== 1) return { refusal: matches.length ? `--integrate ${where} : plusieurs projets portent ce lot, précisez projet:lot` : `--integrate ${where} : lot inconnu dans la vague ${store.id}` };
  const l = matches[0];
  const key = lotKey(l.project, l.lot);
  if (seen.includes(key)) return { refusal: `--integrate ${key} : lot visé deux fois` };
  if (!integrationHandBack(store, l)) return { refusal: `--integrate ${key} : le lot n'est pas rendu à l'étape d'intégration (${l.status}, étape ${l.next ?? 'aucune'} : ${l.outcome ?? 'sans cause'})${gestureSuffix({ id: store.id, status: store.readWave()?.status ?? '', cwd: store.readWave()?.cwd }, l)}` };
  return { key };
}

/**
 * `--resume --integrate` sur une vague VIVANTE (L532) : l'intégration est déposée dans la file de la vague (`integrates.log`), qui la reprend entre deux étapes, comme un `--add`.
 * Sans cela le lead attendait la fin de la vague (qui dure des heures sous `--continue`). Les lots visés sont contrôlés comme à la reprise : connus, rendus à l'intégration ou revus par le lead.
 */
export function depositIntegrations(targets: { project?: string; lot: string }[], io: OrchestrateIo, store: RunStore): number {
  const refusals: string[] = [];
  const keys: string[] = [];
  for (const t of targets) {
    const r = checkTarget(store, t, keys);
    if ('key' in r) keys.push(r.key);
    else refusals.push(r.refusal);
  }
  if (!waveReadsIntegrateQueue(store.dir)) refusals.push(`la vague ${store.id} ne lit pas la file d'intégrations (lancée avec une version de cadence d'avant L532) : attendre sa fin, puis ${resumeCommand(store.id, '--integrate', '<projet>:<lot>')}`);
  if (refusals.length) {
    for (const r of refusals) io.err(`orchestrate : ${r}`);
    return 2;
  }
  for (const key of keys) {
    const id = store.requestIntegrate(key);
    // La vague a pu finir entre le contrôle et le dépôt : sa file ne sera plus lue, la demande est retirée et le lead reprend à la main.
    if (!liveWaves(cadenceHome()).some((w) => w.wave === store.id)) {
      store.markIntegrateTaken(id);
      io.err(`orchestrate : ${key} : la vague ${store.id} vient de finir, intégration non prise : ${resumeCommand(store.id, '--integrate', key)}`);
      return 2;
    }
    store.journal(`demande : intégration du lot ${key}`);
    io.out(`${key} : intégration déposée — la vague ${store.id} la reprend entre deux étapes dès qu'un créneau est libre`);
  }
  return 0;
}

/** Pourquoi la demande ne peut plus être jouée (lot inconnu, déjà repris, revue du lead perdue), ou le lot et ce qui le reprend. */
function eligible(store: RunStore, ctxs: LotCtx[], lot: string): { why: string } | { c: LotCtx; back: { lead: LeadReview | null } } {
  const c = ctxs.find((x) => lotKey(x.lot.project, x.lot.lot) === lot);
  if (!c) return { why: 'lot inconnu' };
  if (c.lot.status !== 'handed-back') return { why: `le lot n'est plus rendu (${c.lot.status})` };
  const back = integrationHandBack(store, c.lot);
  return back ? { c, back } : { why: "le lot n'est pas rendu à l'étape d'intégration ni revu par le lead au dernier commit de son worktree" };
}

/**
 * La vague vivante prend les intégrations déposées (L532) : le lot rendu repart à l'étape `integrate` comme sous `--resume --integrate`, quand `canRun` l'accepte ; une demande dont le lot ne qualifie plus
 * (déjà repris, commit après la revue du lead, fichier suivi modifié) est écartée et dite au journal. Rend les lots à jouer ; `settled` est la liste des lots qui ont fini de jouer.
 */
export async function takeIntegrations(w: { store: RunStore; ctxs: LotCtx[]; wctx: WaveCtx; settled: Set<LotCtx> }, canRun: (c: LotCtx) => boolean): Promise<LotCtx[]> {
  const { store, wctx } = w;
  const taken: LotCtx[] = [];
  const drop = (id: number, lot: string, why: string): void => {
    wctx.log(`${lot} : intégration écartée (${why})`);
    store.markIntegrateTaken(id);
  };
  for (const e of store.integrateQueue()) {
    const r = eligible(store, w.ctxs, e.lot);
    if ('why' in r) {
      drop(e.id, e.lot, r.why);
      continue;
    }
    const { c, back } = r;
    if (!canRun(c)) continue;
    const dirty = await trackedDirty(lotTreeDir(store.dir, c.lot.project, c.lot.lot, c.lot.repo));
    if (dirty.length) {
      drop(e.id, e.lot, `arbre sale, ${dirty.length} fichier(s) suivi(s) modifié(s) : ${dirty.join(', ')}`);
      continue;
    }
    if (back.lead) adoptLeadReview(c.lot, back.lead);
    c.lot.next = 'integrate';
    c.lot.status = 'suspended';
    c.lot.outcome = null;
    store.writeLot(c.lot);
    // L557 (issue #26) : l'intégration explicite l'emporte sur un retrait déjà appliqué, sinon la première session du lot le relirait et le rendrait au lead.
    store.consumeDrops([e.lot]);
    store.markIntegrateTaken(e.id);
    wctx.log(`${e.lot} → suspended — ${integrationText(back.lead)}`);
    // Le lot avait fini de jouer (`settled`) : il rejoue, il tient de nouveau un créneau (L433).
    w.settled.delete(c);
    taken.push(c);
  }
  return taken;
}

/** `--resume --integrate` seul (sans --replay, --answer, --budget, --drop ni --continue) sur une vague qui tourne encore : l'intégration est déposée, pas refusée. */
export function depositsOnly(a: { integrate: { replay?: boolean }[]; answers: unknown[]; lotBudgets: unknown[]; drop: unknown[]; budget?: number; continue: boolean }, live: boolean): boolean {
  return live && a.integrate.length > 0 && a.integrate.every((t) => !t.replay) && !a.answers.length && !a.lotBudgets.length && !a.drop.length && a.budget === undefined && !a.continue;
}

/** La vague tourne dans un autre processus de ce dossier, et joue (« running ») : une reprise qui attend le dépôt (L443) est inscrite vivante sans rien jouer encore, elle ne lit pas la file. */
export function runsElsewhere(store: RunStore, launch: string): boolean {
  return store.readWave()?.status === 'running' && liveWaves(cadenceHome()).some((w) => w.wave === store.id && w.cwd === launch && w.pid !== process.pid);
}
