// Le contexte commun des commandes de raf et de cadence (L488, sorti de cli.ts) : les options, ce que dispatch construit, les assistants partagés.
import { parseArgs } from 'node:util';
import { dirname, join, relative, resolve } from 'node:path';
import { defaultPlan, PLAN_DEFAULT, PLAN_LEGACY, readNewsConfig, readPlanConfig } from '../config.js';
import type { Day } from '../dates.js';
import { shellQuote } from '../deliver.js';
import { gitRoot, isTracked } from '../git.js';
import { publicTitleTooLong } from '../news.js';
import { type Lot, Plan, RafError } from '../plan.js';

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Avis qui ne sont pas des erreurs (plan hérité, L246) ; absent : `err`. `session --all` y met la vraie sortie d'erreur, pas sa sortie standard. */
  notice?: (line: string) => void;
  now: () => Date;
  /** Entrée standard, lue en entier (hook pre-push, L405) ; absent : le descripteur 0. */
  stdin?: () => string;
}

/** Les options de la ligne de commande, toutes commandes confondues : une option n'a de sens que pour certaines, chaque commande lit les siennes. */
const OPTIONS = {
    file: { type: 'string' },
    project: { type: 'string' },
    prefix: { type: 'string' },
    'no-hook': { type: 'boolean' },
    estimate: { type: 'string' },
    quickwin: { type: 'boolean' },
    visible: { type: 'boolean' },
    screen: { type: 'string' },
    spec: { type: 'boolean' },
    local: { type: 'boolean' },
    public: { type: 'string' },
    every: { type: 'string' },
    dir: { type: 'string' },
    title: { type: 'string' },
    after: { type: 'string' },
    uses: { type: 'string' },
    set: { type: 'string', multiple: true },
    parent: { type: 'string' },
    id: { type: 'string' },
    under: { type: 'string' },
    force: { type: 'boolean' },
    back: { type: 'boolean' },
    reason: { type: 'string' },
    porteur: { type: 'string' },
    status: { type: 'string' },
    since: { type: 'string' },
    before: { type: 'string' },
    idle: { type: 'string' },
    ttl: { type: 'string' },
    session: { type: 'string' },
    all: { type: 'boolean' },
    depth: { type: 'string' },
    output: { type: 'string', short: 'o' },
    config: { type: 'string' },
    'dry-run': { type: 'boolean' },
    sha: { type: 'string' },
    retry: { type: 'string' },
    gate: { type: 'boolean' },
    clear: { type: 'boolean' },
    ignored: { type: 'boolean' },
    notes: { type: 'boolean' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean' },
    classify: { type: 'boolean' },
    model: { type: 'string' },
    cache: { type: 'string' },
    'cache-sous-causes': { type: 'string' },
    sample: { type: 'string' },
    sections: { type: 'string' },
    slug: { type: 'string' },
    quoi: { type: 'string' },
    'sans-rendu': { type: 'boolean' },
    out: { type: 'string' },
    seuil: { type: 'string' },
    'model-b': { type: 'string' },
    double: { type: 'boolean' },
    largeur: { type: 'string' },
    until: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
} as const;

export function parseCli(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
}

export type Values = ReturnType<typeof parseCli>['values'];

/** Ce que toute commande reçoit : la ligne de commande lue, l'horloge et la racine du dépôt. */
export interface EarlyCtx {
  rest: string[];
  values: Values;
  io: Io;
  today: Day;
  root: string;
}

/** Ce que reçoit une commande qui lit le plan : où il est, comment le charger, et les refus communs. */
export interface Ctx extends EarlyCtx {
  command: string;
  configPath: string;
  planConfig: ReturnType<typeof readPlanConfig>;
  planPath: string;
  /** Le plan désigné par --file, RAF_FILE ou plan: ; absent quand le défaut est pris. */
  chosen: string | undefined;
  loadPlan: () => Plan;
  newsDir: string;
  refuseLongTitle: (text: string, hint?: string) => void;
  need: (n: number, usage: string) => void;
}

/** Le contexte d'une commande qui lit le plan : ce que dispatch construit une fois, après les commandes qui n'en ont pas besoin. */
export function buildCtx(base: EarlyCtx & { command: string }): Ctx {
  const { command, rest, values, io, root } = base;
  // cadence.yaml peut dire où est le plan et, s'il est tenu par un autre outil, comment le lire.
  const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
  // Installer les skills ou le hook ne lit pas le plan : un cadence.yaml fautif ne doit pas l'empêcher.
  const installing = command === 'skills' || (command === 'hook' && rest[0] === 'install');
  const planConfig = installing ? null : readPlanConfig(configPath, root);
  // Le défaut (ni --file, ni RAF_FILE, ni plan:) : .cadence/raf.yaml, ou le docs/plan/raf.yaml hérité, dont le déplacement est proposé sur stderr (L246).
  // --file et RAF_FILE se lisent depuis le dossier courant ; le plan: de cadence.yaml, depuis la racine du dépôt où est ce fichier.
  const chosen = values.file ?? io.env.RAF_FILE ?? planConfig?.path;
  const fallback = chosen === undefined ? defaultPlan(root) : null;
  const planPath = resolve(io.cwd, values.file ?? io.env.RAF_FILE ?? (planConfig?.path !== undefined ? resolve(root, planConfig.path) : fallback!.path));
  if (fallback?.legacy && !installing) (io.notice ?? io.err)(legacyPlanLine(root, fallback.legacy));
  const loadPlan = () => Plan.load(planPath, { ...planConfig?.settings, config: configPath });
  const newsDir = resolve(io.cwd, values.dir ?? join(root, 'docs/nouveautes'));
  // Limite DÉCLARÉE (news.publicTitleMax) : sans clé, seul « raf check » avertit ; avec, la pose d'un titre public est refusée.
  const refuseLongTitle = (text: string, hint = '') => {
    const max = readNewsConfig(configPath).publicTitleMax;
    const m = max === undefined ? null : publicTitleTooLong(text, max);
    if (m) throw new RafError(m + hint);
  };
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new RafError(`usage : raf ${usage}`);
  };
  return { ...base, configPath, planConfig, planPath, chosen, loadPlan, newsDir, refuseLongTitle, need };
}

/** `--verbose` (L453) : la ligne `id  état  titre entier` du lot touché par `done`, `ux`, `review`, `note`, `move`, `public` ; sans lui, rien de plus (une sous-tâche n'a pas de ligne). */
export function touchedLot(plan: Plan, id: string, verbose: boolean | undefined, io: Io): void {
  const lot = verbose ? plan.lots().find((l) => l.id === id) : undefined;
  if (lot) io.out(`${lot.id}  ${lot.status}  ${lot.title}`);
}

export function knownLot(plan: Plan, id: string, subtask: string): Lot {
  const lot = plan.lots().find((l) => l.id === id);
  if (!lot) throw new RafError(id.includes('/') ? `${subtask} : ${id}` : `lot inconnu : ${id}`);
  return lot;
}

/** Le plan, relatif à la racine du dépôt git (comme les fichiers d'un commit), séparateurs `/`. */
export function planFileIn(root: string, planPath: string): string {
  return relative(gitRoot(root) ?? root, planPath).split('\\').join('/');
}

/**
 * La ligne stderr d'un docs/plan/raf.yaml hérité : le déplacement proposé (jamais fait), ou l'avertissement quand .cadence/raf.yaml existe aussi.
 * La commande proposée commence par `cd <racine>` : elle s'exécute telle quelle depuis n'importe quel dossier (et non depuis la racine
 * seulement) et, sous `session --all`, elle nomme le projet dont il s'agit.
 */
function legacyPlanLine(root: string, legacy: 'read' | 'ignored'): string {
  if (legacy === 'ignored') return `raf: ${PLAN_LEGACY} est ignoré : ${PLAN_DEFAULT} existe aussi et fait foi (supprimer ou fusionner l'ancien)`;
  return `raf: ${PLAN_LEGACY} est l'ancien emplacement du plan ; le déplacer : cd ${shellQuote(root)} && mkdir -p ${dirname(PLAN_DEFAULT)} && ${gitRoot(root) && isTracked(root, PLAN_LEGACY) ? 'git mv' : 'mv'} ${PLAN_LEGACY} ${PLAN_DEFAULT}`;
}

