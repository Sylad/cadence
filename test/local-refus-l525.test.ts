import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { sharedStateDir } from '../src/state.js';
import { gitRepo, tempDir } from './helpers.js';

// L525 — `deliver` et `raf move` pendant une tâche locale du lead (L519) : le refus nomme la tâche locale (heldRefusal), pas une vague « état illisible ».

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

/** Un dépôt de deux lots dont L1 est une tâche locale en cours (verrou déclaré). */
async function avecTacheLocale() {
  const dir = gitRepo();
  await cli(dir, 'init', '--project', 'demo', '--no-hook');
  await cli(dir, 'add', 'un', '--local');
  await cli(dir, 'add', 'deux');
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n');
  mkdirSync(sharedStateDir(dir), { recursive: true });
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'local:L1', started: '2026-11-02T09:00:00.000Z', until: '2099-01-01T00:00:00.000Z' }));
  return dir;
}

describe('refus pendant une tâche locale (L525)', () => {
  it('R1 — raf move nomme la tâche locale et sa sortie, plan inchangé', async () => {
    const dir = await avecTacheLocale();
    const avant = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
    const r = await cli(dir, 'move', 'L2', '--before', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('move : ');
    expect(r.err).toContain('une tâche locale du lead y est en cours (L1, depuis 2026-11-02T09:00:00.000Z)');
    expect(r.err).toContain('cadence local done L1');
    expect(r.err).not.toContain('vague local:L1');
    expect(r.err).not.toContain('illisible');
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toBe(avant);
  });

  it('R2 — deliver sans --sha nomme la tâche locale, sans conseil de --sha', async () => {
    const dir = await avecTacheLocale();
    const r = await cli(dir, 'deliver', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('une tâche locale du lead y est en cours (L1');
    expect(r.err).not.toContain('--sha');
    expect(r.err).not.toContain('vague local:L1');
  });

  it('R3 — deliver --sha pendant une tâche locale : même refus, pas « état de la vague illisible »', async () => {
    const dir = await avecTacheLocale();
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', 'HEAD');
    expect(r.code).toBe(2);
    expect(r.err).toContain('une tâche locale du lead y est en cours (L1');
    expect(r.err).not.toContain('illisible');
    expect(r.err).not.toContain('--sha');
  });
});
