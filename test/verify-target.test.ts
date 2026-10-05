import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { parseDeliverConfig } from '../src/deliver.js';
import { appendDelivery, sharedStateDir } from '../src/state.js';
import { headSha } from '../src/git.js';
import { expectedTarget, effectLines } from '../src/verify.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const NO_DEPLOY = parseDeliverConfig('deliver:\n  ci: none\n  verify:\n    - url: https://site.example/\n      contains: ${SHORT}\n', 'cadence.yaml');
const WITH_DEPLOY = parseDeliverConfig('deliver:\n  ci: none\n  deploy:\n    - echo go\n  verify:\n    - url: https://site.example/\n      contains: ${SHORT}\n', 'cadence.yaml');

/** Dépôt local relié à un dépôt « distant » nu local (aucun réseau). */
function withRemote() {
  const repo = gitRepo();
  const bare = tempDir();
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', bare);
  commit(repo, 'feat: un');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return repo;
}

describe('expectedTarget (L54)', () => {
  it('sans commande de déploiement : la tête distante, pas la dernière livraison', () => {
    const repo = withRemote();
    const first = headSha(repo)!;
    appendDelivery(sharedStateDir(repo), '2026-10-01', first);
    commit(repo, 'chore(plan): entretien');
    git(repo, 'push', '-q');
    const pushed = headSha(repo)!;
    const t = expectedTarget(repo, NO_DEPLOY, first);
    expect(t.sha).toBe(pushed);
    expect(t.note).toBeNull();
  });

  it('commits non poussés : sha distant et note « N commit(s) non poussé(s) »', () => {
    const repo = withRemote();
    const pushed = headSha(repo)!;
    commit(repo, 'a');
    commit(repo, 'b');
    const t = expectedTarget(repo, NO_DEPLOY, null);
    expect(t.sha).toBe(pushed);
    expect(t.note).toBe("2 commit(s) non poussé(s) — l'effet vérifié est celui de origin/main");
  });

  it('avec des commandes de déploiement : dernière livraison, inchangé', () => {
    const repo = withRemote();
    const first = headSha(repo)!;
    commit(repo, 'x');
    git(repo, 'push', '-q');
    expect(expectedTarget(repo, WITH_DEPLOY, first)).toEqual({ sha: first, note: null });
    expect(expectedTarget(repo, WITH_DEPLOY, null).sha).toBe(headSha(repo));
  });

  it('script de livraison : inchangé (dernière livraison)', () => {
    const repo = withRemote();
    const first = headSha(repo)!;
    commit(repo, 'x');
    const cfg = parseDeliverConfig('deliver:\n  script: ./l.sh\n  verify:\n    - url: https://s.example/\n', 'cadence.yaml');
    expect(expectedTarget(repo, cfg, first)).toEqual({ sha: first, note: null });
  });

  it('sans amont : repli sur la dernière livraison, à défaut la tête', () => {
    const repo = gitRepo();
    commit(repo, 'seul');
    expect(expectedTarget(repo, NO_DEPLOY, null)).toEqual({ sha: headSha(repo), note: null });
    expect(expectedTarget(repo, NO_DEPLOY, 'abc1234').sha).toBe('abc1234');
  });

  it("effectLines place la note avant le verdict", async () => {
    const lines = await effectLines(NO_DEPLOY, 'abcdef1234', { exec: async () => 0, fetch: async () => ({ status: 200, text: 'abcdef1' }), sleep: async () => {}, now: () => 0 }, 'N');
    expect(lines[0]).toBe('N');
  });
});

describe('cadence verify : sha attendu (L54)', () => {
  it('verify annonce les commits non poussés et vise la tête distante', async () => {
    const repo = withRemote();
    const pushed = headSha(repo)!;
    commit(repo, 'local');
    const yaml = 'deliver:\n  ci: none\n  verify:\n    - command: test "$CADENCE_SHORT" = ' + pushed.slice(0, 7) + '\n';
    execFileSync('sh', ['-c', `cat > cadence.yaml <<'EOF'\n${yaml}EOF`], { cwd: repo });
    const out: string[] = [];
    const code = await run(['verify'], { cwd: repo, env: { RAF_TODAY: '2026-10-05' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date('2026-10-05T10:00:00') });
    expect(code).toBe(0);
    expect(out[0]).toContain('1 commit(s) non poussé(s) — l\'effet vérifié est celui de origin/main');
  });
});
