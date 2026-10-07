import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canInstallPrePush, cleanPlaywrightOutput, installPrePush, pushed, removePrePush, snapshot } from '../src/orchestrate/guard.js';
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
  it('ux objet { command, url, timeout } : timeout en secondes, positif, sinon erreur nommée (L60)', () => {
    expect(read('orchestrate:\n  ux: { command: npm start, url: http://localhost:4200, timeout: 90 }\n')().ux).toEqual({ command: 'npm start', url: 'http://localhost:4200', timeout: 90 });
    expect(read('orchestrate:\n  ux: { command: npm start, url: http://localhost:4200 }\n')().ux).toEqual({ command: 'npm start', url: 'http://localhost:4200' });
    expect(read('orchestrate:\n  ux: { command: npm start, url: http://localhost:4200, timeout: 0 }\n')).toThrow(/ux\.timeout/);
    expect(read('orchestrate:\n  ux: { command: npm start, url: http://localhost:4200, timeout: vite }\n')).toThrow(/ux\.timeout/);
    expect(read('orchestrate:\n  ux: { command: npm start, env: x }\n')).toThrow(/ux\.env inconnu/);
  });
  it('ux objet : url en http(s) exigée, timeout seulement avec command ET url (L60)', () => {
    expect(read('orchestrate:\n  ux: { command: npm start, url: localhost:4200 }\n')).toThrow(/ux\.url.*http/);
    expect(read('orchestrate:\n  ux: { url: ftp://x }\n')).toThrow(/ux\.url/);
    expect(read('orchestrate:\n  ux: { command: npm start, timeout: 90 }\n')).toThrow(/ux\.timeout.*command ET url/);
    expect(read('orchestrate:\n  ux: { url: http://localhost:4200, timeout: 90 }\n')).toThrow(/ux\.timeout.*command ET url/);
    expect(read('orchestrate:\n  ux: { url: https://localhost:4200 }\n')().ux).toEqual({ url: 'https://localhost:4200' });
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

  it('.playwright-mcp/ et .cadence/ : les noms que git cite entre guillemets (accents, espaces) ne sont pas sales non plus', async () => {
    const dir = gitRepo();
    commit(dir, 'chore: init');
    mkdirSync(join(dir, '.playwright-mcp'));
    mkdirSync(join(dir, '.cadence'));
    writeFileSync(join(dir, '.playwright-mcp/réglages.png'), 'x');
    writeFileSync(join(dir, '.playwright-mcp/a b.png'), 'x');
    writeFileSync(join(dir, '.cadence/é f.json'), 'x');
    expect((await snapshot(dir, { remote: false })).untracked).toEqual([]);
    writeFileSync(join(dir, 'dehors é.png'), 'x');
    const s = await snapshot(dir, { remote: false });
    expect(s.untracked).toHaveLength(1);
    expect(s.untracked[0]).toContain('dehors');
  });

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

  it('hooksPath hors de l\'arbre ou .git/hooks : aucune ligne d\'exclusion pour le hook (seule celle de .playwright-mcp/ est posée)', () => {
    const dir = gitRepo();
    const before = exclude(dir);
    installPrePush(dir, 'w1');
    expect(exclude(dir).replace(/# cadence orchestrate — sorties Playwright[^\n]*\n\/\.playwright-mcp\/\n/, '')).toBe(before);
    removePrePush(dir, 'w1');
    expect(exclude(dir)).toBe(before);
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

describe('.git/info/exclude restauré à l\'octet près (L50/t2)', () => {
  const file = (dir: string) => join(dir, '.git/info/exclude');

  it('un fichier sans retour à la ligne final revient identique', () => {
    const dir = gitRepo();
    writeFileSync(file(dir), 'foo');
    installPrePush(dir, 'w1');
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('foo');
  });

  it('un fichier absent avant la vague est absent après', () => {
    const dir = gitRepo();
    rmSync(file(dir), { force: true });
    installPrePush(dir, 'w1');
    removePrePush(dir, 'w1');
    expect(existsSync(file(dir))).toBe(false);
  });

  it('reprise : une vague interrompue puis reposée restaure toujours l\'état d\'avant la première vague', () => {
    const dir = gitRepo();
    writeFileSync(file(dir), 'foo');
    installPrePush(dir, 'w1');
    installPrePush(dir, 'w1');
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('foo');
  });
});

describe('fin de vague : note d\'exclusion illisible, saut de ligne, ligne préexistante (L87, L88)', () => {
  const file = (dir: string) => join(dir, '.git/info/exclude');
  const memo = (dir: string) => join(dir, '.git/info/cadence-exclude-before');
  function trackedHooksRepo() {
    const dir = gitRepo();
    mkdirSync(join(dir, '.githooks'));
    writeFileSync(join(dir, '.githooks/post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    git(dir, 'add', '--', '.githooks/post-commit');
    git(dir, 'config', 'core.hooksPath', '.githooks');
    commit(dir, 'chore: init');
    return dir;
  }

  it('note illisible (vide, JSON invalide, mauvaise forme) : ignorée et retirée sans lever, nos lignes partent', () => {
    for (const garbage of ['', 'pas du json {', 'null', '42', '{"absent":"oui"}']) {
      const dir = trackedHooksRepo();
      writeFileSync(file(dir), 'foo');
      expect(installPrePush(dir, 'w1')).toEqual({ ok: true });
      expect(readFileSync(file(dir), 'utf8')).toContain('/.githooks/pre-push');
      writeFileSync(memo(dir), garbage);
      expect(() => removePrePush(dir, 'w1'), JSON.stringify(garbage)).not.toThrow();
      expect(existsSync(join(dir, '.githooks/pre-push'))).toBe(false);
      const text = readFileSync(file(dir), 'utf8');
      expect(text).not.toContain('.githooks/pre-push');
      expect(text).not.toContain('playwright-mcp');
      expect(existsSync(memo(dir))).toBe(false);
    }
  });

  it('le saut de ligne final n\'est retiré que s\'il est celui de la vague : une ligne ajoutée par l\'utilisateur pendant la vague reste', () => {
    const dir = gitRepo();
    writeFileSync(file(dir), 'foo');
    installPrePush(dir, 'w1');
    writeFileSync(file(dir), `${readFileSync(file(dir), 'utf8')}user\n`);
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('foo\nuser\n');
  });

  it('une ligne /.githooks/pre-push que l\'utilisateur avait déjà avant la vague reste après', () => {
    const dir = trackedHooksRepo();
    writeFileSync(file(dir), '# perso\n/.githooks/pre-push\n');
    expect(installPrePush(dir, 'w1')).toEqual({ ok: true });
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('# perso\n/.githooks/pre-push\n');
  });

  it('ligne laissée par une vague 0.11.0 interrompue (hook cadence présent, aucune note) : elle n\'est pas celle de l\'utilisateur, elle part (L89)', () => {
    const dir = trackedHooksRepo();
    writeFileSync(file(dir), '# perso\n');
    installPrePush(dir, 'w0');
    rmSync(memo(dir)); // 0.11.0 ne laissait pas de note
    installPrePush(dir, 'w1');
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('# perso\n');
  });

  it('note d\'ancienne forme (sans content ni hookLine) : le saut de ligne final de la vague est retiré comme avant (L89)', () => {
    const dir = gitRepo();
    writeFileSync(file(dir), 'foo');
    installPrePush(dir, 'w1');
    writeFileSync(memo(dir), JSON.stringify({ absent: false, noFinalNewline: true }));
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('foo');
  });

  it('une ligne /.githooks/pre-push posée par la vague part toujours', () => {
    const dir = trackedHooksRepo();
    writeFileSync(file(dir), '# perso\n');
    installPrePush(dir, 'w1');
    removePrePush(dir, 'w1');
    expect(readFileSync(file(dir), 'utf8')).toBe('# perso\n');
  });
});

describe('sorties de Playwright MCP dans le dépôt (L50)', () => {
  const raw = (dir: string) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).trim();

  it('le temps de la vague, .playwright-mcp/ est exclu par .git/info/exclude (git ne le voit plus) ; la ligne part avec le hook', () => {
    const dir = gitRepo();
    installPrePush(dir, 'w1');
    mkdirSync(join(dir, '.playwright-mcp'));
    writeFileSync(join(dir, '.playwright-mcp/page.yml'), 'x');
    expect(raw(dir)).toBe('');
    removePrePush(dir, 'w1');
    expect(readFileSync(join(dir, '.git/info/exclude'), 'utf8')).not.toContain('playwright-mcp');
    expect(raw(dir)).toContain('.playwright-mcp/');
  });

  it('une exclusion déjà présente avant la vague est laissée en place', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, '.git/info/exclude'), '.playwright-mcp/\n');
    installPrePush(dir, 'w1');
    removePrePush(dir, 'w1');
    expect(readFileSync(join(dir, '.git/info/exclude'), 'utf8')).toContain('.playwright-mcp/');
  });

  it('cleanPlaywrightOutput supprime les fichiers non suivis de .playwright-mcp/, jamais un fichier suivi', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, '.playwright-mcp'));
    writeFileSync(join(dir, '.playwright-mcp/page.yml'), 'x');
    cleanPlaywrightOutput(dir);
    expect(existsSync(join(dir, '.playwright-mcp'))).toBe(false);
    mkdirSync(join(dir, '.playwright-mcp'));
    writeFileSync(join(dir, '.playwright-mcp/kept.yml'), 'x');
    git(dir, 'add', '-f', '.playwright-mcp/kept.yml');
    writeFileSync(join(dir, '.playwright-mcp/new.png'), 'x');
    cleanPlaywrightOutput(dir);
    expect(existsSync(join(dir, '.playwright-mcp/kept.yml'))).toBe(true);
    expect(existsSync(join(dir, '.playwright-mcp/new.png'))).toBe(false);
  });

  const outside = () => {
    const out = tempDir();
    writeFileSync(join(out, 'precious.txt'), 'keep');
    return out;
  };

  it('L50/t1 : un .playwright-mcp non suivi qui est un lien vers un dossier extérieur : le dossier extérieur reste intact', () => {
    const dir = gitRepo();
    const out = outside();
    symlinkSync(out, join(dir, '.playwright-mcp'));
    cleanPlaywrightOutput(dir);
    expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('keep');
  });

  it('L50/t1 : un .playwright-mcp suivi par git qui est un lien : ni le lien ni le dossier extérieur ne sont touchés', () => {
    const dir = gitRepo();
    const out = outside();
    symlinkSync(out, join(dir, '.playwright-mcp'));
    git(dir, 'add', '-f', '.playwright-mcp');
    cleanPlaywrightOutput(dir);
    expect(lstatSync(join(dir, '.playwright-mcp')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('keep');
  });

  it('L50/t1 : un lien à l\'intérieur est retiré lui-même, sa cible extérieure reste', () => {
    const dir = gitRepo();
    const out = outside();
    mkdirSync(join(dir, '.playwright-mcp'));
    symlinkSync(out, join(dir, '.playwright-mcp/lien'));
    writeFileSync(join(dir, '.playwright-mcp/a.yml'), 'x');
    cleanPlaywrightOutput(dir);
    expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, '.playwright-mcp/a.yml'))).toBe(false);
    expect(existsSync(join(dir, '.playwright-mcp'))).toBe(false);
  });

  it('L50/t1 : un fichier suivi à l\'intérieur survit', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, '.playwright-mcp/sub'), { recursive: true });
    writeFileSync(join(dir, '.playwright-mcp/sub/kept.yml'), 'x');
    git(dir, 'add', '-f', '.playwright-mcp/sub/kept.yml');
    writeFileSync(join(dir, '.playwright-mcp/sub/new.png'), 'x');
    cleanPlaywrightOutput(dir);
    expect(existsSync(join(dir, '.playwright-mcp/sub/kept.yml'))).toBe(true);
    expect(existsSync(join(dir, '.playwright-mcp/sub/new.png'))).toBe(false);
  });
});
