import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { sharedStateDir } from '../src/state.js';
import { REPO_LOCK, activeLock, releaseLock, takeLock } from '../src/orchestrate/lock.js';
import { repoRefusals } from '../src/orchestrate/depot.js';
import { LOCAL_TTL_MINUTES, abortLocal, finishLocal, localOverdueLines, localWave, startLocal, type LocalDeps } from '../src/local-task.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { AGENTS_DIR } from '../src/skills.js';
import { commit, gitRepo } from './helpers.js';

const TODAY = '2026-11-01';
const lockFile = (repo: string) => join(sharedStateDir(repo), REPO_LOCK);

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T09:00:00`) });
  return Promise.resolve(code).then((c) => ({ code: c, out: out.join('\n'), err: err.join('\n') }));
}

/** Dépôt avec un plan : L1 local, L2 de vague, commité (arbre propre). */
async function repoWith(...flags: string[][]) {
  const dir = gitRepo();
  await raf(dir, 'init', '--project', 'demo', '--no-hook');
  for (const f of flags) await raf(dir, 'add', 'un lot', ...f);
  commit(dir, 'chore: plan');
  return dir;
}

const deps = (over: Partial<LocalDeps> = {}): LocalDeps => ({ pid: process.pid, today: TODAY, now: () => new Date(`${TODAY}T09:00:00Z`), gate: async () => 0, out: () => {}, err: () => {}, ...over });
const plan = (dir: string) => Plan.load(join(dir, '.cadence/raf.yaml'));

describe('L519 R5 — raf add --local marque un lot du lead', () => {
  it('R5 — le lot porte local: true dans le plan et à la relecture ; sans le drapeau, la clé est absente', async () => {
    const dir = await repoWith(['--local'], []);
    expect(plan(dir).lot('L1').local).toBe(true);
    expect(plan(dir).lot('L2').local).toBeUndefined();
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8').match(/local: true/g)).toHaveLength(1);
  });

  it('R5 — --local sur une sous-tâche est refusé (comme --spec)', async () => {
    const dir = await repoWith([]);
    const r = await raf(dir, 'add', 'sous', '--parent', 'L1', '--local');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--local se pose sur un lot/);
  });
});

describe('L519 R6 — cadence local start verrouille le dépôt comme une vague', () => {
  it('R6 — pose le verrou du dépôt au nom de la tâche, passe le lot à doing', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    const held = activeLock(lockFile(dir));
    expect(held?.wave).toBe(localWave('L1'));
    expect(held?.pid).toBe(process.pid);
    expect(plan(dir).lot('L1').status).toBe('doing');
  });

  it('R6 — un lot qui n\'est pas marqué local est refusé, rien n\'est verrouillé', async () => {
    const dir = await repoWith([]);
    expect(() => startLocal(dir, plan(dir), 'L1', deps())).toThrow(/pas marqué local.*raf add --local/);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it('R6 — un lot inconnu, déjà fini ou abandonné est refusé', async () => {
    const dir = await repoWith(['--local']);
    expect(() => startLocal(dir, plan(dir), 'L9', deps())).toThrow(/inconnu/);
    await raf(dir, 'drop', 'L1');
    expect(() => startLocal(dir, plan(dir), 'L1', deps())).toThrow(/dropped/);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it('R6 — une vague vivante qui tient le dépôt fait refuser la tâche, le verrou de la vague reste intact', async () => {
    const dir = await repoWith(['--local']);
    expect(takeLock(lockFile(dir), { pid: process.pid, wave: 'w9', started: 'x' }).ok).toBe(true);
    expect(() => startLocal(dir, plan(dir), 'L1', deps({ pid: process.ppid }))).toThrow(/orchestration y est déjà en cours \(w9/);
    expect(activeLock(lockFile(dir))?.wave).toBe('w9');
    expect(plan(dir).lot('L1').status).toBe('todo');
  });

  it('R6 — un autre lot du dépôt en cours (doing) fait refuser la tâche, il est nommé', async () => {
    const dir = await repoWith(['--local'], []);
    await raf(dir, 'start', 'L2');
    expect(() => startLocal(dir, plan(dir), 'L1', deps())).toThrow(/L2/);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it('R6 — démarrer deux fois la même tâche est refusé sans toucher au verrou', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    expect(() => startLocal(dir, plan(dir), 'L1', deps())).toThrow(/déjà en cours/);
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1'));
  });

  it('R6 — le verrou d\'une vague morte est repris ; celui d\'une tâche locale (déclaré, sans porteur) ne l\'est jamais', async () => {
    const dir = await repoWith(['--local']);
    takeLock(lockFile(dir), { pid: 2 ** 22 + 12345, wave: 'w-morte', started: 'x' });
    startLocal(dir, plan(dir), 'L1', deps());
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1'));
    await finishLocal(dir, 'L1', deps());
    takeLock(lockFile(dir), { pid: 2 ** 22 + 12345, wave: localWave('L1'), started: 'x', until: '2026-11-01T10:00:00.000Z' });
    expect(() => startLocal(dir, plan(dir), 'L1', deps())).toThrow(/déjà en cours/);
  });
});

describe('L519 R7 — pendant la tâche, aucune vague ni ajout n\'entre dans le dépôt', () => {
  it('R7 — le contrôle de dépôt d\'un lancement, d\'une reprise et d\'un --add refuse en nommant la tâche locale', async () => {
    const dir = await repoWith(['--local'], []);
    startLocal(dir, plan(dir), 'L1', deps());
    const runEnv = { io: { now: () => new Date(), out: () => {}, err: () => {} }, deps: { gitRunning: () => false }, launch: dir } as unknown as Parameters<typeof repoRefusals>[2];
    for (const opts of [{}, { addTo: { wave: 'w1' } }]) {
      const out = await repoRefusals(dir, { projectDir: dir, lot: 'L2' }, runEnv, opts);
      expect(out.join('\n')).toMatch(/tâche locale du lead y est en cours \(L1,.*cadence local done L1/);
    }
  });

  it('R7 — la tâche finie, le dépôt est libre : plus de refus de verrou', async () => {
    const dir = await repoWith(['--local'], []);
    startLocal(dir, plan(dir), 'L1', deps());
    await finishLocal(dir, 'L1', deps());
    const runEnv = { io: { now: () => new Date(), out: () => {}, err: () => {} }, deps: { gitRunning: () => false }, launch: dir } as unknown as Parameters<typeof repoRefusals>[2];
    const out = await repoRefusals(dir, { projectDir: dir, lot: 'L2' }, runEnv, {});
    expect(out.join('\n')).not.toMatch(/orchestration/);
  });
});

describe('L519 R8 — cadence local done : porte une fois, puis le dépôt est rendu', () => {
  it('R8 — porte verte : la porte est jouée une seule fois, le verrou tombe, la suite (capture, livraison, raf done) est dite', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    let plays = 0;
    const out: string[] = [];
    const code = await finishLocal(dir, 'L1', deps({ gate: async () => (plays++, 0), out: (l) => out.push(l) }));
    expect(code).toBe(0);
    expect(plays).toBe(1);
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(out.join('\n')).toMatch(/capture.*diff.*raf review L1.*cadence deliver.*raf done L1/s);
  });

  it('R8 — porte rouge : code 1, le verrou reste (le lead corrige puis rejoue)', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    const code = await finishLocal(dir, 'L1', deps({ gate: async () => 1 }));
    expect(code).toBe(1);
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1'));
  });

  it('R8 — porte sans verdict (rien à rejouer, code 2) : la tâche n\'est pas close, le verrou reste', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    expect(await finishLocal(dir, 'L1', deps({ gate: async () => 2 }))).toBe(2);
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1'));
  });

  it('R8 — sans tâche démarrée, ou avec le verrou d\'une vague, la fin est refusée et la porte n\'est pas jouée', async () => {
    const dir = await repoWith(['--local']);
    let plays = 0;
    const gate = async () => (plays++, 0);
    await expect(finishLocal(dir, 'L1', deps({ gate }))).rejects.toThrow(/aucune tâche locale en cours pour L1/);
    takeLock(lockFile(dir), { pid: process.pid, wave: 'w9', started: 'x' });
    await expect(finishLocal(dir, 'L1', deps({ gate }))).rejects.toThrow(/aucune tâche locale en cours pour L1/);
    expect(plays).toBe(0);
    expect(activeLock(lockFile(dir))?.wave).toBe('w9');
    releaseLock(lockFile(dir), process.pid);
  });
});

describe('L519 R9 — la commande', () => {
  it('R9 — cadence local start L1 verrouille, local done refuse sans configuration de porte, usage sinon', async () => {
    const dir = await repoWith(['--local']);
    const started = await raf(dir, 'local', 'start', 'L1');
    expect(started.code).toBe(0);
    expect(started.out).toMatch(/L1.*verrouillé/);
    expect(activeLock(lockFile(dir))?.wave).toBe('local:L1');
    expect((await raf(dir, 'local')).code).toBe(2);
    expect((await raf(dir, 'local', 'start')).code).toBe(2);
    expect((await raf(dir, 'local', 'stop', 'L1')).code).toBe(2);
    releaseLock(lockFile(dir), activeLock(lockFile(dir))!.pid);
  });
});

describe('L519 R10 — le verrou d\'une tâche locale tient sans processus porteur (revue : le shell de l\'outil Bash meurt à chaque appel)', () => {
  const DEAD = 2 ** 22 + 12345;
  const T0 = new Date('2026-11-01T09:00:00Z');
  const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

  it('R10 — le processus qui a posé le verrou est mort : le verrou tient, une vague est refusée, local done le lève', async () => {
    const dir = await repoWith(['--local'], []);
    startLocal(dir, plan(dir), 'L1', deps({ pid: DEAD }));
    const held = activeLock(lockFile(dir));
    expect(held?.wave).toBe(localWave('L1'));
    expect(held?.until).toBe(minutes(LOCAL_TTL_MINUTES).toISOString());
    const runEnv = { io: { now: () => new Date(), out: () => {}, err: () => {} }, deps: { gitRunning: () => false }, launch: dir } as unknown as Parameters<typeof repoRefusals>[2];
    expect((await repoRefusals(dir, { projectDir: dir, lot: 'L2' }, runEnv, {})).join('\n')).toMatch(/tâche locale du lead y est en cours \(L1,/);
    expect(takeLock(lockFile(dir), { pid: process.pid, wave: 'w1', started: 'x' }).ok).toBe(false);
    expect(await finishLocal(dir, 'L1', deps({ pid: DEAD }))).toBe(0);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it('R10 — le TTL est déclaré (--ttl, 60 min par défaut comme lead hold) ; échu, le verrou tient toujours et se signale en ⚠ avec la sortie', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps({ pid: DEAD, ttlMinutes: 30 }));
    expect(activeLock(lockFile(dir))?.until).toBe(minutes(30).toISOString());
    expect(localOverdueLines([dir], minutes(29))).toEqual([]);
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1'));
    const lines = localOverdueLines([dir], minutes(100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^⚠ tâche locale échue : L1 \(.*depuis 1 h 10 min\).*cadence local done L1.*cadence local abort L1/);
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1')); // jamais libéré en silence
  });

  it('R10 — lead tour et orchestrate --status signalent la tâche échue', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps({ pid: DEAD, ttlMinutes: 10 }));
    const tour = await rafAt(dir, minutes(30), 'lead', 'tour');
    expect(tour.out).toContain('⚠ tâche locale échue : L1');
    expect(tour.out).toMatch(/dépôt .*tâche locale L1/);
    const before = await rafAt(dir, minutes(5), 'lead', 'tour');
    expect(before.out).not.toContain('⚠ tâche locale');
    const st = await orchestrateIn(dir, ['--status'], minutes(30));
    expect(st.out.join('\n')).toContain('⚠ tâche locale échue : L1');
  });

  it('R10 — cadence local abort <lot> lève le verrou sans porte, laisse le plan tel quel ; refusé sans tâche de ce lot', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps({ pid: DEAD }));
    expect(() => abortLocal(dir, 'L2')).toThrow(/aucune tâche locale en cours pour L2/);
    const out: string[] = [];
    abortLocal(dir, 'L1', (l) => out.push(l));
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(plan(dir).lot('L1').status).toBe('doing');
    expect(out.join('\n')).toMatch(/raf todo L1/);
    expect((await raf(dir, 'local', 'abort', 'L1')).code).toBe(2);
    expect((await raf(dir, 'local', 'start', 'L1', '--ttl', '0')).code).toBe(2);
    expect((await raf(dir, 'local', 'start', 'L1', '--ttl', '15')).code).toBe(0);
    expect(activeLock(lockFile(dir))?.until).toBe(new Date(new Date(`${TODAY}T09:00:00`).getTime() + 15 * 60_000).toISOString());
    expect((await raf(dir, 'local', 'abort', 'L1')).code).toBe(0);
  });
});

describe('L519 R11 — une vague ne joue pas un lot local (revue, constat 2)', () => {
  it('R11 — orchestrate <projet>:<lot local> --dry-run est refusé en nommant la voie du lead ; le lot de vague voisin passe', async () => {
    const dir = await repoWith(['--local'], []);
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    commit(dir, 'chore: config');
    const r = await orchestrateIn(dir, ['.:L1', '.:L2', '--dry-run'], new Date());
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/:L1 : lot local .*cadence local start L1/);
    expect(r.err.join('\n')).not.toMatch(/:L2/);
    expect(plan(dir).lot('L1').status).toBe('todo');
  });
});

describe('L519 R12 — le hook pre-push reconnaît la tâche locale (revue, constat 4)', () => {
  it('R12 — pendant une tâche locale, pas de « vague local:L1 : état illisible » : le push passe sans avertissement de vague', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps({ pid: 2 ** 22 + 12345 }));
    const out: string[] = [];
    const err: string[] = [];
    const head = (await import('../src/git.js')).tryGit(dir, ['rev-parse', 'HEAD'])!;
    const code = await run(['hook', 'pre-push'], { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(), stdin: () => `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n` });
    expect(code).toBe(0);
    expect(err.join('\n')).not.toMatch(/état illisible|vague local/);
  });
});

function rafAt(dir: string, now: Date, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => now });
  return Promise.resolve(code).then((c) => ({ code: c, out: out.join('\n'), err: err.join('\n') }));
}

async function orchestrateIn(dir: string, argv: string[], now: Date) {
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('aucune session ne doit s\'ouvrir'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), claudeAuth: () => ({ loggedIn: true }), agentsDir: AGENTS_DIR };
  const out: string[] = [];
  const err: string[] = [];
  const io: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => now };
  const code = await orchestrate(argv, io, deps);
  return { code, out, err };
}
