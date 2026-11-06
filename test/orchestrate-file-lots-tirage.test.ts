import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { queueVerdict } from '../src/orchestrate/continue.js';
import { addHold, cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { QueueSession, SkipLog, queuePath } from '../src/orchestrate/queue.js';
import { RunStore } from '../src/orchestrate/state.js';
import { REPO_LOCK, releaseLock, takeLock } from '../src/orchestrate/lock.js';
import { sharedStateDir } from '../src/state.js';
import type { ClaudeFn, LaunchOutcome } from '../src/orchestrate/launch.js';
import { gitRoot } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, git, kindOf, precheckReport, reviewReport, workReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

const savedHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = savedHome;
});

type Lots = { title: string; estimate?: number; after?: string[]; uses?: string[]; status?: 'doing' }[];

/** Projets sous un même dossier parent, chacun son dépôt git et son plan (contrôle préalable coupé). */
function parentWith(projects: Record<string, Lots>, yaml = ''): { parent: string; dirs: Record<string, string> } {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, lots] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    for (const l of lots) {
      const id = plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, after: l.after, uses: l.uses });
      if (l.status === 'doing') plan.setStatus(id, 'doing', '2026-10-01');
    }
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: false\n${yaml}`);
    git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

type Over = Partial<Record<'implement' | 'review' | 'fix', (cwd: string, brief: string) => LaunchOutcome | Promise<LaunchOutcome>>>;

function fakeDeps(over: Over = {}): { deps: OrchestrateDeps; played: string[] } {
  const played: string[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    const custom = over[kind as keyof Over];
    if (kind === 'implement') played.push(`${basename(o.cwd)}:${/on lot `([^`]+)`/.exec(args[1])![1]}`);
    if (custom) return custom(o.cwd, args[1]);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind === 'implement' || kind === 'fix') {
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `${kind}-${Math.random()}.txt`, `${kind === 'fix' ? 'fix' : 'feat'}(${lot}): travail`)] }));
    }
    return claudeOut(reviewReport());
  };
  return { deps: { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, queueLockMs: 150 }, played };
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-11-06' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-06T10:00:00') };
  return { io: i, out, err };
}

const queueAdd = (parent: string, ...keys: string[]) => orchestrate(['queue', 'add', ...keys], io(parent).io, fakeDeps().deps);
const show = async (parent: string) => {
  const o = io(parent);
  await orchestrate(['queue', 'show'], o.io, fakeDeps().deps);
  return o.out;
};
const journalOf = (parent: string) => readFileSync(join(RunStore.last(parent)!.dir, 'journal.log'), 'utf8');
const wavesLots = (parent: string) => RunStore.last(parent)!.readWave()!.lots;
const plannedLots = (out: string[]) => out.filter((l) => /^[\w/-]+:L\d+ — /.test(l)).map((l) => l.split(' — ')[0]);

describe('L498 — tirage de la file approuvée', () => {
  it('R11 — vague lancée avec des lots donnés : un créneau libéré tire le lot de la file', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['a:L1', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1', 'b:L1']);
    expect(wavesLots(parent)).toEqual(['a:L1', 'b:L1']);
    expect(o.out).toContain('file : tire b:L1 (position 1)');
  });

  it('R11 — vague lancée avec --continue : un créneau libéré tire le lot de la file', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--continue', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1', 'b:L1', 'a:L2']); // la file avant le plan (R19)
  });

  it('R11 — vague lancée avec --queue : un créneau libéré tire le lot de la file', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'a:L1', 'b:L1');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['--queue', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1', 'b:L1']);
    expect(o.out.filter((l) => l.startsWith('file : tire'))).toEqual(['file : tire a:L1 (position 1)', 'file : tire b:L1 (position 2)']);
  });

  it('R11 — file sans lot mûr : orchestrate --queue refuse en listant les causes', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un', after: [] }, { title: 'a deux', after: ['L1'] }] });
    await queueAdd(parent, 'a:L2');
    const o = io(parent);
    expect(await orchestrate(['--queue'], o.io, fakeDeps().deps)).toBe(2);
    expect(o.err).toEqual(['file : lot sauté — a:L2 : after non clos (L1)', 'file : aucun lot mûr (1 sauté(s))', 'orchestrate --queue : aucun lot mûr dans la file approuvée']);
  });

  it('R11 — file vide : orchestrate --queue refuse', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    const o = io(parent);
    expect(await orchestrate(['--queue'], o.io, fakeDeps().deps)).toBe(2);
    expect(o.err).toEqual(['orchestrate --queue : aucun lot mûr dans la file approuvée']);
  });

  it('R11 — lots donnés et --queue : les lots donnés d\'abord', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--queue', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1', 'b:L1']);
  });

  it('R5 — premier lot de la file avec after non clos : le deuxième est tiré, le premier reste en file (--no-fill : le plan ne remplit pas le créneau libéré)', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un', after: [] }, { title: 'a deux', after: ['L1'] }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'a:L2', 'b:L1');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['--queue', '--max-sessions', '1', '--no-fill'], o.io, f.deps)).toBe(0);
    expect(f.played).toEqual(['b:L1']);
    expect(await show(parent)).toEqual(['1. a:L2 — a deux — sauté : after non clos (L1)', '2. b:L1 — b un — tiré par la vague ' + RunStore.last(parent)!.id]);
  });

  it('R5 — tous les lots mûrs : le premier de la file est tiré (simulation)', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1', 'a:L1');
    const o = io(parent);
    const code = await orchestrate(['--queue', '--max-sessions', '1', '--dry-run'], o.io, fakeDeps().deps);
    try {
      expect(code).toBe(0);
      expect(plannedLots(o.out)).toEqual(['b:L1']);
    } finally {
      removeDryRunBriefs(o.out.join('\n'));
    }
  });

  it('R5 — lot « à décider » : sauté ; lot dont uses: est tenu par un lot doing : sauté', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un à décider avec Sylvain' }, { title: 'a deux', uses: ['banc'] }, { title: 'a trois', uses: ['banc'], status: 'doing' }] });
    await queueAdd(parent, 'a:L1', 'a:L2');
    expect(await show(parent)).toEqual(['1. a:L1 — a un à décider avec Sylvain — sauté : question posée', '2. a:L2 — a deux — sauté : ressource tenue (banc)']);
  });

  it('R6 — journal « file : lot sauté — p:L2 : after non clos (L1) », lot toujours en file, et « aucun lot mûr » quand rien n\'est tirable', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], c: [{ title: 'c un à décider avec Sylvain' }, { title: 'c deux', after: ['L1'] }] });
    await queueAdd(parent, 'c:L2');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['a:L1', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(journalOf(parent)).toContain('file : lot sauté — c:L2 : after non clos (L1)');
    expect(journalOf(parent)).toContain('file : aucun lot mûr (1 sauté(s))');
    expect(await show(parent)).toEqual(['1. c:L2 — c deux — sauté : after non clos (L1)']);
  });

  it('R6 — même cause sur deux créneaux de la même vague : une seule ligne', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }, { title: 'a trois' }], c: [{ title: 'c un à décider avec Sylvain' }, { title: 'c deux', after: ['L1'] }] });
    await queueAdd(parent, 'c:L2');
    const f = fakeDeps();
    const o = io(parent);
    await orchestrate(['--continue', '--max-sessions', '1', '--priority', 'a,c'], o.io, f.deps);
    expect(f.played).toEqual(['a:L1', 'a:L2', 'a:L3']);
    expect(journalOf(parent).split('\n').filter((l) => l.includes('file : lot sauté — c:L2')).length).toBe(1);
  });

  it('R6 — cause qui change puis revient dans la même vague : trois lignes ; autre vague : une ligne par vague', () => {
    const a = new SkipLog();
    expect([a.changed('p:L2', 'X'), a.changed('p:L2', 'X'), a.changed('p:L2', 'Y'), a.changed('p:L2', 'X')]).toEqual([true, false, true, true]);
    const b = new SkipLog();
    expect(b.changed('p:L2', 'X')).toBe(true);
  });

  it('R7 — deux tirages simultanés du même lot : un seul le prend', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    const one = new QueueSession(cadenceHome(), parent, () => 'v1');
    const two = new QueueSession(cadenceHome(), parent, () => 'v2');
    expect(one.reserve('a:L1')).toBe('ok');
    expect(two.reserve('a:L1')).toBe('taken');
  });

  it('R7 — vague interrompue avant le lancement : le lot revient en file', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    const one = new QueueSession(cadenceHome(), parent, () => 'v1');
    expect(one.reserve('a:L1')).toBe('ok');
    one.releaseAll();
    expect(one.list().map((e) => e.state)).toEqual(['pending']);
    expect(new QueueSession(cadenceHome(), parent, () => 'v2').reserve('a:L1')).toBe('ok');
  });

  it('R7 — lancement refusé après le « tiré » : le lot est rendu à la file (en attente)', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    const s = new QueueSession(cadenceHome(), parent, () => 'v1');
    s.reserve('a:L1');
    s.drawn('a:L1');
    expect(s.list()[0]).toMatchObject({ state: 'drawn', wave: 'v1' });
    s.undraw(['a:L1']);
    expect(s.list()[0].state).toBe('pending');
    new QueueSession(cadenceHome(), parent, () => 'v2').undraw(['a:L1']); // la file n'est pas rendue par une autre vague
    expect(s.list()[0].state).toBe('pending');
  });

  it('R13 — lot tiré : état tiré avec l\'id de la vague, non retiré de la file ; show l\'affiche ; jamais tiré une seconde fois', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    let during = '';
    const f = fakeDeps({
      implement: async (cwd) => {
        during = (await show(parent))[0];
        return claudeOut(workReport({ commits: [commitFile(cwd, `x${Math.random()}.txt`, 'feat(L1): x')] }));
      },
    });
    expect(await orchestrate(['--queue'], io(parent).io, f.deps)).toBe(0);
    const id = RunStore.last(parent)!.id;
    expect(during).toBe(`1. a:L1 — a un — tiré par la vague ${id}`); // « tiré » avant que la session ne parte
    const file = JSON.parse(readFileSync(queuePath(cadenceHome()), 'utf8'));
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]).toMatchObject({ key: 'a:L1', state: 'drawn', wave: id });
    const again = io(parent);
    expect(await orchestrate(['--queue'], again.io, fakeDeps().deps)).toBe(2); // rien à tirer : le lot tiré n'est pas repris
    expect(again.err.at(-1)).toBe('orchestrate --queue : aucun lot mûr dans la file approuvée');
  });

  it('R14 — vague tuée après réservation (pid mort) : le lot est de nouveau tiré, le journal le dit', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    const file = JSON.parse(readFileSync(queuePath(cadenceHome()), 'utf8'));
    file.entries[0] = { ...file.entries[0], state: 'reserved', wave: 'morte', pid: 2 ** 22 + 4321 };
    writeFileSync(queuePath(cadenceHome()), JSON.stringify(file));
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['--queue'], o.io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1']);
    expect(o.err).toContain('file : réservation orpheline reprise — a:L1 (vague morte)');
    expect(journalOf(parent)).toContain('file : réservation orpheline reprise — a:L1 (vague morte)');
  });

  it('R14 — réservation d\'une vague vivante : lot non tiré par une autre', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    const file = JSON.parse(readFileSync(queuePath(cadenceHome()), 'utf8'));
    file.entries[0] = { ...file.entries[0], state: 'reserved', wave: 'vivante', pid: process.ppid };
    writeFileSync(queuePath(cadenceHome()), JSON.stringify(file));
    const f = fakeDeps();
    expect(await orchestrate(['--queue'], io(parent).io, f.deps)).toBe(2);
    expect(f.played).toEqual([]);
    expect(await show(parent)).toEqual(['1. a:L1 — a un — réservé par la vague vivante']);
  });

  it('R9 — dépôt tenu par une autre vague vivante : le lot lui est poussé par --add, « tiré par » cette vague ; rien d\'autre n\'écrit chez elle (R18)', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }, { title: 'b deux' }] });
    await queueAdd(parent, 'b:L2');
    // La vague « autre » tient le dépôt b comme une vraie vague : son verrou de dépôt, son inscription au registre sous un autre processus vivant, son dossier d'état ; elle ne joue pas ici (deux vagues d'un même processus ne tiennent pas dans le registre).
    const other = RunStore.reserve(parent, 'autre', { exact: true })!;
    other.writeWave({ id: 'autre', created: '2026-11-06T09:00:00Z', cwd: parent, budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: ['b:L1'], addsGoalBudget: true });
    const lock = join(sharedStateDir(gitRoot(dirs.b)!), REPO_LOCK);
    expect(takeLock(lock, { pid: process.ppid, wave: 'autre', started: '2026-11-06T09:00:00Z' }).ok).toBe(true);
    registerWave(cadenceHome(), { pid: process.ppid, wave: 'autre', started: '2026-11-06T09:00:00Z', cwd: parent, repos: [gitRoot(dirs.b)!], cap: 3 });
    const registry = join(cadenceHome(), 'waves', `${process.ppid}.json`);
    const before = readFileSync(registry, 'utf8');
    try {
      const f = fakeDeps();
      const o = io(parent);
      expect(await orchestrate(['a:L1', '--max-sessions', '3'], o.io, f.deps)).toBe(0);
      expect(f.played).toEqual(['a:L1']);
      expect(o.out).toContain('file : tire b:L2 (position 1) — poussé par --add dans la vague autre');
      expect(other.addQueue().map((e) => `${e.project}:${e.lot}`)).toEqual(['b:L2']); // le seul chemin : la file d'ajouts de --add
      expect(other.lots()).toEqual([]);
      expect(readFileSync(registry, 'utf8')).toBe(before);
      expect((await show(parent))[0]).toBe('1. b:L2 — b deux — tiré par la vague autre');
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
      releaseLock(lock, process.ppid);
    }
  });

  it('R9 — --add refusé par la vague qui tient le dépôt : le lot reste en attente, sauté et dit avec le message de --add, une fois', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    // Une vague inscrite au registre sans dossier d'état : --add ne peut rien y déposer.
    registerWave(cadenceHome(), { pid: process.ppid, wave: 'autre', started: '2026-11-06T09:00:00Z', cwd: parent, repos: [gitRoot(dirs.b)!], cap: 3 });
    try {
      const f = fakeDeps();
      const o = io(parent);
      expect(await orchestrate(['a:L1', '--max-sessions', '3'], o.io, f.deps)).toBe(0);
      expect(f.played).toEqual(['a:L1']);
      expect(o.out.filter((l) => l.startsWith('file : --add refusé — b:L1 : '))).toEqual(["file : --add refusé — b:L1 : dossier d'état de la vague autre introuvable"]);
      expect((await show(parent))[0]).toMatch(/^1\. b:L1 — b un — en attente$/);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R9 — orchestrate --queue dans un dépôt tenu par une autre vague : refus qui nomme la vague, rien d\'écrit chez elle (le tirage d\'un tour ne pousse pas)', async () => {
    const { parent, dirs } = parentWith({ b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    registerWave(cadenceHome(), { pid: process.ppid, wave: 'autre', started: '2026-11-06T09:00:00Z', cwd: parent, repos: [gitRoot(dirs.b)!], cap: 3 });
    try {
      const o = io(parent);
      expect(await orchestrate(['--queue', '--max-sessions', '3'], o.io, fakeDeps().deps)).toBe(2);
      expect(o.err).toEqual(['file : lot sauté — b:L1 : dépôt tenu par la vague autre', 'file : aucun lot mûr (1 sauté(s))', 'orchestrate --queue : aucun lot mûr dans la file approuvée']);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R9 — aucune vague ne tient le dépôt : la vague le tire et le joue elle-même', async () => {
    const { parent } = parentWith({ b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps();
    expect(await orchestrate(['--queue'], io(parent).io, f.deps)).toBe(0);
    expect(f.played).toEqual(['b:L1']);
  });

  it('R10 — arbre sale : le lot est retenté au créneau suivant (reste en file)', async () => {
    const { parent, dirs } = parentWith({ b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    writeFileSync(join(dirs.b, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n# sale\n');
    const o = io(parent);
    expect(await orchestrate(['--queue'], o.io, fakeDeps().deps)).toBe(2);
    expect(o.err.join('\n')).toMatch(/file : lot sauté — b:L1 : b : arbre sale/);
    expect((await show(parent))[0]).toMatch(/en attente$/);
    git(dirs.b, 'commit', '-qam', 'chore: propre');
    const f = fakeDeps();
    expect(await orchestrate(['--queue'], io(parent).io, f.deps)).toBe(0);
    expect(f.played).toEqual(['b:L1']);
  });

  it('R12 — lot approuvé listé dans continue.exclude / au-dessus de continue.maxEstimate / « non tirable » : sauté et dit, reste en file', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux', estimate: 3 }, { title: 'a trois (non tirable)' }] }, '  continue:\n    exclude: [L1]\n    maxEstimate: 1\n');
    await queueAdd(parent, 'a:L1', 'a:L2', 'a:L3');
    expect(await show(parent)).toEqual([
      '1. a:L1 — a un — sauté : écarté du tirage : listé dans continue.exclude',
      '2. a:L2 — a deux — sauté : écarté du tirage : estimate 3 > continue.maxEstimate 1',
      '3. a:L3 — a trois (non tirable) — sauté : écarté du tirage : marqué « non tirable »',
    ]);
    const o = io(parent);
    expect(await orchestrate(['--queue'], o.io, fakeDeps().deps)).toBe(2);
    expect(o.err).toContain('file : lot sauté — a:L1 : écarté du tirage : listé dans continue.exclude');
  });

  it('R15 — lot terminé par un autre chemin : sauté « déjà terminé », show le dit, reste en file', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }] });
    await queueAdd(parent, 'a:L1', 'a:L2');
    const plan = Plan.load(join(dirs.a, 'docs/plan/raf.yaml'));
    plan.setStatus('L1', 'done', '2026-11-06');
    plan.save();
    expect(await show(parent)).toEqual(['1. a:L1 — a un — sauté : déjà terminé', '2. a:L2 — a deux — en attente']);
  });

  it('R15 — lot supprimé du plan : sauté « introuvable » ; plan illisible : sauté « plan illisible », les autres lots sont tirés', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }], c: [{ title: 'c un' }] });
    await queueAdd(parent, 'a:L1', 'b:L1', 'c:L1');
    rmSync(join(dirs.a, 'docs/plan/raf.yaml'));
    writeFileSync(join(dirs.b, 'docs/plan/raf.yaml'), 'lots: [ {');
    expect(await show(parent)).toEqual(['1. a:L1 — lot introuvable — sauté : introuvable', '2. b:L1 — lot introuvable — sauté : plan illisible', '3. c:L1 — c un — en attente']);
    const verdict = (key: string) => queueVerdict(key, parent, { home: cadenceHome(), remaining: Infinity });
    expect(verdict('zzz:L1')).toEqual({ cause: 'introuvable' });
    expect(verdict('b:L1')).toEqual({ cause: 'plan illisible' });
    const f = fakeDeps();
    expect(await orchestrate(['--queue', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(0);
    expect(f.played).toEqual(['c:L1']);
  });

  it('R15 — lot en cours à la main : sauté « déjà en cours »', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un', status: 'doing' }] });
    await queueAdd(parent, 'a:L1');
    expect(await show(parent)).toEqual(['1. a:L1 — a un — sauté : déjà en cours']);
  });

  it('R16 — queue.json corrompu : le tirage ne tire rien et avertit, fichier inchangé', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    mkdirSync(cadenceHome(), { recursive: true });
    writeFileSync(queuePath(cadenceHome()), '{ corrompu');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['a:L1', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1']);
    expect(o.err).toContain("file : illisible ou verrouillée, rien n'est tiré à ce créneau");
    expect(readFileSync(queuePath(cadenceHome()), 'utf8')).toBe('{ corrompu');
  });

  it('R8 — vague en question : la file n\'est pas tirée', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps({ implement: () => claudeOut(workReport({ questions: ['Quelle base ?'] })) });
    expect(await orchestrate(['a:L1', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(1);
    expect(f.played).toEqual(['a:L1']);
    expect((await show(parent))[0]).toMatch(/en attente$/);
  });

  it('R8 — --stop-after-current : rien n\'est tiré à la libération du créneau', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps({
      implement: async (cwd) => {
        await orchestrate(['--stop-after-current'], io(parent).io, fakeDeps().deps);
        return claudeOut(workReport({ commits: [commitFile(cwd, `x${Math.random()}.txt`, 'feat(L1): x')] }));
      },
    });
    await orchestrate(['a:L1', '--max-sessions', '1'], io(parent).io, f.deps);
    expect(f.played).toEqual(['a:L1']);
    expect((await show(parent))[0]).toMatch(/en attente$/);
  });

  it('R8 — budget restant inférieur à celui du lot : lot sauté et dit, reste en file', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un', estimate: 0.25 }], b: [{ title: 'b gros', estimate: 5 }] });
    await queueAdd(parent, 'b:L1');
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--budget', '600k', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1']);
    expect(journalOf(parent)).toContain('file : lot sauté — b:L1 : budget restant insuffisant');
    expect((await show(parent))[0]).toMatch(/en attente$/);
  });

  it('R8 — plafond atteint avec un hold du lead : aucun tirage', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    addHold(cadenceHome(), 'sous-agent', 180, new Date('2026-11-06T09:00:00'));
    const f = fakeDeps();
    expect(await orchestrate(['--queue', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(2);
    expect(f.played).toEqual([]);
    expect((await show(parent))[0]).toMatch(/en attente$/);
  });

  it('R20 — un créneau libéré, trois lots mûrs : un seul tiré ; deux créneaux libérés : deux lots tirés, un par créneau', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }], b: [{ title: 'b un' }] });
    await queueAdd(parent, 'a:L1', 'a:L2', 'b:L1');
    for (const [cap, expected] of [['1', ['a:L1']], ['2', ['a:L1', 'b:L1']]] as const) {
      const o = io(parent);
      const code = await orchestrate(['--queue', '--max-sessions', cap, '--dry-run'], o.io, fakeDeps().deps);
      try {
        expect(code).toBe(0);
        expect(plannedLots(o.out)).toEqual(expected);
      } finally {
        removeDryRunBriefs(o.out.join('\n'));
      }
    }
  });

  it('R19 — --continue avec un lot mûr en file et un lot prêt au plan : le lot de la file est tiré ; file sans lot mûr : le plan est tiré', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }], c: [{ title: 'c un à décider avec Sylvain' }, { title: 'c deux', after: ['L1'] }] });
    await queueAdd(parent, 'b:L1');
    const first = fakeDeps();
    expect(await orchestrate(['--continue', '--max-sessions', '1', '--priority', 'a,b'], io(parent).io, first.deps)).toBe(0);
    expect(first.played).toEqual(['b:L1', 'a:L1']); // le plan mettrait a avant b
    const { parent: other } = parentWith({ a: [{ title: 'a un' }], c: [{ title: 'c un à décider avec Sylvain' }, { title: 'c deux', after: ['L1'] }] });
    await queueAdd(other, 'c:L2');
    const second = fakeDeps();
    expect(await orchestrate(['--continue', '--max-sessions', '1'], io(other).io, second.deps)).toBe(0);
    expect(second.played).toEqual(['a:L1']);
  });
  it('R10 — refus propre au lot : non retiré de la file, non retenté par cette vague, sa cause dite', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }], b: [{ title: 'b un' }] });
    writeFileSync(join(dirs.b, '.nvmrc'), '99.0.0\n'); // aucune version 99 de node : refus propre au lot b:L1
    git(dirs.b, 'add', '--', '.nvmrc');
    git(dirs.b, 'commit', '-qm', 'chore: nvmrc');
    await queueAdd(parent, 'b:L1', 'a:L2');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['a:L1', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(f.played).toEqual(['a:L1', 'a:L2']);
    expect(journalOf(parent).split('\n').filter((l) => l.includes('file : lot sauté — b:L1 : ')).length).toBe(1); // une seule fois : exclu de cette vague
    expect((await show(parent))[0]).toMatch(/^1\. b:L1 — b un — /);
    expect((await show(parent))[0]).not.toMatch(/tiré par/);
  });

  it('R16 — verrou tenu au-delà du délai pendant le tirage : le lot n\'est pas tiré, avertissement, file inchangée', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }] });
    await queueAdd(parent, 'a:L1');
    const before = readFileSync(queuePath(cadenceHome()), 'utf8');
    writeFileSync(`${queuePath(cadenceHome())}.lock`, JSON.stringify({ pid: process.pid }));
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['--queue'], o.io, f.deps)).toBe(2);
    expect(f.played).toEqual([]);
    expect(readFileSync(queuePath(cadenceHome()), 'utf8')).toBe(before);
  });
});
