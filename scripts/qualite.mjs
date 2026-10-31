// Garde-fous de qualité du code (L462) : mesure (ESLint + typescript-eslint + sonarjs, knip, jscpd) et cliquet.
// Le cliquet compare la mesure à qualite-baseline.json : l'existant passe, rien ne peut empirer, ce qui baisse se fige.
// Lancé par `npm run qualite` (porte orchestrate.build et CI) ; la recette est dans docs/qualite.md.
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE = 'qualite-baseline.json';

/** Où lire le chiffre d'une règle ESLint dans son message (« Maximum allowed is 400 » donne le seuil, pas la mesure). */
const MESURE = {
  'max-lines': /too many lines \((\d+)\)/,
  'max-lines-per-function': /too many lines \((\d+)\)/,
  'max-params': /too many parameters \((\d+)\)/,
  'max-depth': /nested too deeply \((\d+)\)/,
  complexity: /complexity of (\d+)/,
  'sonarjs/cognitive-complexity': /from (\d+) to the/,
};

// une règle sans chiffre dans son message (erreur d'analyse, directive inutile) pèse 1 par occurrence
const chiffre = (regle, message) => {
  const m = MESURE[regle]?.exec(message);
  return m ? Number(m[1]) : 1;
};

const ajouter = (mesure, cle, n) => { mesure[cle] = (mesure[cle] ?? 0) + n; };
const chemin = (racine, fichier) => relative(racine, fichier).split('\\').join('/');

/** Sortie JSON d'ESLint → par fichier et par règle : le nombre de dépassements et la somme des chiffres mesurés (`|total`). */
export function lireEslint(json, racine) {
  const mesure = {};
  for (const f of json) {
    for (const m of f.messages) {
      // ruleId nul : erreur d'analyse, ou directive eslint-disable inutile ; comptée, jamais ignorée
      const regle = m.ruleId ?? 'analyse';
      const base = `eslint|${chemin(racine, f.filePath)}|${regle}`;
      ajouter(mesure, base, 1);
      // la somme, pas le pire : une fonction qui grossit sans dépasser la pire du fichier fait monter le total
      ajouter(mesure, `${base}|total`, chiffre(regle, m.message));
    }
  }
  return mesure;
}

const TYPES_KNIP = ['dependencies', 'devDependencies', 'optionalPeerDependencies', 'unlisted', 'binaries', 'unresolved', 'exports', 'types', 'duplicates', 'catalog'];

/** Sortie JSON de knip → par fichier et par sorte de code mort : le nombre d'éléments. */
export function lireKnip(json, racine) {
  const mesure = {};
  for (const f of json.files ?? []) ajouter(mesure, `knip|${chemin(racine, f)}|files`, 1);
  for (const i of json.issues ?? []) {
    for (const t of TYPES_KNIP) if (i[t]?.length) ajouter(mesure, `knip|${i.file}|${t}`, i[t].length);
    // enumMembers est un objet { enum: [membres] }, pas une liste
    const membres = Object.values(i.enumMembers ?? {}).reduce((n, l) => n + l.length, 0);
    if (membres) ajouter(mesure, `knip|${i.file}|enumMembers`, membres);
  }
  return mesure;
}

/** Rapport JSON de jscpd → par fichier, le nombre de blocs dupliqués qui le touchent et leur total de lignes (`|lignes`). */
export function lireJscpd(rapport) {
  const mesure = {};
  for (const d of rapport.duplicates ?? []) {
    for (const nom of [d.firstFile.name, d.secondFile.name]) {
      ajouter(mesure, `jscpd|${nom}`, 1);
      ajouter(mesure, `jscpd|${nom}|lignes`, d.lines ?? 0);
    }
  }
  return mesure;
}

// Les directives qui éteignent un contrôle au lieu de corriger le code : un fichier qui en gagne une empire, comme pour une règle.
// (ESLint les ignore déjà : eslint.config.mjs pose noInlineConfig ; on les compte aussi, pour que la tentative se voie.)
// Chaque motif exige le commentaire qui porte la directive : le même texte dans une chaîne, une regex ou une phrase n'éteint rien.
const DIRECTIVES = {
  'eslint-disable': /\/[/*][ \t]*eslint-disable/g,
  'jscpd-ignore': /\/[/*][ \t]*jscpd:ignore-(?:start|end)/g,
  'knip-tag': /(?:\/\*\*|^[ \t]*\*)[^\n]*?@(?:public|internal|beta|alpha|alias|lintignore|knipignore)\b/gm,
};

/**
 * Par fichier et par sorte de directive (`directive|fichier|nom`), le nombre d'occurrences — dans les seuls fichiers que
 * l'outil concerné analyse (`perimetres[nom]` : chemins relatifs à `racine`). Une directive dans un fichier qu'ESLint ne
 * lint pas, ou que .jscpd.json ignore, n'éteint rien : elle n'est pas comptée.
 */
export function lireDirectives(racine, perimetres) {
  const mesure = {};
  for (const [nom, re] of Object.entries(DIRECTIVES)) {
    for (const f of new Set(perimetres[nom] ?? [])) {
      const n = readFileSync(join(racine, f), 'utf8').match(re)?.length ?? 0;
      if (n) ajouter(mesure, `directive|${f}|${nom}`, n);
    }
  }
  return mesure;
}

/** Ce qui empire (une clé neuve ou plus haute que la base), ce qui baisse (plus bas ou disparu). */
export function comparer(base, courant) {
  const pires = [];
  const mieux = [];
  for (const cle of new Set([...Object.keys(base), ...Object.keys(courant)])) {
    const avant = base[cle] ?? 0;
    const apres = courant[cle] ?? 0;
    if (apres > avant) pires.push({ cle, avant, apres });
    else if (apres < avant) mieux.push({ cle, avant, apres });
  }
  return { pires, mieux };
}

const cheminDeCle = (cle) => cle.split('|')[1];
// les clés `eslint|fichier|règle` et `jscpd|fichier` comptent des occurrences ; les autres portent le chiffre à additionner
const estCompteur = (cle) => { const p = cle.split('|'); return (p[0] === 'eslint' && p.length === 3) || (p[0] === 'jscpd' && p.length === 2); };

/** Le total de chaque mesure (outil, règle) sur tous les fichiers : ce que la ligne de base pèse en tout. */
function totaux(mesure) {
  const t = {};
  for (const [cle, n] of Object.entries(mesure)) {
    if (estCompteur(cle)) continue;
    const p = cle.split('|');
    ajouter(t, [p[0], ...p.slice(2)].join('|'), n);
  }
  return t;
}

/**
 * Le passage de `avant` à `apres` quand des fichiers ont été déplacés ou découpés : une clé d'un fichier qui existait
 * (`existe(chemin)`) ne peut pas monter, un chemin neuf part libre, mais le total de chaque mesure sur tous les fichiers
 * ne peut pas monter. Rend ce qui empire. Découper un fichier de 3000 lignes en trois de 1000 passe ; en déplacer
 * le défaut dans un fichier qui existait, ou en ajouter, non.
 */
export function comparerMigration(avant, apres, existe) {
  const pires = comparer(avant, Object.fromEntries(Object.entries(apres).filter(([cle]) => existe(cheminDeCle(cle))))).pires;
  const ta = totaux(avant);
  const tb = totaux(apres);
  for (const cle of Object.keys(tb)) if (tb[cle] > (ta[cle] ?? 0)) pires.push({ cle: `${cle} (total, tous fichiers)`, avant: ta[cle] ?? 0, apres: tb[cle] });
  return pires;
}

const trier = (mesure) => Object.fromEntries(Object.entries(mesure).sort(([a], [b]) => (a < b ? -1 : 1)));

export const lireBase = (racine) => JSON.parse(readFileSync(join(racine, BASELINE), 'utf8'));
const ecrireBase = (racine, mesure) => writeFileSync(join(racine, BASELINE), `${JSON.stringify(trier(mesure), null, 2)}\n`);

function lancer(racine, bin, args, accepte) {
  const r = spawnSync(process.execPath, [join(racine, 'node_modules', bin), ...args], { cwd: racine, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // un outil qui plante ne doit jamais passer pour « zéro défaut »
  if (r.error || !accepte.includes(r.status)) throw new Error(`${bin} a échoué (code ${r.status}) : ${r.error?.message ?? r.stderr.slice(0, 500)}`);
  return r.stdout;
}

const lireJson = (racine, f) => JSON.parse(readFileSync(join(racine, f), 'utf8'));

/** Les fichiers que chaque outil a analysés : ESLint et jscpd les listent dans leur sortie, knip se lit dans ses globs `project` moins `ignore`. */
function perimetres(racine, eslint, jscpd) {
  const knip = lireJson(racine, 'knip.json');
  const sources = Object.values(jscpd.statistics?.formats ?? {}).flatMap((f) => Object.keys(f.sources ?? {}));
  return {
    'eslint-disable': eslint.map((f) => chemin(racine, f.filePath)),
    'jscpd-ignore': sources.map((f) => chemin(racine, f)),
    'knip-tag': globSync(knip.project ?? [], { cwd: racine, exclude: [...(knip.ignore ?? []), 'node_modules/**'] }).map((f) => f.split('\\').join('/')),
  };
}

/** Joue les trois outils dans `racine` (qui porte eslint.config.mjs, knip.json et .jscpd.json) et rend la mesure à plat. */
export function mesurer(racine) {
  const eslint = JSON.parse(lancer(racine, 'eslint/bin/eslint.js', ['-f', 'json', '.'], [0, 1]));
  const knip = JSON.parse(lancer(racine, 'knip/bin/knip.js', ['--reporter', 'json'], [0, 1]));
  const sortie = mkdtempSync(join(tmpdir(), 'qualite-jscpd-'));
  try {
    lancer(racine, 'jscpd/bin/jscpd', ['-c', '.jscpd.json', '--output', sortie], [0]);
    const jscpd = lireJson(sortie, 'jscpd-report.json');
    return trier({ ...lireEslint(eslint, racine), ...lireKnip(knip, racine), ...lireJscpd(jscpd), ...lireDirectives(racine, perimetres(racine, eslint, jscpd)) });
  } finally {
    rmSync(sortie, { recursive: true, force: true });
  }
}

/** Le point de départ du lot : au merge-base de HEAD et de `ref`, la ligne de base (null si elle n'y existait pas encore), `existe(chemin)` (vrai pour un fichier qui y était) et `config(chemin)` (son contenu, null s'il n'y était pas). */
export function lireRef(racine, ref) {
  const git = (...args) => spawnSync('git', args, { cwd: racine, encoding: 'utf8' });
  const mb = git('merge-base', 'HEAD', ref);
  if (mb.status !== 0) throw new Error(`référence « ${ref} » introuvable (git merge-base HEAD ${ref}) : ${mb.stderr.trim() || 'pas de dépôt git ?'}`);
  const sha = mb.stdout.trim();
  const show = git('show', `${sha}:${BASELINE}`);
  const existe = (chemin) => git('cat-file', '-e', `${sha}:${chemin}`).status === 0;
  const config = (chemin) => { const r = git('show', `${sha}:${chemin}`); return r.status === 0 ? r.stdout : null; };
  return { nom: `${ref} (${sha.slice(0, 7)})`, base: show.status === 0 ? JSON.parse(show.stdout) : null, existe, config };
}

// Les seuils et les exclusions des trois outils : les relever ferait baisser la mesure sans corriger le code. Tout ce que les
// outils lisent est comparé, pas seulement le fichier que ce dépôt utilise : ESLint 9 charge eslint.config.js AVANT .mjs, knip
// lit huit noms et package.json#knip, jscpd lit package.json#jscpd, et knip comme jscpd respectent .gitignore.
const CONFIGS = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((e) => `eslint.config.${e}`),
  'knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc', 'knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js',
  '.jscpd.json',
  '.gitignore',
];
const CLES_PACKAGE = ['knip', 'jscpd'];

// la valeur d'une clé de package.json, sérialisée pour la comparer ; null si le fichier manque, est illisible ou n'a pas la clé
const section = (texte, cle) => {
  if (texte === null) return null;
  try { const v = JSON.parse(texte)[cle]; return v === undefined ? null : JSON.stringify(v); } catch { return null; }
};

const lireSiPresent = (racine, f) => (existsSync(join(racine, f)) ? readFileSync(join(racine, f), 'utf8') : null);
const etat = (depart, actuel) => (depart === null ? 'nouveau' : actuel === null ? 'supprimé' : 'modifié');

// les libellés « fichier (nouveau|supprimé|modifié) » des couples (nom, départ, actuel) qui diffèrent
const differences = (couples) => couples.filter(([, depart, actuel]) => depart !== actuel).map(([nom, depart, actuel]) => `${nom} (${etat(depart, actuel)})`);

const fichiersChanges = (racine, ref) => differences(CONFIGS.map((f) => [f, ref.config(f), lireSiPresent(racine, f)]));

function clesPackageChangees(racine, ref) {
  const depart = ref.config('package.json');
  const actuel = lireSiPresent(racine, 'package.json');
  return differences(CLES_PACKAGE.map((cle) => [`package.json#${cle}`, section(depart, cle), section(actuel, cle)]));
}

/** Refus (code 1) si une config que les outils lisent diffère de celle du point de départ du lot (apparue, disparue ou modifiée), null sinon. */
function configChangee(racine, ref) {
  // sans base au départ, rien n'est encore jugé par ces configs : le lot qui adopte les outils les introduit librement
  if (!ref?.config || !ref.base) return null;
  const changees = [...fichiersChanges(racine, ref), ...clesPackageChangees(racine, ref)];
  if (!changees.length) return null;
  return { code: 1, texte: `${changees.join(', ')} diffère(nt) de ${ref.nom} : un seuil ou une exclusion ne se change pas dans un lot qui est jugé par eux (corriger le code ; changer une config est une décision du plan, livrée seule).` };
}

const ligne = ({ cle, avant, apres }) => `  ${cle} : ${avant} → ${apres}`;

const existeAuDepart = (ref) => ref.existe ?? (() => true);

/** La base du lot contre celle du départ : refus (code 1) si elle monte, null sinon. */
function baseRemonte(base, ref) {
  const remonte = ref?.base ? comparerMigration(ref.base, base, existeAuDepart(ref)) : [];
  if (!remonte.length) return null;
  return { code: 1, texte: `${BASELINE} remonte par rapport à ${ref.nom} (elle ne peut que baisser : corriger le code, pas la base) :\n${remonte.map(ligne).join('\n')}` };
}

/** `--migrer` : réécrit la base pour une mesure où des fichiers ont été déplacés ou découpés. */
function migrer(racine, base, mesure, ref) {
  if (!ref) return { code: 2, texte: '--migrer exige --contre <ref> : les fichiers « qui existaient » sont ceux du point de départ du lot.' };
  const empire = comparerMigration(base, mesure, existeAuDepart(ref));
  if (empire.length) return { code: 1, texte: `Qualité : la migration empire ${empire.length} mesure(s) (ni un fichier qui existait ni le total ne peuvent monter) :\n${empire.map(ligne).join('\n')}` };
  ecrireBase(racine, mesure);
  return { code: 0, texte: `${BASELINE} migrée : ${Object.keys(mesure).length} mesures, aucun total en hausse.` };
}

/** Refus (code 1) qui nomme ce qui empire ; sans base au point de départ, il propose la voie d'amorçage plutôt que de corriger le code des autres. */
function empire(pires, ref) {
  // la base locale date d'alors d'avant les commits de main : --init --contre la re-mesure (docs/qualite.md)
  const voie = ref && !ref.base ? `\n${ref.nom} n'a pas encore de ${BASELINE} : si ces hausses viennent de ses commits (merge ou rebase), « node scripts/qualite.mjs --init --contre ${ref.nom.split(' ')[0]} » re-mesure la base au sommet courant.` : '';
  return { code: 1, texte: `Qualité : ${pires.length} mesure(s) empirent (rien ne peut empirer, un fichier touché ne peut que baisser) :\n${pires.map(ligne).join('\n')}${voie}` };
}

/**
 * Compare la mesure à la base. mode : 'verifier' (défaut), 'init' (crée la base), 'ecrire' (la baisse) ou 'migrer'
 * (réécrit la base après un déplacement ou un découpage de fichiers, voir comparerMigration ; exige `ref`). Rend { code, texte }.
 * `ref` (voir lireRef) : la base du point de départ du lot ; la base du lot ne peut pas la dépasser, sinon une session
 * « réparerait » la base au lieu du code et la porte comme la CI resteraient vertes.
 */
export function appliquer(racine, mode, mesure = mesurer(racine), ref = null) {
  const existe = existsSync(join(racine, BASELINE));
  const config = configChangee(racine, ref);
  if (config) return config;
  if (mode === 'init') {
    if (ref?.base) return { code: 2, texte: `${BASELINE} existe déjà dans ${ref.nom} : --init ne la recrée pas (elle ne peut que baisser, utiliser --ecrire).` };
    // sans base au départ (main n'en a pas encore), il n'y a rien à ne pas dépasser : on l'amorce, y compris pour re-mesurer après un rebase
    if (existe && !ref) return { code: 2, texte: `${BASELINE} existe déjà : --init ne la recrée pas (elle ne peut que baisser, utiliser --ecrire).` };
    ecrireBase(racine, mesure);
    return { code: 0, texte: `${BASELINE} créée : ${Object.keys(mesure).length} mesures figées.` };
  }
  if (!existe) return { code: 2, texte: `${BASELINE} absente : lancer « node scripts/qualite.mjs --init » une fois, puis la versionner.` };
  const base = lireBase(racine);
  const refus = baseRemonte(base, ref);
  if (refus) return refus;
  if (mode === 'migrer') return migrer(racine, base, mesure, ref);
  const { pires, mieux } = comparer(base, mesure);
  if (pires.length) return empire(pires, ref);
  if (mode === 'ecrire') {
    ecrireBase(racine, mesure);
    return { code: 0, texte: `${BASELINE} baissée : ${mieux.length} mesure(s) en moins.` };
  }
  const reste = mieux.length ? `\n${mieux.length} mesure(s) ont baissé : « npm run qualite:cliquet » fige le gain.` : '';
  return { code: 0, texte: `Qualité : rien n'empire (${Object.keys(mesure).length} mesures sous la ligne de base).${reste}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--contre');
  const ref = i >= 0 ? args.splice(i, 2)[1] : null;
  const arg = args[0];
  const mode = { '--init': 'init', '--ecrire': 'ecrire', '--migrer': 'migrer' }[arg ?? ''];
  if ((arg && !mode) || args.length > 1 || (i >= 0 && !ref)) { console.error('usage : node scripts/qualite.mjs [--init | --ecrire | --migrer] [--contre <ref>]'); process.exit(2); }
  try {
    const { code, texte } = appliquer(process.cwd(), mode ?? 'verifier', undefined, ref ? lireRef(process.cwd(), ref) : null);
    (code ? console.error : console.log)(texte);
    process.exit(code);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
