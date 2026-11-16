// L726 : aiguillage de modèle de cadence run (décision de Sylvain du 13-11, garder l'« intelligence » des vagues ; périmètre réduit le 14-11 après L524 :
// le modèle plus petit n'est ni moins cher ni plus rapide à la mesure, aucune branche vers lui). Opus par défaut ; Fable automatiquement à la 3e passe de correction d'un
// lot ou après deux revues non conformes. Les passes et les revues se comptent sur les runs du même lot (`--lot`, états de ../.cadence-run/) et sur la
// revue de code du plan (raf list --json) au lancement : le lead relance un run du lot après une revue non conforme. L748 : plus les revues du lot mises
// en attente (.cadence/plan-en-attente.yaml) quand un autre programme tenait la branche (vécu 16-11 sur L745 : deux revues comptées pour une).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { PLAN_EN_ATTENTE } from '../../../scripts/arbre-non-commite.mjs';
import { OPTIONS_RAF } from '../../../scripts/options-raf.mjs';

export const PASSE_FABLE = 3;
export const REVUES_FABLE = 2;
/** `en_attente` : lue dans le plan en attente au lancement, pas encore appliquée au plan (L748). */
export interface Revue { date: string; verdict: string; commit?: string | null; en_attente?: boolean }
/** Ce que l'état d'un run garde pour l'aiguillage (sous-ensemble de Etat, run.ts). */
export interface RunDuLot { id: string; repo: string; lot?: string; etat: string; debut?: string; corrections?: unknown[]; correction_revue?: boolean; revue?: Revue }
/** Une session du run : ce qu'elle a fait, sur quel modèle, et pourquoi ce modèle. */
export interface Passe { quoi: string; modele: string; raison: string }

/** Même règle que isNonConformingVerdict (src/audit.ts, L660) : le verdict COMMENCE par « non conforme » / « not compliant ». */
export const nonConforme = (verdict: string) => /^[^\p{L}\p{N}]*(?:non[\s-]*conforme|not\s+compliant|non[\s-]*compliant)/iu.test(verdict);
/** L726 (revue) : une revue est son jour et le commit revu, pas son texte (verdict précisé par raf review). L748 : le commit seul quand il est connu,
 * car une revue en attente, datée de sa mise en attente, peut être appliquée au plan le lendemain ; son commit, figé à la mise en attente, ne change pas. */
const cle = (r: Revue) => (r.commit ? `@${r.commit}` : `${r.date}|`);

/** L748 : la revue qu'écrira un `raf review <lot> <verdict…> --vu <sha|aucun>` mis en attente (format de src/repo-held.ts), ou null. L'argv est celui
 * que raf a reçu : il se lit avec la table d'options de raf (revue L748), sans quoi la valeur d'une option (--file x.yaml) se prendrait pour le lot. */
function revueEnAttente(w: { date: string; argv: string[] }, lot: string): Revue | null {
  const d = new Date(w.date), jour = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
  const { values, positionals } = parseArgs({ args: w.argv, allowPositionals: true, options: OPTIONS_RAF });
  const [cmd, id, ...mots] = positionals, vu = values.vu;
  return cmd === 'review' && id === lot && mots.length ? { date: jour, verdict: mots.join(' '), commit: !vu || vu === 'aucun' ? null : vu, en_attente: true } : null;
}

/** Les `raf review` du lot mises en attente, dans l'ordre ; `erreur` si le fichier ne se lit pas. */
export function revuesEnAttente(repo: string, lot: string): { revues: Revue[]; erreur?: string } {
  const f = join(repo, PLAN_EN_ATTENTE);
  try {
    const tout: unknown = existsSync(f) ? parse(readFileSync(f, 'utf8')) ?? [] : [];
    if (!Array.isArray(tout)) throw new Error('ce n\'est pas une liste');
    return { revues: tout.flatMap((w) => (Array.isArray(w?.argv) && typeof w.date === 'string' ? [revueEnAttente(w, lot) ?? []].flat() : [])) };
  } catch (x) { return { revues: [], erreur: `plan en attente illisible (${PLAN_EN_ATTENTE} : ${(x as Error).message.replace(/\s+/g, ' ').trim()})` }; }
}

/** Les revues du lot au lancement : `revue`, celle qui vaudra une fois l'attente appliquée ; `precedentes`, les non conformes qu'elle remplacera, écrites
 * après la dernière revue conforme (L748). */
export interface RevuesDuPlan { revue?: Revue; precedentes?: Revue[]; erreur?: string }

/** La revue du lot dans le plan, lue par raf, puis celles du plan en attente ; `erreur` si l'un ne se lit pas (le run part quand même, sans le compter). */
export function revueDuPlan(repo: string, lot: string, raf: string): RevuesDuPlan {
  const attente = revuesEnAttente(repo, lot), avec = (p: { revue?: Revue; erreur?: string }): RevuesDuPlan => {
    const toutes = [...(p.revue ? [p.revue] : []), ...attente.revues], erreur = [p.erreur, attente.erreur].filter(Boolean).join(' ; ');
    // Revue L748 : une revue conforme remplace celles d'avant comme au plan (L726) ; seules les non conformes écrites après elle se comptent ici.
    const precedentes = toutes.slice(toutes.reduce((k, r, i) => (nonConforme(r.verdict) ? k : i), -1) + 1, -1);
    return { ...(toutes.length ? { revue: toutes.at(-1) } : {}), ...(precedentes.length ? { precedentes } : {}), ...(erreur ? { erreur } : {}) };
  };
  const r = spawnSync(process.execPath, [raf, 'list', '--json'], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 });
  if (r.status !== 0) return avec({ erreur: `plan illisible (raf list : ${`${r.stderr ?? ''}`.trim().split('\n')[0] || r.error?.message || `code ${r.status}`})` });
  try {
    const l = (JSON.parse(r.stdout) as { id: string; review?: Revue }[]).find((x) => x.id === lot);
    return avec(l ? (l.review ? { revue: l.review } : {}) : { erreur: `lot ${lot} absent du plan` });
  } catch (x) { return avec({ erreur: `plan illisible (raf list : ${(x as Error).message.replace(/\s+/g, ' ').trim()})` }); } // sur une ligne : elle va à la ligne de lancement
}

/** Les runs précédents du lot dans ce dépôt (états de `dossier`), hors `id`. Un état illisible est ignoré. */
export function runsDuLot(dossier: string, repo: string, lot: string, id: string): RunDuLot[] {
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { return [JSON.parse(readFileSync(join(dossier, f), 'utf8')) as RunDuLot]; } catch { return []; }
  }).filter((e) => e.repo === repo && e.lot === lot && e.id !== id);
}

/** Passes de correction déjà jouées sur le lot : chaque run relancé sur une revue non conforme neuve (correction après revue), plus chaque correction de porte rouge. */
export const correctionsAvant = (runs: RunDuLot[]) => runs.reduce((n, r) => n + (r.correction_revue ? 1 : 0) + (r.corrections?.length ?? 0), 0);

/** Les revues non conformes distinctes du lot : celles qu'ont vues les runs précédents, plus celles du plan et du plan en attente au lancement. */
export function revuesNonConformes(runs: RunDuLot[], revue?: Revue, precedentes: Revue[] = []): Revue[] {
  const toutes = [...runs.flatMap((r) => (r.revue ? [r.revue] : [])), ...precedentes, ...(revue ? [revue] : [])].filter((r) => nonConforme(r.verdict));
  return [...new Map(toutes.map((r) => [cle(r), r])).values()];
}

/**
 * L726 (revue) : le run corrige après revue si la revue non conforme du plan est postérieure au dernier run intégré du lot, c'est-à-dire qu'aucun run
 * lancé jusqu'à lui ne l'a vue. Un lot livré en plusieurs runs sans revue, ou relancé sur une revue déjà traitée, n'est pas une correction.
 */
export function revueApresIntegre(runs: RunDuLot[], revue?: Revue): boolean {
  const integre = runs.filter((r) => r.etat === 'integre').map((r) => r.debut ?? '').sort().at(-1);
  if (!revue || integre === undefined) return false;
  return !runs.some((r) => (r.debut ?? '') <= integre && r.revue && cle(r.revue) === cle(revue));
}

export interface Depart { modele: string; raison: string; correctionRevue: boolean; correctionsAvant: number; revue?: Revue }
/**
 * Le modèle de la première session. `choisi` : celui de --modele, de CADENCE_RUN_MODELE ou du défaut, avec sa source. Sans lot, rien ne se compte.
 * Un run relancé sur une revue non conforme postérieure au dernier run intégré du lot est une passe de correction (après revue) ; à la 3e, ou dès deux
 * revues non conformes, Fable.
 */
export function modeleDeDepart(choisi: { modele: string; raison: string }, lot: string | undefined, runs: RunDuLot[], plan: RevuesDuPlan): Depart {
  if (!lot) return { ...choisi, correctionRevue: false, correctionsAvant: 0 };
  const revue = plan.revue && nonConforme(plan.revue.verdict) ? plan.revue : undefined;
  const correctionRevue = revueApresIntegre(runs, revue);
  const avant = correctionsAvant(runs);
  const revues = revuesNonConformes(runs, revue, plan.precedentes);
  const d = { correctionRevue, correctionsAvant: avant, ...(revue ? { revue } : {}) };
  if (choisi.modele === 'fable') return { ...choisi, ...d };
  if (revues.length >= REVUES_FABLE) return { modele: 'fable', raison: `${revues.length} revues non conformes du lot ${lot} (${revues.map((r) => `${r.date}${r.en_attente ? ' en attente' : ''}`).join(', ')})`, ...d };
  if (correctionRevue && avant + 1 >= PASSE_FABLE) return { modele: 'fable', raison: `${avant + 1}e passe de correction du lot ${lot}`, ...d };
  const plusDe = plan.erreur ? ` ; revues non comptées : ${plan.erreur}` : '';
  return { ...choisi, raison: `${choisi.raison}${plusDe}`, ...d };
}

/** Le numéro, parmi les passes de correction du lot, de la dernière correction de porte rouge ouverte (ou de la correction après revue s'il n'y en a pas). */
export const numeroCorrection = (e: { corrections_avant?: number; correction_revue?: boolean; corrections?: unknown[] }) =>
  (e.corrections_avant ?? 0) + (e.correction_revue ? 1 : 0) + (e.corrections?.length ?? 0);

const Nom = (m: string) => `${m[0].toUpperCase()}${m.slice(1)}`;
/** « Fable (3e passe de correction du lot L12) » */
export const modeleDit = (modele: string, raison: string) => `${Nom(modele)} (${raison})`;
/** La ligne du rapport : chaque passe, son modèle et pourquoi. */
export const lignePasses = (passes: Passe[]) => `modèles : ${passes.map((p) => `${p.quoi} : ${modeleDit(p.modele, p.raison)}`).join(' · ')}`;
