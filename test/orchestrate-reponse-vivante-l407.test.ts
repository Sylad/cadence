import { describe, expect, it } from 'vitest';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { waveReadsAnswerQueue } from '../src/orchestrate/snapshot.js';
import { cadenceHome, freeSlots, liveWaves, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { briefOf, claudeOut, commitFile, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { fake as treeFake, inWorktree, lotOf, run as treeRun, setup as treeSetup, store as treeStore, until } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function parentWith(names: string[], lotsOf: Record<string, number> = {}) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (let i = 0; i < (lotsOf[name] ?? 1); i++) plan.add('lot', '2026-10-01', { estimate: 1 });
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

const wait = async (until: () => boolean) => {
  for (let i = 0; i < 300 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(until()).toBe(true);
};

/** a pose sa question à sa première écriture ; b tourne (sa session ne finit que quand `release()` le dit). */
function scene(parent: string, onB: (store: RunStore) => Promise<void>) {
  const briefs: { project: string; kind: string; brief: string }[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    const project = o.cwd.split('/').pop()!;
    briefs.push({ project, kind, brief: briefOf(args) });
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    if (project === 'a' && briefs.filter((x) => x.project === 'a' && x.kind === 'implement').length === 1) return claudeOut(workReport({ questions: ['Quelle base ?'] }));
    if (project === 'b') {
      const store = RunStore.last(parent)!;
      await wait(() => store.readLot('a', 'L1')?.status === 'question');
      await onB(store);
    }
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, briefs };
}

describe('L407 — réponse sur une vague vivante', () => {
  it("R1 — --answer est accepté pendant qu'un autre lot tourne, et la vague vivante rejoue le lot avec la réponse avant la fin de l'autre lot", async () => {
    const parent = parentWith(['a', 'b']);
    let said = '';
    let replayedWhileBRuns = false;
    const s = scene(parent, async (store) => {
      const r = io(parent);
      expect(await orchestrate(['--answer', 'a:L1', 'la base est main'], r.io, s.d)).toBe(0);
      said = r.out.join('\n');
      await wait(() => s.briefs.filter((x) => x.project === 'a' && x.kind === 'implement').length === 2);
      replayedWhileBRuns = store.readLot('b', 'L1')!.status !== 'ready';
    });
    const r = io(parent);
    expect(await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], r.io, s.d)).toBe(0);
    expect(said).toMatch(/a:L1 : réponse déposée/);
    expect(replayedWhileBRuns).toBe(true);
    const second = s.briefs.filter((x) => x.project === 'a' && x.kind === 'implement')[1];
    expect(second.brief).toContain('la base est main');
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('a', 'L1')!.answers).toEqual(['la base est main']);
    expect(store.readWave()!.status).toBe('done');
  });

  it("R2 — la forme documentée (--resume --wave <vague> --answer) sur une vague vivante dépose la réponse au lieu de refuser « tourne encore », sans rien jouer ; avec une autre option de reprise, le refus reste", async () => {
    const parent = parentWith(['a']);
    const calls: string[] = [];
    const base = scene(parent, async () => {}).d;
    const asking: OrchestrateDeps = { ...base, claude: async (args, o) => (kindOf(args) === 'implement' ? claudeOut(workReport({ questions: ['Quelle base ?'] })) : base.claude(args, o)) };
    expect(await orchestrate(['a:L1'], io(parent).io, asking)).toBe(1);
    const store = RunStore.last(parent)!;
    const spy: OrchestrateDeps = { ...base, claude: async (args, o) => { calls.push(kindOf(args)); return base.claude(args, o); } };
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: 'x', cwd: parent, repos: [] });
    try {
      const r = io(parent);
      expect(await orchestrate(['--resume', '--wave', store.id, '--answer', 'a:L1', 'main'], r.io, spy)).toBe(0);
      expect(r.out.join('\n')).toMatch(/a:L1 : réponse déposée/);
      expect(store.answerQueue().map((e) => [e.lot, e.text])).toEqual([['a:L1', 'main']]);
      expect(calls).toEqual([]);
      expect(store.readLot('a', 'L1')!.status).toBe('question');
      expect(store.readLot('a', 'L1')!.pendingAnswer ?? null).toBeNull();
      const refused = io(parent);
      expect(await orchestrate(['--resume', '--wave', store.id, '--answer', 'a:L1', 'main', '--budget', '1M'], refused.io, spy)).toBe(2);
      expect(refused.err.join('\n')).toMatch(/tourne encore/);
      expect(store.answerQueue()).toHaveLength(1);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it("R3 — un lot qui n'attend pas de réponse, ou inconnu, est refusé (code 2) et rien n'est déposé", async () => {
    const parent = parentWith(['a', 'b']);
    const out: { code: number; err: string }[] = [];
    const s = scene(parent, async (store) => {
      for (const target of ['b:L1', 'z:L9']) {
        const r = io(parent);
        out.push({ code: await orchestrate(['--answer', target, 'x'], r.io, s.d), err: r.err.join('\n') });
      }
      expect(store.answerQueue()).toEqual([]);
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(out.map((o) => o.code)).toEqual([2, 2]);
    expect(out[0].err).toMatch(/b:L1 : le lot n'attend pas de réponse/);
    expect(out[1].err).toMatch(/z:L9 : lot inconnu/);
  });

  it('R3 — --answer sans aucune vague vivante dans ce dossier : refusé (code 2), il renvoie à --resume', async () => {
    const parent = parentWith(['a']);
    const r = io(parent);
    expect(await orchestrate(['--answer', 'a:L1', 'x'], r.io, scene(parent, async () => {}).d)).toBe(2);
    expect(r.err.join('\n')).toMatch(/aucune vague en cours[\s\S]*--resume/);
  });

  it("R4 — la réponse n'est jouée qu'une fois : deux réponses déposées pour le même lot, la seconde est écartée et dite au journal", async () => {
    const parent = parentWith(['a', 'b']);
    const s = scene(parent, async (store) => {
      expect(await orchestrate(['--answer', 'a:L1', 'première'], io(parent).io, s.d)).toBe(0);
      expect(await orchestrate(['--answer', 'a:L1', 'seconde'], io(parent).io, s.d)).toBe(0);
      await wait(() => s.briefs.filter((x) => x.project === 'a' && x.kind === 'implement').length === 2);
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], io(parent).io, s.d);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.answers).toEqual(['première']);
    expect(s.briefs.filter((x) => x.project === 'a' && x.kind === 'implement')).toHaveLength(2);
    expect(store.answerQueue()).toEqual([]);
    expect(readFileSync(join(store.dir, 'journal.log'), 'utf8')).toMatch(/a:L1 : réponse écartée/);
  });

  it("R5 — une réponse déposée pour un lot qui n'est plus en question est écartée, jamais jouée", async () => {
    const parent = parentWith(['a', 'b']);
    const s = scene(parent, async (store) => {
      store.requestAnswer('b:L1', 'perdue'); // b tourne : il n'attend rien
      expect(await orchestrate(['--drop', 'a:L1'], io(parent).io, s.d)).toBe(0);
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], io(parent).io, s.d);
    const store = RunStore.last(parent)!;
    expect(store.readLot('b', 'L1')!.answers).toEqual([]);
    expect(store.answerQueue()).toEqual([]);
    expect(readFileSync(join(store.dir, 'journal.log'), 'utf8')).toMatch(/b:L1 : réponse écartée/);
  });

  it("R6 — la file : ajout, relecture, marque « prise » ; absente, elle est vide et n'est pas prise pour un lot", () => {
    const store = new RunStore(tempDir(), 'w1');
    expect(store.answerQueue()).toEqual([]);
    const a = store.requestAnswer('a:L1', 'un\ndeux "citation"');
    const b = store.requestAnswer('b:L2', 'trois');
    expect(store.answerQueue().map((e) => [e.lot, e.text])).toEqual([['a:L1', 'un\ndeux "citation"'], ['b:L2', 'trois']]);
    store.markAnswerTaken(a);
    expect(store.answerQueue().map((e) => e.id)).toEqual([b]);
    expect(store.lots()).toEqual([]);
    writeFileSync(join(store.dir, 'answers.log'), `${readFileSync(join(store.dir, 'answers.log'), 'utf8')}{pas du json\n`);
    expect(store.answerQueue().map((e) => e.id)).toEqual([b]); // une ligne illisible est ignorée
  });

  it("R7 — une vague d'avant L407 ne lit pas la file : la réponse est refusée (code 2) et rien n'est écrit", async () => {
    const parent = parentWith(['a', 'b']);
    let seen: { code: number; err: string; queued: number } | undefined;
    const s = scene(parent, async (store) => {
      mkdirSync(join(store.dir, 'tool', 'bin'), { recursive: true });
      mkdirSync(join(store.dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
      writeFileSync(join(store.dir, 'tool', 'bin', 'cadence.js'), '');
      writeFileSync(join(store.dir, 'tool', 'dist', 'orchestrate', 'state.js'), '// avant L407 : control.log\n');
      const r = io(parent);
      seen = { code: await orchestrate(['--answer', 'a:L1', 'x'], r.io, s.d), err: r.err.join('\n'), queued: store.answerQueue().length };
      writeFileSync(join(store.dir, 'tool', 'dist', 'orchestrate', 'state.js'), "join(this.dir, 'answers.log')\n");
      expect(waveReadsAnswerQueue(store.dir)).toBe(true);
    });
    await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(seen).toMatchObject({ code: 2, queued: 0 });
    expect(seen!.err).toMatch(/ne lit pas la file de réponses/);
  });

  it('R7 — sans instantané (vague jouée dans ce processus ou antérieure à L61) : on suppose que la vague lit la file', () => {
    expect(waveReadsAnswerQueue(tempDir())).toBe(true);
  });

  it("R8 — --answer ne se combine pas avec --drop, --stop-after-current, --budget ni des lots à lancer", async () => {
    const parent = parentWith(['a']);
    const d = scene(parent, async () => {}).d;
    for (const extra of [['--drop', 'a:L1'], ['--stop-after-current'], ['--budget', '1M'], ['a:L1']]) {
      await expect(orchestrate(['--answer', 'a:L1', 'x', ...extra], io(parent).io, d)).rejects.toThrow(/ne se combine/);
    }
  });

  it("R9 — deux réponses prises au même tour pour deux lots du même dépôt ne partent pas ensemble : jamais deux sessions dans un même dépôt", async () => {
    const parent = parentWith(['a', 'b'], { a: 2 });
    let inA = 0;
    let maxA = 0;
    const asked = new Set<string>();
    const claude: ClaudeFn = async (args, o) => {
      const kind = kindOf(args);
      const project = o.cwd.split('/').pop()!;
      if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      const store = RunStore.last(parent)!;
      if (project === 'a' && !asked.has(lot)) {
        asked.add(lot);
        return claudeOut(workReport({ questions: ['Quelle base ?'] }));
      }
      if (project === 'b') {
        await wait(() => store.readLot('a', 'L1')?.status === 'question' && store.readLot('a', 'L2')?.status === 'question');
        expect(await orchestrate(['--answer', 'a:L1', 'x', '--answer', 'a:L2', 'y'], io(parent).io, d)).toBe(0);
        await wait(() => store.readLot('a', 'L1')?.status === 'ready' && store.readLot('a', 'L2')?.status === 'ready');
      } else {
        maxA = Math.max(maxA, ++inA);
        await new Promise((r) => setTimeout(r, 60));
        inA--;
      }
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
    };
    const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
    await orchestrate(['a:L1', 'a:L2', 'b:L1', '--max-sessions', '3'], io(parent).io, d);
    expect(maxA).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('a', 'L2')!.status).toBe('ready');
  });

  it("R9bis — deux réponses déposées SÉPARÉMENT alors que les créneaux sont pleins : la seconde attend la file de la première, jamais deux sessions dans un même dépôt", async () => {
    const parent = parentWith(['a', 'b', 'c'], { a: 2 });
    let inA = 0;
    let maxA = 0;
    let cStarted = false;
    let released = false;
    const asked = new Set<string>();
    const claude: ClaudeFn = async (args, o) => {
      const kind = kindOf(args);
      const project = o.cwd.split('/').pop()!;
      if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      const store = RunStore.last(parent)!;
      if (project === 'a' && !asked.has(lot)) {
        asked.add(lot);
        return claudeOut(workReport({ questions: ['Quelle base ?'] }));
      }
      if (project === 'b') {
        // b et c tiennent les deux créneaux ; les deux lots de a sont en question.
        await wait(() => cStarted && store.readLot('a', 'L1')?.status === 'question' && store.readLot('a', 'L2')?.status === 'question');
        expect(await orchestrate(['--answer', 'a:L1', 'x'], io(parent).io, d)).toBe(0);
        await new Promise((r) => setTimeout(r, 150));
        expect(await orchestrate(['--answer', 'a:L2', 'y'], io(parent).io, d)).toBe(0);
        await new Promise((r) => setTimeout(r, 150));
        released = true;
      } else if (project === 'c') {
        cStarted = true;
        await wait(() => released);
      } else {
        maxA = Math.max(maxA, ++inA);
        await new Promise((r) => setTimeout(r, 60));
        inA--;
      }
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
    };
    const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
    await orchestrate(['a:L1', 'a:L2', 'b:L1', 'c:L1', '--max-sessions', '2'], io(parent).io, d);
    expect(maxA).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('a', 'L2')!.status).toBe('ready');
  });

  it('R10 — en worktrees : le lot répondu rejoue dans son worktree PENDANT que l\'autre lot du même dépôt tourne, et le registre compte de nouveau son créneau (2 files, 0 libre sur 2)', async () => {
    const { parent } = treeSetup([{ title: 'un' }, { title: 'deux' }]);
    let asked = false;
    let l2Done = false;
    let seen: { lanes: number | undefined; free: number; tree: boolean; l2Running: boolean } | undefined;
    const f = treeFake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        if (lot === 'L1' && !asked) {
          asked = true;
          return claudeOut(workReport({ questions: ['Quelle base ?'] }));
        }
        if (lot === 'L1') {
          // Le rejeu de L1 : L2 joue encore, la vague tient deux créneaux et doit le dire au registre.
          const w = liveWaves(cadenceHome()).find((x) => x.pid === process.pid)!;
          seen = { lanes: w.lanes, free: freeSlots([w], 2), tree: inWorktree(cwd), l2Running: !l2Done };
        } else {
          const s = treeStore(parent);
          await until(() => s.readLot('a', 'L1')?.status === 'question');
          expect((await treeRun(parent, ['--answer', 'a:L1', 'main'], f, { slotPollMs: 20 })).code).toBe(0);
          await until(() => !!seen);
          l2Done = true;
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await treeRun(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, { slotPollMs: 20 });
    expect(r.code).toBe(0);
    expect(seen).toEqual({ lanes: 2, free: 0, tree: true, l2Running: true });
    expect(f.calls.filter((c) => c.lot === 'L1' && c.kind === 'implement').map((c) => inWorktree(c.cwd))).toEqual([true, true]); // la reprise retrouve le worktree (ensureTree)
    const s = treeStore(parent);
    expect(s.readLot('a', 'L1')!.status).toBe('ready');
    expect(s.readLot('a', 'L2')!.status).toBe('ready');
    expect(s.readWave()!.status).toBe('done');
  });
});
