// Gabarit de l'étape accept d'orchestrate (L173) : à copier dans le projet (ex. tests/acceptation-runner.mjs) et à importer
// depuis la config du lanceur de tests, PARTAGÉE par `orchestrate.test` et la CI. Voir « Étape accept » dans le README de cadence.
//
//   vitest.config.ts          test: { exclude: [...configDefaults.exclude, ...acceptationIgnored()] }
//   jest.config.js            testPathIgnorePatterns: ['/node_modules/', ...acceptationIgnored(process.cwd(), 'docs/specs', 'regex')]
//   vitest.acceptation.config.ts   (commande dédiée, orchestrate.accept)
//                             test: { include: acceptationOnly() }   (une LISTE de lanceurs : chacun ne voit que les fichiers sous sa racine, cf. acceptationOnly)
//
//   playwright.config.ts      testMatch: acceptationE2e()   (suite e2e, lancée APRÈS le build : une acceptation `"e2e": true`, navigateur et dist requis)
//
// Un acceptation.json à `vert: false` (tests rouges du lot, pas encore implémenté) exclut ses fichiers du lanceur du projet et de la CI ;
// le cycle pose `vert: true` quand la commande dédiée passe, et les fichiers rejoignent alors le lanceur ordinaire.
// Exception (L203) : une acceptation `"e2e": true` ne le rejoint JAMAIS (sans dist ni Chromium elle le rendrait rouge) : elle reste exclue, verte ou non, et va dans la suite e2e.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const read = (file) => {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && Array.isArray(doc.fichiers) ? doc : null;
  } catch {
    return null;
  }
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function collect(root, dir, format, keep) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base).sort()) {
    const folder = join(base, name);
    let files = [];
    try {
      files = readdirSync(folder).filter((f) => /^acceptation(-.+)?\.json$/.test(f)).sort();
    } catch {
      continue; // pas un dossier d'écran
    }
    for (const file of files) {
      const doc = read(join(folder, file));
      if (!doc || !keep(doc)) continue;
      for (const f of doc.fichiers) if (typeof f === 'string') out.push(format === 'regex' ? `${escape(f)}$` : f);
    }
  }
  return out;
}

/** Fichiers des acceptation-<lot>.json (ou acceptation.json) à `vert: false`, ou à `e2e: true` (verts ou non), sous `<root>/<dir>/*` (un fichier par lot : plusieurs par écran), relatifs à `root` ; `format: 'regex'` pour testPathIgnorePatterns. */
export function acceptationIgnored(root = process.cwd(), dir = 'docs/specs', format = 'glob') {
  return collect(root, dir, format, (doc) => doc.vert !== true || doc.e2e === true);
}

/** Fichiers des acceptations `e2e: true` (vertes ou rouges) sous `<root>/<dir>/*`, relatifs à `root` : le `testMatch` de la suite e2e, lancée après le build. */
export function acceptationE2e(root = process.cwd(), dir = 'docs/specs', format = 'glob') {
  return collect(root, dir, format, (doc) => doc.e2e === true);
}

/**
 * Fichiers de l'acceptation.json donné (par défaut celui de `CADENCE_ACCEPTATION`, posé par le cycle) : l'`include` de la config dédiée.
 * Avec une liste de lanceurs (`orchestrate.accept` en liste), chaque lanceur ne prend que les fichiers sous SA racine, le dossier de son
 * `cd <dossier> &&` initial (`CADENCE_ACCEPTATION_ROOT`, posé par le cycle ; '.' ou absent = le dépôt) : ils sont rendus relatifs à cette racine,
 * là où le lanceur est démarré.
 */
export function acceptationOnly(file = process.env.CADENCE_ACCEPTATION, root = process.env.CADENCE_ACCEPTATION_ROOT ?? '.') {
  if (!file) throw new Error('CADENCE_ACCEPTATION : chemin de l\'acceptation.json du lot attendu (posé par la commande orchestrate.accept)');
  const doc = read(file);
  if (!doc) throw new Error(`${file} : acceptation.json illisible`);
  const files = doc.fichiers.filter((f) => typeof f === 'string');
  const base = posix.normalize(root.replace(/\\/g, '/')).replace(/\/$/, '');
  if (base === '.' || base === '') return files;
  return files.filter((f) => posix.normalize(f).startsWith(`${base}/`)).map((f) => posix.normalize(f).slice(base.length + 1));
}
