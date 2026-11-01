import { describe, expect, it } from 'vitest';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { waveReadsAdds } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { stillThird } from '../src/orchestrate/tiers.js';
import { addNotAlone } from '../src/orchestrate/ajout.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function parentWith(names: string[]) {
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
  return parent;
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out, err };
}

function scene(parent: string, holder: string, hold: (store: RunStore) => Promise<void>) {
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const project = o.cwd.split('/').pop()!;
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    if (`${project}:${lot}` === holder) await hold(RunStore.last(parent)!);
    else await new Promise((r) => setTimeout(r, 30));
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d };
}

describe('L421 — bords de --add', () => {
  it('le même lot donné deux fois dans un seul --add : refusé (code 2), rien déposé', async () => {
    const parent = parentWith(['a', 'b']);
    let seen: { code: number; queued: number; err: string } | undefined;
    const s = scene(parent, 'a:L1', async (store) => {
      const r = io(parent);
      seen = { code: await orchestrate(['--add', 'b:L1', '--add', 'b:L1'], r.io, s.d), queued: store.addQueue().length, err: r.err.join('\n') };
    });
    await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(seen).toMatchObject({ code: 2, queued: 0 });
  });

  it('un lot donné sans projet puis avec le nom du dossier de lancement : une seule demande déposée', async () => {
    const parent = parentWith(['a']);
    const base = parent.split('/').pop()!;
    let queued = -1;
    const s = scene(parent, 'a:L1', async (store) => {
      await orchestrate(['--add', `${base}:L1`, '--add', 'L1'], io(parent).io, s.d).catch(() => 0);
      queued = store.addQueue().length;
    });
    await orchestrate(['a:L1'], io(parent).io, s.d);
    expect(queued).toBeLessThanOrEqual(1);
  });

  it('arguments vides ou mal formés : lot invalide, jamais une demande', () => {
    for (const bad of ['', ':', 'a:', ':L1', 'a:L1@', 'a::L1']) expect(() => parseOrchestrateArgs(['--add', bad]), bad).toThrow();
  });

  it('--add avec --abandon-commits ou --watch : refusé comme les autres actions', async () => {
    const parent = parentWith(['a']);
    const d = scene(parent, 'x', async () => {}).d;
    await expect(orchestrate(['--add', 'a:L1', '--abandon-commits'], io(parent).io, d)).rejects.toThrow();
    await expect(orchestrate(['--add', 'a:L1', '--watch'], io(parent).io, d)).rejects.toThrow();
  });

  it('addNotAlone : --wave seul ne compte pas, --budget 0 compte', () => {
    expect(addNotAlone(parseOrchestrateArgs(['--add', 'a:L1', '--wave', 'w']))).toBe(false);
    expect(addNotAlone({ ...parseOrchestrateArgs(['--add', 'a:L1']), budget: 0 })).toBe(true);
  });

  it("la file adds.log : id texte, lot numérique, lot absent, modèle non texte, id répété", () => {
    const dir = tempDir();
    const store = RunStore.find(dir, 'x') ?? new RunStore(dir, 'x');
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(
      join(store.dir, 'adds.log'),
      ['{"id":"1","lot":"L1"}', '{"id":2,"lot":7}', '{"id":3}', '{"id":4,"lot":"L4","model":5}', '[]', 'null', '{"id":5,"lot":"L5","project":null}', '{"taken":99}', ''].join('\n'),
    );
    expect(store.addQueue()).toEqual([
      { id: 4, lot: 'L4' },
      { id: 5, lot: 'L5' },
    ]);
  });

  it('requestAdd : les numéros continuent après des demandes prises, un projet vide n\'est pas écrit', () => {
    const dir = tempDir();
    const store = new RunStore(dir, 'x');
    mkdirSync(store.dir, { recursive: true });
    const a = store.requestAdd({ project: '', lot: 'L1' });
    store.markAddTaken(a);
    const b = store.requestAdd({ lot: 'L2' });
    expect(b).toBe(a + 1);
    expect(store.addQueue()).toEqual([{ id: b, lot: 'L2' }]);
    store.markAddTaken(b);
    expect(store.requestAdd({ lot: 'L3' })).toBe(b + 1);
  });

  it('adds.log vide ou ne finissant pas par un saut de ligne : la demande suivante reste lisible', () => {
    const dir = tempDir();
    const store = new RunStore(dir, 'x');
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(join(store.dir, 'adds.log'), '{"id":1,"lot":"L1"}');
    const id = store.requestAdd({ lot: 'L2' });
    expect(id).toBe(2);
    expect(store.addQueue().map((e) => e.lot)).toEqual(['L1', 'L2']);
  });

  it('stillThird : vague vide, aucun dépôt avant, lot seul, dépôt partagé par un autre lot', () => {
    const rd = { head: 'h' } as never;
    expect(stillThird(new Map(), [], 'p:L1')).toEqual([]);
    expect(stillThird(new Map([['/r', rd]]), [], 'p:L1')).toHaveLength(1);
    expect(stillThird(new Map([['/r', rd]]), [{ project: 'p', lot: 'L1', repo: '/x' } as never], 'p:L1')).toHaveLength(1);
    expect(stillThird(new Map([['/r', rd]]), [{ project: 'q', lot: 'L2', repo: '/r' } as never], 'p:L1')).toHaveLength(0);
    expect(stillThird(new Map([['/r', rd]]), [{ project: 'p', lot: 'L1', repo: '/r' } as never], 'p:L1')).toHaveLength(1);
  });

  it("waveReadsAdds : instantané présent mais state.js absent → la vague est tenue pour ne pas lire la file", () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'tool', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'tool', 'bin', 'cadence.js'), '');
    expect(waveReadsAdds(dir)).toBe(false);
  });
});
