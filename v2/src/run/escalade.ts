// L726 : aiguillage de modèle de cadence run (décision de Sylvain du 13-11, garder l'« intelligence » des vagues ; périmètre réduit le 14-11 après L524 :
// le modèle plus petit n'est ni moins cher ni plus rapide à la mesure, aucune branche vers lui). Opus par défaut ; Fable automatiquement à la 3e passe de correction d'un
// lot ou après deux revues non conformes. Les passes et les revues se comptent sur les runs du même lot (`--lot`, états de ../.cadence-run/) et sur la
// revue de code du plan (raf list --json) au lancement : le lead relance un run du lot après une revue non conforme.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSE_FABLE = 3, REVUES_FABLE = 2;
export interface Revue { date: string; verdict: string; commit?: string | null }
/** Ce que l'état d'un run garde pour l'aiguillage (sous-ensemble de Etat, run.ts). */
export interface RunDuLot { id: string; repo: string; lot?: string; etat: string; corrections?: unknown[]; correction_revue?: boolean; revue?: Revue }
/** Une session du run : ce qu'elle a fait, sur quel modèle, et pourquoi ce modèle. */
export interface Passe { quoi: string; modele: string; raison: string }

/** Même règle que isNonConformingVerdict (src/audit.ts, L660) : le verdict COMMENCE par « non conforme » / « not compliant ». */
export const nonConforme = (verdict: string) => /^[^\p{L}\p{N}]*(?:non[\s-]*conforme|not\s+compliant|non[\s-]*compliant)/iu.test(verdict);
const cle = (r: Revue) => `${r.date}|${r.commit ?? ''}|${r.verdict}`;

/** La revue de code du lot dans le plan, lue par raf ; `erreur` si le plan ne se lit pas (le run part quand même, sans la compter). */
export function revueDuPlan(repo: string, lot: string, raf: string): { revue?: Revue; erreur?: string } {
  const r = spawnSync(process.execPath, [raf, 'list', '--json'], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 });
  if (r.status !== 0) return { erreur: `plan illisible (raf list : ${`${r.stderr ?? ''}`.trim().split('\n')[0] || r.error?.message || `code ${r.status}`})` };
  try {
    const l = (JSON.parse(r.stdout) as { id: string; review?: Revue }[]).find((x) => x.id === lot);
    return l ? (l.review ? { revue: l.review } : {}) : { erreur: `lot ${lot} absent du plan` };
  } catch (x) { return { erreur: `plan illisible (raf list : ${(x as Error).message})` }; }
}

/** Les runs précédents du lot dans ce dépôt (états de `dossier`), hors `id`. Un état illisible est ignoré. */
export function runsDuLot(dossier: string, repo: string, lot: string, id: string): RunDuLot[] {
  if (!existsSync(dossier)) return [];
  return readdirSync(dossier).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { return [JSON.parse(readFileSync(join(dossier, f), 'utf8')) as RunDuLot]; } catch { return []; }
  }).filter((e) => e.repo === repo && e.lot === lot && e.id !== id);
}

/** Passes de correction déjà jouées sur le lot : chaque run relancé après un run intégré (correction après revue), plus chaque correction de porte rouge. */
export const correctionsAvant = (runs: RunDuLot[]) => runs.reduce((n, r) => n + (r.correction_revue ? 1 : 0) + (r.corrections?.length ?? 0), 0);

/** Les revues non conformes distinctes du lot : celles qu'ont vues les runs précédents, plus celle du plan au lancement. */
export function revuesNonConformes(runs: RunDuLot[], revue?: Revue): Revue[] {
  const toutes = [...runs.flatMap((r) => (r.revue ? [r.revue] : [])), ...(revue ? [revue] : [])].filter((r) => nonConforme(r.verdict));
  return [...new Map(toutes.map((r) => [cle(r), r])).values()];
}

export interface Depart { modele: string; raison: string; correctionRevue: boolean; correctionsAvant: number; revue?: Revue }
/**
 * Le modèle de la première session. `choisi` : celui de --modele, de CADENCE_RUN_MODELE ou du défaut, avec sa source. Sans lot, rien ne se compte.
 * Un run relancé sur un lot déjà intégré est une passe de correction (après revue) ; à la 3e, ou dès deux revues non conformes, Fable.
 */
export function modeleDeDepart(choisi: { modele: string; raison: string }, lot: string | undefined, runs: RunDuLot[], plan: { revue?: Revue; erreur?: string }): Depart {
  if (!lot) return { ...choisi, correctionRevue: false, correctionsAvant: 0 };
  const correctionRevue = runs.some((r) => r.etat === 'integre'), avant = correctionsAvant(runs);
  const revue = plan.revue && nonConforme(plan.revue.verdict) ? plan.revue : undefined, revues = revuesNonConformes(runs, revue);
  const d = { correctionRevue, correctionsAvant: avant, ...(revue ? { revue } : {}) };
  if (choisi.modele === 'fable') return { ...choisi, ...d };
  if (revues.length >= REVUES_FABLE) return { modele: 'fable', raison: `${revues.length} revues non conformes du lot ${lot} (${revues.map((r) => r.date).join(', ')})`, ...d };
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
