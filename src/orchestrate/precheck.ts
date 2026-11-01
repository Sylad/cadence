// Les critères du contrôle préalable (L77, L288, L292, L322) : un lot qui cite un constat ou un autre lot, et un lot créé après le dernier commit de code, qui n'a rien à retrouver.
import { relative } from 'node:path';
import { isPlanOnly, lotWork } from '../audit.js';
import type { Plan } from '../plan.js';
import type { LotRepo } from '../repos.js';
import { git } from './worktree.js';

/**
 * Mots du titre ou du goal qui disent que le lot reprend un constat : le livrable peut déjà exister. Mots entiers (« review » ne
 * se lit pas dans `qa-reviewer` ni `review-small`), au pluriel ou accordés pour « constat ».
 */
const CITES_FINDING = /(?<![\w-])(?:constat\w*|revues?|reviews?|audits?)(?![\w-])/i;

/**
 * Le texte du lot (titre, goal, objectif donné) cite un constat, ou un autre lot dont le travail a pu être fait. Pour un lot
 * `L<n>`, « L12 » compte dans le texte de `L30` (aussi dans « L12-L15 », « L12-bis », « L12.3 ») et non celui de `L12` ni d'un lot postérieur ; tout identifiant du plan qui n'est
 * pas `L<n>` (`Q-CAN5`, `B28.1`, `Q4/qa-expectations`) compte cité en entier (`B28.1` n'est pas `B28.10`), pour un lot `L<n>`
 * comme pour un autre ; un lot d'un autre projet (`cadence:L68`) compte toujours.
 */
export function citesPriorWork(text: string, lot: string, ids: string[]): boolean {
  if (CITES_FINDING.test(text)) return true;
  const { ids: cited, foreign } = citedLots(text, lot, ids);
  return foreign || cited.length > 0;
}

/**
 * Les lots que le texte cite (même reconnaissance que `citesPriorWork`, L288/L292) : les identifiants du plan cités, et `foreign` quand il cite un lot d'un autre projet
 * (`cadence:L68`, dont on ne lit pas les commits ici).
 */
function citedLots(text: string, lot: string, ids: string[]): { ids: string[]; foreign: boolean } {
  const foreign = /(?<![\w-])[a-z][\w-]*:L\d+(?!\w)/i.test(text);
  const own = /^L(\d+)$/.exec(lot);
  const cited = (id: string) => new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`).test(text);
  return {
    foreign,
    ids: ids.filter((id) => {
      if (id === lot) return false;
      const n = /^L(\d+)$/.exec(id);
      if (own && n) return Number(n[1]) < Number(own[1]) && new RegExp(`(?<![\\w-])${id}(?!\\w)`).test(text);
      return cited(id);
    }),
  };
}

/**
 * Un lot créé après le dernier commit de code du dépôt n'a rien à retrouver (L322) : tout ce que le dépôt contient date d'avant le lot, donc aucun autre lot ne l'a livré.
 * Rend la raison à écrire au journal, ou null quand le contrôle garde un sens. Le lot est daté par le commit qui a ajouté son id au plan, borné par sa clé `created` (une
 * migration ou un déplacement du plan ne rajeunit pas un vieux lot) ; le dernier commit de code est le dernier qui ne touche pas que le plan (`isPlanOnly`). Prudent : lot
 * qui travaille dans des dépôts voisins, id introuvable dans l'historique du plan, dépôt sans commit de code ou instants égaux → le contrôle reste.
 * Le contrôle reste aussi quand le titre ou le goal (ou le goal donné au lancement) cite un lot qui a déjà ses propres commits, ou un lot d'un autre projet : une « suite de revue L<n> » écrite
 * juste après le dernier correctif de L<n> liste des constats que les passes de correction de L<n> ont pu régler avant la création du lot (rejoué depuis le 24-10 : 5 lots sautés à tort,
 * dont 2 avec un vrai « partiel »).
 */
export function precheckNothingToFind(plan: Plan, root: string, lot: string, repos: LotRepo[] = [], goal?: string): string | null {
  if (repos.length) return null;
  try {
    const rel = relative(root, plan.path);
    const idLine = `^\\s*- id: ["']?${lot.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["']?\\s*$`;
    // Pas de `--reverse` : avec `--follow`, git 2.43 ne rend rien sur un fichier renommé (`raf migrate`) ; le plus ancien est la dernière ligne.
    const added = git(root, '-c', 'core.quotepath=off', 'log', '--follow', '--format=%ct', '-G', idLine, '--', rel).split('\n').filter(Boolean).pop();
    if (!added) return null;
    const created = plan.lot(lot).created;
    const endOfCreated = created ? Date.parse(`${created}T23:59:59`) / 1000 : Infinity;
    const createdAt = Math.min(Number(added), Number.isNaN(endOfCreated) ? Infinity : endOfCreated);
    const log = git(root, 'log', '--format=%H %ct').split('\n').filter(Boolean);
    const code = log.map((x) => x.split(' ')).find(([sha]) => !isPlanOnly(sha!, plan, root));
    if (!code) return null;
    if (createdAt <= Number(code[1])) return null;
    const l = plan.lot(lot);
    const { ids, foreign } = citedLots([l.title, l.goal, goal].filter(Boolean).join('\n'), lot, plan.lots().map((x) => x.id));
    if (foreign || ids.some((id) => lotWork(plan, root, id).length > 0)) return null;
    return `lot créé après le dernier commit de code du dépôt (${code[0]!.slice(0, 7)}) : rien à retrouver`;
  } catch {
    return null;
  }
}

/** Taille permise de la lecture du précheck rangée dans l'état du lot, marqueur compris (L523). */
export const PRECHECK_LU_MAX = 4000;
const PRECHECK_LU_CUT = '[…tronqué]';

/** Ligne du journal quand Sonnet a relu un « oui » du modèle local (L146) : il le confirme ou le contredit. */
export function localYesNote(verdict: 'oui' | 'partiel' | 'non'): string {
  return verdict === 'oui'
    ? 'contrôle préalable : « oui » du modèle local, confirmé par Sonnet'
    : `contrôle préalable : le modèle local a dit « oui », Sonnet dit « ${verdict} » — le local s'est trompé, repasser orchestrate.precheck à true`;
}

/**
 * Range la lecture du précheck (`lu` du rapport, facultatif : `checkShape` ne le contrôle pas) dans `precheckLu` du lot : rognée de ses
 * espaces, coupée à `PRECHECK_LU_MAX` caractères marqueur compris. Rien n'est rangé quand `lu` est absent, vide ou d'espaces ; un `lu`
 * qui n'est pas une chaîne est écarté avec un avertissement.
 */
export function keepPrecheckReading(lot: { precheckLu?: string; warnings: string[] }, lu: unknown): void {
  if (lu === undefined) return;
  if (typeof lu !== 'string') {
    lot.warnings.push('contrôle préalable : champ lu ignoré (mal typé)');
    return;
  }
  const text = lu.trim();
  if (!text) return;
  lot.precheckLu = text.length > PRECHECK_LU_MAX ? `${text.slice(0, PRECHECK_LU_MAX - PRECHECK_LU_CUT.length)}${PRECHECK_LU_CUT}` : text;
}
