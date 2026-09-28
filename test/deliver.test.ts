import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { deliver, parseDeliverConfig, type DeliverDeps, type GhRun } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { lastDelivery, readLock, stateDir, writeLock } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Dépôt poussé sur un « origin » local, avec un plan L1 et un commit qui le cite. */
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

function fakeDeps(over: Partial<DeliverDeps> = {}) {
  let clock = 0;
  const execs: { cmd: string; env: Record<string, string> }[] = [];
  const deps: DeliverDeps = {
    exec: (cmd, env) => {
      execs.push({ cmd, env });
      return 0;
    },
    gh: () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { deps, execs, clock: () => clock };
}

const CONFIG = parseDeliverConfig(
  `deliver:
  ci: github
  deploy:
    - echo "$CADENCE_SHORT"
  verify:
    - url: https://app.example/v/\${SHORT}
      contains: ok
`,
  'cadence.yaml',
);

function ctx(dir: string, over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    c: {
      root: dir,
      state: stateDir(dir),
      plan: Plan.load(join(dir, 'docs/plan/raf.yaml')),
      config: CONFIG,
      today: '2026-09-28',
      dryRun: false,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      ...over,
    },
    out,
    err,
  };
}

describe('parseDeliverConfig', () => {
  it('applique les défauts', () => {
    const c = parseDeliverConfig('deliver:\n  verify:\n    - command: "true"\n', 'f');
    expect(c).toEqual({ ci: 'none', ciTimeout: 1800, deploy: [], verify: [{ command: 'true' }], verifyTimeout: 300 });
  });
  it.each([
    ['foo: 1', /clé deliver absente/],
    ['deliver:\n  ci: gitlab\n  verify: [{command: x}]', /ci/],
    ['deliver:\n  deploy: {a: 1}\n  verify: [{command: x}]', /deploy/],
    ['deliver:\n  verify: []', /au moins une vérification/],
    ['deliver:\n  verify: [{status: 200}]', /verify\[1\]/],
    ['deliver:\n  verify: [{url: x, command: y}]', /verify\[1\]/],
    ['deliver:\n  ciTimeout: -1\n  verify: [{command: x}]', /ciTimeout/],
    ['deliver: [', /illisible/],
  ])('refuse %j', (text, msg) => {
    expect(() => parseDeliverConfig(text, 'f')).toThrow(msg);
  });
});

describe('deliver', () => {
  it('livre : CI, déploiement avec les variables, vérification, journal, lots livrés', async () => {
    const dir = pushedRepo();
    const state = stateDir(dir);
    const { deps, execs } = fakeDeps();
    const urls: string[] = [];
    deps.fetch = async (u) => {
      urls.push(u);
      return { status: 200, text: 'ok' };
    };
    // Première livraison : pose le point de départ.
    expect(await deliver(ctx(dir).c, deps)).toBe(0);
    commit(dir, 'feat(L1): cache');
    git(dir, 'push', '-q');
    const sha = headSha(dir)!;
    const { c, out } = ctx(dir);
    expect(await deliver(c, deps)).toBe(0);
    expect(execs.at(-1)).toEqual({
      cmd: 'echo "$CADENCE_SHORT"',
      env: { CADENCE_SHA: sha, CADENCE_SHORT: sha.slice(0, 7), CADENCE_BRANCH: 'main' },
    });
    expect(urls.at(-1)).toBe(`https://app.example/v/${sha.slice(0, 7)}`);
    expect(lastDelivery(state)).toBe(sha);
    expect(readLock(state)).toBeNull();
    expect(out.join('\n')).toContain('livré : L1');
  });

  it('refuse un arbre modifié, un sha non poussé, une livraison en cours (code 2)', async () => {
    const dir = pushedRepo();
    writeFileSync(join(dir, 'README.md'), 'x');
    const a = ctx(dir);
    expect(await deliver(a.c, fakeDeps().deps)).toBe(2);
    expect(a.err.join('\n')).toContain('modifié');
    git(dir, 'checkout', '-q', '.');

    commit(dir, 'feat(L1): local');
    const b = ctx(dir);
    expect(await deliver(b.c, fakeDeps().deps)).toBe(2);
    expect(b.err.join('\n')).toContain('non poussé');
    git(dir, 'push', '-q');

    writeLock(stateDir(dir), { pid: process.pid, sha: 'x', started: 'y' });
    const c = ctx(dir);
    expect(await deliver(c.c, fakeDeps().deps)).toBe(2);
    expect(c.err.join('\n')).toContain('déjà en cours');
    expect(readLock(stateDir(dir))?.pid).toBe(process.pid);
  });

  it('retire un verrou périmé et continue', async () => {
    const dir = pushedRepo();
    writeLock(stateDir(dir), { pid: 2 ** 22 + 12345, sha: 'x', started: 'y' });
    const { c, err } = ctx(dir);
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(err.join('\n')).toContain('périmé');
  });

  it('simulation : rien n’est exécuté ni verrouillé', async () => {
    const dir = pushedRepo();
    const { deps, execs } = fakeDeps({ gh: () => { throw new Error('gh appelé'); } });
    const { c, out } = ctx(dir, { dryRun: true });
    expect(await deliver(c, deps)).toBe(0);
    expect(execs).toEqual([]);
    expect(lastDelivery(stateDir(dir))).toBeNull();
    expect(out.join('\n')).toMatch(/simulation[\s\S]*1\. echo "\$CADENCE_SHORT"[\s\S]*GET https:\/\/app\.example\/v\/[0-9a-f]{7} → 200, contient « ok »/);
  });

  it('CI : aucun run après 5 min → échec, verrou retiré', async () => {
    const dir = pushedRepo();
    let calls = 0;
    const { deps, execs, clock } = fakeDeps({ gh: () => (calls++, []) });
    const { c, err } = ctx(dir);
    expect(await deliver(c, deps)).toBe(1);
    expect(err.join('\n')).toContain('aucun run CI');
    expect(clock()).toBeGreaterThanOrEqual(300_000);
    expect(calls).toBeGreaterThan(1);
    expect(execs).toEqual([]);
    expect(readLock(stateDir(dir))).toBeNull();
  });

  it('CI : attend que les runs apparaissent puis se terminent ; échec nommé', async () => {
    const dir = pushedRepo();
    const seq: GhRun[][] = [
      [],
      [{ name: 'build', status: 'in_progress', conclusion: '' }],
      [
        { name: 'build', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'skipped' },
      ],
    ];
    const { deps } = fakeDeps({ gh: () => seq.shift() ?? [] });
    const { c, err } = ctx(dir);
    expect(await deliver(c, deps)).toBe(1);
    expect(err.join('\n')).toContain('CI en échec : build (failure)');
  });

  it('déploiement en échec : arrêt, verrou retiré', async () => {
    const dir = pushedRepo();
    const { deps } = fakeDeps({ exec: () => 3 });
    const { c, err } = ctx(dir);
    expect(await deliver(c, deps)).toBe(1);
    expect(err.join('\n')).toContain('code 3');
    expect(readLock(stateDir(dir))).toBeNull();
  });

  it('vérifications réessayées jusqu’au délai, dernière raison affichée', async () => {
    const dir = pushedRepo();
    let n = 0;
    const ok = fakeDeps({ fetch: async () => (++n < 3 ? { status: 502, text: '' } : { status: 200, text: 'ok' }) });
    expect(await deliver(ctx(dir).c, ok.deps)).toBe(0);
    expect(n).toBe(3);

    const ko = fakeDeps({ fetch: async () => ({ status: 200, text: 'ancienne version' }) });
    const { c, err } = ctx(dir);
    expect(await deliver(c, ko.deps)).toBe(1);
    expect(err.join('\n')).toContain('« ok » absent');
    expect(ko.clock()).toBeGreaterThanOrEqual(300_000);
  });
});

describe('cadence deliver (CLI)', () => {
  async function cad(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date() });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('refuse sans cadence.yaml', async () => {
    const r = await cad(pushedRepo(), 'deliver');
    expect(r.code).toBe(2);
    expect(r.err).toContain('cadence.yaml');
  });

  it('livre pour de vrai avec des commandes shell', async () => {
    const dir = pushedRepo();
    writeFileSync(
      join(dir, 'cadence.yaml'),
      'deliver:\n  deploy:\n    - echo "$CADENCE_SHORT" > .git/deployed-$CADENCE_BRANCH\n  verify:\n    - command: test -s .git/deployed-main\n',
    );
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    expect((await cad(dir, 'deliver', '--dry-run')).code).toBe(0);
    expect(existsSync(join(dir, '.git/deployed-main'))).toBe(false);
    const r = await cad(dir, 'deliver');
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, '.git/deployed-main'), 'utf8').trim()).toBe(headSha(dir)!.slice(0, 7));
  });
});
