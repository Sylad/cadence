import { describe, expect, it } from 'vitest';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, reviewReport, precheckReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function parentWith(names: string[], lotsOf: Record<string, number> = {}) {
  const parent = tempDir();
  for (const n of names) repoAt(join(parent, n), n, lotsOf[n] ?? 1);
  writeFileSync(join(parent, 'cadence.yaml'), `priority: [${names.join(', ')}]\n`);
  return parent;
}

function io(cwd: string) {
  const out: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out };
}


const journal = (parent: string) => readFileSync(join(RunStore.last(parent)!.dir, 'journal.log'), 'utf8');


/** a:L1 tient la vague jusqu'à ce que `hold` rende la main. */
function holdScene(parent: string, hold: () => Promise<void>) {
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    if (lot === 'L1') await hold();
    else await new Promise((r) => setTimeout(r, 30));
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d };
}

describe('L587 — correctifs de la revue', () => {
  it("R6 — un cadence.yaml parent rendu illisible pendant la vague passe le tirage de ce regard, dit au journal, sans tuer le pool", async () => {
    const parent = parentWith(['a', 'b']);
    const s = holdScene(parent, async () => {
      writeFileSync(join(parent, 'cadence.yaml'), 'priority: nope\n');
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(RunStore.last(parent)!.readWave()!.status).not.toBe('interrupted');
    expect(journal(parent)).toMatch(/remplissage : priority: illisible, tirage passé/);
  });

  it("R7 — --continue --no-fill refuse avant d'agir une clé priority: illisible", async () => {
    const parent = parentWith(['a']);
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: nope\n');
    await expect(orchestrate(['a:L1', '--continue', '--no-fill'], io(parent).io, holdScene(parent, async () => {}).d)).rejects.toThrow(/priority/);
    expect(RunStore.last(parent)).toBeNull();
  });
});
