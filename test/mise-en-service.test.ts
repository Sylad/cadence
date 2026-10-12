import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAccepted, checkLotsDone, fingerprint, mettreEnService } from '../scripts/mise-en-service.mjs';
import { takeSnapshot } from '../src/orchestrate/snapshot.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
afterAll(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const plan = (statuses: Record<string, string>) =>
  `version: 1\nproject: "x"\nprefix: L\nlots:\n${Object.entries(statuses).map(([id, s]) => `  - { id: ${id}, title: "t", status: ${s}, estimate: 1, created: 2026-10-01 }`).join('\n')}\n`;

function commitAll(dir: string, message: string, ...paths: string[]) {
  git(dir, 'add', '--', ...paths);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Dépôt de travail : copie du paquet (sources, bin, scripts npm) avec un plan, node_modules du dépôt réel en lien. */
function workRepo(statuses: Record<string, string> = { L1: 'done' }) {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const n of ['src', 'bin', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) cpSync(join(REPO, n), join(dir, n), { recursive: true });
  mkdirSync(join(dir, 'docs/plan'), { recursive: true });
  writeFileSync(join(dir, 'docs/plan/raf.yaml'), plan(statuses));
  writeFileSync(join(dir, '.gitignore'), 'dist/\nnode_modules/\n');
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const first = commitAll(dir, 'feat(L1): premier', 'src', 'bin', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'docs/plan/raf.yaml', '.gitignore');
  return { dir, first };
}

/** Installation de test : les dépendances viennent du dépôt réel (pas de réseau), la compilation est la vraie. */
const install = (dir: string) => {
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  execFileSync(join(REPO, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json'], { cwd: dir, stdio: 'pipe' });
};

const places = () => ({ root: join(tempDir(), 'share'), binDir: join(tempDir(), 'bin') });

describe('le code en service est une copie séparée du dépôt de travail (L195)', () => {
  it('construit un worktree détaché, bascule service/ et les liens raf et cadence du bin-dir', () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    const r = mettreEnService({ repo: dir, rev: first, root, binDir, install });
    expect(r.sha).toBe(first);
    expect(existsSync(join(root, 'service', 'dist', 'cli.js'))).toBe(true);
    expect(git(join(root, 'service'), 'rev-parse', 'HEAD')).toBe(first);
    expect(git(join(root, 'service'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // détaché
    for (const n of ['raf', 'cadence']) {
      expect(lstatSync(join(binDir, n)).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(binDir, n))).toBe(realpathSync(join(root, 'service', 'bin', `${n}.js`)));
    }
    expect(execFileSync(join(binDir, 'cadence'), ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(realpathSync(join(binDir, 'raf'))).not.toContain(realpathSync(dir));
  });

  it("npm run build, un build:service-like, prepare et un fichier src modifié dans le dépôt de travail laissent l'empreinte du service inchangée", () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    mettreEnService({ repo: dir, rev: first, root, binDir, install });
    const before = fingerprint(join(root, 'service'));

    execFileSync('npm', ['run', '--silent', 'build'], { cwd: dir, stdio: 'pipe' });
    execFileSync('npm', ['run', '--silent', 'prepare'], { cwd: dir, stdio: 'pipe' }); // écrit dist/ du dépôt de travail
    appendFileSync(join(dir, 'src/dates.ts'), '\nexport const nonRevu = 1;\n');
    appendFileSync(join(dir, 'bin/raf.js'), '\n// non revu\n');
    execFileSync('npm', ['run', '--silent', 'prepare'], { cwd: dir, stdio: 'pipe' });
    commitAll(dir, 'feat(L2): non revu', 'src', 'bin');

    expect(fingerprint(join(root, 'service'))).toBe(before);
    expect(readFileSync(join(root, 'service', 'bin', 'raf.js'), 'utf8')).not.toContain('non revu');
    expect(readFileSync(join(root, 'service', 'dist', 'dates.js'), 'utf8')).not.toContain('nonRevu');
  });

  it("npm ci (réinstallation des dépendances) dans le dépôt de travail ne touche pas non plus au service", () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    mettreEnService({ repo: dir, rev: first, root, binDir, install });
    const before = fingerprint(join(root, 'service'));
    // le service a ses propres dépendances : on supprime celles du dépôt de travail, comme le fait npm ci
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    expect(existsSync(join(root, 'service', 'node_modules', 'yaml', 'package.json'))).toBe(true);
    expect(fingerprint(join(root, 'service'))).toBe(before);
    expect(execFileSync(join(binDir, 'cadence'), ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+/);
  });

  it("refuse un sha qui n'est pas un ancêtre de HEAD ou qui n'existe pas, sans rien changer", () => {
    const { dir, first } = workRepo();
    git(dir, 'checkout', '-q', '-b', 'autre');
    writeFileSync(join(dir, 'x.txt'), 'x');
    const off = commitAll(dir, 'feat(L1): ailleurs', 'x.txt');
    git(dir, 'checkout', '-q', 'main');
    const { root, binDir } = places();
    expect(() => mettreEnService({ repo: dir, rev: off, root, binDir, install })).toThrow(/pas un ancêtre de HEAD/);
    expect(() => mettreEnService({ repo: dir, rev: 'inconnu', root, binDir, install })).toThrow(/pas un commit/);
    expect(existsSync(join(root, 'service'))).toBe(false);
    expect(existsSync(join(binDir, 'raf'))).toBe(false);
    expect(checkAccepted(dir, first)).toBe(first);
  });

  it("refuse un sha dont les commits citent un lot non rendu (doing), même ancêtre de HEAD", () => {
    const { dir } = workRepo({ L1: 'done', L2: 'doing' });
    writeFileSync(join(dir, 'a.txt'), 'a');
    const sha = commitAll(dir, 'feat(L2): en cours', 'a.txt');
    const { root, binDir } = places();
    expect(() => mettreEnService({ repo: dir, rev: sha, root, binDir, install })).toThrow(/L2 \(doing\)/);
    expect(existsSync(join(root, 'service'))).toBe(false);
  });

  it("accepte un sha dont le lot est rendu même avec un lot rendu non conforme au-dessus ; les commits « plan: » ne comptent pas", () => {
    const { dir, first } = workRepo({ L1: 'done', L2: 'doing' });
    writeFileSync(join(dir, 'a.txt'), 'a');
    const accepted = commitAll(dir, 'plan: L2 démarré', 'a.txt');
    writeFileSync(join(dir, 'b.txt'), 'b');
    commitAll(dir, 'feat(L2): au-dessus, non accepté', 'b.txt');
    const { root, binDir } = places();
    mettreEnService({ repo: dir, rev: accepted, root, binDir, install });
    expect(git(join(root, 'service'), 'rev-parse', 'HEAD')).toBe(accepted);
    expect(() => mettreEnService({ repo: dir, rev: 'HEAD', root, binDir, install })).toThrow(/L2 \(doing\)/);
    expect(git(join(root, 'service'), 'rev-parse', 'HEAD')).toBe(accepted); // le service n'a pas bougé
    expect(first).toBeTruthy();
  });

  it("un lot abandonné (dropped) dont chaque commit est annulé par un git revert sous le sha ne bloque plus (L207)", () => {
    const { dir } = workRepo({ L1: 'done', L2: 'dropped' });
    writeFileSync(join(dir, 'a.txt'), 'a');
    commitAll(dir, 'feat(L2): travail', 'a.txt');
    git(dir, 'revert', '--no-edit', 'HEAD');
    const { root, binDir } = places();
    const r = mettreEnService({ repo: dir, rev: 'HEAD', root, binDir, install });
    expect(r.sha).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it("un lot abandonné dont un commit n'est pas annulé bloque toujours (L207)", () => {
    const { dir } = workRepo({ L1: 'done', L2: 'dropped' });
    writeFileSync(join(dir, 'a.txt'), 'a');
    commitAll(dir, 'feat(L2): annulé', 'a.txt');
    git(dir, 'revert', '--no-edit', 'HEAD');
    writeFileSync(join(dir, 'b.txt'), 'b');
    commitAll(dir, 'fix(L2): resté', 'b.txt');
    expect(() => checkLotsDone(dir, 'HEAD', undefined)).toThrow(/L2 \(dropped\)/);
    // un lot abandonné sans aucun revert bloque aussi
    const seul = workRepo({ L1: 'done', L3: 'dropped' });
    writeFileSync(join(seul.dir, 'c.txt'), 'c');
    commitAll(seul.dir, 'feat(L3): jamais annulé', 'c.txt');
    expect(() => checkLotsDone(seul.dir, 'HEAD', undefined)).toThrow(/L3 \(dropped\)/);
  });

  it("une installation qui échoue ne change rien : ni service/, ni liens, ni worktree restant", () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    const ok = mettreEnService({ repo: dir, rev: first, root, binDir, install });
    writeFileSync(join(dir, 'c.txt'), 'c');
    const second = commitAll(dir, 'feat(L1): second', 'c.txt');
    expect(() => mettreEnService({ repo: dir, rev: second, root, binDir, install: () => { throw new Error('npm ci en échec'); } })).toThrow(/rien n'a changé/);
    expect(readlinkSync(join(root, 'service'))).toBe(ok.dir);
    expect(existsSync(join(root, 'releases', second.slice(0, 12)))).toBe(false);
    expect(git(dir, 'worktree', 'list')).not.toContain(second.slice(0, 12));
  });

  it('met à jour : la nouvelle version prend service/, la précédente reste pour un retour en arrière, les plus anciennes partent', () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    mettreEnService({ repo: dir, rev: first, root, binDir, install });
    const shas = [first];
    for (const n of ['b', 'c']) {
      writeFileSync(join(dir, `${n}.txt`), n);
      shas.push(commitAll(dir, `feat(L1): ${n}`, `${n}.txt`));
      mettreEnService({ repo: dir, rev: shas.at(-1)!, root, binDir, install });
    }
    expect(git(join(root, 'service'), 'rev-parse', 'HEAD')).toBe(shas[2]);
    expect(existsSync(join(root, 'releases', shas[1].slice(0, 12)))).toBe(true);
    // la plus ancienne n'est retirée qu'une fois vieille : une vague lancée dessus garde ses dépendances (voir plus bas)
    const old = join(root, 'releases', shas[0].slice(0, 12));
    expect(existsSync(old)).toBe(true);
    const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(join(old, '.mise-en-service-ok'), longAgo, longAgo);
    writeFileSync(join(dir, 'd.txt'), 'd');
    mettreEnService({ repo: dir, rev: commitAll(dir, 'feat(L1): d', 'd.txt'), root, binDir, install });
    expect(existsSync(old)).toBe(false);
  });

  it("deux mises en service après le lancement d'une vague ne lui retirent pas ses dépendances (instantané lié au node_modules de la version)", () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    // installation avec un vrai node_modules dans la version, comme `npm ci` : c'est lui que l'instantané vise
    const installReal = (d: string) => {
      install(d);
      rmSync(join(d, 'node_modules'));
      mkdirSync(join(d, 'node_modules'));
      cpSync(join(REPO, 'node_modules', 'yaml'), join(d, 'node_modules', 'yaml'), { recursive: true });
    };
    mettreEnService({ repo: dir, rev: first, root, binDir, install: installReal });
    const wave = tempDir();
    const tool = takeSnapshot(wave, join(root, 'service'));
    for (const n of ['b', 'c']) {
      writeFileSync(join(dir, `${n}.txt`), n);
      mettreEnService({ repo: dir, rev: commitAll(dir, `feat(L1): ${n}`, `${n}.txt`), root, binDir, install: installReal });
    }
    expect(existsSync(join(tool, 'node_modules', 'yaml', 'package.json'))).toBe(true);
  });

  it("une version restée longtemps en service garde ses 7 jours à partir de sa sortie du service (la vague lancée depuis elle)", () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    mettreEnService({ repo: dir, rev: first, root, binDir, install });
    const v1 = join(root, 'releases', first.slice(0, 12));
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    utimesSync(join(v1, '.mise-en-service-ok'), longAgo, longAgo);
    for (const n of ['b', 'c']) {
      writeFileSync(join(dir, `${n}.txt`), n);
      mettreEnService({ repo: dir, rev: commitAll(dir, `feat(L1): ${n}`, `${n}.txt`), root, binDir, install });
    }
    expect(existsSync(v1)).toBe(true);
  });

  it('checkLotsDone ne regarde que les commits au-dessus du sha déjà en service (le seul sha, au premier service)', () => {
    const { dir, first } = workRepo({ L1: 'done', L0: 'doing' });
    writeFileSync(join(dir, 'z.txt'), 'z');
    const old = commitAll(dir, 'feat(L0): ancien en cours', 'z.txt');
    writeFileSync(join(dir, 'y.txt'), 'y');
    const next = commitAll(dir, 'feat(L1): suite', 'y.txt');
    expect(() => checkLotsDone(dir, old, undefined)).toThrow(/L0/);
    expect(() => checkLotsDone(dir, next, undefined)).not.toThrow();
    expect(() => checkLotsDone(dir, next, first)).toThrow(/L0/);
    expect(() => checkLotsDone(dir, next, old)).not.toThrow();
    expect(first).toBeTruthy();
  });

  it('refuse aussi les commits de sous-tâches (fix(L2/t1), listes, « fix: L2/t1 ») d\'un lot non rendu', () => {
    for (const [n, subject] of [['a', 'fix(L2/t1): correction non revue'], ['b', 'fix(L1/t1, L2/t2,t3): liste'], ['c', 'fix: L2/t1 sans portée'], ['d', 'chore(L1,L2): plusieurs lots']]) {
      const { dir } = workRepo({ L1: 'done', L2: 'doing' });
      writeFileSync(join(dir, `${n}.txt`), n);
      const sha = commitAll(dir, subject, `${n}.txt`);
      const { root, binDir } = places();
      expect(() => mettreEnService({ repo: dir, rev: sha, root, binDir, install }), subject).toThrow(/L2 \(doing\)/);
    }
  });

  it('une installation interrompue (dossier resté sans marqueur) est refaite à la relance, jamais mise en service telle quelle', () => {
    const { dir, first } = workRepo();
    const { root, binDir } = places();
    // interruption simulée : le worktree existe, l'installation n'a pas fini (ni node_modules ni dist)
    git(dir, 'worktree', 'add', '--detach', join(root, 'releases', first.slice(0, 12)), first);
    mettreEnService({ repo: dir, rev: first, root, binDir, install });
    expect(existsSync(join(root, 'service', 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(join(root, 'service', 'node_modules'))).toBe(true);
    expect(execFileSync(join(binDir, 'cadence'), ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+/);
  });
});
