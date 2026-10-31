// Garde-fous de qualité du code (L462) : mesure (ESLint + typescript-eslint + sonarjs, knip, jscpd) et cliquet.
// Le cliquet compare la mesure à qualite-baseline.json : l'existant passe, rien ne peut empirer, ce qui baisse se fige.
// Lancé par `npm run qualite` (porte orchestrate.build et CI) ; la recette est dans docs/qualite.md.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const trier = (mesure) => Object.fromEntries(Object.entries(mesure).sort(([a], [b]) => (a < b ? -1 : 1)));

export const lireBase = (racine) => JSON.parse(readFileSync(join(racine, BASELINE), 'utf8'));
const ecrireBase = (racine, mesure) => writeFileSync(join(racine, BASELINE), `${JSON.stringify(trier(mesure), null, 2)}\n`);

function lancer(racine, bin, args, accepte) {
  const r = spawnSync(process.execPath, [join(racine, 'node_modules', bin), ...args], { cwd: racine, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // un outil qui plante ne doit jamais passer pour « zéro défaut »
  if (r.error || !accepte.includes(r.status)) throw new Error(`${bin} a échoué (code ${r.status}) : ${r.error?.message ?? r.stderr.slice(0, 500)}`);
  return r.stdout;
}

/** Joue les trois outils dans `racine` (qui porte eslint.config.mjs, knip.json et .jscpd.json) et rend la mesure à plat. */
export function mesurer(racine) {
  const eslint = JSON.parse(lancer(racine, 'eslint/bin/eslint.js', ['-f', 'json', '.'], [0, 1]));
  const knip = JSON.parse(lancer(racine, 'knip/bin/knip.js', ['--reporter', 'json'], [0, 1]));
  const sortie = mkdtempSync(join(tmpdir(), 'qualite-jscpd-'));
  try {
    lancer(racine, 'jscpd/bin/jscpd', ['-c', '.jscpd.json', '--output', sortie], [0]);
    const jscpd = JSON.parse(readFileSync(join(sortie, 'jscpd-report.json'), 'utf8'));
    return trier({ ...lireEslint(eslint, racine), ...lireKnip(knip, racine), ...lireJscpd(jscpd) });
  } finally {
    rmSync(sortie, { recursive: true, force: true });
  }
}

const ligne = ({ cle, avant, apres }) => `  ${cle} : ${avant} → ${apres}`;

/** Compare la mesure à la base. mode : 'verifier' (défaut), 'init' (crée la base) ou 'ecrire' (la baisse). Rend { code, texte }. */
export function appliquer(racine, mode, mesure = mesurer(racine)) {
  const existe = existsSync(join(racine, BASELINE));
  if (mode === 'init') {
    if (existe) return { code: 2, texte: `${BASELINE} existe déjà : --init ne la recrée pas (elle ne peut que baisser, utiliser --ecrire).` };
    ecrireBase(racine, mesure);
    return { code: 0, texte: `${BASELINE} créée : ${Object.keys(mesure).length} mesures figées.` };
  }
  if (!existe) return { code: 2, texte: `${BASELINE} absente : lancer « node scripts/qualite.mjs --init » une fois, puis la versionner.` };
  const { pires, mieux } = comparer(lireBase(racine), mesure);
  if (pires.length) {
    return { code: 1, texte: `Qualité : ${pires.length} mesure(s) empirent (rien ne peut empirer, un fichier touché ne peut que baisser) :\n${pires.map(ligne).join('\n')}` };
  }
  if (mode === 'ecrire') {
    ecrireBase(racine, mesure);
    return { code: 0, texte: `${BASELINE} baissée : ${mieux.length} mesure(s) en moins.` };
  }
  const reste = mieux.length ? `\n${mieux.length} mesure(s) ont baissé : « npm run qualite:cliquet » fige le gain.` : '';
  return { code: 0, texte: `Qualité : rien n'empire (${Object.keys(mesure).length} mesures sous la ligne de base).${reste}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const mode = { '--init': 'init', '--ecrire': 'ecrire' }[arg ?? ''];
  if (arg && !mode) { console.error('usage : node scripts/qualite.mjs [--init | --ecrire]'); process.exit(2); }
  try {
    const { code, texte } = appliquer(process.cwd(), mode ?? 'verifier');
    (code ? console.error : console.log)(texte);
    process.exit(code);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
