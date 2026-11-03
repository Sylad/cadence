import { isDay } from '../dates.js';
import { RafError } from '../plan.js';
import { parsePriority } from './continue.js';
import type { AnyModel } from './launch.js';
import { resumeCommand } from './table.js';

/** Sessions simultanées, toutes vagues confondues (`--max-sessions`, ou CADENCE_MAX_SESSIONS). */
export const DEFAULT_MAX_SESSIONS = 2;

export interface Args {
  /** Interne (L553) : posé par la reprise, jamais lu de la ligne de commande — les dépôts tenus par une autre vague vivante (la porteuse, par dépôt) où elle n'intègre que ; `execute` n'y prend ni verrou ni garde de push tant que cette vague les tient, et les prend à son compte dès qu'elle les libère (`WaveCtx.claimRepo`). */
  shared?: ReadonlyMap<string, { wave: string; pid: number }>;
  lots: { project?: string; lot: string; model?: AnyModel }[];
  dryRun: boolean;
  status?: string | true;
  /** `--waits` : l'attente de créneau de session par jour et par vague, lue dans les journaux ; `--since` écarte les vagues d'avant. */
  waits: boolean;
  since?: string;
  watch: boolean;
  /** `--status --detail projet:lot` (L441) : le détail d'un lot (choix, propositions, captures…) que le tableau compact de `--status` n'imprime pas. */
  detail?: string;
  /** Secondes entre deux rendus de `--status --watch`. */
  interval?: number;
  resume?: string | true;
  budget?: number;
  /** `--budget projet:lot=+N` (L223) : relève le budget d'un lot rendu sur budget, avec `--resume` ; `text` est le N tel que donné. */
  lotBudgets: { project?: string; lot: string; raise: number; text: string }[];
  /** `--goal "…"` (L258) : l'objectif du seul lot lancé, à la place de son titre dans les briefs. */
  goal?: string;
  maxSessions?: number;
  wave?: string;
  /** `--continue` (L147) : la vague tire elle-même le prochain lot prêt du plan quand ceux en cours sont finis. */
  continue: boolean;
  /** `--until HH:MM` : plus aucun lot n'est tiré à partir de cette heure. */
  until?: string;
  /** `until` en date, lue une fois au lancement (`orchestrate`). */
  untilAt?: Date;
  /** `--priority a,b` : ordre des projets pour le tirage, sinon la clé `priority:` du cadence.yaml du dossier de lancement. */
  priority?: string[];
  answers: { project?: string; lot: string; text: string }[];
  /** `--drop projet:lot` (L79) : retire un lot d'une vague vivante (`--wave` si plusieurs tournent). */
  drop: { project?: string; lot: string }[];
  /** `--stop-after-current` (L79) : la vague vivante finit ses sessions en cours puis s'arrête, reprenable. */
  stopAfterCurrent: boolean;
  /** `--add projet:lot` (L421) : ajoute un lot à une vague vivante (`--wave` si plusieurs tournent) au lieu d'en lancer une seconde, refusée dans le même dépôt. */
  add: { project?: string; lot: string; model?: AnyModel }[];
  /** `--integrate projet:lot` (L279, R27), avec `--resume` : rejoue à l'intégration un lot rendu à cette étape (`next: integrate`) ; ni `--resume` seul ni `--drop`, `--answer`, `--budget` ne le font. `--replay projet:lot` (L279, R26/R27, décision du lead du 24-10) en est la forme générale : elle rejoue aussi un lot rendu sur « écriture de plan refusée » (notes d'hypothèses ou de mineurs de la fiche) à l'étape gardée. */
  integrate: { project?: string; lot: string; replay?: boolean }[];
  /** `--remove-worktree projet:lot` (L279, R20) : retire le worktree et la branche conservés d'un lot ; `--abandon-commits` confirme l'abandon de ses commits non intégrés. */
  removeWorktree?: { project?: string; lot: string };
  abandonCommits: boolean;
}

/** `1500000`, `1.5M`, `800k`. */
export function parseBudget(text: string): number {
  const m = /^(\d+(?:[.,]\d+)?)\s*([kKmM]?)$/.exec(text.trim());
  if (!m) throw new RafError(`--budget invalide : ${text} (1500000, 1.5M, 800k)`);
  const n = Number(m[1].replace(',', '.')) * ({ '': 1, k: 1e3, m: 1e6 }[m[2].toLowerCase() as '' | 'k' | 'm']);
  if (!(n > 0)) throw new RafError(`--budget invalide : ${text}`);
  return Math.round(n);
}

export function parseMaxSessions(text: string, what = '--max-sessions'): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) < 1) throw new RafError(`${what} invalide : ${text} (entier ≥ 1)`);
  return Number(text);
}

// une vague (2026-10-04-1412) n'a ni « : » ni « / » : leur présence désigne un lot, quel que soit son motif (R-M7/ux-1)
export const LOT_LIKE = /^(?:[\w.-]+(?:\/[\w.-]+)*:[\w.-][\w./-]*|[\w.-]+\/[\w./-]*|[A-Za-z]+\d+)(?:@[\w.-]+)?$/;

function lotArg(text: string): { project?: string; lot: string; model?: AnyModel } {
  // le premier « : » sépare le projet du lot, un « @ » final le modèle ; le lot garde ses « / » (L120), le projet peut être un chemin depuis le dossier (`groupe/gamma`, projet imbriqué de lead tour --depth, L201)
  const m = /^(?:([\w.-]+(?:\/[\w.-]+)*):)?([\w.-][\w./-]*?)(?:@([\w.-]+))?$/.exec(text);
  if (!m) throw new RafError(`lot invalide : ${text} (projet:lot, lot, projet:lot@haiku ; @ suivi d'un alias ou d'un nom de modèle)`);
  return { project: m[1], lot: m[2], model: m[3] };
}

/** `projet:lot=+200k`, `lot=+0.3M` (L223) : le « = » distingue le relèvement d'un lot du budget de la vague. */
function lotBudgetArg(text: string): Args['lotBudgets'][number] {
  const bad = () => new RafError(`--budget invalide : ${text} (projet:lot=+500k)`);
  const m = /^([^=]+)=\+(.+)$/.exec(text);
  if (!m) throw bad();
  let target: ReturnType<typeof lotArg>;
  let raise: number;
  try {
    target = lotArg(m[1]);
    raise = parseBudget(m[2]);
  } catch {
    throw bad();
  }
  if (target.model) throw bad();
  return { project: target.project, lot: target.lot, raise, text: m[2] };
}

export function parseOrchestrateArgs(argv: string[]): Args {
  const a: Args = { lots: [], lotBudgets: [], dryRun: false, waits: false, watch: false, continue: false, answers: [], drop: [], stopAfterCurrent: false, add: [], integrate: [], abandonCommits: false };
  const optional = (i: number) => (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') && !LOT_LIKE.test(argv[i + 1]) ? argv[i + 1] : undefined);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const value = (flag: string) => {
      if (argv[i + 1] === undefined) throw new RafError(`${flag} attend une valeur`);
      return argv[++i];
    };
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--status' || t === '--resume') {
      const v = optional(i);
      if (v !== undefined) i++;
      a[t === '--status' ? 'status' : 'resume'] = v ?? true;
    } else if (t === '--waits') a.waits = true;
    else if (t === '--since') {
      a.since = value(t);
      if (!isDay(a.since)) throw new RafError(`--since invalide : ${a.since} (AAAA-MM-JJ)`);
    } else if (t === '--detail') a.detail = value(t);
    else if (t === '--watch') a.watch = true;
    else if (t === '--interval') a.interval = parseMaxSessions(value(t), '--interval');
    else if (t === '--budget') {
      const v = value(t);
      if (v.includes('=')) a.lotBudgets.push(lotBudgetArg(v));
      else a.budget = parseBudget(v);
    }
    else if (t === '--max-sessions') a.maxSessions = parseMaxSessions(value(t));
    else if (t === '--goal') {
      // Un texte oublié ne doit pas avaler l'option suivante (`--goal --dry-run` lancerait une vraie vague payante).
      const next = argv[i + 1];
      if (next?.startsWith('--')) throw new RafError(`--goal attend un texte, pas l'option ${next}`);
      a.goal = value(t).trim();
      if (a.goal === '') throw new RafError('--goal attend un texte non vide');
    } else if (t === '--wave') a.wave = value(t);
    else if (t === '--drop') a.drop.push(lotArg(value(t)));
    else if (t === '--stop-after-current') a.stopAfterCurrent = true;
    else if (t === '--add') a.add.push(lotArg(value(t)));
    else if (t === '--integrate') a.integrate.push(lotArg(value(t)));
    else if (t === '--replay') a.integrate.push({ ...lotArg(value(t)), replay: true });
    else if (t === '--remove-worktree') a.removeWorktree = lotArg(value(t));
    else if (t === '--abandon-commits') a.abandonCommits = true;
    else if (t === '--continue') a.continue = true;
    else if (t === '--until') a.until = value(t);
    else if (t === '--priority') a.priority = parsePriority(value(t));
    else if (t === '--answer') {
      const target = lotArg(value(t));
      a.answers.push({ project: target.project, lot: target.lot, text: value(t) });
    } else if (t.startsWith('-')) throw new RafError(`option inconnue : ${t}`);
    else a.lots.push(lotArg(t));
  }
  // L309 : --wave <id> après un --resume sans valeur désigne la vague à reprendre ; sans cela le --resume reprenait en silence une AUTRE vague.
  if (a.resume !== undefined && a.wave !== undefined) {
    if (a.resume === true) a.resume = a.wave;
    else if (a.resume !== a.wave) throw new RafError(`--resume ${a.resume} et --wave ${a.wave} désignent deux vagues : une seule (${resumeCommand('<vague>')})`);
  }
  return a;
}
