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

const SCRIPTS = { test: 'vitest run', 'test:e2e': 'playwright test', loop: 'npm run loop' };

function gaps(run: string, gate = 'npx vitest run', scripts: Record<string, string> | null = SCRIPTS): string[] {
  const dir = join(tempDir(), 'p');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: false\n  test: ${gate}\n  build: npx tsc --noEmit\n`);
  if (scripts) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(dir, '.github/workflows/ci.yml'), `name: ci\non: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: ${JSON.stringify(run)}\n`);
  return ciParityGaps(dir).map((g) => g.command);
}

describe('probe L564 — options npm aux bords', () => {
  it('P1 — options répétées et mélangées (--silent --if-present -q) sont dépliées', () => {
    expect(gaps('npm test --silent --if-present -q')).toEqual([]);
  });
  it('P2 — option avant le nom du script (npm run --silent test) est dépliée', () => {
    expect(gaps('npm run --silent test')).toEqual([]);
  });
  it('P3 — npm --silent test est déplié', () => {
    expect(gaps('npm --silent test')).toEqual([]);
  });
  it('P4 — --silent suivi de --workspace reste tel quel (autre package)', () => {
    expect(gaps('npm test --silent --workspace=web')).toEqual(['npm test --silent --workspace=web']);
  });
  it('P5 — --prefix reste tel quel', () => {
    expect(gaps('npm test --prefix web')).toEqual(['npm test --prefix web']);
  });
  it('P6 — option inconnue proche (--silently) ne est pas dépliée à tort comme --silent', () => {
    expect(gaps('npm test --silently')).toEqual(['npm test --silently']);
  });
  it('P7 — --silent=true est déplié (même test)', () => {
    expect(gaps('npm test --silent=true')).toEqual([]);
  });
  it('P8 — --loglevel=silent est déplié', () => {
    expect(gaps('npm test --loglevel=silent')).toEqual([]);
  });
  it('P9 — option npm puis -- et arguments : déplié', () => {
    expect(gaps('npm test --silent -- --coverage --run')).toEqual([]);
  });
  it('P10 — sans package.json, npm test --silent face à la porte npm test : pas de faux positif', () => {
    expect(gaps('npm test --silent', 'npm test', null)).toEqual([]);
  });
  it('P11 — pnpm/yarn test --silent dépliés', () => {
    expect(gaps('pnpm test --silent')).toEqual([]);
    expect(gaps('yarn test --silent')).toEqual([]);
    expect(gaps('pnpm run test --if-present')).toEqual([]);
  });
  it('P12 — script récursif avec option ne boucle pas', () => {
    expect(() => gaps('npm run loop --silent')).not.toThrow();
  });
  it('P13 — une même commande deux fois avec et sans option est signalée une fois', () => {
    expect(gaps('npm run test:e2e --silent && npm run test:e2e')).toEqual(['playwright test']);
  });
  it('P14 — la porte joue npm test --silent, la CI npm test : couvert', () => {
    expect(gaps('npm test', 'npm test --silent')).toEqual([]);
  });
  it('P15 — avec env et enveloppes : CI=1 xvfb-run npm test --silent', () => {
    expect(gaps('CI=1 xvfb-run npm test --silent')).toEqual([]);
  });
  it('P16 — option en majuscules ou espaces multiples', () => {
    expect(gaps('npm test    --silent    -s')).toEqual([]);
    expect(gaps('npm test --SILENT')).toEqual(['npm test --SILENT']);
  });
});
