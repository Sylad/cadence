// `raf add` : les contrôles des options et l'ajout du lot ou de la sous-tâche (sorti de cli.ts).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { invalidResource, RafError, type Plan, type Screen } from './plan.js';
import { DEFAULT_ESTIMATE } from './plan-read.js';
import type { Day } from './dates.js';
import { parseSet } from './plan-extras.js';
import { parseWindow } from './plan-window.js';
import { citedResources, type Resources } from './resources.js';
import { CYCLE_DIR } from './orchestrate/probe.js';

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

/** Les `--uses` donnés puis les ressources que le titre cite (L671), sans doublon ; undefined quand il n'y en a aucune. Une liste `--uses` vide est refusée. */
function usesOf(option: string | undefined, title: string, declared: Resources): string[] | undefined {
  const given = option?.split(',').map((n) => n.trim()).filter(Boolean);
  if (given?.length === 0) throw new RafError(invalidResource(''));
  const all = [...new Set([...(given ?? []), ...citedResources(title, declared)])];
  return all.length ? all : undefined;
}

/**
 * Le titre cite-t-il un chemin du cycle d'un lot (`src/orchestrate/cycle/` ou un fichier dessous), dans un dépôt qui porte ce dossier (L682) ? Un mot du titre
 * qui commence par le dossier, « / » final facultatif : « src/orchestrate/cycle.ts » n'en est pas.
 */
function citesCycle(title: string, root: string): boolean {
  const bare = CYCLE_DIR.slice(0, -1);
  return existsSync(join(root, CYCLE_DIR)) && (title.match(/[\w./*-]+/g) ?? []).some((w) => w.startsWith(CYCLE_DIR) || (w.startsWith(bare) && /^\.*$/.test(w.slice(bare.length))));
}

/**
 * L'estimate d'un lot qui touche le cycle est doublée (L682) : ses lots dépassent l'estimate (L676 : 0,5 j, 559 676 / 600 000 tokens, rendu au lead avec ses majeurs
 * sans correction ; « correction non jouée » dans 7 vagues). Le budget du lot, dérivé de l'estimate, suit. Sans `--estimate`, l'estimate par défaut est doublée.
 */
function estimateFor(estimate: number | undefined, title: string, root: string, notice: (line: string) => void): number | undefined {
  if (!citesCycle(title, root)) return estimate;
  const base = estimate ?? DEFAULT_ESTIMATE;
  notice(`estimate doublée : ${base} → ${base * 2} j (le titre cite ${CYCLE_DIR}, dont les lots dépassent leur estimate, L682)`);
  return base * 2;
}

/**
 * Ajoute un lot (ou, avec `--parent`, une sous-tâche) et rend son identifiant ; le plan n'est pas encore écrit. Un lot reçoit aussi, après ses `--uses`, les ressources
 * à chemins de `declared` que son titre cite (L671) : il n'attend plus l'intégration d'un lot plus ancien qui touche la même page, la file de la vague (L551) le tient.
 */
export function addLot(plan: Plan, values: AddValues, title: string, today: Day, env: { refuseLongTitle: (text: string) => void; declared: Resources; root: string; notice: (line: string) => void }): string {
  if (values.parent) return addSubTask(plan, values.parent, values, title);
  const given = values.estimate === undefined ? undefined : Number(values.estimate);
  if (given !== undefined && !(given > 0)) throw new RafError(`estimation invalide : ${values.estimate}`);
  const estimate = estimateFor(given, title, env.root, env.notice);
  const after = values.after ? values.after.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const every = values.every === undefined ? undefined : Number(values.every);
  if (every !== undefined && !(Number.isInteger(every) && every > 0)) throw new RafError(`périodicité invalide : ${values.every} (un nombre entier de jours)`);
  if (values.public !== undefined) env.refuseLongTitle(values.public);
  const uses = usesOf(values.uses, title, env.declared);
  const planned = values.planned === undefined ? undefined : parseWindow(values.planned);
  plan.requireWindow({ planned, every, under: values.under });
  return plan.add(title, today, { estimate, quickwin: values.quickwin, visible: values.visible, screen: values.screen as Screen | undefined, spec: values.spec, local: values.local, public: values.public, every, after, uses, planned, extras: parseSet(values.set), id: values.id, under: values.under });
}
