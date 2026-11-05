import { describe, expect, it } from 'vitest';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, reviewReport, precheckReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function repoAt(dir: string, name: string, lots = 1) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
  for (let i = 0; i < lots; i++) plan.add('lot', '2026-10-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
}

function io(cwd: string) {
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: () => {}, err: () => {}, now: () => new Date('2026-10-04T14:12:00') };
  return i;
}

function scene() {
  const played: string[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    played.push(lot);
    await new Promise((r) => setTimeout(r, 20));
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, played };
}

describe('L596 probe — dépôt seul, indépendant de ses frères', () => {
  it('dépôt seul avec des frères non-git et un dossier vide dans son parent : code 0, L1 joué', async () => {
    const parent = tempDir();
    mkdirSync(join(parent, 'vide'));
    mkdirSync(join(parent, 'pas-un-depot'));
    writeFileSync(join(parent, 'pas-un-depot', 'x.txt'), 'x');
    const repo = join(parent, 'solo');
    repoAt(repo, 'solo', 2);
    const s = scene();
    expect(await orchestrate(['L1', '--max-sessions', '2'], io(repo), s.d)).toBe(0);
    expect(s.played).toContain('L1');
  });

  it('deux vagues de suite sur le même dépôt seul : la seconde ne plante pas', async () => {
    const repo = join(tempDir(), 'solo');
    repoAt(repo, 'solo', 3);
    const s = scene();
    expect(await orchestrate(['L1', '--max-sessions', '1'], io(repo), s.d)).toBe(0);
    expect(await orchestrate(['L2', '--max-sessions', '1'], io(repo), s.d)).toBe(0);
    expect(s.played).toEqual(expect.arrayContaining(['L1', 'L2']));
  });

  it('dépôt seul avec un parent dont cadence.yaml est vide : code 0', async () => {
    const parent = tempDir();
    writeFileSync(join(parent, 'cadence.yaml'), '');
    const repo = join(parent, 'solo');
    repoAt(repo, 'solo', 2);
    const s = scene();
    expect(await orchestrate(['L1', '--max-sessions', '2'], io(repo), s.d)).toBe(0);
    expect(s.played).toContain('L1');
  });
});
