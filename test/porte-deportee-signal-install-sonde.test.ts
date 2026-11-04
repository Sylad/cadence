import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// Sonde L507 (R10) : le signal pendant gate.install, sans signal, deux fois, deux portes.
const registered = vi.hoisted(() => new Set<(sig: NodeJS.Signals) => void | Promise<void>>());
vi.mock('../src/proc.js', async (orig) => ({
  ...(await orig<typeof import('../src/proc.js')>()),
  onTermination: (f: (sig: NodeJS.Signals) => void | Promise<void>) => {
    registered.add(f);
    return () => registered.delete(f);
  },
}));
const { openRemoteGate } = await import('../src/remote-gate.js');

afterEach(() => {
  registered.clear();
  cleanupTempDirs();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const alive = (pattern: string): boolean => spawnSync('pgrep', ['-f', pattern]).status === 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 30_000) => {
  for (let t = 0; t < ms && !f(); t += 100) await wait(100);
};
const kill = (p: string) => spawnSync('pkill', ['-f', p]);

function setup() {
  const remote = fakeRemote();
  const repo = join(tempDir(), 'depot');
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { remote, repo, sha: git(repo, 'rev-parse', 'HEAD') };
}
const opts = (s: ReturnType<typeof setup>, install?: string) => ({ host: 'machine', install, repo: s.repo, sha: s.sha, depsFrom: s.repo, env: s.remote.env, timeoutMs: 60_000, workers: () => 1 });

describe('L507 R10 — signal pendant gate.install', () => {
  it('signal pendant gate.install, nettoyage de l\'hôte coupé : le ssh local de l\'installation est tué', async () => {
    const s = setup();
    s.remote.lose('for i in');
    const tag = `${process.pid}`;
    const localSsh = `bin/ssh .*sleep 31401\\.${tag}'`;
    const opening = openRemoteGate(opts(s, `sleep 31401.${tag}`));
    await until(() => alive(localSsh));
    expect(alive(localSsh)).toBe(true);
    expect(registered.size).toBeGreaterThan(0);
    await Promise.all([...registered].map((f) => f('SIGTERM')));
    await until(() => !alive(localSsh), 10_000);
    const still = alive(localSsh);
    kill(`sleep 31401\\.${tag}$`);
    await opening;
    expect(still).toBe(false);
  }, 90_000);

  it('signal sans aucun ssh en cours (porte ouverte et au repos) : le gestionnaire ne jette pas', async () => {
    const s = setup();
    const o = await openRemoteGate(opts(s, 'mkdir -p node_modules'));
    expect(o.ok).toBe(true);
    await expect(Promise.all([...registered].map((f) => f('SIGINT')))).resolves.toBeDefined();
    if (o.ok) o.gate.close();
  }, 60_000);

  it('le même signal joué deux fois pendant une commande : aucun jet, ssh tué', async () => {
    const s = setup();
    const o = await openRemoteGate(opts(s, 'mkdir -p node_modules'));
    if (!o.ok) throw new Error(o.cause);
    const tag = `${process.pid}`;
    const localSsh = `bin/ssh .*sleep 31402\\.${tag}'`;
    const run = o.gate.run(`sleep 31402.${tag}`, 60_000);
    await until(() => alive(localSsh));
    await Promise.all([...registered].map((f) => f('SIGTERM')));
    await Promise.all([...registered].map((f) => f('SIGTERM')));
    await until(() => !alive(localSsh), 10_000);
    const still = alive(localSsh);
    kill(`sleep 31402\\.${tag}$`);
    await run;
    o.gate.close();
    expect(still).toBe(false);
  }, 90_000);

  it('hôte injoignable : aucun gestionnaire de signal ne reste inscrit', async () => {
    const s = setup();
    s.remote.down();
    const o = await openRemoteGate(opts(s, 'mkdir -p node_modules'));
    expect(o.ok).toBe(false);
    expect(registered.size).toBe(0);
  }, 60_000);

  it('porte fermée : le gestionnaire de signal est retiré, rien ne reste inscrit', async () => {
    const s = setup();
    const o = await openRemoteGate(opts(s, 'mkdir -p node_modules'));
    if (!o.ok) throw new Error(o.cause);
    expect(o.gate.close()).toBeNull();
    expect(registered.size).toBe(0);
  }, 60_000);

  it('signal pendant le git push du sha : le push et son ssh local sont tués aussi', async () => {
    const s = setup();
    const tag = `${process.pid}`;
    // git met son propre exec-path devant le PATH : un faux git-receive-pack ne passerait pas ; un hook pre-receive dans le dépôt nu de l'hôte, créé d'avance, tient le push.
    const bare = join(s.remote.home, '.cadence-gate', 'depot', 'repo.git');
    mkdirSync(join(s.remote.home, '.cadence-gate', 'depot'), { recursive: true });
    git(s.repo, 'init', '--bare', '-q', bare);
    const hang = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hang, `#!/bin/sh\nsleep 31403.${tag}\n`);
    chmodSync(hang, 0o755);
    const opening = openRemoteGate(opts(s, 'mkdir -p node_modules'));
    await until(() => alive(`sleep 31403\\.${tag}$`));
    expect(alive(`sleep 31403\\.${tag}$`)).toBe(true);
    await Promise.all([...registered].map((f) => f('SIGTERM')));
    await until(() => !alive(`sleep 31403\\.${tag}$`), 10_000);
    const still = alive(`sleep 31403\\.${tag}$`);
    kill(`sleep 31403\\.${tag}$`);
    await opening;
    expect(still).toBe(false);
  }, 90_000);

  it('signal pendant la sonde de l\'hôte (avant le worktree) : un gestionnaire est déjà inscrit pour tuer le ssh de la sonde', async () => {
    const s = setup();
    s.remote.lose('uname'); // la sonde échoue : le gestionnaire doit pourtant être inscrit dès l'appel, avant son ssh, puis retiré
    const opening = openRemoteGate(opts(s, 'mkdir -p node_modules'));
    const seen = registered.size;
    const o = await opening;
    expect(seen).toBeGreaterThan(0);
    expect(o.ok).toBe(false);
    expect(registered.size).toBe(0);
  }, 60_000);
});
