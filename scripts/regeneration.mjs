// La clé `run.regenerate` de cadence.yaml (L781, revue r1) : les commandes de régénération que `cadence run` joue avant sa porte, déclarées par le
// projet, jamais devinées d'un nom de script (la 1re version lisait `scripts.news` du package.json racine : warhammer40k et cinq autres dépôts, qui
// déclarent `news` dans frontend/, n'avaient rien ; un projet dont `news` fait autre chose l'aurait vu joué). Lue avec le même code par cadence run
// (v2/src/run/regenerer.ts) et par la validation de cadence.yaml (src/config.ts, readRunConfig) : un fichier que l'une accepte, l'autre l'accepte.
// JavaScript sans dépendance, comme scripts/references.mjs : src et v2 l'importent hors de leur rootDir. Il lit la valeur déjà analysée (pas de yaml ici).

const FORME = 'run: { purgeAfterDays: <jours>, worktreeOutside: <true|false>, regenerate: [{ command: <commande>, dir: <dossier du dépôt> }], fastGate: <true|{ command, dir, full }> }';
const CLES_RUN = ['purgeAfterDays', 'worktreeOutside', 'regenerate', 'fastGate']; // les clés de run: lues ailleurs : v2/src/run/purger.ts, v2/src/socle.ts ; fastGate : scripts/porte-rapide.mjs (L838)
const estObjet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texte = (v) => typeof v === 'string' && v.trim() !== '';

/** Un dossier relatif au dépôt, sans sortie par « .. » ; « . » est la racine. */
function dossier(v, ou) {
  if (!texte(v)) throw new Error(`${ou} : dossier relatif au dépôt attendu`);
  const d = v.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  if (d.startsWith('/') || /^[A-Za-z]:/.test(d) || d.startsWith('~') || d.split('/').includes('..'))
    throw new Error(`${ou} : « ${v} » sort du dépôt (dossier relatif au dépôt attendu, sans « .. »)`);
  return d;
}

/**
 * `valeur` : ce que le YAML donne sous `run:` (undefined ou null quand la clé manque). Rend la liste { command, dir } de `run.regenerate`, vide
 * sans la clé ; une forme mal formée lève une Error dont le message commence par `fichier : ` et nomme la clé fautive.
 */
export function lireRegeneration(valeur, fichier) {
  if (valeur == null) return [];
  try {
    if (!estObjet(valeur)) throw new Error(`run doit être un objet ${FORME}`);
    for (const k of Object.keys(valeur)) if (!CLES_RUN.includes(k)) throw new Error(`run.${k} inconnu (attendu : ${CLES_RUN.join(', ')})`);
    const r = valeur.regenerate;
    if (r == null) return [];
    if (!Array.isArray(r) || r.length === 0) throw new Error('run.regenerate : liste non vide de { command, dir } attendue');
    return r.map((e, i) => {
      const ou = `run.regenerate[${i}]`;
      if (!estObjet(e)) throw new Error(`${ou} : objet { command, dir } attendu`);
      for (const k of Object.keys(e)) if (k !== 'command' && k !== 'dir') throw new Error(`${ou}.${k} inconnu (attendu : command, dir)`);
      if (!texte(e.command)) throw new Error(`${ou}.command : commande non vide attendue`);
      return { command: e.command.trim(), dir: e.dir == null ? '.' : dossier(e.dir, `${ou}.dir`) };
    });
  } catch (e) {
    throw new Error(`${fichier} : ${e.message}`);
  }
}
