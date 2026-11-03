import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L468 (M6) — écriture du plan sûre entre sessions : verrou inter-processus `<plan>.lock` et refus d'écraser un plan changé depuis sa lecture.
const T = '2026-11-03';
const fresh = () => Plan.create(join(tempDir(), '.cadence/raf.yaml'), 'demo');
const lockOf = (p: Plan) => `${p.path}.lock`;
const children: ChildProcess[] = [];
/** Un vrai processus vivant, distinct du nôtre, pour tenir un verrou. */
const sleeper = () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
};
const withWait = (ms: number, f: () => void) => {
  const old = process.env.CADENCE_PLAN_LOCK_WAIT_MS;
  process.env.CADENCE_PLAN_LOCK_WAIT_MS = String(ms);
  try {
    f();
  } finally {
    if (old === undefined) delete process.env.CADENCE_PLAN_LOCK_WAIT_MS;
    else process.env.CADENCE_PLAN_LOCK_WAIT_MS = old;
  }
};
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

describe('R1 — save() prend le verrou du plan et le rend', () => {
  it('R1 — le verrou n\'existe plus après une écriture réussie', () => {
    const p = fresh();
    p.add('A', T);
    p.save();
    expect(existsSync(lockOf(p))).toBe(false);
    expect(readFileSync(p.path, 'utf8')).toContain('title: A');
  });

  it('R1 — le verrou est rendu aussi quand l\'écriture échoue (plan.onWrite en échec)', () => {
    const dir = tempDir();
    const path = join(dir, '.cadence/raf.yaml');
    Plan.create(path, 'demo');
    const p = Plan.load(path, { onWrite: { command: 'exit 3', files: [], cwd: dir } });
    p.add('A', T);
    expect(() => p.save()).toThrow(/plan\.onWrite en échec/);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe('R2 — un verrou tenu par un processus vivant fait attendre puis refuser, le plan intact', () => {
  it('R2 — refus nommant le pid, plan inchangé, verrou de l\'autre laissé', () => {
    const p = fresh();
    const other = sleeper();
    writeFileSync(lockOf(p), JSON.stringify({ pid: other.pid, started: 'x' }));
    const before = readFileSync(p.path, 'utf8');
    p.add('A', T);
    withWait(150, () => expect(() => p.save()).toThrow(new RegExp(`plan tenu par une autre session \\(pid ${other.pid},`)));
    expect(readFileSync(p.path, 'utf8')).toBe(before);
    expect(existsSync(lockOf(p))).toBe(true);
  });

  it('R2 — le verrou rendu pendant l\'attente laisse passer l\'écriture', async () => {
    const p = fresh();
    const other = sleeper();
    writeFileSync(lockOf(p), JSON.stringify({ pid: other.pid, started: 'x' }));
    p.add('A', T);
    const holder = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').rmSync(${JSON.stringify(lockOf(p))}),300)`], { stdio: 'ignore' });
    children.push(holder);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    withWait(5000, () => p.save());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(readFileSync(p.path, 'utf8')).toContain('title: A');
  });
});

describe('R3 — un verrou périmé ne bloque pas', () => {
  it('R3 — pid mort : écarté, écriture faite, verrou rendu', () => {
    const p = fresh();
    writeFileSync(lockOf(p), JSON.stringify({ pid: 2 ** 22 + 12345, started: 'x' }));
    p.add('A', T);
    p.save();
    expect(readFileSync(p.path, 'utf8')).toContain('title: A');
    expect(existsSync(lockOf(p))).toBe(false);
  });

  it('R3 — fichier de verrou illisible et ancien : écarté ; illisible et tout récent : tenu', () => {
    const p = fresh();
    writeFileSync(lockOf(p), 'pas du json');
    p.add('A', T);
    withWait(100, () => expect(() => p.save()).toThrow(/plan tenu par une autre session/));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockOf(p), old, old);
    p.save();
    expect(existsSync(lockOf(p))).toBe(false);
  });

  it('R3 — pid vivant mais heure de démarrage différente (pid repris) : périmé', () => {
    const p = fresh();
    writeFileSync(lockOf(p), JSON.stringify({ pid: sleeper().pid, started: 'x', start: 'jamais' }));
    p.add('A', T);
    p.save();
    expect(existsSync(lockOf(p))).toBe(false);
  });
});

describe('R4 — un plan changé sur le disque depuis sa lecture n\'est pas écrasé', () => {
  it('R4 — refus, le changement de l\'autre session reste, verrou rendu', () => {
    const a = fresh();
    a.add('A', T);
    a.save();
    const mine = Plan.load(a.path);
    const theirs = Plan.load(a.path);
    theirs.add('B (autre session)', T);
    theirs.save();
    mine.add('C (moi)', T);
    expect(() => mine.save()).toThrow(/plan modifié par une autre session depuis sa lecture/);
    const text = readFileSync(a.path, 'utf8');
    expect(text).toContain('B (autre session)');
    expect(text).not.toContain('C (moi)');
    expect(existsSync(lockOf(a))).toBe(false);
  });

  it('R4 — deux écritures de suite du même objet passent (la lecture de référence suit l\'écriture)', () => {
    const p = fresh();
    p.add('A', T);
    p.save();
    p.add('B', T);
    p.save();
    expect(readFileSync(p.path, 'utf8')).toContain('title: B');
  });

  it('R4 — reloaded() relit le disque : l\'écriture suivante passe', () => {
    const a = fresh();
    const other = Plan.load(a.path);
    other.add('B', T);
    other.save();
    const again = a.reloaded();
    again.add('C', T);
    again.save();
    expect(readFileSync(a.path, 'utf8')).toMatch(/title: B[\s\S]*title: C/);
  });
});

describe('R5 — un plan en lecture seule ne prend aucun verrou', () => {
  it('R5 — refus de lecture seule inchangé, pas de fichier .lock', () => {
    const dir = tempDir();
    const path = join(dir, 'plan.yaml');
    writeFileSync(path, 'lots:\n  - id: X1\n    title: t\n');
    const p = Plan.load(path, { format: { lots: 'lots' } } as never);
    expect(() => p.save()).toThrow(/lecture seule/);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
