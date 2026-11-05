import { type LotCtx, workDir as wd, startSha } from './ctx.js';
import { type Place } from '../gate-place.js';
import { tryGit } from '../../git.js';
import { lotKey } from '../state.js';
import { gateLabel, relatedCommand, runGate, withFiles, type GateRan, type GateTest } from '../gate-parts.js';
import { NO_TEST_RAN } from '../workers.js';
import type { CheckRun } from './checks.js';

/** Ce que joue une porte de tests (L590, R14) : `ciblee` les tests liés aux fichiers du lot (après une écriture), `complete` la suite entière (à l'intégration). */
export type Portee = 'ciblee' | 'complete';

/** Portée de la porte d'une écriture (R16, exception à R1) : la suite complète quand la session annonce des tests rouges (L213, L522 : l'annonce ne se juge que sur la suite entière), ciblée sinon. */
export const porteApresEcriture = (annonceRouge: boolean): Portee => (annonceRouge ? 'complete' : 'ciblee');

/** Les fichiers modifiés du lot entre son sha de départ et HEAD, supprimés exclus ; vide sans sha de départ, sans diff ou si git ne le lit pas (R4). Le dépôt du lot seulement, pas ses dépôts voisins. */
function lotFiles(c: LotCtx): string[] {
  const start = startSha(c);
  const out = start ? tryGit(wd(c), ['diff', '--name-only', '-z', '--diff-filter=d', start, 'HEAD']) : null;
  return out ? out.split('\0').filter(Boolean) : [];
}

/** La porte ciblée d'une écriture : la commande liée (avec `{files}`) et les fichiers du diff ; null quand il n'y a pas de commande liée possible ou de fichier à viser, la suite complète est alors jouée (R4). */
function targetOf(c: LotCtx): { template: string; files: string[] } | null {
  const template = relatedCommand(c.config.test, c.config.testRelated);
  const files = template ? lotFiles(c) : [];
  return template && files.length ? { template, files } : null;
}

type Target = NonNullable<ReturnType<typeof targetOf>>;

/** Joue les tests liés quand la porte est ciblée, que le lot a un worktree (sans lui, aucune intégration ne jouera la suite complète : la porte la joue) et qu'il en a (R1) ; `{ motif }` quand ils ne trouvent aucun test (R3 : la détection de workers.ts, ligne de fin du lanceur avec le code 0) ; `{}` sinon, la suite complète est jouée (R4). */
async function playRelated(c: LotCtx, place: Place, label: 'build' | 'tests', portee: Portee): Promise<{ target: Target; r: GateRan } | { motif?: string }> {
  const target = label === 'tests' && portee === 'ciblee' && c.tree?.active ? targetOf(c) : null;
  if (!target) return {};
  const r = await place.run(withFiles(target.template, target.files));
  if (r.code !== 0 || !NO_TEST_RAN.test(r.output)) return { target, r };
  c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · porte ciblée sans test lié : suite complète jouée`);
  return { motif: 'aucun test lié' };
}

/**
 * Joue la commande `label` d'une porte (L590). Le build, et les tests en portée `complete`, sont joués comme avant (suite entière, `suiteRuns` + 1) ; les tests en portée `ciblee` ne jouent que la commande liée aux fichiers du diff,
 * et la suite complète quand aucun test n'y est lié ou qu'il n'y a pas de commande liée. Chaque porte de tests s'ajoute à `l.portes` avec sa portée, ses fichiers, son code et sa durée.
 * Le CheckRun d'une porte ciblée porte la commande liée et `portee: 'ciblee'` : il n'est jamais le verdict de la suite (R11). `settle` : un rouge de charge que le rejeu seul a absous passe à 0 dans le CheckRun et dans `l.portes`.
 */
export async function playTests(c: LotCtx, place: Place, label: 'build' | 'tests', command: GateTest, portee: Portee): Promise<{ r: GateRan; run: CheckRun; settle: () => void }> {
  const l = c.lot;
  const t0 = Date.now();
  const related = await playRelated(c, place, label, portee);
  const target = 'target' in related ? related.target : null;
  if (!target && label === 'tests') l.suiteRuns = (l.suiteRuns ?? 0) + 1;
  const r: GateRan = 'r' in related ? related.r : await runGate(place.run, command); // porte en parties (L512) : toutes jouées, chacune dans son dossier ; le CheckRun porte le libellé « dir : run ; … »
  const run: CheckRun = { label, command: target ? target.template : gateLabel(command), code: r.code, ...(target ? { portee: 'ciblee' as const } : {}), ...place.stamp() };
  const porte = { portee: target ? ('ciblee' as const) : ('complete' as const), fichiers: target?.files ?? [], code: r.code, duree: Math.round((Date.now() - t0) / 100) / 10, ...('motif' in related && related.motif ? { motif: related.motif } : {}) };
  if (label === 'tests') l.portes = [...(l.portes ?? []), porte];
  return {
    r,
    run,
    settle: () => {
      run.code = 0;
      porte.code = 0;
    },
  };
}
