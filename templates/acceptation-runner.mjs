// Gabarit de l'étape accept d'orchestrate (L173) : à copier dans le projet (ex. tests/acceptation-runner.mjs) et à importer
// depuis la config du lanceur de tests, PARTAGÉE par `orchestrate.test` et la CI. Voir « Étape accept » dans le README de cadence.
//
//   vitest.config.ts          test: { exclude: [...configDefaults.exclude, ...acceptationIgnored()] }
//   jest.config.js            testPathIgnorePatterns: ['/node_modules/', ...acceptationIgnored(process.cwd(), 'docs/specs', 'regex')]
//   vitest.acceptation.config.ts   (commande dédiée, orchestrate.accept)
//                             test: { include: acceptationOnly() }
//
// Un acceptation.json à `vert: false` (tests rouges du lot, pas encore implémenté) exclut ses fichiers du lanceur du projet et de la CI ;
// le cycle pose `vert: true` quand la commande dédiée passe, et les fichiers rejoignent alors le lanceur ordinaire.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (file) => {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && Array.isArray(doc.fichiers) ? doc : null;
  } catch {
    return null;
  }
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fichiers des acceptation-<lot>.json (ou acceptation.json) à `vert: false` sous `<root>/<dir>/*` (un fichier par lot : plusieurs par écran), relatifs à `root` ; `format: 'regex'` pour testPathIgnorePatterns. */
export function acceptationIgnored(root = process.cwd(), dir = 'docs/specs', format = 'glob') {
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
      if (!doc || doc.vert === true) continue;
      for (const f of doc.fichiers) if (typeof f === 'string') out.push(format === 'regex' ? `${escape(f)}$` : f);
    }
  }
  return out;
}

/** Fichiers de l'acceptation.json donné (par défaut celui de `CADENCE_ACCEPTATION`, posé par le cycle) : l'`include` de la config dédiée. */
export function acceptationOnly(file = process.env.CADENCE_ACCEPTATION) {
  if (!file) throw new Error('CADENCE_ACCEPTATION : chemin de l\'acceptation.json du lot attendu (posé par la commande orchestrate.accept)');
  const doc = read(file);
  if (!doc) throw new Error(`${file} : acceptation.json illisible`);
  return doc.fichiers.filter((f) => typeof f === 'string');
}
