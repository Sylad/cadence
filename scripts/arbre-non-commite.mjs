// L722 : ce que l'arbre principal n'a pas commité au départ d'un run (v2/src/run/run.ts) ou d'une porte (src/verify-gate.ts, via src/repo-held.ts).
// Une seule lecture pour les deux (revue L722 r1 : la copie de v2 aurait divergé au premier changement du filtre). JavaScript sans dépendance,
// comme scripts/qualite.mjs : src et v2 l'importent hors de leur rootDir, sa déclaration est arbre-non-commite.d.mts.
import { spawnSync } from 'node:child_process';

/** Le plan en attente (L695) : jamais suivi, jamais dit comme une modification à commiter. */
export const PLAN_EN_ATTENTE = '.cadence/plan-en-attente.yaml';

/**
 * Les fichiers de l'arbre de `repo` que git voit modifiés, ajoutés, supprimés ou non suivis, hors du plan en attente ; un dossier non suivi est
 * nommé une fois (« dossier/ »), comme le montre git status ; null si git ne répond pas.
 */
export function fichiersNonCommites(repo) {
  // -z : chemins bruts, sans trim qui mangerait l'espace de tête du premier « XY chemin » ( M a.txt) ; sans renommages : l'ancien et le nouveau chemin sont dits.
  const r = spawnSync('git', ['status', '--porcelain', '--no-renames', '-z'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean).map((e) => e.slice(3)).filter((f) => f !== PLAN_EN_ATTENTE);
}

/** La ligne qui nomme ces fichiers ; au-delà de 10, le compte des autres. */
export const nommerFichiers = (f) => (f.length > 10 ? `${f.slice(0, 10).join(', ')} et ${f.length - 10} autre(s)` : f.join(', '));
