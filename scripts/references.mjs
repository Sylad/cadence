// La clé `references:` de cadence.yaml, lue par ses deux commandes avec le même code (L760) : `cadence ref` y prend `dir` (src/config.ts,
// readReferencesConfig) et `cadence run` y prend `run`, la liste de { mots, docs } de son aiguillage (v2/src/run/aiguillage.ts). Avant L760, chacune
// attendait sa propre forme (un objet { dir } pour l'une, une liste pour l'autre) : un même cadence.yaml ne pouvait servir les deux (vu le 16-11).
// JavaScript sans dépendance, comme scripts/options-raf.mjs : src et v2 l'importent hors de leur rootDir. Il lit la valeur déjà analysée (pas de yaml ici).

const FORME = 'references: { dir: <dossier>, run: [{ mots: [...], docs: [...] }] }';
/** Le message de migration de l'ancienne forme de cadence run (une liste directement sous `references:`). */
export const MIGRATION_REFERENCES = 'references en liste (ancienne forme de cadence run) : lue comme references.run ; '
  + 'écrire « references:\\n  run:\\n    - { mots: [...], docs: [...] } » (docs/config.md#references-cadence-ref-and-cadence-run)';

const estObjet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texte = (v) => typeof v === 'string' && v.trim() !== '';

/** Une liste de textes non vides, ou une erreur qui nomme le chemin. */
function textes(v, ou) {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${ou} : liste non vide de textes attendue`);
  v.forEach((x, i) => { if (!texte(x)) throw new Error(`${ou}[${i}] : texte non vide attendu`); });
  return v.map((x) => x.trim());
}

function entrees(v, ou) {
  if (!Array.isArray(v)) throw new Error(`${ou} : liste de { mots: [...], docs: [...] } attendue`);
  return v.map((r, i) => {
    if (!estObjet(r)) throw new Error(`${ou}[${i}] : objet { mots: [...], docs: [...] } attendu`);
    for (const k of Object.keys(r)) if (k !== 'mots' && k !== 'docs') throw new Error(`${ou}[${i}].${k} inconnu (attendu : mots, docs)`);
    return { mots: textes(r.mots, `${ou}[${i}].mots`), docs: textes(r.docs, `${ou}[${i}].docs`) };
  });
}

/**
 * `valeur` : ce que le YAML donne sous `references:` (undefined ou null quand la clé manque). Rend { dir?, run, migration? } ; une forme mal formée lève
 * une Error dont le message commence par `fichier : ` et nomme la clé fautive. L'ancienne forme (une liste) est acceptée et rend `migration`, à dire à l'utilisateur.
 */
export function lireReferences(valeur, fichier) {
  const ko = (m) => new Error(`${fichier} : ${m}`);
  if (valeur == null) return { run: [] };
  try {
    if (Array.isArray(valeur)) return { run: entrees(valeur, 'references'), migration: MIGRATION_REFERENCES };
    if (!estObjet(valeur)) throw new Error(`references doit être un objet ${FORME}`);
    for (const k of Object.keys(valeur)) if (k !== 'dir' && k !== 'run') throw new Error(`references.${k} inconnu (attendu : dir, run)`);
    const r = { run: valeur.run == null ? [] : entrees(valeur.run, 'references.run') };
    if (valeur.dir != null) {
      if (!texte(valeur.dir)) throw new Error('references.dir : chemin attendu');
      r.dir = valeur.dir.trim();
    }
    return r;
  } catch (e) {
    throw ko(e.message);
  }
}
