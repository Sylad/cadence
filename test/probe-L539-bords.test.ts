import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refDepartLot } from '../scripts/qualite.mjs';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, kindOf, precheckReport, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function parentWith(names: string[], yamlPriority = names) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    plan.add('lot', '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
  }
  writeFileSync(join(parent, 'cadence.yaml'), `priority: [${yamlPriority.join(', ')}]\n`);
  return parent;
}

function run(parent: string, args: string[], delay = 10) {
  const err: string[] = [];
  const i: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-10-04' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  const claude: ClaudeFn = async (a, o) => {
    const kind = kindOf(a);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const lot = /on lot `([^`]+)`/.exec(a[1])![1];
    await new Promise((r) => setTimeout(r, delay));
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return orchestrate(args, i, d).then((code) => ({ code, err, lots: RunStore.last(parent)?.readWave()?.lots.map((k) => k.split(':')[0]) }));
}

describe('L539 — --priority, bords du tirage lu dans la vague', () => {
  it('sans --priority : l’ordre du cadence.yaml parent (témoin)', async () => {
    const parent = parentWith(['a', 'b', 'c'], ['b', 'c', 'a']);
    expect((await run(parent, ['--continue', '--max-sessions', '2'])).lots).toEqual(['b', 'c', 'a']);
  });

  it('--priority c,b,a avec --max-sessions 1 : même ordre en série', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    expect((await run(parent, ['--continue', '--max-sessions', '1', '--priority', 'c,b,a'])).lots).toEqual(['c', 'b', 'a']);
  });

  it('--priority partiel (b) : b d’abord, les autres suivent sans doublon', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    const r = await run(parent, ['--continue', '--max-sessions', '2', '--priority', 'b']);
    expect(r.lots![0]).toBe('b');
    expect([...r.lots!].sort()).toEqual(['a', 'b', 'c']);
  });

  it('--priority avec un doublon (c,c,b,a) : chaque lot une seule fois', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    const r = await run(parent, ['--continue', '--max-sessions', '2', '--priority', 'c,c,b,a']);
    expect(r.lots).toEqual(['c', 'b', 'a']);
  });

  it('--priority nommant un dépôt inconnu : ne plante pas, le reste est tiré', async () => {
    const parent = parentWith(['a', 'b']);
    const r = await run(parent, ['--continue', '--max-sessions', '2', '--priority', 'zz,b,a']);
    expect(r.code).toBe(0);
    expect(r.lots).toEqual(['b', 'a']);
  });

  it('--priority sans --continue : refusé', async () => {
    const parent = parentWith(['a', 'b']);
    await expect(run(parent, ['--priority', 'b,a'])).rejects.toThrow(/--priority/);
  });

  it('--priority vide : refus net ou repli sur le cadence.yaml, jamais un tirage vide en succès', async () => {
    const parent = parentWith(['a', 'b'], ['b', 'a']);
    const r = await run(parent, ['--continue', '--max-sessions', '2', '--priority', '']).catch((e: Error) => e);
    if (r instanceof Error) expect(r.message).toMatch(/priority/);
    else expect(r.lots).toEqual(['b', 'a']);
  });

  it('le contrat tient 6 fois de suite avec trois sessions en parallèle (ordre de départ simultané)', async () => {
    for (let k = 0; k < 6; k++) {
      const parent = parentWith(['a', 'b', 'c']);
      expect((await run(parent, ['--continue', '--max-sessions', '3', '--priority', 'c,b,a'], k % 2 ? 0 : 25)).lots).toEqual(['c', 'b', 'a']);
    }
  }, 180_000); // L567 : six vagues complètes (neuf dépôts git, dix-huit worktrees) : 8 s seules, 30 s sous charge, le délai de 30 s par défaut tombait sur le travail, pas sur un blocage
});

describe('L539 — versions de la 1.42.1 alignées', () => {
  it('package.json, plugin.json, marketplace.json, lock et CHANGELOG disent la même version', async () => {
    const { readFileSync } = await import('node:fs');
    const j = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
    const v = j('package.json').version;
    expect(j('.claude-plugin/plugin.json').version).toBe(v);
    expect(j('.claude-plugin/marketplace.json').plugins[0].version).toBe(v);
    expect(j('package-lock.json').version).toBe(v);
    expect(j('package-lock.json').packages[''].version).toBe(v);
    expect(/^## \[(\d[^\]]*)\]/m.exec(readFileSync('CHANGELOG.md', 'utf8'))![1]).toBe(v);
  });
});

describe('L539 — cliquet contre origin/main', () => {
  it('node scripts/qualite.mjs --contre origin/main passe (comme tests.yml)', () => {
    // L645 : origin/main en retard sur main (vague en cours) donnerait un faux refus ; le départ du lot est alors main
    const r = execFileSync('node', ['scripts/qualite.mjs', '--contre', refDepartLot(process.cwd())], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r).toBeTypeOf('string');
  }, 300000);
});
