import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { sharedStateDir } from '../src/state.js';
import { waveHolding } from '../src/repo-busy.js';
import { gitRepo, tempDir } from './helpers.js';

// L525 (bords) — le refus d'une tâche locale doit être le même partout où le verrou du dépôt est lu.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

async function cli(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function avecTacheLocale(lock: Record<string, unknown> = {}) {
  const dir = gitRepo();
  await cli(dir, 'init', '--project', 'demo', '--no-hook');
  await cli(dir, 'add', 'un', '--local');
  await cli(dir, 'add', 'deux');
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n');
  mkdirSync(sharedStateDir(dir), { recursive: true });
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'local:L1', started: '2026-11-02T09:00:00.000Z', until: '2099-01-01T00:00:00.000Z', ...lock }));
  return dir;
}

describe('bords du refus de tâche locale (L525)', () => {
  it('spec reseal pendant une tâche locale ne parle pas de « vague local:L1 » ni d\'état illisible', async () => {
    const dir = await avecTacheLocale();
    const r = await cli(dir, 'spec', 'reseal', 'L2', 'x.test.ts', '--reason', 'parce que');
    expect(r.code).not.toBe(0);
    expect(r.err).not.toContain('vague local:L1');
    expect(r.err).not.toContain('illisible');
  });

  it('spec green pendant une tâche locale ne parle pas de « vague local:L1 »', async () => {
    const dir = await avecTacheLocale();
    const r = await cli(dir, 'spec', 'green', 'L2');
    expect(r.code).not.toBe(0);
    expect(r.err).not.toContain('vague local:L1');
    expect(r.err).not.toContain('illisible');
  });

  it('move avec un identifiant de lot inconnu garde son refus propre (pas celui de la tâche locale)', async () => {
    const dir = await avecTacheLocale();
    const r = await cli(dir, 'move', 'L99', '--before', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('tâche locale');
  });

  it('TTL échu : move refuse toujours en nommant la tâche locale', async () => {
    const dir = await avecTacheLocale({ until: '2020-01-01T00:00:00.000Z' });
    const avant = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
    const r = await cli(dir, 'move', 'L2', '--before', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('une tâche locale du lead y est en cours (L1');
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toBe(avant);
  });

  it('wave « local: » sans lot (nom vide) ne plante pas move', async () => {
    const dir = await avecTacheLocale({ wave: 'local:' });
    const r = await cli(dir, 'move', 'L2', '--before', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('TypeError');
    expect(r.err).not.toContain('illisible');
  });

  it('deliver deux fois : même refus, aucune écriture du verrou', async () => {
    const dir = await avecTacheLocale();
    const lockPath = join(sharedStateDir(dir), REPO_LOCK);
    const a = await cli(dir, 'deliver', '--dry-run');
    const b = await cli(dir, 'deliver', '--dry-run');
    expect(b.err).toBe(a.err);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).wave).toBe('local:L1');
  });

  it('waveHolding sans nom de commande rend toujours le verrou local (autres appelants)', async () => {
    const dir = await avecTacheLocale();
    expect(waveHolding(dir)?.wave).toBe('local:L1');
    expect(() => waveHolding(dir, '')).not.toThrow();
  });

  it('waveHolding : dépôt sans verrou → null même avec un nom de commande', () => {
    expect(waveHolding(gitRepo(), 'deliver')).toBeNull();
  });

  it('deliver --sha avec une vague "local:L1" : le refus ne conseille pas --sha', async () => {
    const dir = await avecTacheLocale();
    const r = await cli(dir, 'deliver', '--sha', 'zzzz');
    expect(r.code).toBe(2);
    expect(r.err).not.toContain('--sha');
  });
});
