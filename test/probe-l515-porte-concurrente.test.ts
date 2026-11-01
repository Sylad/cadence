import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
import { fakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function project(name: string) {
  const remote = fakeRemote();
  const repo = join(tempDir(), name);
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: "echo ok"\n  gate:\n    host: machine\nverify:\n  inPlace: false\n`);
  writeFileSync(join(repo, 'v.txt'), '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'i');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD'), remote, work: join(remote.home, '.cadence-gate', name) };
}
const gate = async (p: ReturnType<typeof project>) => {
  const lines: string[] = [];
  const cfg = join(p.repo, 'cadence.yaml');
  const code = await verifyGate({ repo: p.repo, sha: p.sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), env: p.remote.env, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
};

describe('L515 probe — création du dépôt nu de l\'hôte', () => {
  it('douze portes simultanées sans gate.install : aucune repli, aucun résidu .init', async () => {
    const p = project('depot');
    const runs = await Promise.all(Array.from({ length: 12 }, () => gate(p)));
    expect(runs.filter((r) => r.text.includes('dépôt de travail impossible'))).toEqual([]);
    expect(runs.map((r) => r.code)).toEqual(Array(12).fill(0));
    expect(readdirSync(p.work).filter((n) => n.includes('init-'))).toEqual([]);
    expect(readdirSync(join(p.work, 'repo.git')).filter((n) => n.includes('init-'))).toEqual([]);
  });

  it('nom de dépôt avec espace, douze portes : le dépôt nu est créé sans erreur', async () => {
    const p = project('mon depot');
    const runs = await Promise.all(Array.from({ length: 6 }, () => gate(p)));
    expect(runs.map((r) => r.code)).toEqual(Array(6).fill(0));
    expect(readdirSync(p.work).filter((n) => n.startsWith('repo.git'))).toEqual(['repo.git']);
  });

  it('deux fois de suite (dépôt déjà là) : aucun résidu, rien de recréé', async () => {
    const p = project('depot');
    await gate(p);
    const r = await gate(p);
    expect(r.code).toBe(0);
    expect(readdirSync(p.work).filter((n) => n.startsWith('repo.git'))).toEqual(['repo.git']);
  });

  it('repo.git existe mais comme fichier : échec dit, pas de plantage ni de résidu', async () => {
    const p = project('depot');
    mkdirSync(p.work, { recursive: true });
    writeFileSync(join(p.work, 'repo.git'), 'x');
    const r = await gate(p);
    expect(r.text).toContain("dépôt de travail impossible");
    expect(existsSync(p.work) ? readdirSync(p.work).filter((n) => n.includes('init-')) : []).toEqual([]);
  });
});
