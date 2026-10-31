import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { lockfileFingerprint } from '../src/remote-gate.js';
import { verifyGate } from '../src/verify-gate.js';
import { fakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function project(orchestrate: string, o: { name?: string; files?: Record<string, string>; lock?: boolean } = {}) {
  const remote = fakeRemote();
  const mark = join(tempDir(), 'ran.log');
  const name = o.name ?? 'depot';
  const repo = join(tempDir(), name);
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n${orchestrate.replaceAll('{MARK}', mark)}verify:\n  inPlace: false\n`);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  if (o.lock !== false) writeFileSync(join(repo, 'package-lock.json'), '{"v":1}\n');
  for (const [f, c] of Object.entries(o.files ?? {})) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'local');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD'), remote, mark, work: join(remote.home, '.cadence-gate', name) };
}
type Proj = ReturnType<typeof project>;
const marks = (p: Proj) => (existsSync(p.mark) ? readFileSync(p.mark, 'utf8').split('\n').filter(Boolean) : []);
async function gate(p: Proj, env: Record<string, string | undefined> = {}, sha = p.sha) {
  const lines: string[] = [];
  const cfg = join(p.repo, 'cadence.yaml');
  const code = await verifyGate({ repo: p.repo, sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), env: { ...p.remote.env, ...env }, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n'), lines };
}
const HOST = '  gate:\n    host: machine\n    install: mkdir -p node_modules\n';

describe('L403 probe — R18 : empreinte des lockfiles sur la vraie forme des chemins', () => {
  it('R18 — lockfile dans un dossier au nom non ASCII : compté dans l\'empreinte (git cite ces chemins)', () => {
    const p = project('  test: true\n', { lock: false, files: { 'fronté/package-lock.json': '{"a":1}\n' } });
    const fp = lockfileFingerprint(p.repo, p.sha);
    expect(fp, 'un lockfile existe au sha').not.toBeNull();
    expect(fp!.files).toEqual(['fronté/package-lock.json']);
  });

  it('R18 — deux shas dont seul le lockfile d\'un dossier non ASCII change : empreintes différentes', () => {
    const p = project('  test: true\n', { lock: false, files: { 'fronté/yarn.lock': 'v1\n' } });
    const a = lockfileFingerprint(p.repo, p.sha);
    writeFileSync(join(p.repo, 'fronté', 'yarn.lock'), 'v2\n');
    git(p.repo, 'commit', '-qam', 'bump');
    const b = lockfileFingerprint(p.repo, git(p.repo, 'rev-parse', 'HEAD'));
    expect(a?.fp).toBeTruthy();
    expect(b?.fp).not.toBe(a?.fp);
  });

  it('R18 — lockfile dans un dossier avec espace : compté', () => {
    const p = project('  test: true\n', { lock: false, files: { 'mon front/yarn.lock': 'v1\n' } });
    expect(lockfileFingerprint(p.repo, p.sha)?.files).toEqual(['mon front/yarn.lock']);
  });

  it('R18 — lockfile vide (0 octet) : une empreinte existe, distincte de « aucun lockfile »', () => {
    const p = project('  test: true\n', { lock: false, files: { 'yarn.lock': '' } });
    expect(lockfileFingerprint(p.repo, p.sha)).not.toBeNull();
  });

  it('R18 — sha absent du dépôt : lockfileFingerprint lève, sans produire d\'empreinte bidon', () => {
    const p = project('  test: true\n');
    expect(() => lockfileFingerprint(p.repo, 'deadbeef')).toThrow();
  });

  it('R18 — sha en majuscules accepté par la porte déportée', async () => {
    const p = project(`  test: echo "tests $(pwd)" >> {MARK}\n${HOST}`);
    const r = await gate(p, {}, p.sha.toUpperCase());
    expect(r.text).not.toContain('sha invalide');
    expect(r.code).toBe(0);
  });

  it('R18 — sha « HEAD » ou vide : code 2, message de A3, aucune commande ssh', async () => {
    for (const s of ['HEAD', '', 'abc', 'g'.repeat(40), 'a'.repeat(65)]) {
      const p = project(`  test: echo ok\n${HOST}`);
      const r = await gate(p, {}, s);
      expect(r.code, JSON.stringify(s)).toBe(2);
      expect(p.remote.commands(), JSON.stringify(s)).toEqual([]);
    }
  });
});

describe('L403 probe — R3/R14/R16 : la vraie forme de l\'hôte et du projet', () => {
  it('R14 — dossier du projet avec espace et accent : la porte tourne sur l\'hôte', async () => {
    const p = project(`  test: echo "tests $(pwd)" >> {MARK}\n${HOST}`, { name: 'mon dépôt perso' });
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(marks(p)[0]).toContain('.cadence-gate/mon dépôt perso/wt/');
  });

  it('R16 — dépendances imbriquées (front/node_modules) copiées dans le worktree de l\'hôte', async () => {
    const p = project(`  test: cat front/node_modules/x/i.js >> {MARK}\n  gate:\n    host: machine\n`, { files: { 'front/package.json': '{}\n' } });
    mkdirSync(join(p.repo, 'front', 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(p.repo, 'front', 'node_modules', 'x', 'i.js'), 'imbriqué');
    const r = await gate(p);
    expect(r.text).toContain('cache rempli par copie');
    expect(r.code).toBe(0);
    expect(marks(p)).toEqual(['imbriqué']);
  });

  it('R13 — une bannière de connexion (motd, .bashrc bavard) avant la sonde ne fausse pas les cœurs de l\'hôte', async () => {
    const p = project(`  test: echo $CADENCE_TEST_WORKERS >> {MARK}\n${HOST}`);
    p.remote.machine({ nproc: 16 });
    // Un faux ssh en tête du PATH ajoute une ligne de bavardage devant la sortie de la sonde, comme un shell de connexion qui écrit.
    const wrap = join(tempDir(), 'wrap');
    mkdirSync(wrap);
    writeFileSync(join(wrap, 'ssh'), `#!/bin/sh\ncase "$*" in *"uname -s"*) echo "Welcome to the build box";; esac\nexec "${join(p.remote.dir, 'bin', 'ssh')}" "$@"\n`);
    chmodSync(join(wrap, 'ssh'), 0o755);
    const r = await gate(p, { PATH: `${wrap}${delimiter}${p.remote.env.PATH}`, CADENCE_MAX_SESSIONS: '2', CADENCE_TEST_WORKERS: undefined });
    expect(r.code).toBe(0);
    expect(marks(p)[0]).toBe('8');
  });

  it('R17 — une publication de cache déjà faite par un autre appel : le second ne réinstalle pas et ne casse pas le premier', async () => {
    const p = project(`  test: echo "tests $(pwd)" >> {MARK}\n  gate:\n    host: machine\n    install: echo "install" >> {MARK}; mkdir -p node_modules/q && echo ok > node_modules/q/f\n`);
    const [a, b] = await Promise.all([gate(p), gate(p)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const caches = execFileSync('ls', [join(p.work, 'deps')], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(caches.filter((c) => c.startsWith('.tmp-'))).toEqual([]);
    expect(caches).toHaveLength(1);
  });
});
