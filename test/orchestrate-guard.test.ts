import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canInstallPrePush, installPrePush, pushed, removePrePush, snapshot } from '../src/orchestrate/guard.js';
import { readFileSync, rmSync } from 'node:fs';
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
  it('un push change la référence amont et le dépôt distant', async () => {
    const dir = repoWithRemote();
    const before = await snapshot(dir);
    expect(before.remote).toContain('refs/heads/main');
    expect(pushed(before, await snapshot(dir))).toBe(false);
    commit(dir, 'feat(L1): x');
    expect(pushed(before, await snapshot(dir))).toBe(false); // un commit local n'est pas un push
    git(dir, 'push', '-q');
    expect(pushed(before, await snapshot(dir))).toBe(true);
  });

  it('suivi modifié, non suivi, .cadence/ exclu', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'a.txt'), '1');
    git(dir, 'add', 'a.txt');
    commit(dir, 'feat: a');
    writeFileSync(join(dir, 'a.txt'), '2');
    writeFileSync(join(dir, 'new.txt'), 'x');
    mkdirSync(join(dir, '.cadence'));
    writeFileSync(join(dir, '.cadence/state'), 'x');
    const s = await snapshot(dir);
    expect(s.tracked).toEqual([' M a.txt']);
    expect(s.untracked).toEqual(['new.txt']);
    expect(s.upstream).toBeNull();
    expect(s.remote).toBeNull(); // pas de dépôt distant : rien à comparer
  });

  it('.playwright-mcp/ non ignoré par git n\'est pas un dépôt sale, tout autre fichier non suivi l\'est', async () => {
    const dir = gitRepo();
    commit(dir, 'chore: init');
    mkdirSync(join(dir, '.playwright-mcp'));
    writeFileSync(join(dir, '.playwright-mcp/console-1.log'), 'x');
    writeFileSync(join(dir, '.playwright-mcp/page.png'), 'x');
    expect((await snapshot(dir, { remote: false })).untracked).toEqual([]);
    writeFileSync(join(dir, 'autre.png'), 'x');
    expect((await snapshot(dir, { remote: false })).untracked).toEqual(['autre.png']);
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


describe('core.hooksPath dans l\'arbre suivi (L3/t19)', () => {
  function trackedHooksRepo() {
    const dir = gitRepo();
    mkdirSync(join(dir, '.githooks'));
    writeFileSync(join(dir, '.githooks/post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(dir, 'add', '--', '.githooks/post-commit');
    git(dir, 'config', 'core.hooksPath', '.githooks');
    commit(dir, 'chore: init');
    return dir;
  }
  const status = (dir: string) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  const exclude = (dir: string) => (existsSync(join(dir, '.git/info/exclude')) ? readFileSync(join(dir, '.git/info/exclude'), 'utf8') : '');

  it('le hook est posé dans le dossier, exclu de git pendant la vague, et l\'arbre est identique après', async () => {
    const dir = trackedHooksRepo();
    const excludeBefore = exclude(dir);
    expect(installPrePush(dir, 'w1')).toEqual({ ok: true });
    expect(existsSync(join(dir, '.githooks/pre-push'))).toBe(true);
    expect(status(dir)).toBe('');
    expect((await snapshot(dir, { remote: false })).untracked).toEqual([]);
    removePrePush(dir, 'w1');
    expect(existsSync(join(dir, '.githooks/pre-push'))).toBe(false);
    expect(status(dir)).toBe('');
    expect(exclude(dir)).toBe(excludeBefore);
  });

  it('hook supprimé ou remplacé par une session : la ligne d\'exclusion est retirée quand même', () => {
    for (const replace of [false, true]) {
      const dir = trackedHooksRepo();
      const excludeBefore = exclude(dir);
      expect(installPrePush(dir, 'w1')).toEqual({ ok: true });
      rmSync(join(dir, '.githooks/pre-push'));
      if (replace) writeFileSync(join(dir, '.githooks/pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      removePrePush(dir, 'w1');
      expect(exclude(dir)).toBe(excludeBefore);
      // un fichier qui n'est pas le nôtre reste, et redevient visible à git
      expect(existsSync(join(dir, '.githooks/pre-push'))).toBe(replace);
      expect(status(dir)).toBe(replace ? '?? .githooks/pre-push\n' : '');
    }
  });

  it('le hook d\'une autre vague garde sa ligne d\'exclusion', () => {
    const dir = trackedHooksRepo();
    expect(installPrePush(dir, 'w-autre')).toEqual({ ok: true });
    removePrePush(dir, 'w-moi');
    expect(existsSync(join(dir, '.githooks/pre-push'))).toBe(true);
    expect(status(dir)).toBe('');
  });

  it('un hook pre-push suivi du projet est toujours refusé', () => {
    const dir = trackedHooksRepo();
    writeFileSync(join(dir, '.githooks/pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(dir, 'add', '--', '.githooks/pre-push');
    expect(canInstallPrePush(dir)).toMatch(/existe déjà/);
    expect(installPrePush(dir, 'w1')).toMatchObject({ ok: false });
  });

  it('hooksPath hors de l\'arbre ou .git/hooks : aucune ligne d\'exclusion', () => {
    const dir = gitRepo();
    const before = exclude(dir);
    installPrePush(dir, 'w1');
    expect(exclude(dir)).toBe(before);
    removePrePush(dir, 'w1');
  });

  it('la suppression du hook est vue par le snapshot (le statut, lui, ne la voit plus)', async () => {
    const dir = trackedHooksRepo();
    installPrePush(dir, 'w1');
    expect((await snapshot(dir, { remote: false })).guard).toBe(true);
    rmSync(join(dir, '.githooks/pre-push'));
    expect(status(dir)).toBe('');
    expect((await snapshot(dir, { remote: false })).guard).toBe(false);
  });
});


describe('snapshot asynchrone (L3/t21)', () => {
  it('git ls-remote ne bloque pas la boucle d\'événements', async () => {
    const dir = repoWithRemote();
    const bin = tempDir();
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n[ "$1" = ls-remote ] && sleep 0.5\nexec ${real} "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 20);
      const s = await snapshot(dir);
      clearInterval(timer);
      expect(s.remote).toContain('refs/heads/main');
      expect(ticks).toBeGreaterThan(10);
    } finally {
      process.env.PATH = path;
    }
  });
});
