import type { Day } from './dates.js';
import type { Plan } from './plan.js';
import { RafError } from './plan.js';
import { currentState } from './plan-states.js';

/** Une ligne par état déclaré : son statut de base, le nombre de lots qui y sont et, si `plan.transitions` est déclaré, les états permis ensuite. */
function listStates(plan: Plan, out: (line: string) => void): void {
  const model = plan.stateModel;
  if (!model) throw new RafError('aucun état déclaré : cadence.yaml plan.states');
  const lots = plan.lots();
  for (const [name, base] of Object.entries(model.states)) {
    const next = model.transitions ? `  → ${model.transitions[name]?.join(', ') || '(terminal)'}` : '';
    out(`${name}  ${base}  ${lots.filter((l) => currentState(model, l) === name).length} lot(s)${next}`);
  }
}

/** `raf status` (L463) : sans argument la liste des états ; `<id> <état> ["message"]` ou `<id> --back ["message"]` pose l'état d'un lot. */
export function statusCommand(plan: Plan, rest: string[], ctx: { back: boolean; today: Day; out: (line: string) => void; commits: (plan: Plan, id: string) => number }): number {
  const { back, today, out } = ctx;
  if (rest.length === 0 && !back) {
    listStates(plan, out);
    return 0;
  }
  const first = back ? 1 : 2;
  if (rest.length < first) throw new RafError('usage : raf status <id> <état> ["message"] | raf status <id> --back ["message"]');
  const state = plan.setState(rest[0], back ? null : rest[1], today, { back, message: rest.slice(first).join(' ') }, () => ctx.commits(plan, rest[0]));
  plan.save();
  out(`${rest[0]} → ${state}`);
  return 0;
}
