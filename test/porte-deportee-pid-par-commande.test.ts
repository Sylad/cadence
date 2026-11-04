import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRemoteGate } from '../src/remote-gate.js';
import { fakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const alive = (pattern: string): boolean => spawnSync('pgrep', ['-f', pattern]).status === 0;
const settle = async (pattern: string): Promise<boolean> => {
  for (let t = 0; t < 10_000 && alive(pattern); t += 100) await new Promise((r) => setTimeout(r, 100));
  return alive(pattern);
};

function setup(nom = 'depot') {
  const remote = fakeRemote();
  const repo = join(tempDir(), nom);
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'a.txt'), '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { remote, repo, sha: git(repo, 'rev-parse', 'HEAD'), wt: join(remote.home, '.cadence-gate', nom, 'wt') };
}
const open = async (s: ReturnType<typeof setup>) => {
  const o = await openRemoteGate({ host: 'machine', install: 'mkdir -p node_modules', repo: s.repo, sha: s.sha, depsFrom: s.repo, env: s.remote.env, timeoutMs: 30_000, workers: () => 1 });
  if (!o.ok) throw new Error(o.cause);
  return o.gate;
};
const pidFiles = (s: ReturnType<typeof setup>) => (existsSync(s.wt) ? readdirSync(s.wt).filter((f) => f.endsWith('.pid')) : []);

describe('R19 — un pid par commande distante', () => {
  it('trois commandes en délai à la suite : les trois groupes sont arrêtés à la fermeture', async () => {
    const s = setup();
    const gate = await open(s);
    const tag = `${process.pid}`;
    for (const n of [1, 2, 3]) await gate.run(`sleep 4123${n}.${tag}`, 1200);
    expect(pidFiles(s).length).toBeGreaterThanOrEqual(3);
    expect(gate.close()).toBeNull();
    expect(await settle(`sleep 4123[123]\\.${tag}$`)).toBe(false);
  });

  it('plus de dix commandes : <id>.1.pid et <id>.11.pid sont tous deux pris en compte', async () => {
    const s = setup();
    const gate = await open(s);
    const tag = `${process.pid}`;
    await gate.run(`sleep 51111.${tag}`, 1200);
    for (let i = 0; i < 9; i++) await gate.run('true', 30_000);
    await gate.run(`sleep 51112.${tag}`, 1200);
    expect(pidFiles(s).some((f) => /\.11\.pid$/.test(f))).toBe(true);
    expect(gate.close()).toBeNull();
    expect(await settle(`sleep 5111[12]\\.${tag}$`)).toBe(false);
  });

  it('après la fermeture, aucun fichier .pid ni worktree ne reste sur l\'hôte', async () => {
    const s = setup();
    const gate = await open(s);
    await gate.run('true', 30_000);
    await gate.run('true', 30_000);
    expect(pidFiles(s).length).toBe(2);
    expect(gate.close()).toBeNull();
    expect(existsSync(s.wt) ? readdirSync(s.wt) : []).toEqual([]);
  });

  it('fermeture deux fois : la seconde ne rend pas d\'erreur', async () => {
    const s = setup();
    const gate = await open(s);
    await gate.run(`sleep 61111.${process.pid}`, 1200);
    expect(gate.close()).toBeNull();
    expect(gate.close()).toBeNull();
  });

  it('fichier pid vide ou illisible planté : le nettoyage ne casse pas et retire le fichier', async () => {
    const s = setup();
    const gate = await open(s);
    await gate.run('true', 30_000);
    const first = readdirSync(s.wt).find((f) => f.endsWith('.1.pid'))!;
    const id = first.replace(/\.1\.pid$/, '');
    writeFileSync(join(s.wt, `${id}.7.pid`), '');
    writeFileSync(join(s.wt, `${id}.8.pid`), 'pas-un-pid\n');
    expect(gate.close()).toBeNull();
    expect(pidFiles(s)).toEqual([]);
  });

  it('un ancien fichier <id>.pid (format d\'avant) est encore tué à la fermeture', async () => {
    const s = setup();
    const gate = await open(s);
    await gate.run('true', 30_000);
    const id = readdirSync(s.wt).find((f) => f.endsWith('.1.pid'))!.replace(/\.1\.pid$/, '');
    const tag = `${process.pid}`;
    const child = spawnSync('sh', ['-c', `setsid sh -c 'exec sleep 71111.${tag}' >/dev/null 2>&1 & echo $! `], { encoding: 'utf8' });
    writeFileSync(join(s.wt, `${id}.pid`), child.stdout.trim() + '\n');
    expect(alive(`sleep 71111\\.${tag}$`)).toBe(true);
    expect(gate.close()).toBeNull();
    expect(await settle(`sleep 71111\\.${tag}$`)).toBe(false);
  });

  it('deux portes ouvertes : fermer l\'une n\'arrête pas la commande de l\'autre', async () => {
    const s = setup();
    const a = await open(s);
    const b = await open(s);
    const tag = `${process.pid}`;
    await a.run(`sleep 81111.${tag}`, 1200);
    await b.run(`sleep 81112.${tag}`, 1200);
    expect(a.close()).toBeNull();
    expect(await settle(`sleep 81111\\.${tag}$`)).toBe(false);
    expect(alive(`sleep 81112\\.${tag}$`)).toBe(true);
    expect(b.close()).toBeNull();
    expect(await settle(`sleep 81112\\.${tag}$`)).toBe(false);
  });

  it('dépôt dont le dossier a un espace et une apostrophe : le pid est écrit, lu et tué à la fermeture', async () => {
    const s = setup("l'atelier de test");
    const gate = await open(s);
    const tag = `${process.pid}`;
    await gate.run(`sleep 91111.${tag}`, 1200);
    expect(pidFiles(s).length).toBeGreaterThanOrEqual(1);
    expect(gate.close()).toBeNull();
    expect(await settle(`sleep 91111\\.${tag}$`)).toBe(false);
    expect(existsSync(s.wt) ? readdirSync(s.wt) : []).toEqual([]);
  });
});
