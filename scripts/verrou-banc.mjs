// Revue L931 (M4) : le verrou du passage du banc, lu par v2 (bench, qui le pose) et par src (`cadence suivant`, qui saute un dépôt de cadence
// pendant un banc, règle D-3). Une seule lecture du format « pid date boot » et de la racine : une copie dans src aurait cessé de voir le banc
// au premier changement côté v2 (L901 le déplace). JavaScript sans dépendance, comme scripts/arbre-non-commite.mjs ; déclaration : verrou-banc.d.mts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** La racine des bancs : BENCH_ROOT, sinon ~/bench-cadence. */
export const racineBanc = (env) => env.BENCH_ROOT ?? join(env.HOME ?? '', 'bench-cadence');

/** Le fichier du verrou d'un passage, sous la racine. */
export const fichierPassage = (racine) => join(racine, 'passage.lock');

/** L'identifiant de ce démarrage de la machine ('' hors Linux). */
export const bootId = () => {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; }
};

const vivant = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Le contenu d'un verrou (« pid date boot ») tient-il encore ? Un pid mort, ou d'un autre démarrage (pid réutilisé après un redémarrage de WSL), ne tient rien. */
export function tenantVivant(contenu) {
  const [pid, , boot] = contenu.trim().split(' ');
  const ici = bootId();
  if (boot && ici && boot !== ici) return false;
  return vivant(Number(pid));
}

/** Le contenu du verrou du passage en cours sous `racine`, ou null (pas de verrou, illisible, porteur mort). */
export function passageEnCours(racine) {
  let contenu;
  try { contenu = readFileSync(fichierPassage(racine), 'utf8'); } catch { return null; }
  return tenantVivant(contenu) ? contenu.trim() : null;
}
