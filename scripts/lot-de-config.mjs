// La règle des lots « config: true » (L586), commune aux cliquets de scripts/qualite.mjs et de scripts/analyse.mjs (L801) : un seuil, une exclusion ou
// l'identité d'un outil ne se change pas dans un lot jugé par eux ; seul un lot que le plan du départ déclare `config: true` le peut, et il ne touche alors
// que les configs. Chaque cliquet dit ce qu'il juge par un `jeu` (configChangee) ; la lecture du plan, des commits et des fichiers est ici, une seule fois.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Les plans que cadence lit par défaut (un plan tenu par un autre outil, `plan:` de cadence.yaml, n'est pas cherché : le lot n'y est pas de config).
const PLANS = ['.cadence/raf.yaml', 'docs/plan/raf.yaml'];

/** Vrai si le départ a un plan natif (l'un de PLANS) : sans lui aucun lot ne peut être `config: true`, et scripts/analyse.mjs ouvre sa voie déclarée (L801 r3, M3). */
export const planNatif = (config) => PLANS.some((f) => config(f) !== null);

/**
 * Les ids des lots que le plan du point de départ déclare `config: true`. Lu au départ, pas dans l'arbre : un lot ne se déclare pas lui-même
 * exempté. Vide sans plan.
 */
export function lotsDeConfig(config) {
  const texte = PLANS.map((f) => config(f)).find((t) => t !== null);
  const lots = new Set();
  if (!texte) return lots;
  // le bloc d'un lot : de sa ligne « - id: » à la suivante ; ses clés sont indentées de 4 espaces
  let courant = null;
  for (const l of texte.split('\n')) {
    const id = /^  - id:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(l);
    if (id) courant = id[1];
    else if (courant && /^    config:\s*true\s*(#.*)?$/.test(l)) lots.add(courant);
  }
  return lots;
}

// Ce qu'un lot de config peut toucher : les configs comparées (`jeu.estConfig`, qui dit aussi la base de son cliquet), leurs tests, et ce que tout lot touche
// (plan, CHANGELOG, docs) ; dans changelog.d/, SON fragment seulement (L679, L770) : changelog.d/<id>.md, ou changelog.d/<id en « __ »>.md pour un id à « / »
const estTest = (f) => /^tests?\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const estComptabilite = (f) => f === 'CHANGELOG.md' || f.startsWith('.cadence/') || f.startsWith('docs/');
const fragmentDe = (ids, f) => ids.some((id) => f === `changelog.d/${id}.md` || f === `changelog.d/${id.split('/').join('__')}.md`);
const horsConfig = (ids, config) => (f) => !config(f) && !estTest(f) && !estComptabilite(f) && !fragmentDe(ids, f);

export const lireSiPresent = (racine, f) => (existsSync(join(racine, f)) ? readFileSync(join(racine, f), 'utf8') : null);
const etat = (depart, actuel) => (depart === null ? 'nouveau' : actuel === null ? 'supprimé' : 'modifié');

// les libellés « fichier (nouveau|supprimé|modifié) » des couples (nom, départ, actuel) qui diffèrent
export const differences = (couples) => couples.filter(([, depart, actuel]) => depart !== actuel).map(([nom, depart, actuel]) => `${nom} (${etat(depart, actuel)})`);

// Les commits dont le scope (`feat(L1,L2): …`) ne cite que des lots déclarés de config au plan du départ : à la porte d'intégration, qui ne porte pas le nom d'un lot, c'est eux qui portent la config
const lotsCites = (c) => /^[^(:]*\(([^)]+)\)/.exec(c.sujet)?.[1].split(',').map((i) => i.trim()) ?? [];
const estDeConfig = (c, ref) => lotsCites(c).length > 0 && lotsCites(c).every((id) => ref.lotsConfig?.has(id));

// Vrai si le libellé « fichier (état) » d'une config changée n'est dû qu'à des commits de lots de config (au moins un) : un commit de code qui y touche, ou un arbre sale, la laisse refusée
function deLotsDeConfig(libelle, commits, ref) {
  const fichier = /^(.*?)(#\S*)? \([^()]*\)$/.exec(libelle)[1];
  const touchants = commits.filter((c) => c.fichiers.includes(fichier));
  return touchants.length > 0 && touchants.every((c) => estDeConfig(c, ref));
}

/**
 * Refus (code 1) si une config que les outils lisent diffère de celle du point de départ du lot (apparue, disparue ou modifiée), null sinon. `jeu` dit ce
 * qu'un cliquet juge (scripts/qualite.mjs et scripts/analyse.mjs ont chacun le leur) : `actif`, `changees()` (les libellés « fichier[#clé] (état) » qui diffèrent du départ),
 * `estConfig(f)` (ce qu'un lot « config: true » peut toucher, avec les tests et la comptabilité) et `raison` (la fin du refus).
 */
export function configChangee(racine, ref, jeu) {
  if (!ref?.config || !jeu.actif) return null;
  // un lot déclaré de config au plan (L586) peut changer les configs, à condition de ne rien toucher d'autre ; les autres mesures le jugent toujours
  if (ref.lotConfig) {
    const hors = (ref.touches?.() ?? []).filter(horsConfig([ref.lotConfig], jeu.estConfig));
    return hors.length ? { code: 1, texte: `${hors.join(', ')} : un lot déclaré « config: true » au plan ne touche que les fichiers de config et leurs tests (le reste est du code : un autre lot).` } : null;
  }
  const commits = ref.commits?.() ?? [];
  const changees = jeu.changees().filter((libelle) => !deLotsDeConfig(libelle, commits, ref));
  const hors = commits.filter((c) => estDeConfig(c, ref)).flatMap((c) => c.fichiers.filter(horsConfig(lotsCites(c), jeu.estConfig)));
  if (hors.length) return { code: 1, texte: `${[...new Set(hors)].join(', ')} : un lot déclaré « config: true » au plan ne touche que les fichiers de config et leurs tests (le reste est du code : un autre lot).` };
  if (!changees.length) return null;
  return { code: 1, texte: `${changees.join(', ')} diffère(nt) de ${ref.nom} : ${jeu.raison}.` };
}

/** Les libellés « fichier (nouveau|supprimé|modifié) » des fichiers qui diffèrent du départ (`ref.config`), pour un `jeu` de configChangee. */
export const fichiersDifferents = (racine, ref, fichiers) => differences(fichiers.map((f) => [f, ref.config(f), lireSiPresent(racine, f)]));

/**
 * Le lot de config qui peut faire monter la base (L824), null sinon : sur sa branche, le lot que le plan du départ déclare `config: true` (`ref.lotConfig`) ;
 * sans nom de lot (porte d'un run, porte d'intégration), quand CHAQUE commit depuis le départ, hors ceux qui ne touchent que le plan (`.cadence/`), ne cite
 * que des lots `config: true` et que rien d'autre que la base (`baseline`) n'est hors commit. Un commit de code dans l'intervalle ferme la voie : la mesure du sommet
 * porterait son code, et la base « exacte » le figerait.
 */
export function lotDeConfigQuiMonte(ref, baseline) {
  if (!ref?.base) return null;
  if (ref.lotConfig) return ref.lotConfig;
  const commits = (ref.commits?.() ?? []).filter((c) => !c.fichiers.every((f) => f.startsWith('.cadence/')));
  if (!commits.length || !commits.every((c) => estDeConfig(c, ref))) return null;
  if (!ref.nonCommites || ref.nonCommites().some((f) => f !== baseline)) return null;
  return [...new Set(commits.flatMap(lotsCites))].join(', ');
}

/** Les clés où la base diffère de la mesure (présente d'un seul côté, ou d'une autre valeur) : vide quand la base EST la mesure, clé par clé. */
export const ecartsALaMesure = (base, mesure) => [...new Set([...Object.keys(base), ...Object.keys(mesure)])].sort()
  .filter((cle) => base[cle] !== mesure[cle]).map((cle) => ({ cle, avant: base[cle] ?? 'absente', apres: mesure[cle] ?? 'absente' }));
