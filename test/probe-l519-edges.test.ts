import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { sharedStateDir } from '../src/state.js';
import { REPO_LOCK, activeLock, takeLock } from '../src/orchestrate/lock.js';
import { isExpress } from '../src/orchestrate/express.js';
import { finishLocal, localWave, startLocal, type LocalDeps } from '../src/local-task.js';
import { commit, gitRepo } from './helpers.js';

const TODAY = '2026-11-01';
const lockFile = (repo: string) => join(sharedStateDir(repo), REPO_LOCK);

async function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T09:00:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
async function repoWith(...flags: string[][]) {
  const dir = gitRepo();
  await raf(dir, 'init', '--project', 'demo', '--no-hook');
  for (const f of flags) await raf(dir, 'add', 'un lot', ...f);
  commit(dir, 'chore: plan');
  return dir;
}
const deps = (over: Partial<LocalDeps> = {}): LocalDeps => ({ pid: process.pid, today: TODAY, now: () => new Date(`${TODAY}T09:00:00Z`), gate: async () => 0, out: () => {}, err: () => {}, ...over });
const plan = (dir: string) => Plan.load(join(dir, '.cadence/raf.yaml'));

describe('L519 edge — isExpress, types et bornes', () => {
  it('estimation en chaîne, null, Infinity : jamais express', () => {
    expect(isExpress({ estimate: '0.1' as unknown as number })).toBe(false);
    expect(isExpress({ estimate: null as unknown as number })).toBe(false);
    expect(isExpress({ estimate: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isExpress({ estimate: 0.1000001 })).toBe(false);
    expect(isExpress({ estimate: Number.MIN_VALUE })).toBe(true);
  });
  it('screen vide ou spec faux ne bloquent pas / screen posé bloque', () => {
    expect(isExpress({ estimate: 0.1, specLot: false })).toBe(true);
    expect(isExpress({ estimate: 0.1, screen: 'journey' })).toBe(false);
  });
});

describe('L519 edge — local dans le plan', () => {
  it('local: "true" (chaîne), local: false, local: 1 dans le YAML : relus comme non locaux', async () => {
    const dir = await repoWith([], [], []);
    const f = join(dir, '.cadence/raf.yaml');
    let txt = readFileSync(f, 'utf8');
    const ids = ['L1', 'L2', 'L3'];
    const vals = ['"true"', 'false', '1'];
    ids.forEach((id, i) => {
      txt = txt.replace(new RegExp(`(- id: ${id}\\n)`), `$1    local: ${vals[i]}\n`);
    });
    writeFileSync(f, txt);
    for (const id of ids) expect(plan(dir).lot(id).local).toBeUndefined();
  });
  it('raf add --local --spec --visible --screen page : les drapeaux se cumulent sans écraser local', async () => {
    const dir = await repoWith(['--local', '--spec', '--visible', '--screen', 'page']);
    const l = plan(dir).lot('L1');
    expect(l.local).toBe(true);
    expect(l.spec).toBe(true);
    expect(l.visible).toBe(true);
  });
  it('raf add --local --estimate 0.05 : le lot local garde son estimation', async () => {
    const dir = await repoWith(['--local', '--estimate', '0.05']);
    expect(plan(dir).lot('L1').estimate).toBe(0.05);
  });
});

describe('L519 edge — startLocal', () => {
  it('l\'écriture du plan échoue après la prise du verrou : le verrou ne doit pas rester tenu', async () => {
    const dir = await repoWith(['--local']);
    const p = plan(dir);
    vi.spyOn(p, 'save').mockImplementation(() => {
      throw new Error('disque plein');
    });
    expect(() => startLocal(dir, p, 'L1', deps())).toThrow();
    expect(activeLock(lockFile(dir))).toBeNull();
  });
  it('lot déjà doing (sans verrou) : la tâche démarre et prend le verrou', async () => {
    const dir = await repoWith(['--local']);
    await raf(dir, 'start', 'L1');
    startLocal(dir, plan(dir), 'L1', deps());
    expect(activeLock(lockFile(dir))?.wave).toBe(localWave('L1'));
  });
  it('lot done : refus nommant done, aucun verrou', async () => {
    const dir = await repoWith(['--local']);
    await raf(dir, 'start', 'L1');
    await raf(dir, 'done', 'L1', '--force');
    expect(() => startLocal(dir, plan(dir), 'L1', deps())).toThrow(/done/);
    expect(existsSync(lockFile(dir))).toBe(false);
  });
  it('tâche locale d\'un autre lot qui tient le dépôt : refus nommant la tâche, verrou intact', async () => {
    const dir = await repoWith(['--local'], ['--local']);
    startLocal(dir, plan(dir), 'L1', deps({ pid: process.ppid }));
    expect(() => startLocal(dir, plan(dir), 'L2', deps())).toThrow(/tâche locale du lead y est en cours \(L1,/);
    expect(activeLock(lockFile(dir))?.wave).toBe('local:L1');
  });
  it('id vide : lot inconnu', async () => {
    const dir = await repoWith(['--local']);
    expect(() => startLocal(dir, plan(dir), '', deps())).toThrow(/inconnu/);
  });
});

describe('L519 edge — finishLocal', () => {
  it('sans tâche en cours : refus, la porte n\'est pas jouée', async () => {
    const dir = await repoWith(['--local']);
    const gate = vi.fn(async () => 0);
    await expect(finishLocal(dir, 'L1', deps({ gate }))).rejects.toThrow(/aucune tâche locale/);
    expect(gate).not.toHaveBeenCalled();
  });
  it('verrou d\'une vague (pas locale) : done refusé, verrou intact', async () => {
    const dir = await repoWith(['--local']);
    takeLock(lockFile(dir), { pid: process.pid, wave: 'w1', started: 'x' });
    await expect(finishLocal(dir, 'L1', deps())).rejects.toThrow();
    expect(activeLock(lockFile(dir))?.wave).toBe('w1');
  });
  it('verrou de la tâche d\'un autre lot : refusé', async () => {
    const dir = await repoWith(['--local'], ['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    await expect(finishLocal(dir, 'L2', deps())).rejects.toThrow();
    expect(activeLock(lockFile(dir))?.wave).toBe('local:L1');
  });
  it('done deux fois : la seconde est refusée', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    expect(await finishLocal(dir, 'L1', deps())).toBe(0);
    await expect(finishLocal(dir, 'L1', deps())).rejects.toThrow();
  });
  it('code de porte 2 (rien rejoué) : code non nul, verrou gardé', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    const code = await finishLocal(dir, 'L1', deps({ gate: async () => 2 }));
    expect(code).not.toBe(0);
    expect(activeLock(lockFile(dir))).not.toBeNull();
  });
  it('la porte lève : l\'erreur remonte et le verrou reste', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    await expect(finishLocal(dir, 'L1', deps({ gate: async () => { throw new Error('boom'); } }))).rejects.toThrow('boom');
    expect(activeLock(lockFile(dir))).not.toBeNull();
  });
  it('porte inattendue (code 3, -1, NaN) : jamais traitée comme verte', async () => {
    const dir = await repoWith(['--local']);
    startLocal(dir, plan(dir), 'L1', deps());
    for (const g of [3, -1, Number.NaN]) {
      expect(await finishLocal(dir, 'L1', deps({ gate: async () => g }))).not.toBe(0);
      expect(activeLock(lockFile(dir))).not.toBeNull();
    }
  });
});

describe('L519 edge — cadence local en ligne de commande', () => {
  it('arguments absents, en trop ou inconnus : usage, code 2', async () => {
    const dir = await repoWith(['--local']);
    for (const a of [['local'], ['local', 'start'], ['local', 'start', 'L1', 'L2'], ['local', 'stop', 'L1'], ['local', 'start', '']]) {
      const r = await raf(dir, ...a);
      expect(r.code, a.join(' ')).toBe(2);
    }
  });
  it('local start sur un lot inconnu : code 2 et message, pas de verrou', async () => {
    const dir = await repoWith(['--local']);
    const r = await raf(dir, 'local', 'start', 'L99');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/inconnu/);
    expect(existsSync(lockFile(dir))).toBe(false);
  });
  it('local done sans start : code 2', async () => {
    const dir = await repoWith(['--local']);
    const r = await raf(dir, 'local', 'done', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/aucune tâche locale/);
  });
  it('local start puis raf add pendant la tâche : le --add de cadence orchestrate est refusé, mais raf add (plan) reste possible', async () => {
    const dir = await repoWith(['--local']);
    const s = await raf(dir, 'local', 'start', 'L1');
    expect(s.code).toBe(0);
    const a = await raf(dir, 'add', 'autre');
    expect(a.code).toBe(0);
    expect(activeLock(lockFile(dir))?.wave).toBe('local:L1');
  });
});
