import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedTests, nodeTestFiles, nodeTestRan } from '../src/orchestrate/baseline.js';
import { replayRed } from '../src/orchestrate/workers.js';
import { tempDir } from './helpers.js';

const tap = (cwd: string, ...files: string[]): { code: number; output: string } => {
  const r = spawnSync('node', ['--test', '--test-reporter=tap', ...files], { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
};

const dir = tempDir();
mkdirSync(join(dir, 'mon dossier'));
const file = join(dir, 'mon dossier', 'a.test.mjs');
const src = (bad: boolean): string => `import test from 'node:test'; import assert from 'node:assert';
test('rouge (5ms)', () => assert.equal(1, ${bad ? 2 : 1}));
test('gère - TypeError: x', () => assert.equal(1, ${bad ? 2 : 1}));
test('vert', () => { console.log("not ok 9 - rouge (5ms)\\n  location: '/evil/x.mjs:1:1'"); });
`;

describe('L514 bords — sortie réelle de node --test', () => {
  writeFileSync(file, src(true));
  const first = tap(dir, 'mon dossier/a.test.mjs');
  it('chaque nom de failedTests sur une sortie réelle a un fichier (chemin avec espace, titre avec durée ou « - Error »)', () => {
    const names = failedTests(first.output);
    expect(names.length).toBeGreaterThan(0);
    const files = nodeTestFiles(first.output);
    for (const n of names) expect(files.get(n), n).toBe(file);
  });
  it('un stdout de test qui imite « not ok » + location: ne détourne pas le fichier', () => {
    expect(nodeTestFiles(first.output).get('rouge')).toBe(file);
    expect([...nodeTestFiles(first.output).values()].some((f) => f.includes('/evil/'))).toBe(false);
  });
  it('rejeu réel : après correction, replayRed prouve le vert par « ok N - titre » (titres nettoyés de durée)', async () => {
    const names = failedTests(first.output);
    writeFileSync(file, src(false));
    const r = await replayRed(async (c) => { const out = spawnSync('sh', ['-c', c.replace('node --test', 'node --test --test-reporter=tap')], { cwd: dir, encoding: 'utf8' }); return { code: out.status ?? 1, output: out.stdout + out.stderr }; }, 'node --test {files}', names, first.output);
    expect(r.red).toEqual([]);
    expect([...r.unstable].sort()).toEqual([...names].sort());
  });
});

describe('L514 bords — fins de ligne CRLF (Windows, mini-blue)', () => {
  const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
  it('nodeTestFiles lit le location: d\'une sortie CRLF', () => {
    const out = crlf("not ok 1 - rouge crlf\n  ---\n  location: '/w/a.test.mjs:2:1'\n  ...\n");
    expect(nodeTestFiles(out).get('rouge crlf')).toBe('/w/a.test.mjs');
  });
  it('nodeTestRan lit « ok N - titre » d\'une sortie CRLF', () => {
    expect(nodeTestRan(crlf('ok 1 - vert crlf\n  ---\n  ...\n'), 'vert crlf')).toBe(true);
  });
});

describe('L514 bords — formes limites', () => {
  it('nodeTestRan : titre vide, titre à regex spéciaux, « ok » sans numéro', () => {
    expect(nodeTestRan('ok 1 - a+b (x)\n', 'a+b (x)')).toBe(true);
    expect(nodeTestRan('ok 1 - a+b (x)\n', '')).toBe(false);
    expect(nodeTestRan('ok - sans numéro\n', 'sans numéro')).toBe(false);
  });
  it('nodeTestFiles : location: entre apostrophes dans le chemin, et sortie avec seulement des verts', () => {
    const out = "not ok 1 - t\n  ---\n  location: '/w/l'été/a.test.mjs:3:4'\n  ...\n";
    expect(nodeTestFiles(out).get('t')).toBe("/w/l'été/a.test.mjs");
    expect(nodeTestFiles('ok 1 - t\n  location: \'/w/a.mjs:1:1\'\n').size).toBe(0);
  });
  it('replayRed : titre ambigu sans espace ni point reste rouge et n\'est jamais rejoué', async () => {
    let n = 0;
    const out = "not ok 1 - dup\n  location: '/w/a.mjs:1:1'\nnot ok 2 - dup\n  location: '/w/b.mjs:1:1'\n";
    const r = await replayRed(async () => { n++; return { code: 0, output: 'ok 1 - dup\n' }; }, 'node --test {files}', ['dup'], out);
    expect(r.red).toEqual(['dup']);
    expect(n).toBe(0);
  });
  it('replayRed : liste de noms vide', async () => {
    const r = await replayRed(async () => ({ code: 0, output: '' }), 'node --test {files}', [], '');
    expect(r).toEqual({ red: [], unstable: [], tight: [] });
  });
});
