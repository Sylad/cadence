import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
import { fakeRemote } from './fake-ssh.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Dépôt sur `main` avec une branche de lot un commit plus loin et un `origin/main` (suivi distant) ; la porte joue `test` au sommet de la branche. */
function projet(gateYaml: string, test: string) {
  const remote = fakeRemote();
  const repo = join(tempDir(), 'depot');
  mkdirSync(repo);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
  writeFileSync(join(repo, 'cadence.yaml'), `orchestrate:\n  test: ${test}\n  gate:\n    host: machine\n${gateYaml}verify:\n  inPlace: false\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'lot');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'lot');
  return { repo, remote, sha: git(repo, 'rev-parse', 'HEAD') };
}

async function porte(p: ReturnType<typeof projet>) {
  const lines: string[] = [];
  const cfg = join(p.repo, 'cadence.yaml');
  const code = await verifyGate({ repo: p.repo, sha: p.sha, config: readOrchestrateConfig(cfg), verify: readVerifyConfig(cfg), env: p.remote.env, out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

describe('L617 — gate.refs : les références que la porte lit existent sur l\'hôte', () => {
  it('R1 — avec gate.refs [main, origin/main], « git merge-base HEAD main » et « git rev-parse origin/main » réussissent dans le worktree de l\'hôte', async () => {
    const p = projet('    refs: [main, origin/main]\n', 'git merge-base HEAD main && git rev-parse --verify origin/main');
    const r = await porte(p);
    expect(r.text).toContain('porte jouée sur l\'hôte');
    expect(r.code).toBe(0);
  });

  it('R2 — sans gate.refs, rien de plus n\'est poussé : « main » reste introuvable sur l\'hôte (le sha seul y arrive)', async () => {
    const p = projet('', 'git rev-parse --verify main');
    expect((await porte(p)).code).toBe(1);
  });

  it('R3 — une référence introuvable en local est un repli local dit, jamais un rouge', async () => {
    const p = projet('    refs: [absente]\n', 'echo ok');
    const r = await porte(p);
    expect(r.text).toMatch(/porte déportée indisponible sur machine \(référence « absente » introuvable en local\) — repli sur la porte locale/);
    expect(r.code).toBe(0);
  });
});
