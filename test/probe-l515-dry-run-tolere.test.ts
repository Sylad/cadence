import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

const tests = readFileSync(join(import.meta.dirname, '..', '.github/workflows/tests.yml'), 'utf8');
const step = tests.match(/- name: Suite sous npm publish --dry-run\n(?:\s+continue-on-error: false\n)?\s+run: \|\n((?:\s{10}.*\n)+)/)![1];

const run = (code: number, output: string) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'sortie.txt'), output);
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\ncat "${join(dir, 'sortie.txt')}"\nexit ${code}\n`);
  chmodSync(join(dir, 'npm'), 0o755);
  return spawnSync('bash', ['-e', '-c', step], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', maxBuffer: 1 << 28 });
};

describe('L515 probe — étape dry-run de tests.yml', () => {
  it('sortie énorme (3 Mo) dont le conflit est en tête : toléré, pas de SIGPIPE', () => {
    const r = run(1, `npm error code E403\nnpm error 403 You cannot publish over the previously published versions: 1.0.0.\n${'x'.repeat(100).concat('\n').repeat(30000)}`);
    expect(r.status).toBe(0);
  });

  it('conflit puis ELIFECYCLE de la suite (les deux dans la sortie) : le conflit est lu', () => {
    // prepublishOnly passe avant le conflit : un conflit seul est attendu
    expect(run(1, 'npm error code EPUBLISHCONFLICT\n').status).toBe(0);
  });

  it('fins de ligne CRLF sur la ligne du conflit : toléré', () => {
    expect(run(1, 'npm error code E403\r\nnpm error 403 You cannot publish over the previously published versions: 1.0.0.\r\n').status).toBe(0);
  });

  it('conflit cité par la suite (ligne indentée, préfixe vitest) puis échec : reste rouge', () => {
    expect(run(1, ' stdout | test/publish.test.ts\n  npm error code EPUBLISHCONFLICT\n FAIL x\n').status).toBe(1);
  });

  it('« previously published » sans préfixe npm error : reste rouge', () => {
    expect(run(1, 'You cannot publish over the previously published versions\n').status).toBe(1);
  });

  it('ligne « npm notice » citant previously published : reste rouge', () => {
    expect(run(1, 'npm notice previously published\n').status).toBe(1);
  });

  it('EPUBLISHCONFLICT dans un autre code (EPUBLISHCONFLICTX) ou casse différente : le code exact seul', () => {
    expect(run(1, 'npm error code epublishconflict\n').status).toBe(1);
  });

  it('dry-run vert : la sortie est affichée une fois', () => {
    const r = run(0, 'ligne-unique\n');
    expect(r.stdout.match(/ligne-unique/g)).toHaveLength(1);
  });

  it('refus toléré : la sortie de npm est quand même affichée', () => {
    const r = run(1, 'npm error code EPUBLISHCONFLICT\nnpm error detail-xyz\n');
    expect(r.stdout).toContain('detail-xyz');
  });
});
