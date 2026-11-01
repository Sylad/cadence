import { describe, expect, it } from 'vitest';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { waveReadsAdds } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AddFeed, type AddEnv } from '../src/orchestrate/ajout.js';
import { REPO_LOCK, releaseLock, takeLock } from '../src/orchestrate/lock.js';
import { sharedStateDir } from '../src/state.js';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Des projets sous un même dossier parent ; `chain` : le lot L2 du projet vient après son L1. */
function parentWith(names: string[], lotsOf: Record<string, number> = {}, chain: string[] = []) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (let i = 0; i < (lotsOf[name] ?? 1); i++) plan.add('lot', '2026-10-01', { estimate: 1, ...(chain.includes(name) && i === 1 ? { after: ['L1'] } : {}) });
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
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(until()).toBe(true);
};

/** Les sessions du lot `holder` (projet:lot) tiennent la vague jusqu'à ce que `hold` rende la main ; les autres finissent tout de suite. `played` : les écritures, dans l'ordre de départ ; `maxIn` : le plus de sessions d'écriture à la fois par projet. */
function scene(parent: string, holder: string, hold: (store: RunStore) => Promise<void>) {
  const played: string[] = [];
  const inRepo = new Map<string, number>();
  const maxIn = new Map<string, number>();
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const project = o.cwd.split('/').pop()!;
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    played.push(`${project}:${lot}`);
    inRepo.set(project, (inRepo.get(project) ?? 0) + 1);
    maxIn.set(project, Math.max(maxIn.get(project) ?? 0, inRepo.get(project)!));
    try {
      if (`${project}:${lot}` === holder) await hold(RunStore.last(parent)!);
      else await new Promise((r) => setTimeout(r, 30));
    } finally {
      inRepo.set(project, inRepo.get(project)! - 1);
    }
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, played, maxIn };
}

describe('L421 — ajouter un lot à une vague vivante', () => {
  it("R1 — --add projet:lot dépose le lot ; la vague vivante le joue (un autre dépôt, en parallèle) avant la fin du lot qui la tient, et l'inscrit dans wave.json", async () => {
    const parent = parentWith(['a', 'b']);
    let said = '';
    let bStatusWhileAHolds = '';
    const s = scene(parent, 'a:L1', async (store) => {
      const r = io(parent);
      expect(await orchestrate(['--add', 'b:L1'], r.io, s.d)).toBe(0);
      said = r.out.join('\n');
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
      bStatusWhileAHolds = `${store.readLot('b', 'L1')!.status}/${store.readLot('a', 'L1')!.status}`;
    });
    // a et b sont frères : b est un dépôt tiers de la session de a au départ ; ses commits, une fois le lot ajouté, ne sont pas un incident
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(said).toMatch(/b:L1 : ajout déposé/);
    expect(bStatusWhileAHolds).toMatch(/^ready\/(?!ready)/);
    const store = RunStore.last(parent)!;
    expect(store.readWave()!.lots).toEqual(['a:L1', 'b:L1']);
    expect(store.readWave()!.status).toBe('done');
    expect(store.addQueue()).toEqual([]);
    expect(readFileSync(join(store.dir, 'journal.log'), 'utf8')).toMatch(/b:L1 : ajouté à la vague/);
  });

  it("R2 — le refus « une orchestration y est déjà en cours » d'un second lancement dans le même dépôt nomme --add, avec le lot et la vague", async () => {
    const parent = parentWith(['a'], { a: 2 });
    let err = '';
    const s = scene(parent, 'a:L1', async (store) => {
      const r = io(parent);
      expect(await orchestrate(['a:L2'], r.io, s.d)).toBe(2);
      err = r.err.join('\n');
      expect(err).toContain(`cadence orchestrate --add a:L2 --wave ${store.id}`);
    });
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(err).toMatch(/une orchestration y est déjà en cours/);
  });

  it("R3 — un lot ajouté dans le dépôt d'un lot qui joue attend sa fin : jamais deux sessions dans un même dépôt ; il joue ensuite", async () => {
    const parent = parentWith(['a'], { a: 2 });
    const s = scene(parent, 'a:L1', async (store) => {
      expect(await orchestrate(['--add', 'a:L2'], io(parent).io, s.d)).toBe(0);
      await new Promise((r) => setTimeout(r, 150));
      expect(store.readLot('a', 'L2')?.status ?? 'queued').not.toBe('ready');
    });
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(s.maxIn.get('a')).toBe(1);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L2')!.status).toBe('ready');
    expect(store.readWave()!.lots).toEqual(['a:L1', 'a:L2']);
  });

  it("R4 — un lot qui dépend d'un lot de la vague est accepté et ne joue qu'après lui ; un lot dont la dépendance n'est pas dans la vague est refusé", async () => {
    const parent = parentWith(['a', 'b'], { a: 2 }, ['a']);
    let err = '';
    const s = scene(parent, 'b:L1', async (store) => {
      const r = io(parent);
      expect(await orchestrate(['--add', 'a:L2'], r.io, s.d)).toBe(2); // a:L1 n'est ni terminé ni dans la vague
      err = r.err.join('\n');
      expect(await orchestrate(['--add', 'a:L2', '--add', 'a:L1'], io(parent).io, s.d)).toBe(2); // L2 est donné avant L1 : L1 n'est pas « plus tôt » dans l'ajout
      expect(await orchestrate(['--add', 'a:L1'], io(parent).io, s.d)).toBe(0);
      await wait(() => store.addQueue().length === 0);
      expect(await orchestrate(['--add', 'a:L2'], io(parent).io, s.d)).toBe(0);
      await wait(() => store.readLot('a', 'L2')?.status === 'ready');
    });
    expect(await orchestrate(['b:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(err).toMatch(/a:L2 : dépendance\(s\) ni terminée\(s\) ni plus tôt dans la vague : L1/);
    expect(s.played.filter((p) => p.startsWith('a:'))).toEqual(['a:L1', 'a:L2']);
  });

  it("R5 — refus avant d'agir (code 2, rien déposé) : lot inconnu, projet inconnu, lot déjà dans la vague, lot déjà en file", async () => {
    const parent = parentWith(['a', 'b']);
    const errs: string[] = [];
    const s = scene(parent, 'a:L1', async (store) => {
      for (const target of ['b:L9', 'z:L1', 'a:L1']) {
        const r = io(parent);
        expect(await orchestrate(['--add', target], r.io, s.d)).toBe(2);
        errs.push(r.err.join('\n'));
      }
      expect(store.addQueue()).toEqual([]);
      store.requestAdd({ project: 'b', lot: 'L1' });
      const dup = io(parent);
      expect(await orchestrate(['--add', 'b:L1'], dup.io, s.d)).toBe(2);
      errs.push(dup.err.join('\n'));
      await wait(() => store.addQueue().length === 0);
    });
    await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(errs[0]).toMatch(/b:L9 : lot inconnu/);
    expect(errs[1]).toMatch(/z:L1 : dossier .* introuvable/);
    expect(errs[2]).toMatch(/a:L1 : lot déjà dans la vague/);
    expect(errs[3]).toMatch(/b:L1 : lot déjà (en file|dans la vague)/);
  });

  it('R6 — sans vague vivante dans ce dossier : refusé (code 2), il dit de lancer la vague', async () => {
    const parent = parentWith(['a']);
    const r = io(parent);
    expect(await orchestrate(['--add', 'a:L1'], r.io, scene(parent, 'x', async () => {}).d)).toBe(2);
    expect(r.err.join('\n')).toMatch(/aucune vague en cours/);
  });

  it("R7 — une vague d'avant L421 ne lit pas la file d'ajouts : refusé (code 2), rien d'écrit", async () => {
    const parent = parentWith(['a', 'b']);
    let seen: { code: number; err: string; queued: number } | undefined;
    const s = scene(parent, 'a:L1', async (store) => {
      mkdirSync(join(store.dir, 'tool', 'bin'), { recursive: true });
      mkdirSync(join(store.dir, 'tool', 'dist', 'orchestrate'), { recursive: true });
      writeFileSync(join(store.dir, 'tool', 'bin', 'cadence.js'), '');
      writeFileSync(join(store.dir, 'tool', 'dist', 'orchestrate', 'state.js'), "// avant L421 : answers.log\n");
      const r = io(parent);
      seen = { code: await orchestrate(['--add', 'b:L1'], r.io, s.d), err: r.err.join('\n'), queued: store.addQueue().length };
      writeFileSync(join(store.dir, 'tool', 'dist', 'orchestrate', 'state.js'), "join(this.dir, 'adds.log')\n");
      expect(waveReadsAdds(store.dir)).toBe(true);
    });
    await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d);
    expect(seen).toMatchObject({ code: 2, queued: 0 });
    expect(seen!.err).toMatch(/ne lit pas la file d'ajouts/);
  });

  it('R7 — sans instantané : on suppose que la vague lit la file', () => {
    expect(waveReadsAdds(tempDir())).toBe(true);
  });

  it("R8 — côté vague, une demande qui ne tient plus au moment de la prendre (lot inconnu) est écartée et dite au journal, sans faire échouer la vague", async () => {
    const parent = parentWith(['a', 'b']);
    const s = scene(parent, 'a:L1', async (store) => {
      store.requestAdd({ project: 'b', lot: 'L9' });
      await wait(() => store.addQueue().length === 0);
    });
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    const store = RunStore.last(parent)!;
    expect(readFileSync(join(store.dir, 'journal.log'), 'utf8')).toMatch(/b:L9 : ajout écarté \(.*lot inconnu/);
    expect(store.readWave()!.lots).toEqual(['a:L1']);
  });

  it("R9 — l'arrêt demandé (--stop-after-current) : un ajout encore en file quand la vague s'arrête est écarté et dit, jamais perdu en silence", async () => {
    const parent = parentWith(['a', 'b']);
    const s = scene(parent, 'a:L1', async (store) => {
      expect(await orchestrate(['--stop-after-current'], io(parent).io, s.d)).toBe(0);
      expect(await orchestrate(['--add', 'b:L1'], io(parent).io, s.d)).toBe(0);
    });
    await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d);
    const store = RunStore.last(parent)!;
    expect(store.addQueue()).toEqual([]);
    expect(readFileSync(join(store.dir, 'journal.log'), 'utf8')).toMatch(/b:L1 : ajout écarté \(la vague s'arrête/);
    expect(s.played).not.toContain('b:L1');
  });

  it('R10 — la file : ajout, relecture, marque « prise » ; une ligne illisible est ignorée ; absente elle est vide et n\'est pas prise pour un lot', () => {
    const store = new RunStore(tempDir(), 'w1');
    expect(store.addQueue()).toEqual([]);
    const a = store.requestAdd({ project: 'p', lot: 'L1', model: 'haiku' });
    const b = store.requestAdd({ lot: 'L2' });
    expect(store.addQueue()).toEqual([{ id: a, project: 'p', lot: 'L1', model: 'haiku' }, { id: b, lot: 'L2' }]);
    store.markAddTaken(a);
    expect(store.addQueue().map((e) => e.id)).toEqual([b]);
    expect(store.lots()).toEqual([]);
    writeFileSync(join(store.dir, 'adds.log'), `${readFileSync(join(store.dir, 'adds.log'), 'utf8')}{pas du json\n`);
    expect(store.addQueue().map((e) => e.id)).toEqual([b]);
    expect(store.answerQueue()).toEqual([]); // deux files distinctes
  });

  it("R11 — --add ne se combine avec aucune autre action ; sans valeur il est refusé", async () => {
    const parent = parentWith(['a']);
    const d = scene(parent, 'x', async () => {}).d;
    expect(parseOrchestrateArgs(['--add', 'a:L1@haiku', '--add', 'b:L2', '--wave', 'w']).add).toEqual([{ project: 'a', lot: 'L1', model: 'haiku' }, { project: 'b', lot: 'L2', model: undefined }]);
    for (const extra of [['a:L1'], ['--drop', 'a:L1'], ['--stop-after-current'], ['--budget', '1M'], ['--dry-run'], ['--continue'], ['--resume'], ['--status'], ['--answer', 'a:L1', 'x']]) {
      await expect(orchestrate(['--add', 'a:L1', ...extra], io(parent).io, d)).rejects.toThrow(/--add ne se combine/);
    }
    await expect(orchestrate(['--add'], io(parent).io, d)).rejects.toThrow(/--add attend une valeur/);
  });

  it("R12 — plusieurs vagues vivantes depuis ce dossier : --wave désigne celle qui reçoit ; sans --wave, refus qui les nomme", async () => {
    const parent = parentWith(['a', 'b']);
    const s = scene(parent, 'a:L1', async (store) => {
      const { registerWave, cadenceHome } = await import('../src/orchestrate/registry.js');
      registerWave(cadenceHome(), { pid: process.ppid, wave: 'autre', started: 'x', cwd: parent, repos: [] });
      try {
        const r = io(parent);
        expect(await orchestrate(['--add', 'b:L1'], r.io, s.d)).toBe(2);
        expect(r.err.join('\n')).toMatch(/plusieurs vagues tournent[\s\S]*précisez --wave/);
        expect(store.addQueue()).toEqual([]);
        expect(await orchestrate(['--add', 'b:L1', '--wave', store.id], io(parent).io, s.d)).toBe(0);
      } finally {
        const { unregisterWave } = await import('../src/orchestrate/registry.js');
        unregisterWave(cadenceHome(), process.ppid);
      }
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
    });
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
  });

  it("R13 — le budget restant de la vague doit tenir celui du lot ajouté : refusé (code 2), rien déposé", async () => {
    const parent = parentWith(['a', 'b']);
    let err = '';
    const s = scene(parent, 'a:L1', async (store) => {
      const r = io(parent);
      expect(await orchestrate(['--add', 'b:L1'], r.io, s.d)).toBe(2);
      err = r.err.join('\n');
      expect(store.addQueue()).toEqual([]);
    });
    await orchestrate(['a:L1', '--budget', '500k', '--max-sessions', '2'], io(parent).io, s.d);
    expect(err).toMatch(/b:L1 : le budget restant de la vague \(500000 tokens\) ne tient pas le budget du lot \(\d+\)/);
  });

  it("R14 — une demande encore en file quand plus rien ne joue est écartée et dite (« la vague a fini de jouer »), jamais perdue en silence", () => {
    const store = new RunStore(tempDir(), 'w1');
    mkdirSync(store.dir, { recursive: true });
    const lines: string[] = [];
    store.requestAdd({ project: 'b', lot: 'L1' });
    store.requestAdd({ lot: 'L2' });
    new AddFeed({ store, launch: '/x/parent', wctx: { log: (l: string) => lines.push(l) } } as unknown as AddEnv).drain('la vague a fini de jouer');
    expect(store.addQueue()).toEqual([]);
    expect(lines).toEqual(['b:L1 : ajout écarté (la vague a fini de jouer)', 'parent:L2 : ajout écarté (la vague a fini de jouer)']);
  });

  it("R15 — côté vague, un dépôt pris par une autre vague entre le dépôt de la demande et sa prise : le lot est écarté (cause dite), pas ajouté ; la vague finit", async () => {
    const parent = parentWith(['a', 'b']);
    const lock = join(sharedStateDir(join(parent, 'b')), REPO_LOCK);
    const s = scene(parent, 'a:L1', async (store) => {
      expect(takeLock(lock, { pid: process.ppid, wave: 'autre', started: 'x' }).ok).toBe(true);
      try {
        store.requestAdd({ project: 'b', lot: 'L1' });
        await wait(() => store.addQueue().length === 0);
      } finally {
        releaseLock(lock, process.ppid);
      }
    });
    expect(await orchestrate(['a:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    const store = RunStore.last(parent)!;
    expect(readFileSync(join(store.dir, 'journal.log'), 'utf8')).toMatch(/b:L1 : ajout écarté \(b : une orchestration y est déjà en cours \(autre/);
    expect(store.readWave()!.lots).toEqual(['a:L1']);
    expect(s.played).toEqual(['a:L1']);
  });
});
