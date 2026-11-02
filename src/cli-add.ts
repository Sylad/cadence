// `raf add` : les contrôles des options et l'ajout du lot ou de la sous-tâche (sorti de cli.ts).
import { invalidResource, RafError, type Plan, type Screen } from './plan.js';
import type { Day } from './dates.js';
import { parseSet } from './plan-extras.js';
import { parseWindow } from './plan-window.js';

/** Les options de `raf add` telles que `parseArgs` les rend. */
interface AddValues {
  parent?: string;
  id?: string;
  under?: string;
  estimate?: string;
  quickwin?: boolean;
  visible?: boolean;
  screen?: string;
  spec?: boolean;
  local?: boolean;
  public?: string;
  every?: string;
  after?: string;
  uses?: string;
  planned?: string;
  set?: string[];
}

/** `raf add --parent <lot>` : une sous-tâche, qui ne porte aucune des options d'un lot. */
function addSubTask(plan: Plan, parent: string, values: AddValues, title: string): string {
  if (values.id !== undefined) throw new RafError('--id se pose sur un lot, pas sur une sous-tâche');
  if (values.under !== undefined) throw new RafError('--under se pose sur un lot, pas sur une sous-tâche : --parent crée une sous-tâche, --under un sous-lot');
  for (const [flag, given] of [['screen', values.screen !== undefined], ['spec', values.spec], ['local', values.local], ['public', values.public !== undefined], ['every', values.every !== undefined], ['planned', values.planned !== undefined]]) {
    if (given) throw new RafError(`--${flag} se pose sur un lot, pas sur une sous-tâche`);
  }
  if (values.uses !== undefined) throw new RafError(`uses se pose sur un lot, pas sur une sous-tâche : ${parent}`);
  if (values.set !== undefined) throw new RafError(`--set se pose sur un lot, pas sur une sous-tâche : ${parent}`);
  return plan.addTask(parent, title);
}

/** Ajoute un lot (ou, avec `--parent`, une sous-tâche) et rend son identifiant ; le plan n'est pas encore écrit. */
export function addLot(plan: Plan, values: AddValues, title: string, today: Day, refuseLongTitle: (text: string) => void): string {
  if (values.parent) return addSubTask(plan, values.parent, values, title);
  const estimate = values.estimate === undefined ? undefined : Number(values.estimate);
  if (estimate !== undefined && !(estimate > 0)) throw new RafError(`estimation invalide : ${values.estimate}`);
  const after = values.after ? values.after.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const every = values.every === undefined ? undefined : Number(values.every);
  if (every !== undefined && !(Number.isInteger(every) && every > 0)) throw new RafError(`périodicité invalide : ${values.every} (un nombre entier de jours)`);
  if (values.public !== undefined) refuseLongTitle(values.public);
  const uses = values.uses?.split(',').map((n) => n.trim()).filter(Boolean);
  if (uses?.length === 0) throw new RafError(invalidResource(''));
  const planned = values.planned === undefined ? undefined : parseWindow(values.planned);
  plan.requireWindow({ planned, every, under: values.under });
  return plan.add(title, today, { estimate, quickwin: values.quickwin, visible: values.visible, screen: values.screen as Screen | undefined, spec: values.spec, local: values.local, public: values.public, every, after, uses, planned, extras: parseSet(values.set), id: values.id, under: values.under });
}
