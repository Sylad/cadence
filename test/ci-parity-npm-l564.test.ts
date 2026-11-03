import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciParityGaps } from '../src/orchestrate/ci-parity.js';
import { git } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const SCRIPTS = { test: 'vitest run', 'test:unit': 'vitest run --coverage', 'test:e2e': 'playwright test' };

function gaps(run: string, gate = 'npx vitest run', scripts: Record<string, string> = SCRIPTS): string[] {
  const dir = join(tempDir(), 'p');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  test: ${gate}\n  build: npx tsc --noEmit\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(dir, '.github/workflows/ci.yml'), `name: ci\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: ${run}\n`);
  return ciParityGaps(dir).map((g) => g.command);
}

describe('parité porte ↔ CI — npm test déplié malgré les options de npm (L564, issue #32)', () => {
  it('R1 — npm test et npm run test, avec ou sans npx côté porte, jouent le même test : rien à signaler', () => {
    for (const run of ['npm test', 'npm run test', 'npm run test:unit']) {
      expect(gaps(run, 'npx vitest run')).toEqual([]);
      expect(gaps(run, 'vitest run')).toEqual([]);
    }
  });

  it('R2 — une option de npm après le nom du script (--silent, --if-present, -s) ne l\'empêche pas d\'être déplié', () => {
    for (const run of ['npm test --silent', 'npm run test --if-present', 'npm test -s', 'npm test --silent -- --run']) {
      expect(gaps(run)).toEqual([]);
    }
  });

  it('R3 — la porte qui joue npm test couvre la CI qui joue npx vitest run', () => {
    expect(gaps('npx vitest run', 'npm test')).toEqual([]);
  });

  it('R4 — un script déplié qui joue une autre suite reste signalé, options de npm comprises', () => {
    expect(gaps('npm run test:e2e --silent')).toEqual(['playwright test']);
  });

  it('R5 — une option qui change de paquet (--workspace, --prefix) n\'est pas dépliée par le package.json racine', () => {
    expect(gaps('npm test --workspace=web')).toEqual(['npm test --workspace=web']);
  });
});
