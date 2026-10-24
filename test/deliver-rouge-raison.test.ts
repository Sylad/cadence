import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliver, parseDeliverConfig, realDeps, type DeliverCtx, type DeliverDeps } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { readFailedDeliveries, readFailedEntries, sharedStateDir as stateDir } from '../src/state.js';
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
const CI_CMD = parseDeliverConfig('deliver:\n  ci:\n    command: ./ci.sh\n  deploy:\n    - echo deploy\n  verify:\n    - command: ./check.sh\n', 'cadence.yaml');
const CHECK_CMD = parseDeliverConfig('deliver:\n  deploy:\n    - echo deploy\n  verify:\n    - command: ./check.sh\n  verifyTimeout: 1\n', 'cadence.yaml');

function ctx(dir: string, config = CONFIG): DeliverCtx {
  return { root: dir, state: stateDir(dir), plan: Plan.load(join(dir, 'docs/plan/raf.yaml')), config, today: '2026-10-16', dryRun: false, args: [], out: () => {}, err: () => {} };
}
const redLines = (dir: string) => {
  const f = join(stateDir(dir), 'deliveries-failed.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

describe('deliver — raison et classe d\'une livraison rouge (L282)', () => {
  it('R1 — échec du script : classe « deploiement » et dernières lignes de sortie du script sur la même ligne', async () => {
    const dir = pushedRepo();
    const code = await deliver(ctx(dir, SCRIPT), deps({ exec: () => 1, lastOutput: () => ['build ok', 'kubectl rollout timeout'] }));
    expect(code).toBe(1);
    expect(redLines(dir)).toEqual([`2026-10-16 ${headSha(dir)} [deploiement] script de livraison en échec (code 1) : ./livrer.sh ⏎ build ok ⏎ kubectl rollout timeout`]);
  });

  it('R2 — script sorti avec le code 2 (refus avant action) : classe « refus »', async () => {
    const dir = pushedRepo();
    await deliver(ctx(dir, SCRIPT), deps({ exec: () => 2, lastOutput: () => ['arbre sale'] }));
    expect(readFailedEntries(join(stateDir(dir)))[0]).toMatchObject({ cls: 'refus', tail: ['arbre sale'] });
  });

  it('R3 — CI : classe « ci » (run GitHub rouge, sans sortie) et sortie d\'une commande de CI', async () => {
    const dir = pushedRepo();
    await deliver(ctx(dir), deps({ gh: () => [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }));
    await deliver(ctx(dir, CI_CMD), deps({ exec: () => 1, lastOutput: () => ['2 tests en échec'] }));
    const [gh, cmd] = readFailedEntries(stateDir(dir));
    expect(gh).toMatchObject({ cls: 'ci', tail: [] });
    expect(cmd).toMatchObject({ cls: 'ci', tail: ['2 tests en échec'] });
  });

  it('R4 — déploiement : classe « deploiement » avec la sortie de la commande qui a échoué', async () => {
    const dir = pushedRepo();
    await deliver(ctx(dir), deps({ exec: () => 1, lastOutput: () => ['denied'] }));
    expect(readFailedEntries(stateDir(dir))[0]).toMatchObject({ cls: 'deploiement', tail: ['denied'] });
  });

  it('R5 — vérification : classe « verification » ; la sortie n\'est lue que pour une commande de contrôle, jamais pour une URL', async () => {
    const dir = pushedRepo();
    let calls = 0;
    const d = deps({ exec: (cmd) => (cmd === './check.sh' ? 1 : 0), lastOutput: () => ((calls += 1), ['check: 503']) });
    await deliver(ctx(dir, CHECK_CMD), d);
    expect(readFailedEntries(stateDir(dir))[0]).toMatchObject({ cls: 'verification', tail: ['check: 503'] });
    calls = 0;
    await deliver(ctx(dir), deps({ fetch: async () => ({ status: 500, text: 'ko' }), lastOutput: () => ((calls += 1), ['reste du déploiement']) }));
    expect(calls).toBe(0);
    expect(readFailedEntries(stateDir(dir))[1]).toMatchObject({ cls: 'verification', tail: [] });
  });

  it('R6 — la raison est bornée : 5 lignes au plus, 200 caractères par ligne, séquences ANSI retirées, une seule ligne dans le fichier', async () => {
    const dir = pushedRepo();
    const long = Array.from({ length: 30 }, (_, i) => `\u001b[31mligne ${i}\u001b[0m ${'x'.repeat(500)}`);
    await deliver(ctx(dir, SCRIPT), deps({ exec: () => 1, lastOutput: () => long }));
    expect(redLines(dir)).toHaveLength(1);
    const e = readFailedEntries(stateDir(dir))[0]!;
    expect(e.tail).toHaveLength(5);
    expect(e.tail[4]).toMatch(/^ligne 29 x+…$/);
    for (const l of e.tail) expect(l.length).toBeLessThanOrEqual(200);
    expect(redLines(dir)[0]).not.toContain('\u001b');
  });

  it('R7 — journal historique « jour sha raison » (sans classe) : lu avec une classe inconnue, ses jours comptés comme avant', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'deliveries-failed.log'), '2026-10-10 abc CI en échec : ci\nn importe quoi\n2026-10-11 def [ci] CI en échec ⏎ a ⏎ b\n2026-10-12 ghi [bizarre] x\n');
    expect(readFailedEntries(dir)).toEqual([
      { day: '2026-10-10', sha: 'abc', cls: null, reason: 'CI en échec : ci', tail: [] },
      { day: '2026-10-11', sha: 'def', cls: 'ci', reason: 'CI en échec', tail: ['a', 'b'] },
      { day: '2026-10-12', sha: 'ghi', cls: null, reason: '[bizarre] x', tail: [] },
    ]);
    expect(readFailedDeliveries(dir)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('R8 — exec réel : lastOutput rend les dernières lignes de la commande (stdout et stderr), remises à zéro à chaque commande', async () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    const d = realDeps(root);
    expect(await d.exec('echo un; echo deux >&2; exit 3', {}, 5_000)).toBe(3);
    expect(d.lastOutput!().sort()).toEqual(['deux', 'un']);
    expect(await d.exec('true', {}, 5_000)).toBe(0);
    expect(d.lastOutput!()).toEqual([]);
  });

  it('R9 — la borne de 8192 garde la fin de la sortie : plus de 8192 caractères d\'indicateur d\'attente (\\r) puis une vraie raison donnent cette raison (L282, L294)', async () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    const d = realDeps(root);
    const cmd = String.raw`i=0; while [ $i -lt 400 ]; do printf '\r\033[K- Deploying site...'; i=$((i+1)); done; printf '\r\033[KX Deploy failed: quota exceeded\n'; exit 1`;
    expect(await d.exec(cmd, {}, 5_000)).toBe(1);
    // les séquences ANSI sont retirées plus tard, à l'écriture du journal
    expect(d.lastOutput!().map((l) => l.replaceAll('\u001b[K', ''))).toEqual(['X Deploy failed: quota exceeded']);
    expect(await d.exec('echo court; exit 1', {}, 5_000)).toBe(1);
    expect(d.lastOutput!()).toEqual(['court']);
  });
});
