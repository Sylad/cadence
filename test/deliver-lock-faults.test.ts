import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, gitRepo, tempDir } from './helpers.js';

// Un système de fichiers sans liens physiques : la pose du verrou de livraison échoue autrement que par EEXIST.
const hooks = vi.hoisted(() => ({ link: null as null | NodeJS.ErrnoException }));
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    linkSync: (a: string, b: string) => {
      if (hooks.link) throw hooks.link;
      return fs.linkSync(a, b);
    },
  };
});

const { deliver, parseDeliverConfig } = await import('../src/deliver.js');
const { Plan } = await import('../src/plan.js');
const { lockPath, sharedStateDir } = await import('../src/state.js');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
afterEach(() => {
  hooks.link = null;
});

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

describe('deliver : verrou impossible à poser', () => {
  it.each(['EPERM', 'EMLINK'])('%s : refus (2) avec « verrou <chemin> : <errno> », rien exécuté, pas d\'exception', async (code) => {
    const dir = pushedRepo();
    hooks.link = Object.assign(new Error(`${code}: pas de liens physiques`), { code });
    const err: string[] = [];
    const execs: string[] = [];
    const config = parseDeliverConfig('deliver:\n  ci: none\n  deploy:\n    - echo hi\n  verify:\n    - url: https://app.example/\n      contains: ok\n', 'cadence.yaml');
    const state = sharedStateDir(dir);
    const deps = {
      exec: (cmd: string) => (execs.push(cmd), 0),
      gh: () => [],
      ghReady: () => null,
      fetch: async () => ({ status: 200, text: 'ok' }),
      sleep: async () => {},
      now: () => 0,
    };
    const c = { root: dir, state, plan: Plan.load(join(dir, 'docs/plan/raf.yaml')), config, today: '2026-09-28', dryRun: false, args: [] as string[], out: () => {}, err: (l: string) => err.push(l) };
    expect(await deliver(c, deps)).toBe(2);
    expect(err.join('\n')).toContain(`deliver : verrou ${lockPath(state)} : ${code}`);
    expect(execs).toEqual([]);
    expect(existsSync(lockPath(state))).toBe(false);
  });
});
