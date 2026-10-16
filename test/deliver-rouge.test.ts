import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliver, parseDeliverConfig, type DeliverCtx, type DeliverDeps } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { readFailedDeliveries, sharedStateDir as stateDir, writeLock } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

function pushedRepo(): string {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-09-28');
  plan.add('Cache', '2026-09-28');
  plan.save();
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

function deps(over: Partial<DeliverDeps> = {}): DeliverDeps {
  let clock = 0;
  return {
    exec: () => 0,
    gh: () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    ghReady: () => null,
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
}

const CONFIG = parseDeliverConfig('deliver:\n  ci: github\n  deploy:\n    - echo deploy\n  verify:\n    - url: https://app.example/v\n      contains: ok\n', 'cadence.yaml');
const SCRIPT = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n', 'cadence.yaml');

function ctx(dir: string, config = CONFIG) {
  const out: string[] = [];
  const err: string[] = [];
  const c: DeliverCtx = { root: dir, state: stateDir(dir), plan: Plan.load(join(dir, 'docs/plan/raf.yaml')), config, today: '2026-10-16', dryRun: false, args: [], out: (l) => out.push(l), err: (l) => err.push(l) };
  return { c, out, err };
}
const red = (dir: string) => join(stateDir(dir), 'deliveries-failed.log');
const redLines = (dir: string) => (existsSync(red(dir)) ? readFileSync(red(dir), 'utf8').split('\n').filter(Boolean) : []);

describe('deliver — journal des livraisons rouges (L227)', () => {
  it('R1 — échec de CI après le verrou : une entrée rouge du jour, deliveries.log inchangé', async () => {
    const dir = pushedRepo();
    const { c } = ctx(dir);
    const code = await deliver(c, deps({ gh: () => [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }));
    expect(code).toBe(1);
    expect(redLines(dir)).toHaveLength(1);
    expect(redLines(dir)[0]).toMatch(new RegExp(`^2026-10-16 ${headSha(dir)} CI en échec`));
    expect(existsSync(join(stateDir(dir), 'deliveries.log'))).toBe(false);
  });

  it('R1 — échec du script, du déploiement, de la vérification : une entrée chacun', async () => {
    const dir = pushedRepo();
    expect(await deliver(ctx(dir, SCRIPT).c, deps({ exec: () => 3 }))).toBe(1);
    expect(redLines(dir)).toHaveLength(1);
    expect(redLines(dir)[0]).toContain('script de livraison en échec');
    expect(await deliver(ctx(dir).c, deps({ exec: () => 1 }))).toBe(1);
    expect(redLines(dir)).toHaveLength(2);
    expect(redLines(dir)[1]).toContain('déploiement en échec');
    expect(await deliver(ctx(dir).c, deps({ fetch: async () => ({ status: 500, text: 'ko' }) }))).toBe(1);
    expect(redLines(dir)).toHaveLength(3);
  });

  it('R1 — la ligne rouge est « jour sha raison » avec la raison sur une seule ligne (message d\'échec multiligne tronqué à la première ligne)', async () => {
    const dir = pushedRepo();
    const { c } = ctx(dir, parseDeliverConfig('deliver:\n  ci:\n    command: "echo a\\nb"\n  verify:\n    - command: "true"\n', 'cadence.yaml'));
    expect(await deliver(c, deps({ exec: () => 1 }))).toBe(1);
    const lines = redLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`2026-10-16 ${headSha(dir)} CI en échec (code 1) : echo a`);
  });

  it('R1 — livraison verte : aucune entrée rouge, deliveries.log reçoit sa ligne', async () => {
    const dir = pushedRepo();
    expect(await deliver(ctx(dir).c, deps())).toBe(0);
    expect(existsSync(red(dir))).toBe(false);
    expect(readFileSync(join(stateDir(dir), 'deliveries.log'), 'utf8')).toBe(`2026-10-16 ${headSha(dir)}\n`);
  });

  it('R1 — refus avant le verrou (autre livraison en cours) : aucune entrée rouge', async () => {
    const dir = pushedRepo();
    writeLock(stateDir(dir), { pid: process.pid, sha: 'x', started: 'y' });
    expect(await deliver(ctx(dir).c, deps())).toBe(2);
    expect(existsSync(red(dir))).toBe(false);
  });

  it('R2 — le journal rouge se lit ligne à ligne, une ligne illisible est ignorée, un fichier absent ou illisible donne une liste vide', () => {
    const dir = tempDir();
    expect(readFailedDeliveries(dir)).toEqual([]);
    writeFileSync(join(dir, 'deliveries-failed.log'), '2026-10-10 abc CI en échec\nn importe quoi\n2026-10-11 def x\n');
    expect(readFailedDeliveries(dir)).toEqual(['2026-10-10', '2026-10-11']);
    const unreadable = tempDir();
    mkdirSync(join(unreadable, 'deliveries-failed.log'));
    expect(readFailedDeliveries(unreadable)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('R9 — journal rouge non inscriptible : deliver sort 1 avec son message d\'échec et l\'avertissement', async () => {
    const dir = pushedRepo();
    mkdirSync(stateDir(dir), { recursive: true });
    writeFileSync(red(dir), '');
    chmodSync(red(dir), 0o444);
    const { c, err } = ctx(dir);
    const code = await deliver(c, deps({ gh: () => [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }));
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toContain('deliver : CI en échec');
    expect(text).toMatch(/deliver : journal des livraisons rouges non écrit : /);
  });
});
