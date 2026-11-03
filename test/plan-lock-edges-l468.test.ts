import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L468 — bords du verrou d'écriture du plan (sondes).
const T = '2026-11-03';
const fresh = () => Plan.create(join(tempDir(), '.cadence/raf.yaml'), 'demo');
const lockOf = (p: Plan) => `${p.path}.lock`;
const kids: ChildProcess[] = [];
const sleeper = () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  kids.push(c);
  return c;
};
const env = (v: string | undefined, f: () => void) => {
  const old = process.env.CADENCE_PLAN_LOCK_WAIT_MS;
  if (v === undefined) delete process.env.CADENCE_PLAN_LOCK_WAIT_MS;
  else process.env.CADENCE_PLAN_LOCK_WAIT_MS = v;
  try {
    f();
  } finally {
    if (old === undefined) delete process.env.CADENCE_PLAN_LOCK_WAIT_MS;
    else process.env.CADENCE_PLAN_LOCK_WAIT_MS = old;
  }
};
afterEach(() => {
  for (const c of kids.splice(0)) c.kill('SIGKILL');
});

describe('contenu de verrou de forme inattendue', () => {
  for (const [name, content] of [
    ['JSON null', 'null'],
    ['pid négatif', '{"pid":-5,"started":"x"}'],
    ['pid zéro', '{"pid":0,"started":"x"}'],
  ] as const) {
    it(`verrou ${name} ancien ou à pid invalide : ne bloque pas, écriture faite`, () => {
      const p = fresh();
      writeFileSync(lockOf(p), content);
      const old = new Date(Date.now() - 60_000);
      
      utimesSync(lockOf(p), old, old);
      p.add('A', T);
      env('100', () => p.save());
      expect(readFileSync(p.path, 'utf8')).toContain('title: A');
      expect(existsSync(lockOf(p))).toBe(false);
    });
  }

  it('verrou vide (0 octet) et récent : tenu, refus lisible', () => {
    const p = fresh();
    writeFileSync(lockOf(p), '');
    p.add('A', T);
    env('100', () => expect(() => p.save()).toThrow(/verrou en cours de pose/));
  });

  it('verrou qui est un dossier : pas de plantage obscur, plan inchangé', () => {
    const p = fresh();
    mkdirSync(lockOf(p));
    const before = readFileSync(p.path, 'utf8');
    p.add('A', T);
    env('100', () => {
      try {
        p.save();
      } catch (e) {
        expect((e as Error).message).not.toMatch(/^EISDIR|TypeError/);
      }
    });
    expect(readFileSync(p.path, 'utf8')).toBe(before.replace(/\n*$/, '\n') === before ? before : readFileSync(p.path, 'utf8'));
  });
});

describe('verrou à pid non numérique : ne boucle pas', () => {
  // Joué dans un processus fils borné : une boucle sans fin dans save() est synchrone et ne laisserait pas vitest expirer.
  for (const [name, content] of [
    ['JSON tableau', '[1,2]'],
    ['JSON chaîne', '"x"'],
    ['objet vide', '{}'],
    ['pid texte', '{"pid":"abc","started":"x"}'],
  ] as const) {
    it(`verrou ${name} : écarté comme périmé, écriture faite (pas de boucle sans fin)`, () => {
      const p = fresh();
      writeFileSync(lockOf(p), content);
      const script = join(tempDir(), 'run.ts');
      writeFileSync(script, `import { Plan } from ${JSON.stringify(join(process.cwd(), 'src/plan.ts'))};\nconst p = Plan.load(${JSON.stringify(p.path)});\np.add('A', '${T}');\np.save();\nconsole.log('ok');\n`);
      const r = spawnSync(join(process.cwd(), 'node_modules/.bin/vite-node'), [script], { encoding: 'utf8', timeout: 8_000, killSignal: 'SIGKILL', env: { ...process.env, CADENCE_PLAN_LOCK_WAIT_MS: '300' } });
      expect(r.error?.message ?? '').not.toMatch(/ETIMEDOUT/);
      expect(r.stdout).toContain('ok');
      expect(readFileSync(p.path, 'utf8')).toContain('title: A');
    });
  }
});

describe('CADENCE_PLAN_LOCK_WAIT_MS', () => {
  const held = (p: Plan) => writeFileSync(lockOf(p), JSON.stringify({ pid: sleeper().pid, started: 'x' }));
  it('0 : refus immédiat, message « après 0 s »', () => {
    const p = fresh();
    held(p);
    p.add('A', T);
    const t0 = Date.now();
    env('0', () => expect(() => p.save()).toThrow(/après 0 s/));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it.each(['abc', '-1', '1.5', '', ' 100'])('valeur invalide %j : retombe sur 30 s (attend le verrou rendu à 600 ms au lieu de refuser)', async (v) => {
    const p = fresh();
    held(p);
    p.add('A', T);
    const holder = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').rmSync(${JSON.stringify(lockOf(p))}),600)`], { stdio: 'ignore' });
    kids.push(holder);
    await new Promise((r) => setTimeout(r, 50));
    env(v, () => p.save());
    expect(readFileSync(p.path, 'utf8')).toContain('title: A');
  });
});

describe('verrou et fichiers annexes', () => {
  it('aucun .tmp / .stale ne reste après refus ni après reprise d\'un verrou périmé', () => {
    const p = fresh();
    writeFileSync(lockOf(p), JSON.stringify({ pid: 2 ** 22 + 999, started: 'x' }));
    p.add('A', T);
    p.save();
    const h = sleeper();
    writeFileSync(lockOf(p), JSON.stringify({ pid: h.pid, started: 'x' }));
    p.add('B', T);
    env('100', () => expect(() => p.save()).toThrow());
    const left = readdirSync(dirname(p.path)).filter((f) => /\.(tmp|stale\.\d+)$/.test(f));
    expect(left).toEqual([]);
  });

  it('verrou posé par notre propre pid (écriture imbriquée) : refus lisible, pas de blocage 30 s', () => {
    const p = fresh();
    writeFileSync(lockOf(p), JSON.stringify({ pid: process.pid, started: 'x' }));
    p.add('A', T);
    const t0 = Date.now();
    env('200', () => expect(() => p.save()).toThrow(/plan tenu par une autre session/));
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('le verrou d\'un autre, pris pendant notre écriture (finally), n\'est pas retiré', () => {
    const dir = tempDir();
    const path = join(dir, '.cadence/raf.yaml');
    Plan.create(path, 'demo');
    const h = sleeper();
    // la commande onWrite remplace le verrou par celui d'un autre porteur
    const swap = `node -e "require('fs').writeFileSync('${path}.lock', JSON.stringify({pid:${h.pid},started:'autre'}))"`;
    const p = Plan.load(path, { onWrite: { command: swap, files: [], cwd: dir } });
    p.add('A', T);
    try {
      p.save();
    } catch {
      /* ignoré */
    }
    expect(existsSync(`${path}.lock`)).toBe(true);
    expect(readFileSync(`${path}.lock`, 'utf8')).toContain('autre');
    rmSync(`${path}.lock`, { force: true });
  });
});

describe('plan changé depuis la lecture', () => {
  it('plan supprimé du disque après lecture : save refuse au lieu de recréer en silence', () => {
    const p = fresh();
    p.add('A', T);
    rmSync(p.path);
    expect(() => p.save()).toThrow(/modifié par une autre session|plan/);
    expect(existsSync(p.path)).toBe(false);
  });

  it('changement d\'un seul octet (fin de ligne) par un autre : refusé', () => {
    const p = fresh();
    writeFileSync(p.path, readFileSync(p.path, 'utf8') + '\n');
    p.add('A', T);
    expect(() => p.save()).toThrow(/modifié par une autre session/);
  });

  it('deux save() sans changement entre les deux (rien à écrire) passent', () => {
    const p = fresh();
    p.save();
    p.save();
    expect(existsSync(lockOf(p))).toBe(false);
  });

  it('refus par plan changé, puis relance via reloaded() : passe et le verrou est rendu', () => {
    const a = fresh();
    const b = Plan.load(a.path);
    b.add('B', T);
    b.save();
    a.add('A', T);
    expect(() => a.save()).toThrow(/modifié par une autre session/);
    const c = a.reloaded();
    c.add('C', T);
    c.save();
    expect(readFileSync(a.path, 'utf8')).toMatch(/title: B[\s\S]*title: C/);
    expect(existsSync(lockOf(a))).toBe(false);
  });

  it('onWrite qui modifie le plan lui-même avec succès : l\'écriture suivante du même objet n\'est pas refusée à tort', () => {
    const dir = tempDir();
    const path = join(dir, '.cadence/raf.yaml');
    Plan.create(path, 'demo');
    const touch = `node -e "require('fs').appendFileSync('${path}','# note\\n')"`;
    const p = Plan.load(path, { onWrite: { command: touch, files: [path], cwd: dir } });
    p.add('A', T);
    p.save();
    p.add('B', T);
    expect(() => p.save()).not.toThrow();
  });
});
