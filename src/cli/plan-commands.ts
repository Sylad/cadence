// La planification d'un plan natif (L466, M4) : `raf plan` pose la fenêtre prévue d'un lot, ou propose celles des lots qui n'en ont pas.
import { isCalendarDay } from '../dates.js';
import { PLAN_ACTIONS } from '../plan-commit.js';
import { printUncommittedPlan } from '../plan-uncommitted.js';
import { parseWindow, proposeWindows } from '../plan-window.js';
import { RafError } from '../plan.js';
import { warnIntegrating, warnWaveWorking } from '../repo-busy.js';
import type { Ctx } from './context.js';

const USAGE = 'usage : raf plan <lot> AAAA-MM-JJ..AAAA-MM-JJ | raf plan <lot> --clear | raf plan --propose [--per-day n] [--from AAAA-MM-JJ] [--apply]';

/** Le plus petit `--per-day` : en deçà, la durée d'un lot se compterait en milliers de jours ouvrés. */
const MIN_PER_DAY = 0.01;

/** raf plan … : pose, retire ou propose les fenêtres prévues. */
export function cmdPlan(c: Ctx): number | Promise<number> {
  const { rest, values } = c;
  if (values.propose) {
    if (rest.length > 0 || values.clear) throw new RafError(USAGE);
    return propose(c);
  }
  for (const flag of ['apply', 'from', 'per-day'] as const) if (values[flag] !== undefined) throw new RafError(`--${flag} ne va qu'avec --propose`);
  if (values.clear && rest.length > 1) throw new RafError('--clear n\'attend pas de fenêtre');
  if (rest.length !== (values.clear ? 1 : 2)) throw new RafError(USAGE);
  return setWindow(c);
}

/** raf plan <lot> J1..J2 | --clear. */
function setWindow(c: Ctx): number {
  const { rest, values, io, root, loadPlan } = c;
  const window = values.clear ? null : parseWindow(rest[1]!);
  const plan = loadPlan();
  plan.setPlanned(rest[0]!, window);
  plan.save();
  io.out(`${rest[0]} → ${window ? `prévu ${window.from}..${window.to}` : 'fenêtre prévue retirée'}`);
  warnIntegrating(root, io.err);
  warnWaveWorking(root, io.env, io.err);
  return 0;
}

/** raf plan --propose [--per-day n] [--from J] [--apply] : les fenêtres des lots à faire qui n'en ont pas, écrites d'un coup avec --apply. */
function propose(c: Ctx): number {
  const { values, io, today, root, planConfig, loadPlan } = c;
  const perDayText = values['per-day'];
  if (perDayText !== undefined && !(/^\d+(\.\d+)?$/.test(perDayText.trim()) && Number(perDayText) >= MIN_PER_DAY)) throw new RafError(`--per-day invalide : ${perDayText} (un nombre de jours de travail par jour ouvré, ${MIN_PER_DAY} au moins)`);
  if (values.from !== undefined && !isCalendarDay(values.from)) throw new RafError(`--from invalide : ${values.from} (attendu AAAA-MM-JJ)`);
  const plan = loadPlan();
  const lots = plan.lots();
  const proposals = proposeWindows(lots, { from: values.from ?? today, perDay: perDayText === undefined ? 1 : Number(perDayText) });
  if (proposals.length === 0) {
    io.out('rien à proposer : tous les lots à faire ont une fenêtre prévue');
    return 0;
  }
  for (const p of proposals) io.out(`${p.id}  ${p.window.from}..${p.window.to}  ${lots.find((l) => l.id === p.id)!.title}`);
  if (!values.apply) {
    io.out(`${proposals.length} lot(s) proposé(s) — raf plan --propose --apply les écrit`);
    return 0;
  }
  for (const p of proposals) plan.setPlanned(p.id, p.window);
  plan.save();
  io.out(`${proposals.length} fenêtre(s) posée(s)`);
  printUncommittedPlan(io.out, plan, root, proposals[0]!.id, planConfig?.commit, PLAN_ACTIONS.planned(proposals.length));
  warnIntegrating(root, io.err);
  warnWaveWorking(root, io.env, io.err);
  return 0;
}
