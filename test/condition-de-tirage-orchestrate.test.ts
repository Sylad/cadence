import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidates } from '../src/orchestrate/continue.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, git, precheckReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Projet « a » : `done` lots spec: true terminés, un lot G à gate (count 8), et les lots en plus. */
function projectWith(done: number, gateLine = '{ count: 8, spec: true }', extra = '', gStatus = 'todo') {
  const parent = tempDir();
  const dir = join(parent, 'a');
  mkdirSync(join(dir, 'docs/plan'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const lots = Array.from({ length: done }, (_, i) => `  - { id: S${i + 1}, title: Spec ${i + 1}, status: done, spec: true, finished: 2026-09-20 }\n`).join('');
  writeFileSync(join(dir, 'docs/plan/raf.yaml'), `project: a\nprefix: L\nlots:\n${lots}  - { id: G, title: Lot à gate, status: ${gStatus}, gate: ${gateLine} }\n${extra}`);
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return { parent, dir };
}

function launch(parent: string, argv: string[]) {
  const calls: string[] = [];
  const claude: ClaudeFn = async (args) => {
    calls.push(args.join(' ').slice(0, 40));
    return claudeOut(precheckReport());
  };
  const deps: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  const out: string[] = [];
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-10-15' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-15T14:12:00') };
  return orchestrate(argv, io, deps).then((code) => {
    removeDryRunBriefs(out.join('\n'));
    return { code, out: out.join('\n'), err: err.join('\n'), calls };
  });
}

describe('condition de tirage — orchestrate (L219)', () => {
  it('R2 — --continue ne tire pas le lot à condition non remplie', () => {
    const { parent } = projectWith(2, undefined, '  - { id: N, title: Libre, status: todo }\n');
    expect(candidates(parent, { priority: [], exclude: new Set(), remaining: 1e9 }).map((c) => c.lot.id)).toEqual(['N']);
  });

  it('A3 — le lot est refusé avec le compte courant (code 2)', async () => {
    const { parent } = projectWith(2);
    const r = await launch(parent, ['a:G']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:G : condition de tirage non remplie : 2/8 lots spec: true faits');
    expect(r.calls).toEqual([]);
  });

  it('R8 — refus avant l\'arbre sale et avant tout lancement de session', async () => {
    const { parent, dir } = projectWith(2);
    writeFileSync(join(dir, 'docs/plan/raf.yaml'), `${readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')}# sale\n`);
    const r = await launch(parent, ['a:G']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('condition de tirage non remplie');
    expect(r.err).not.toContain('arbre sale');
    expect(r.calls).toEqual([]);
  });

  it('R8 — un lot spec: true placé plus tôt dans la même vague ne lève pas la condition', async () => {
    const { parent } = projectWith(0, '{ count: 1, spec: true }', '  - { id: T, title: Spec à faire, status: todo, spec: true }\n');
    const r = await launch(parent, ['a:T', 'a:G']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:G : condition de tirage non remplie : 0/1 lots spec: true faits');
  });

  it('R3 — compte 8 sur 8 : orchestrate accepte le lot', async () => {
    const { parent } = projectWith(8);
    const r = await launch(parent, ['a:G', '--dry-run']);
    expect(r.err).not.toContain('condition de tirage');
    expect(r.code).toBe(0);
  });

  it('R6 — lot doing à condition non remplie : non refusé pour ce motif', async () => {
    const { parent } = projectWith(2, undefined, '', 'doing');
    const r = await launch(parent, ['a:G', '--dry-run']);
    expect(r.err).not.toContain('condition de tirage');
  });

  it('R7 — gate mal formé : jamais tirable, refus nommant la faute', async () => {
    const { parent } = projectWith(9, '{ count: 0, spec: true }');
    const r = await launch(parent, ['a:G', '--dry-run']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:G : condition de tirage non remplie');
  });
});
