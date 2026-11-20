// L792 (issue #68) : le brief de cadence run (v2/src/run/run.ts) nomme les commandes de vérification du projet quand le travail touche des fiches d'écran.
// Le 19-11, une session chargée d'amener des fiches à « fiche valide » n'a jamais lancé `cadence spec check` (le brief n'en disait rien et interdisait
// `cadence`), a reconstruit les règles depuis git et s'est crue à 0 écart : 97 restaient. Cause : découverte. Le brief nomme donc la commande, et la session
// peut la lancer (interdiction de `cadence` levée pour `cadence spec check|qa` seules). Générique : tout est lu dans la clé `orchestrate` de cadence.yaml
// (spec.dir, build, test, accept), rien n'est propre à un projet. Le run ne juge rien contre une fiche : il dit à la session quelle commande le fait.
// JavaScript sans dépendance, comme scripts/etapes-porte.mjs : v2 l'importe hors de son rootDir.
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { lireEtapes } from './etapes-porte.mjs';

/** Les outils de bin/cadence.js qu'une session de run ne lance jamais ; `spec` n'y est pas : ses verbes du lead (green, reseal) sont interdits un à un. */
export const OUTILS_CADENCE = ['run', 'sondes', 'raf', 'news', 'session', 'deliver', 'verify', 'eval', 'skills', 'orchestrate', 'lead', 'corrections', 'perf',
  'cost', 'inspect', 'ref', 'config', 'release', 'local', 'claude-hook'];
const SPEC_DU_LEAD = ['green', 'reseal'];

/** orchestrate.spec.dir (défaut docs/specs, comme src/config.ts) ; une valeur que src/config.ts refuserait garde le défaut. */
function dossierSpecs(o) {
  const d = typeof o.spec?.dir === 'string' ? o.spec.dir.trim().replace(/\/+$/, '') : '';
  return d && !isAbsolute(d) && !d.split(/[\\/]/).includes('..') ? d : 'docs/specs';
}
/** Le nombre de fiches `<dir>/<écran>/fiche.yaml` présentes. */
const fichesPresentes = (repo, dir) => (existsSync(join(repo, dir))
  ? readdirSync(join(repo, dir), { withFileTypes: true }).filter((x) => x.isDirectory() && existsSync(join(repo, dir, x.name, 'fiche.yaml'))).length
  : 0);
const plat = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** La demande parle de fiches (d'écran, back, mixtes, valides, fiche.yaml, spec check). */
export const demandeToucheFiches = (demande) => /fiches? (d['’]ecrans?|back|mixtes?|valides?)|fiche\.yaml|spec check/.test(plat(demande));
const code = (cs) => cs.map((c) => `\`${c}\``).join(', puis ');

/**
 * Le paragraphe du brief (`texte`, vide quand ni la demande ni le dépôt n'ont de fiches) et s'il nomme `cadence spec check` (`nommeSpec`).
 * `orchestrate` : la clé de cadence.yaml du worktree du run, déjà lue.
 */
export function commandesNommees(repo, orchestrate, demande) {
  const o = orchestrate ?? {}, dir = dossierSpecs(o), n = fichesPresentes(repo, dir);
  if (!n && !demandeToucheFiches(demande)) return { texte: '', nommeSpec: false };
  const lignes = [
    `- Fiches d'écran (\`${dir}/<écran>/fiche.yaml\`, ${n ? `${n} dans le dépôt` : 'aucune encore'}) : \`cadence spec check <fiche.yaml>\`, une fiche par appel ; `
    + 'code 0 et son résumé quand elle est valide, sinon une ligne « ✗ … » par écart et code 1. '
    + `Toutes : \`for f in ${dir}/*/fiche.yaml; do cadence spec check "$f"; done\`. C'est la seule commande \`cadence\` permise dans cette session.`,
  ];
  const etapes = lireEtapes(o);
  for (const e of etapes.etapes ?? []) lignes.push(`- ${e.nom === 'build' ? 'Build (orchestrate.build)' : 'Tests (orchestrate.test)'} : ${code(e.commandes)}.`);
  const accept = (typeof o.accept === 'string' ? [o.accept] : Array.isArray(o.accept) ? o.accept : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (accept.length) lignes.push(`- Tests d'acceptation (orchestrate.accept) : ${code(accept)} ; ils ne lancent que les tests listés par \`CADENCE_ACCEPTATION\` `
    + `(chemin de \`${dir}/<écran>/acceptation-<lot>.json\`, aussi substitué à \`{acceptation}\`).`);
  const tete = 'Vérifications du projet (lues dans cadence.yaml) : lance-les toi-même et fie-toi à leur sortie, jamais à une relecture des règles '
    + '(code, historique git) ; ne dis pas qu\'une fiche est valide tant que `cadence spec check` ne l\'a pas dit.';
  return { texte: `${[tete, ...lignes].join('\n')}\n\n`, nommeSpec: true };
}

/** La ligne « N'utilise ni raf ni cadence » des briefs, avec l'exception de `cadence spec check`. */
export const leverPourSpec = (brief) =>
  brief.replaceAll("N'utilise ni `raf` ni `cadence`", "N'utilise ni `raf` ni `cadence` (seule exception : `cadence spec check`, nommée dans les vérifications plus haut)");

/** Les interdits de la session : `Bash(cadence:*)` remplacé par chaque outil de cadence sauf `cadence spec check|qa`. */
export const interditsPourSpec = (interdits) => interdits.flatMap((x) => (x === 'Bash(cadence:*)'
  ? [...OUTILS_CADENCE.map((t) => `Bash(cadence ${t}:*)`), ...SPEC_DU_LEAD.map((v) => `Bash(cadence spec ${v}:*)`)] : [x]));
