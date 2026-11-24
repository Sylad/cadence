// Template of the accept step of orchestrate (L173): copy it into the project (e.g. tests/acceptation-runner.mjs) and import it
// from the test runner config SHARED by `orchestrate.test` and the CI. See "The accept step" in docs/orchestrate-spec.md of the @sylad/cadence package (linked from its README).
//
//   vitest.config.ts          test: { exclude: [...configDefaults.exclude, ...acceptationIgnored()] }
//   jest.config.js            testPathIgnorePatterns: ['/node_modules/', ...acceptationIgnored(process.cwd(), 'docs/specs', 'regex')]
//   vitest.acceptation.config.ts   (dedicated command, orchestrate.accept)
//                             test: { include: acceptationOnly() }   (a LIST of runners: each one sees only the files under its root, see acceptationOnly)
//
//   playwright.config.ts      testMatch: acceptationE2e()   (e2e suite, run AFTER the build: an acceptation with `"e2e": true` needs a browser and dist)
//
// An acceptation.json with `vert: false` (red tests of the lot, not implemented yet) keeps its files out of the project's runner and of the CI;
// the cycle sets `vert: true` when the dedicated command passes, and the files then join the ordinary runner.
// Exception (L203): an acceptation with `"e2e": true` NEVER joins it (without dist or Chromium it would turn it red): it stays excluded, green or not, and goes to the e2e suite.
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
      continue; // not a screen folder
    }
    for (const file of files) {
      const doc = read(join(folder, file));
      if (!doc || !keep(doc)) continue;
      for (const f of doc.fichiers) if (typeof f === 'string') out.push(format === 'regex' ? `${escape(f)}$` : f);
    }
  }
  return out;
}

/** Files of the acceptation-<lot>.json (or acceptation.json) with `vert: false`, or with `e2e: true` (green or not), under `<root>/<dir>/*` (one file per lot: several per screen), relative to `root`; `format: 'regex'` for testPathIgnorePatterns. */
export function acceptationIgnored(root = process.cwd(), dir = 'docs/specs', format = 'glob') {
  return collect(root, dir, format, (doc) => doc.vert !== true || doc.e2e === true);
}

/** Files of the acceptations with `e2e: true` (green or red) under `<root>/<dir>/*`, relative to `root`: the `testMatch` of the e2e suite, run after the build. */
export function acceptationE2e(root = process.cwd(), dir = 'docs/specs', format = 'glob') {
  return collect(root, dir, format, (doc) => doc.e2e === true);
}

/**
 * Files of the given acceptation.json (by default the one of `CADENCE_ACCEPTATION`, set by the cycle): the `include` of the dedicated config.
 * With a list of runners (`orchestrate.accept` as a list), each runner takes only the files under ITS root, the folder of its
 * leading `cd <folder> &&` (`CADENCE_ACCEPTATION_ROOT`, set by the cycle; '.' or absent = the repository): they are made relative to that root,
 * where the runner is started.
 */
export function acceptationOnly(file = process.env.CADENCE_ACCEPTATION, root = process.env.CADENCE_ACCEPTATION_ROOT ?? '.') {
  if (!file) throw new Error('CADENCE_ACCEPTATION: path of the acceptation.json of the lot expected (set by the orchestrate.accept command)');
  const doc = read(file);
  if (!doc) throw new Error(`${file}: unreadable acceptation.json`);
  const files = doc.fichiers.filter((f) => typeof f === 'string');
  const base = posix.normalize(root.replace(/\\/g, '/')).replace(/\/$/, '');
  if (base === '.' || base === '') return files;
  return files.filter((f) => posix.normalize(f).startsWith(`${base}/`)).map((f) => posix.normalize(f).slice(base.length + 1));
}
