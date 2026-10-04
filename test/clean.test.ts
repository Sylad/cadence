import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanStale, staleFiles } from '../src/clean.js';
import { CLEAN_TODAY, cleanAt, gitRepo, tempDir } from './helpers.js';

const TODAY = CLEAN_TODAY;
const OLD = cleanAt(-18);

const touch = (file: string, when: Date = OLD) => {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, 'x');
  utimesSync(file, when, when);
};
/** Vieillit tout un arbre (dossiers et fichiers, `.git` compris) : un `git init` frais est daté d'aujourd'hui. */
const ageTree = (path: string, when: Date = OLD) => {
  if (!lstatSync(path).isDirectory()) return lutimesSync(path, when, when);
  for (const n of readdirSync(path)) ageTree(join(path, n), when);
  lutimesSync(path, when, when);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const names = (r: { path: string }[]) => r.map((s) => s.path);

/** Droits retirés pour un test, rendus après lui : sans eux, le dossier temporaire ne se supprimerait plus. */
const locked: string[] = [];
const lock = (path: string, mode: number) => {
  chmodSync(path, mode);
  locked.push(path);
};
afterEach(() => {
  for (const p of locked.splice(0).reverse()) chmodSync(p, 0o755);
});
/** root lit tout malgré les droits : les tests de lecture refusée n'ont pas de sens sous root. */
const asRoot = process.getuid?.() === 0;

describe('staleFiles — dépôts git', () => {
  it('ne propose jamais un dossier qui est un dépôt git', () => {
    const tmp = tempDir();
    const clone = join(tmp, 'clone');
    mkdirSync(clone);
    git(clone, 'init', '-q');
    touch(join(tmp, 'libre.png'));
    ageTree(clone);
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'libre.png')]);
  });

  it('ne propose jamais un dossier qui contient un dépôt git, même profond', () => {
    const tmp = tempDir();
    const outer = join(tmp, 'outer');
    mkdirSync(join(outer, 'a/b/clone'), { recursive: true });
    git(join(outer, 'a/b/clone'), 'init', '-q');
    ageTree(outer);
    expect(staleFiles(tmp, [`${tmp}/*`], 7, TODAY)).toEqual([]);
  });

  it('ne propose pas un dossier dont un fichier est suivi par un dépôt situé hors de la racine', () => {
    const root = tempDir();
    const autre = gitRepo();
    touch(join(autre, 'dossier/suivi.png'));
    git(autre, 'add', 'dossier/suivi.png');
    git(autre, 'commit', '-qm', 'chore: suivi');
    touch(join(autre, 'dossier'));
    touch(join(autre, 'libre.png'));
    expect(names(staleFiles(root, [`${autre}/*`], 7, TODAY))).toEqual([join(autre, 'libre.png')]);
  });

  // Ici le dossier porte un FICHIER `.git` (« gitdir: … ») : le travail non commité qu'il contient
  // n'est dans aucun dépôt que git retrouverait en remontant depuis le dossier parent.
  it('un arbre de travail lié (git worktree add) avec du travail non commité n’est jamais proposé', () => {
    const tmp = tempDir();
    const repo = gitRepo();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: init');
    const wt = join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    expect(lstatSync(join(wt, '.git')).isFile()).toBe(true);
    touch(join(wt, 'travail-non-commite.txt'));
    touch(join(tmp, 'libre.png'));
    ageTree(wt);
    ageTree(join(tmp, 'libre.png'));
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'libre.png')]);
  });

  it('un dossier à fichier .git façon sous-module avec du travail non commité n’est jamais proposé', () => {
    const tmp = tempDir();
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub/.git'), 'gitdir: ../../.git/modules/sub\n');
    touch(join(tmp, 'sub/travail-non-commite.txt'));
    touch(join(tmp, 'libre.png'));
    ageTree(join(tmp, 'sub'));
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'libre.png')]);
  });

  // Sans entrée `.git` : un dossier git se reconnaît à son contenu, comme git le fait (HEAD + objects/ + refs/).
  it('un dépôt nu n’est jamais proposé, ni ce qu’il contient', () => {
    const tmp = tempDir();
    git(tmp, 'init', '-q', '--bare', 'backup.git');
    touch(join(tmp, 'libre.png'));
    ageTree(tmp);
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'libre.png')]);
    expect(staleFiles(tmp, [`${tmp}/*/*`, `${tmp}/*/*/*`, `${tmp}/backup.git/HEAD`], 7, TODAY)).toEqual([]);
  });

  it('un dossier qui contient un miroir (clone --mirror) n’est jamais proposé, ni le miroir, ni son contenu', () => {
    const tmp = tempDir();
    const source = gitRepo();
    touch(join(source, 'a.txt'));
    git(source, 'add', 'a.txt');
    git(source, 'commit', '-qm', 'chore: a');
    mkdirSync(join(tmp, 'work'));
    git(join(tmp, 'work'), 'clone', '-q', '--mirror', source, 'mirror.git');
    ageTree(tmp);
    expect(staleFiles(tmp, [`${tmp}/*`, `${tmp}/*/*`, `${tmp}/*/*/*`, `${tmp}/*/*/*/*`], 7, TODAY)).toEqual([]);
  });

  it('un dossier git séparé (--separate-git-dir) n’est jamais proposé, ni ce qu’il contient', () => {
    const tmp = tempDir();
    const travail = tempDir();
    execFileSync('git', ['init', '-q', '--separate-git-dir', join(tmp, 'gitdir'), travail], { stdio: 'ignore' });
    touch(join(tmp, 'libre.png'));
    ageTree(tmp);
    expect(names(staleFiles(tmp, [`${tmp}/*`, `${tmp}/*/*`, `${tmp}/*/*/*`], 7, TODAY))).toEqual([join(tmp, 'libre.png')]);
  });

  it('un dossier d’administration d’arbre de travail (HEAD + commondir) n’est jamais proposé, ni ce qu’il contient', () => {
    const tmp = tempDir();
    const repo = gitRepo();
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: init');
    git(repo, 'worktree', 'add', '-q', join(tempDir(), 'wt'));
    execFileSync('cp', ['-r', join(repo, '.git/worktrees/wt'), join(tmp, 'admin')]);
    ageTree(tmp);
    expect(staleFiles(tmp, [`${tmp}/*`, `${tmp}/*/*`], 7, TODAY)).toEqual([]);
  });

  // Dans un hook git (pre-commit…), GIT_INDEX_FILE et GIT_DIR sont hérités : git répondrait pour un
  // autre index ou un autre dépôt, et un fichier suivi passerait pour « non suivi ».
  for (const variable of ['GIT_INDEX_FILE', 'GIT_DIR'] as const) {
    it(`un fichier suivi reste protégé malgré un ${variable} hérité (index ou dépôt vide)`, () => {
      const repo = gitRepo();
      touch(join(repo, 'suivi.png'));
      git(repo, 'add', 'suivi.png');
      git(repo, 'commit', '-qm', 'chore: suivi');
      touch(join(repo, 'suivi.png'));
      const vide = gitRepo();
      const valeur = variable === 'GIT_DIR' ? join(vide, '.git') : join(vide, 'index-vide');
      if (variable === 'GIT_INDEX_FILE') execFileSync('git', ['read-tree', '--empty'], { cwd: vide, env: { ...process.env, GIT_INDEX_FILE: valeur } });
      const avant = process.env[variable];
      process.env[variable] = valeur;
      try {
        expect(staleFiles(repo, [`${repo}/*.png`], 7, TODAY)).toEqual([]);
      } finally {
        if (avant === undefined) delete process.env[variable];
        else process.env[variable] = avant;
      }
    });
  }

  it('un fichier suivi dont le nom porte des métacaractères de pathspec (* ? [ :( ) n’est pas proposé', () => {
    // Sans --literal-pathspecs, git lit « :x.png » comme « x.png » et « :(icase)Y.png » comme une magie :
    // il répondrait « non suivi ».
    const repo = gitRepo();
    const noms = ['st*r.png', 'a?b.png', '[x].png', ':x.png', ':(icase)Y.png'];
    for (const n of noms) touch(join(repo, n));
    git(repo, 'add', '--', ...noms.map((n) => `:(literal)${n}`));
    git(repo, 'commit', '-qm', 'chore: suivis');
    touch(join(repo, 'libre.png'));
    for (const n of noms) touch(join(repo, n));
    expect(names(staleFiles(repo, [`${repo}/*.png`], 7, TODAY))).toEqual([join(repo, 'libre.png')]);
  });

  it('un fichier suivi qu’on atteint par un lien symbolique reste protégé', () => {
    const root = tempDir();
    const autre = gitRepo();
    touch(join(autre, 'suivi.png'));
    git(autre, 'add', 'suivi.png');
    git(autre, 'commit', '-qm', 'chore: suivi');
    const lien = tempDir();
    symlinkSync(autre, join(lien, 'vers'));
    expect(staleFiles(root, [`${lien}/vers/*.png`], 7, TODAY)).toEqual([]);
  });

  it('un fichier suivi dont le nom commence par .. n’est pas pris pour « hors du dépôt »', () => {
    const dir = gitRepo();
    touch(join(dir, '..weird'));
    git(dir, 'add', '..weird');
    git(dir, 'commit', '-qm', 'chore: suivi');
    expect(staleFiles(dir, ['..*'], 7, TODAY)).toEqual([]);
  });
});

describe('staleFiles — motifs', () => {
  it('« * » n’attrape pas les noms en « . », comme le shell', () => {
    const dir = tempDir();
    touch(join(dir, '.env'));
    touch(join(dir, 'a.png'));
    expect(names(staleFiles(dir, [`${dir}/*`], 7, TODAY))).toEqual([join(dir, 'a.png')]);
  });

  it('un motif commençant par « . » attrape les noms cachés', () => {
    const dir = tempDir();
    touch(join(dir, '.cache-vieux'));
    touch(join(dir, '.autre'));
    expect(names(staleFiles(dir, [`${dir}/.cache-*`], 7, TODAY))).toEqual([join(dir, '.cache-vieux')]);
  });

  it('« * » ne traverse pas non plus un dossier caché au milieu du chemin', () => {
    const dir = tempDir();
    touch(join(dir, '.caché/vieux.png'));
    expect(staleFiles(dir, [`${dir}/*/vieux.png`], 7, TODAY)).toEqual([]);
  });

  it('« * » ne descend jamais dans un lien symbolique vers un dossier extérieur ; le lien seul peut être proposé', () => {
    const tmp = tempDir();
    const dehors = tempDir();
    touch(join(dehors, 'precieux/these.txt'));
    // Le contenu de la cible est d'aujourd'hui : un lien mesuré à travers ne serait jamais proposé.
    touch(join(dehors, 'precieux/du-jour.txt'), cleanAt(0, '08:00:00'));
    symlinkSync(join(dehors, 'precieux'), join(tmp, 'lien'));
    lutimesSync(join(tmp, 'lien'), OLD, OLD);
    expect(staleFiles(tmp, [`${tmp}/*/*`, `${tmp}/*/*/*`, `${tmp}/*/these.txt`], 7, TODAY)).toEqual([]);
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'lien')]);
  });

  it('« * » ne descend jamais dans un lien vers un ancêtre (tmp/self → ..) : la racine n’est pas reparcourue', () => {
    const root = tempDir();
    touch(join(root, 'vieux.png'));
    mkdirSync(join(root, 'tmp'));
    symlinkSync('..', join(root, 'tmp/self'));
    lutimesSync(join(root, 'tmp/self'), OLD, OLD);
    ageTree(join(root, 'tmp'));
    expect(staleFiles(root, ['tmp/*/*', 'tmp/*/*/*'], 7, TODAY)).toEqual([]);
  });

  it('une fois un « * » franchi, un segment écrit en entier ne suit plus un lien non plus (tmp/*/out/*)', () => {
    const tmp = tempDir();
    const dehors = tempDir();
    touch(join(dehors, 'precieux/these.docx'));
    mkdirSync(join(tmp, 'run1'));
    symlinkSync(join(dehors, 'precieux'), join(tmp, 'run1/out'));
    ageTree(tmp);
    expect(staleFiles(tmp, [`${tmp}/*/out/*`, `${tmp}/*/out/these.docx`], 7, TODAY)).toEqual([]);
  });

  it('un segment écrit en entier suit le lien symbolique, comme cd', () => {
    const tmp = tempDir();
    const dehors = tempDir();
    touch(join(dehors, 'vieux.png'));
    symlinkSync(dehors, join(tmp, 'partage'));
    expect(names(staleFiles(tmp, [`${tmp}/partage/*`], 7, TODAY))).toEqual([join(tmp, 'partage/vieux.png')]);
  });

  it('.git n’est jamais proposé, même par un motif en « . »', () => {
    const dir = gitRepo();
    touch(join(dir, '.gitx'));
    // Tout l'arbre est vieilli, .git compris : seul le refus de .git le protège, pas son contenu frais.
    ageTree(dir);
    expect(names(staleFiles(dir, [`${dir}/.git*`], 7, TODAY))).toEqual([join(dir, '.gitx')]);
  });
});

describe('staleFiles — contenu des dossiers et .git', () => {
  it('l’âge d’un dossier est la date la plus récente de son contenu', () => {
    const tmp = tempDir();
    touch(join(tmp, 'travail/notes.md'), cleanAt(-1));
    touch(join(tmp, 'travail'));
    touch(join(tmp, 'vieux/a/b.txt'));
    touch(join(tmp, 'vieux/a'));
    touch(join(tmp, 'vieux'));
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'vieux')]);
  });

  it('ne propose rien sous un dossier .git, même atteint par un motif caché', () => {
    const tmp = tempDir();
    const clone = join(tmp, 'repo');
    mkdirSync(clone);
    git(clone, 'init', '-q');
    ageTree(clone);
    expect(staleFiles(tmp, [`${tmp}/repo/.*/*`], 7, TODAY)).toEqual([]);
    expect(staleFiles(tmp, [`${tmp}/repo/.git/*`, `${tmp}/repo/.*`], 7, TODAY)).toEqual([]);
  });

  it('l’âge d’un dossier ancien vient d’un fichier d’aujourd’hui caché profondément : non proposé', () => {
    const tmp = tempDir();
    touch(join(tmp, 'ancien/a/b/c/du-jour.txt'), cleanAt(0, '08:00:00'));
    for (const d of ['ancien/a/b/c', 'ancien/a/b', 'ancien/a', 'ancien']) touch(join(tmp, d));
    touch(join(tmp, 'vieux.png'));
    expect(names(staleFiles(tmp, [`${tmp}/*`], 7, TODAY))).toEqual([join(tmp, 'vieux.png')]);
  });

  it('un .git au milieu du chemin protège même quand git, lui, répond « non suivi »', () => {
    // vendor/.git n'est pas un dépôt valide : git remonte au dépôt englobant, qui répond « non suivi ».
    const repo = gitRepo();
    touch(join(repo, 'vendor/.git/vieux.png'));
    ageTree(repo);
    expect(staleFiles(repo, [`${repo}/vendor/.*/*`, `${repo}/*/.git/vieux.png`], 7, TODAY)).toEqual([]);
  });
});

describe('staleFiles — rien de ce qui n’a pu être mesuré entièrement', () => {
  for (const mode of [0o311, 0o300, 0o000]) {
    it.skipIf(asRoot)(`un dossier illisible (${mode.toString(8).padStart(4, '0')}) qui contient un clone n’est jamais proposé, ni son contenu`, () => {
      const tmp = tempDir();
      mkdirSync(join(tmp, 'ferme/clone'), { recursive: true });
      git(join(tmp, 'ferme/clone'), 'init', '-q');
      touch(join(tmp, 'ferme/vieux.png'));
      touch(join(tmp, 'libre.png'));
      ageTree(tmp);
      lock(join(tmp, 'ferme'), mode);
      const r = staleFiles(tmp, [`${tmp}/*`, `${tmp}/ferme/*`, `${tmp}/ferme/vieux.png`, `${tmp}/ferme/clone`], 7, TODAY);
      expect(names(r)).toEqual([join(tmp, 'libre.png')]);
    });
  }

  it.skipIf(asRoot)('un dossier lisible dont un enfant refuse lstat (droit x retiré) n’est pas proposé, sans lever', () => {
    const tmp = tempDir();
    touch(join(tmp, 'sans-x/f'));
    ageTree(tmp);
    lock(join(tmp, 'sans-x'), 0o644);
    // Compter l'enfant illisible comme très vieux (new Date(0)) ou l'ignorer proposerait le dossier.
    expect(staleFiles(tmp, [`${tmp}/*`], 7, TODAY)).toEqual([]);
  });

  it.skipIf(asRoot)('le dossier d’un motif qu’on ne peut pas lister ne livre rien, même par un nom écrit en entier', () => {
    const tmp = tempDir();
    touch(join(tmp, 'base/vieux.png'));
    ageTree(tmp);
    lock(join(tmp, 'base'), 0o311);
    const r = scanStale(tmp, [`${tmp}/base/vieux.png`], 7, TODAY);
    expect(r.stale).toEqual([]);
    expect(r.unreadable).toEqual([join(tmp, 'base')]);
  });

  it.skipIf(asRoot)('scanStale rend ce qu’il n’a pas pu lire, pour le dire au lieu de le taire', () => {
    const tmp = tempDir();
    touch(join(tmp, 'ferme/f'));
    touch(join(tmp, 'libre.png'));
    ageTree(tmp);
    lock(join(tmp, 'ferme'), 0o300);
    const r = scanStale(tmp, [`${tmp}/*`], 7, TODAY);
    expect(names(r.stale)).toEqual([join(tmp, 'libre.png')]);
    expect(r.unreadable).toEqual([join(tmp, 'ferme')]);
  });

  it('un .git qui n’est pas un dépôt valide : git ne peut pas répondre, rien n’est proposé à côté', () => {
    const tmp = tempDir();
    mkdirSync(join(tmp, 'faux/.git'), { recursive: true });
    touch(join(tmp, 'faux/vieux.png'));
    ageTree(tmp);
    const r = scanStale(tmp, [`${tmp}/faux/*.png`], 7, TODAY);
    expect(r.stale).toEqual([]);
    expect(r.unreadable).toEqual([join(tmp, 'faux/vieux.png')]);
  });
});

describe('staleFiles — la racine', () => {
  it('ne propose jamais la racine ni un dossier qui la contient', () => {
    const tmp = tempDir();
    const root = join(tmp, 'parent/projet');
    touch(join(root, 'vieux.png'));
    touch(join(tmp, 'libre.png'));
    ageTree(tmp);
    const r = staleFiles(root, [`${tmp}/*`, `${tmp}/parent/*`, '.'], 7, TODAY);
    expect(names(r)).toEqual([join(tmp, 'libre.png')]);
  });
});

describe('staleFiles — seuil et ~', () => {
  it('un âge égal au seuil n’est pas proposé, un jour de plus l’est', () => {
    const dir = tempDir();
    touch(join(dir, 'egal.png'), cleanAt(-7));
    touch(join(dir, 'plus.png'), cleanAt(-8));
    const r = staleFiles(dir, [`${dir}/*`], 7, TODAY);
    expect(r.map((s) => [s.path, s.age])).toEqual([[join(dir, 'plus.png'), 8]]);
  });

  it('~ se résout sous le dossier personnel courant', () => {
    const home = tempDir();
    touch(join(home, 'partage/vieux.png'));
    // Tout est vieilli, le dossier personnel compris : « ~ » seul le désigne lui-même, « ~/… » ce qu'il contient.
    ageTree(home);
    const avant = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(names(staleFiles(tempDir(), ['~/partage/*', '~'], 7, TODAY))).toEqual([home, join(home, 'partage/vieux.png')]);
    } finally {
      if (avant === undefined) delete process.env.HOME;
      else process.env.HOME = avant;
    }
  });
});
