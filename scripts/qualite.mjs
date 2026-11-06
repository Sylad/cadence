// Garde-fous de qualité du code (L462) : mesure (ESLint + typescript-eslint + sonarjs, knip, jscpd) et cliquet.
// Le cliquet compare la mesure à qualite-baseline.json : l'existant passe, rien ne peut empirer, ce qui baisse se fige.
// Lancé par `npm run qualite` (porte orchestrate.build et CI) ; la recette est dans docs/qualite.md.
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
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

/** Les lignes non vides d'un texte (espaces de bord retirés), comptées par multiensemble. */
function lignesDe(texte) {
  const m = new Map();
  for (const l of texte.split('\n')) { const t = l.trim(); if (t) m.set(t, (m.get(t) ?? 0) + 1); }
  return m;
}

/**
 * Le lien d'un fichier neuf à sa source (R14, R18) : `lien(chemin)` rend, parmi les fichiers de `base` (la base du point de départ), la
 * source dont le fichier neuf tient le plus de lignes que la source avait au départ ET a perdues depuis, à condition qu'elles fassent 50 %
 * des lignes non vides du fichier neuf ; null sinon. `lecture` : `depart(chemin)` (contenu au point de départ, null si le fichier n'y
 * était pas, lève si git échoue), `courant(chemin)` (la source aujourd'hui, null si elle a disparu : elle a tout perdu) et `neuf(chemin)`.
 * Le contenu d'une source se lit une fois (cache), au premier fichier neuf qui en a besoin, jamais sans fichier neuf à relier.
 */
export function creerLien(base, lecture) {
  const sources = [...new Set(Object.keys(base).map(cheminDeCle))].sort();
  const pertes = new Map(); // source → ses lignes perdues depuis le départ (ligne → nombre)
  const perdues = (source) => {
    if (!pertes.has(source)) {
      const avant = lecture.depart(source);
      if (avant === null) pertes.set(source, null); // absente de l'arbre du départ : pas une source
      else {
        const apres = lignesDe(lecture.courant(source) ?? '');
        const perte = new Map();
        for (const [l, n] of lignesDe(avant)) if (n > (apres.get(l) ?? 0)) perte.set(l, n - (apres.get(l) ?? 0));
        pertes.set(source, perte);
      }
    }
    return pertes.get(source);
  };
  return (neuf) => {
    const contenu = lecture.neuf(neuf);
    if (contenu === null) return null;
    const lignes = lignesDe(contenu);
    const total = [...lignes.values()].reduce((a, n) => a + n, 0);
    let meilleure = null;
    let meilleures = 0;
    for (const source of sources) {
      const perte = perdues(source);
      if (!perte) continue;
      let liees = 0;
      for (const [l, n] of lignes) liees += Math.min(n, perte.get(l) ?? 0);
      if (liees > meilleures) { meilleure = source; meilleures = liees; }
      if (liees === total) break; // aucune autre source ne peut en lier davantage
    }
    return meilleures > 0 && meilleures * 2 >= total ? meilleure : null;
  };
}

const regleDeCle = (cle) => { const p = cle.split('|'); return [p[0], ...p.slice(2)].join('|'); };
const MENTION = 'fichier neuf : au-delà de ce que sa source a perdu';

/** Les fichiers neufs qui portent un chiffre positif, groupés par source (null : aucune) et par outil-règle, avec la somme de leurs mesures. */
function groupesDeNeufs(apres, existe, lien) {
  const groupes = new Map();
  const liens = new Map();
  for (const [cle, n] of Object.entries(apres)) {
    const fichier = cheminDeCle(cle);
    if (estCompteur(cle) || n <= 0 || existe(fichier)) continue;
    if (!liens.has(fichier)) liens.set(fichier, lien ? lien(fichier) : null);
    const source = liens.get(fichier);
    const regle = regleDeCle(cle);
    // la clé distingue « aucune source » (null) d'un fichier du départ qui s'appellerait « null »
    const id = `${source === null ? '-' : `+${source}`}\0${regle}`;
    const groupe = groupes.get(id) ?? { source, regle, cles: [], somme: 0 };
    groupe.cles.push([cle, n]);
    groupe.somme += n;
    groupes.set(id, groupe);
  }
  return [...groupes.values()];
}

/** Ce que `source` a perdu sur `regle` depuis `depart` : la somme, sur ses clés qui portent un chiffre, de la valeur du départ moins la mesure courante, bornée à 0. */
const perteDeSource = (depart, apres, source, regle) => Object.entries(depart).reduce((t, [k, v]) => (!estCompteur(k) && cheminDeCle(k) === source && regleDeCle(k) === regle ? t + Math.max(0, v - (apres[k] ?? 0)) : t), 0);

/**
 * Le passage de `avant` (la base du lot) à `apres` quand des fichiers ont été déplacés ou découpés : une clé d'un fichier qui existait
 * (`existe(chemin)`) ne peut pas monter, le total de chaque mesure sur tous les fichiers non plus, et un fichier neuf qui porte un chiffre
 * n'est crédité que par la source du départ dont `lien(chemin)` le dit issu : pour chaque source et chaque outil-règle, la somme de ses
 * fichiers neufs est au plus ce que la source a perdu depuis `depart` (la base du départ du lot, `avant` pour la porte). Un fichier neuf
 * sans source ne reçoit aucun crédit. Rend ce qui empire.
 */
export function comparerMigration(avant, apres, existe, lien, depart = avant) {
  const pires = comparer(avant, Object.fromEntries(Object.entries(apres).filter(([cle]) => existe(cheminDeCle(cle))))).pires;
  const ta = totaux(avant);
  const tb = totaux(apres);
  for (const cle of Object.keys(tb)) if (tb[cle] > (ta[cle] ?? 0)) pires.push({ cle: `${cle} (total, tous fichiers)`, avant: ta[cle] ?? 0, apres: tb[cle] });
  for (const { source, regle, cles, somme } of groupesDeNeufs(apres, existe, lien)) {
    if (source !== null && somme <= perteDeSource(depart, apres, source, regle)) continue;
    const note = `${MENTION} (${source === null ? 'aucune source' : `source la plus proche : ${source}`})`;
    for (const [cle, n] of cles) pires.push({ cle, avant: 0, apres: n, note });
  }
  return pires;
}

const trier = (mesure) => Object.fromEntries(Object.entries(mesure).sort(([a], [b]) => (a < b ? -1 : 1)));

export const lireBase = (racine) => JSON.parse(readFileSync(join(racine, BASELINE), 'utf8'));
/** Le texte de la ligne de base : trié par clé, JSON indenté de 2 espaces, terminé par un saut de ligne. */
export const serialiser = (mesure) => `${JSON.stringify(trier(mesure), null, 2)}\n`;
const ecrireBase = (racine, mesure) => writeFileSync(join(racine, BASELINE), serialiser(mesure));

function lancer(racine, bin, args, accepte) {
  // un outil absent ferait sortir node avec 1 et rien sur stdout, que le JSON.parse d'après lirait comme « Unexpected end of JSON input »
  if (!existsSync(join(racine, 'node_modules', bin))) throw new Error(`${bin.split('/')[0]} est absent de node_modules (${racine}) : lancer « npm install » puis relancer.`);
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

/** Le point de départ du lot : au merge-base de HEAD et de `ref`, la ligne de base (null si elle n'y existait pas encore), `existe(chemin)` (vrai pour un fichier qui y était, erreur si git ne rend pas l'arbre), `contenu(chemin)` (son contenu, null s'il n'y était pas, erreur si git échoue) et `config(chemin)` (son contenu, null s'il n'y était pas). */
export function lireRef(racine, ref) {
  const git = (...args) => spawnSync('git', args, { cwd: racine, encoding: 'utf8' });
  const mb = git('merge-base', 'HEAD', ref);
  if (mb.status !== 0) throw new Error(`référence « ${ref} » introuvable (git merge-base HEAD ${ref}) : ${mb.stderr?.trim() || mb.error?.message || 'pas de dépôt git ?'}`);
  const sha = mb.stdout.trim();
  const show = git('show', `${sha}:${BASELINE}`);
  // présent dans l'arbre du départ : `ls-tree` lit l'arbre, pas le blob — un blob perdu (clone partiel) ne passe pas pour un fichier absent
  const dansArbre = (chemin, opts = {}) => { const r = spawnSync('git', ['ls-tree', '-z', sha, '--', chemin], { cwd: racine, encoding: 'utf8', ...opts }); return r.error || r.status !== 0 ? undefined : r.stdout !== ''; };
  const config = (chemin) => { const r = git('show', `${sha}:${chemin}`); return r.status === 0 ? r.stdout : null; };
  // le contenu d'un fichier du départ : null s'il n'y était pas, une erreur (code 2) si git ne le rend pas — jamais un faux « pas de lien »
  const illisible = (chemin) => new Error(`Qualité : le contenu de ${chemin} au point de départ ${ref} est illisible (git show a échoué) : le lien des fichiers neufs ne peut pas être établi.`);
  // l'arbre du départ illisible n'est pas « fichier absent » : un fichier du départ passerait pour neuf, et son refus serait celui de git
  const existe = (chemin) => { const present = dansArbre(chemin); if (present === undefined) throw illisible(chemin); return present; };
  const contenu = (chemin) => {
    const opts = { timeout: 60000, maxBuffer: 64 * 1024 * 1024 };
    const present = dansArbre(chemin, opts);
    if (present === undefined) throw illisible(chemin);
    if (!present) return null;
    const r = spawnSync('git', ['show', `${sha}:${chemin}`], { cwd: racine, encoding: 'utf8', ...opts });
    if (r.error || r.status !== 0) throw illisible(chemin);
    return r.stdout;
  };
  const fichiers = () => git('ls-tree', '-r', '-z', '--name-only', sha).stdout.split('\0').filter(Boolean);
  // ce que le lot a touché depuis son départ : commits, modifications suivies (sans détection de renommage : un renommage src → test remonte ses deux chemins)
  // et fichiers neufs non ignorés — hors liens symboliques non suivis, que la vague orchestrate pose elle-même dans un worktree (evals/results, plugins/…/types)
  const nonSymbolique = (f) => !lstatSync(join(racine, f)).isSymbolicLink();
  const touches = () => [...new Set([
    ...git('diff', '--name-only', '--no-renames', '-z', sha).stdout.split('\0').filter(Boolean),
    ...git('ls-files', '-z', '--others', '--exclude-standard').stdout.split('\0').filter(Boolean).filter(nonSymbolique),
  ])];
  // les commits du lot depuis son départ, avec les fichiers de chacun : la porte d'intégration n'a pas de branche de lot, elle juge la config à ses commits
  const commits = () => git('log', '--no-renames', '--name-only', '--format=%x01%s', '-z', `${sha}..HEAD`).stdout.split('\x01').slice(1).map((b) => {
    const [sujet, ...fichiers] = b.split(/\n|\0/);
    return { sujet, fichiers: fichiers.filter(Boolean) };
  });
  const lots = lotsDeConfig(config);
  const slug = /--([^/]+)$/.exec(git('branch', '--show-current').stdout.trim())?.[1];
  return { nom: `${ref} (${sha.slice(0, 7)})`, base: show.status === 0 ? JSON.parse(show.stdout) : null, existe, contenu, config, fichiers, touches, commits, lotsConfig: lots, lotConfig: !!slug && [...lots].some((id) => id.split('/').join('__') === slug) };
}

// Les plans que cadence lit par défaut (un plan tenu par un autre outil, `plan:` de cadence.yaml, n'est pas cherché : le lot n'y est pas de config).
const PLANS = ['.cadence/raf.yaml', 'docs/plan/raf.yaml'];

/**
 * Les ids des lots que le plan du point de départ déclare `config: true`. Lu au départ, pas dans l'arbre : un lot ne se déclare pas lui-même
 * exempté. Vide sans plan.
 */
function lotsDeConfig(config) {
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

// Ce qu'un lot de config peut toucher : les configs comparées, leurs tests, et ce que tout lot touche (base du cliquet, plan, CHANGELOG, docs)
const estConfig = (f) => CONFIGS.includes(f) || f === 'package.json' || basename(f) === '.gitignore';
const estTest = (f) => /^tests?\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const estComptabilite = (f) => f === BASELINE || f === 'CHANGELOG.md' || f.startsWith('.cadence/') || f.startsWith('docs/');
const horsConfig = (f) => !estConfig(f) && !estTest(f) && !estComptabilite(f);

// Les seuils et les exclusions des trois outils : les relever ferait baisser la mesure sans corriger le code. Tout ce que les
// outils lisent est comparé, pas seulement le fichier que ce dépôt utilise : ESLint 9 charge eslint.config.js AVANT .mjs, knip
// lit huit noms et package.json#knip, jscpd lit package.json#jscpd, et knip comme jscpd respectent .gitignore.
const CONFIGS = [
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((e) => `eslint.config.${e}`),
  'knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc', 'knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js',
  '.jscpd.json',
  '.gitignore',
  // knip lit la config de vitest (ses entrées, son plugin) et tsconfig.json (ses chemins, son périmètre) ; vitest se rabat sur vite.config.*
  ...['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].flatMap((e) => [`vitest.config.${e}`, `vitest.workspace.${e}`, `vite.config.${e}`]),
  'tsconfig.json',
];
// package.json : knip y lit ses points d'entrée (scripts, main, bin, exports) ; jscpd et knip leur config
const CLES_PACKAGE = ['knip', 'jscpd', 'scripts', 'main', 'bin', 'exports'];

// la valeur d'une clé de package.json, sérialisée pour la comparer ; null si le fichier manque, est illisible ou n'a pas la clé
const section = (texte, cle) => {
  if (texte === null) return null;
  try { const v = JSON.parse(texte)[cle]; return v === undefined ? null : JSON.stringify(v); } catch { return null; }
};

const lireSiPresent = (racine, f) => (existsSync(join(racine, f)) ? readFileSync(join(racine, f), 'utf8') : null);
const etat = (depart, actuel) => (depart === null ? 'nouveau' : actuel === null ? 'supprimé' : 'modifié');

// les libellés « fichier (nouveau|supprimé|modifié) » des couples (nom, départ, actuel) qui diffèrent
const differences = (couples) => couples.filter(([, depart, actuel]) => depart !== actuel).map(([nom, depart, actuel]) => `${nom} (${etat(depart, actuel)})`);

// les .gitignore imbriqués (src/.gitignore…), ceux du départ comme ceux d'aujourd'hui ; node_modules et .git ne sont pas parcourus
const gitignoresImbriques = (racine, ref) => {
  const ici = [];
  const parcourir = (rel) => {
    for (const e of readdirSync(join(racine, rel), { withFileTypes: true })) {
      const chemin = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') parcourir(chemin); } else if (e.name === '.gitignore') ici.push(chemin);
    }
  };
  parcourir('');
  // un .gitignore posé dans un dossier ignoré par une règle d'AILLEURS (généré, non suivi) ne change rien à ce que knip et jscpd
  // mesurent ; celui qui s'ignore lui-même (`*`) est une vraie règle neuve et reste compté. check-ignore -v cite aussi le chemin
  // qu'un motif de négation (`!.gitignore`) remet dans le dépôt : lui n'est PAS ignoré, il reste compté
  const ignores = ici.length ? spawnSync('git', ['check-ignore', '-v', '-z', '--stdin'], { cwd: racine, input: ici.join('\0'), encoding: 'utf8' }) : null;
  const exclus = new Set();
  if (ignores?.status === 0) {
    const champs = ignores.stdout.split('\0'); // source, ligne, motif, chemin
    for (let i = 0; i + 3 < champs.length; i += 4) if (champs[i] !== champs[i + 3] && !champs[i + 2].startsWith('!')) exclus.add(champs[i + 3]);
  }
  const depart = (ref.fichiers?.() ?? []).filter((f) => basename(f) === '.gitignore');
  return [...new Set([...ici.filter((f) => !exclus.has(f)), ...depart])].filter((f) => f !== '.gitignore').sort();
};

const fichiersChanges = (racine, ref) => differences([...CONFIGS, ...gitignoresImbriques(racine, ref)].map((f) => [f, ref.config(f), lireSiPresent(racine, f)]));

function clesPackageChangees(racine, ref) {
  const depart = ref.config('package.json');
  const actuel = lireSiPresent(racine, 'package.json');
  return differences(CLES_PACKAGE.map((cle) => [`package.json#${cle}`, section(depart, cle), section(actuel, cle)]));
}

// Les commits dont le scope (`feat(L1,L2): …`) ne cite que des lots déclarés de config au plan du départ : à la porte d'intégration, qui ne porte pas le nom d'un lot, c'est eux qui portent la config
const estDeConfig = (c, ref) => {
  const ids = /^[^(:]*\(([^)]+)\)/.exec(c.sujet)?.[1].split(',').map((i) => i.trim());
  return !!ids && ids.every((id) => ref.lotsConfig?.has(id));
};

// Vrai si le libellé « fichier (état) » d'une config changée n'est dû qu'à des commits de lots de config (au moins un) : un commit de code qui y touche, ou un arbre sale, la laisse refusée
function deLotsDeConfig(libelle, commits, ref) {
  const fichier = /^(.*?)(#\S*)? \([^()]*\)$/.exec(libelle)[1];
  const touchants = commits.filter((c) => c.fichiers.includes(fichier));
  return touchants.length > 0 && touchants.every((c) => estDeConfig(c, ref));
}

/** Refus (code 1) si une config que les outils lisent diffère de celle du point de départ du lot (apparue, disparue ou modifiée), null sinon. */
function configChangee(racine, ref) {
  // sans base au départ, rien n'est encore jugé par ces configs : le lot qui adopte les outils les introduit librement
  if (!ref?.config || !ref.base) return null;
  // un lot déclaré de config au plan (L586) peut changer les configs, à condition de ne rien toucher d'autre ; les autres mesures le jugent toujours
  if (ref.lotConfig) {
    const hors = (ref.touches?.() ?? []).filter(horsConfig);
    return hors.length ? { code: 1, texte: `${hors.join(', ')} : un lot déclaré « config: true » au plan ne touche que les fichiers de config et leurs tests (le reste est du code : un autre lot).` } : null;
  }
  const commits = ref.commits?.() ?? [];
  const changees = [...fichiersChanges(racine, ref), ...clesPackageChangees(racine, ref)].filter((libelle) => !deLotsDeConfig(libelle, commits, ref));
  const hors = commits.filter((c) => estDeConfig(c, ref)).flatMap((c) => c.fichiers.filter(horsConfig));
  if (hors.length) return { code: 1, texte: `${[...new Set(hors)].join(', ')} : un lot déclaré « config: true » au plan ne touche que les fichiers de config et leurs tests (le reste est du code : un autre lot).` };
  if (!changees.length) return null;
  return { code: 1, texte: `${changees.join(', ')} diffère(nt) de ${ref.nom} : un seuil ou une exclusion ne se change pas dans un lot qui est jugé par eux (corriger le code ; changer une config est une décision du plan, livrée seule).` };
}

/** Les motifs actifs de .git/info/exclude (hors commentaires et lignes vides) ; vide hors dépôt git ou sans ce fichier. */
function exclusLocaux(racine) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: racine, encoding: 'utf8' });
  const chemin = r.status === 0 ? resolve(racine, r.stdout.trim()) : null;
  if (!chemin || !existsSync(chemin)) return [];
  return readFileSync(chemin, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

const ligne = ({ cle, avant, apres, note }) => `  ${cle} : ${avant} → ${apres}${note ? ` — ${note}` : ''}`;

const existeAuDepart = (ref) => ref.existe ?? (() => true);

// le contenu d'un fichier de l'arbre de travail (suivi ou non par git), null s'il n'y est pas
const lireLocal = (racine, chemin) => { const f = join(racine, chemin); return existsSync(f) && lstatSync(f).isFile() ? readFileSync(f, 'utf8') : null; };

/** Le lien des fichiers neufs à leurs sources du départ (creerLien) ; sans moyen de lire le départ (`ref.contenu`), aucun lien : un fichier neuf paie son défaut. */
const lienDe = (racine, ref) => (ref?.base && ref.contenu ? creerLien(ref.base, { depart: ref.contenu, courant: (c) => lireLocal(racine, c), neuf: (c) => lireLocal(racine, c) }) : () => null);

/**
 * Refus (code 1) quand `ref` est `origin/<b>` et que la branche locale `<b>` a des commits que `origin/<b>` n'a pas (L645) : le départ du lot vient de `<b>`,
 * le merge-base avec un `origin/<b>` en retard est plus ancien, et le cliquet refuserait alors des configs et des mesures que le lot n'a pas touchées, après
 * six minutes de suite. Null sans branche locale du même nom (clone de la CI), sans la référence ou pour une autre forme de référence.
 */
export function retardSurBranche(racine, ref) {
  const local = /^origin\/(.+)$/.exec(ref)?.[1];
  if (!local) return null;
  const git = (...args) => spawnSync('git', args, { cwd: racine, encoding: 'utf8' });
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${local}`).status !== 0) return null;
  const n = Number(git('rev-list', '--count', `${ref}..refs/heads/${local}`).stdout);
  if (!n) return null;
  return { code: 1, texte: `${ref} est en retard de ${n} commit${n > 1 ? 's' : ''} sur ${local} : le cliquet le comparerait à un départ plus ancien que celui du lot (faux refus). Pousser ${local} (git push origin ${local}), ou comparer au départ du lot : node scripts/qualite.mjs --contre ${local}.` };
}

/** La référence à laquelle un test compare le lot : `origin/main` (comme la CI) quand il est à jour, sinon `main`, le départ du lot (comme la porte). */
export const refDepartLot = (racine, branche = 'main') => (retardSurBranche(racine, `origin/${branche}`) ? branche : `origin/${branche}`);

/** La base du lot contre celle du départ : refus (code 1) si elle monte, null sinon. */
function baseRemonte(racine, base, ref) {
  const remonte = ref?.base ? comparerMigration(ref.base, base, existeAuDepart(ref), lienDe(racine, ref)) : [];
  if (!remonte.length) return null;
  return { code: 1, texte: `${BASELINE} remonte par rapport à ${ref.nom} (elle ne peut que baisser : corriger le code, pas la base) :\n${remonte.map(ligne).join('\n')}` };
}

/** `--migrer` : réécrit la base pour une mesure où des fichiers ont été déplacés ou découpés. */
function migrer(racine, base, mesure, ref) {
  if (!ref) return { code: 2, texte: '--migrer exige --contre <ref> : les fichiers « qui existaient » sont ceux du point de départ du lot.' };
  // sans base au départ, aucun crédit ne se calcule : le lot qui amorce la base n'a rien à découper
  if (!ref.base) return { code: 1, texte: `Qualité : ${ref.nom} n'a pas de ${BASELINE} au point de départ : --migrer n'a aucun crédit à calculer. Versionner la base avec « node scripts/qualite.mjs --init » avant de découper.` };
  const empire = comparerMigration(base, mesure, existeAuDepart(ref), lienDe(racine, ref), ref.base);
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
  const resultat = decider(racine, mode, mesure, ref);
  const exclus = exclusLocaux(racine);
  return exclus.length ? { ...resultat, texte: `${resultat.texte}\nAvertissement : .git/info/exclude n'est pas vide (${exclus.slice(0, 3).join(', ')}${exclus.length > 3 ? `, … ${exclus.length - 3} autre(s)` : ''}) ; il n'est pas versionné et ESLint, knip et jscpd ne le comparent pas au départ : ces chemins échappent peut-être à la mesure (docs/qualite.md).` } : resultat;
}

function decider(racine, mode, mesure, ref) {
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
  const refus = baseRemonte(racine, base, ref);
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
    const retard = ref ? retardSurBranche(process.cwd(), ref) : null;
    if (retard) { console.error(retard.texte); process.exit(retard.code); }
    const { code, texte } = appliquer(process.cwd(), mode ?? 'verifier', undefined, ref ? lireRef(process.cwd(), ref) : null);
    (code ? console.error : console.log)(texte);
    process.exit(code);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
