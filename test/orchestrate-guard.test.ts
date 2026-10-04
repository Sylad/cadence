import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canInstallPrePush, installPrePush, pushed, removePrePush, snapshot } from '../src/orchestrate/guard.js';
import { readOrchestrateConfig } from '../src/config.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });

function repoWithRemote() {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  commit(dir, 'chore: init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

describe('hook pre-push temporaire', () => {
  it('bloque le push d\'une session (CADENCE_ORCHESTRATED) sans toucher au pushurl, laisse passer le lead', () => {
    const dir = repoWithRemote();
    expect(installPrePush(dir)).toEqual({ ok: true });
    commit(dir, 'feat(L1): x');
    const blocked = spawnSync('git', ['push'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CADENCE_ORCHESTRATED: 'w1' } });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('push refusé');
    const cfg = spawnSync('git', ['config', '--get-regexp', 'pushurl'], { cwd: dir, encoding: 'utf8' });
    expect(cfg.stdout.trim()).toBe('');
    const lead = spawnSync('git', ['push'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CADENCE_ORCHESTRATED: '' } });
    expect(lead.status).toBe(0);
    removePrePush(dir);
    expect(existsSync(join(dir, '.git/hooks/pre-push'))).toBe(false);
  });

  it('refuse de remplacer un hook pre-push qui n\'est pas le nôtre ; remplace le nôtre laissé par une vague coupée', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(canInstallPrePush(dir)).toMatch(/hook pre-push existe déjà/);
    expect(installPrePush(dir)).toMatchObject({ ok: false });
    removePrePush(dir); // pas le nôtre : reste
    expect(existsSync(join(dir, '.git/hooks/pre-push'))).toBe(true);
    const other = gitRepo();
    installPrePush(other);
    expect(canInstallPrePush(other)).toBeNull();
    expect(installPrePush(other)).toEqual({ ok: true });
  });
});

describe('hook lié à sa vague (L3/t10)', () => {
  it('removePrePush(repo, vague) ne retire que le hook posé par cette vague', () => {
    const dir = gitRepo();
    installPrePush(dir, 'w-autre');
    removePrePush(dir, 'w-moi');
    expect(existsSync(join(dir, '.git/hooks/pre-push'))).toBe(true);
    removePrePush(dir, 'w-autre');
    expect(existsSync(join(dir, '.git/hooks/pre-push'))).toBe(false);
  });
});

describe('snapshot et détection de push', () => {
  it('un push change la référence amont et le dépôt distant', () => {
    const dir = repoWithRemote();
    const before = snapshot(dir);
    expect(before.remote).toContain('refs/heads/main');
    expect(pushed(before, snapshot(dir))).toBe(false);
    commit(dir, 'feat(L1): x');
    expect(pushed(before, snapshot(dir))).toBe(false); // un commit local n'est pas un push
    git(dir, 'push', '-q');
    expect(pushed(before, snapshot(dir))).toBe(true);
  });

  it('suivi modifié, non suivi, .cadence/ exclu', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'a.txt'), '1');
    git(dir, 'add', 'a.txt');
    commit(dir, 'feat: a');
    writeFileSync(join(dir, 'a.txt'), '2');
    writeFileSync(join(dir, 'new.txt'), 'x');
    mkdirSync(join(dir, '.cadence'));
    writeFileSync(join(dir, '.cadence/state'), 'x');
    const s = snapshot(dir);
    expect(s.tracked).toEqual([' M a.txt']);
    expect(s.untracked).toEqual(['new.txt']);
    expect(s.upstream).toBeNull();
    expect(s.remote).toBeNull(); // pas de dépôt distant : rien à comparer
  });
});

describe('cadence.yaml : orchestrate', () => {
  const read = (yaml: string) => {
    const f = join(tempDir(), 'cadence.yaml');
    writeFileSync(f, yaml);
    return () => readOrchestrateConfig(f);
  };
  it('défauts', () => {
    expect(readOrchestrateConfig('/nope')).toEqual({ permissionMode: 'auto', addDirs: [], timeouts: { work: 2_700_000, review: 1_500_000 } });
  });
  it('lit start, verdict, test, ux, délais', () => {
    const c = read(`orchestrate:\n  start: python3 scripts/raf.py start {lot}\n  verdict: 'python3 scripts/raf.py note {lot} "revue : {verdict}"'\n  test: npm test\n  ux: http://localhost:4200\n  permissionMode: acceptEdits\n  addDirs: [/tmp/t]\n  timeouts: { implement: 60, review: 10 }\n`)();
    expect(c).toMatchObject({ start: 'python3 scripts/raf.py start {lot}', test: 'npm test', ux: { url: 'http://localhost:4200' }, permissionMode: 'acceptEdits', addDirs: ['/tmp/t'], timeouts: { work: 3_600_000, review: 600_000 } });
    expect(c.verdict).toContain('{verdict}');
    expect(read('orchestrate:\n  ux: npm run dev\n')().ux).toEqual({ command: 'npm run dev' });
  });
  it('clé inconnue ou valeur invalide : erreur nommée', () => {
    expect(read('orchestrate:\n  parallel: 3\n')).toThrow(/orchestrate\.parallel inconnu/);
    expect(read('orchestrate:\n  timeouts: { implement: 0 }\n')).toThrow(/timeouts\.implement/);
    expect(read('orchestrate:\n  start: ""\n')).toThrow(/start/);
  });
});
