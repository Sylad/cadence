import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { rebaseOnto } from '../src/orchestrate/integrate.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { RunStore } from '../src/orchestrate/state.js';
import { claudeOut, commitFile, git, workReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, store, subjects, until } from './orchestrate-worktree-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L538 — la ligne de base du cliquet (qualite-baseline.json) en conflit au rebase d'intégration : recalculée sur main + les baisses propres au lot.
const BASE = 'qualite-baseline.json';
const key = (f: string, suffix = 'r') => `eslint|${f}|${suffix}`;
const [A, B, C] = [key('src/a.ts'), key('src/b.ts'), key('src/c.ts')];
type Mesure = Record<string, number>;
const bl = (m: Mesure) => `${JSON.stringify(Object.fromEntries(Object.entries(m).sort(([x], [y]) => (x < y ? -1 : 1))), null, 2)}\n`;
/** `null` : le fichier est supprimé ; une chaîne : le contenu brut (une version illisible). */
type Version = Mesure | string | null;
type Files = Record<string, string | null>;
const put = (dir: string, files: Files, message: string) => {
  for (const [f, text] of Object.entries(files)) {
    if (text === null) {
      git(dir, 'rm', '-q', '--', f);
      continue;
    }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    git(dir, 'add', '--', f);
  }
  git(dir, 'commit', '-q', '-m', message);
};
const text = (v: Version) => (v === null || typeof v === 'string' ? v : bl(v));

/** Un lot parti de `start` : ses commits (`lot`) puis un commit de main (`main`), le rebase n'a pas eu lieu. Les fichiers src/a.ts, b.ts, c.ts existent au départ. */
function scene(o: { start: Version; main: Version | Files; lot: (Version | Files)[]; startFiles?: Files }) {
  const repo = gitRepo();
  const as = (v: Version | Files): Files => (v === null || typeof v === 'string' || Object.values(v).some((x) => typeof x === 'number') ? { [BASE]: text(v as Version) } : (v as Files));
  put(repo, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n', ...(o.start === null ? {} : { [BASE]: text(o.start) }), ...o.startFiles }, 'init');
  const store = new RunStore(tempDir(), 'w1');
  const t = { repo, dir: lotTreeDir(store.dir, 'p', 'L1'), branch: lotBranch('w1', 'p', 'L1'), base: 'main', lot: 'p:L1' };
  expect(prepareTree(t).ok).toBe(true);
  o.lot.forEach((v, i) => put(t.dir, as(v), `feat(L1): commit ${i + 1}`));
  put(repo, as(o.main), 'feat(L2): main');
  return { repo, t, read: () => readFileSync(join(t.dir, BASE), 'utf8'), shas: () => [git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', t.branch)] };
}
const untouched = (s: ReturnType<typeof scene>, shas: string[]) => {
  expect(s.shas()).toEqual(shas);
  expect(git(s.t.dir, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(git(s.t.dir, 'rev-parse', '--git-dir'), 'rebase-merge'))).toBe(false);
};

describe('R1 — la base du lot recalculée sur main', () => {
  it('R1 — lot qui baisse deux clés, main qui en a monté une autre : la base rebasée porte main + les baisses du lot', () => {
    const s = scene({ start: { [A]: 5, [B]: 4, [C]: 3 }, main: { [A]: 5, [B]: 6, [C]: 3 }, lot: [{ [A]: 2, [B]: 4, [C]: 1 }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(JSON.parse(s.read())).toEqual({ [A]: 2, [B]: 6, [C]: 1 });
    expect(git(s.t.dir, 'merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
    expect(git(s.t.dir, 'status', '--porcelain')).toBe('');
  });
  it('R1 — clé baissée à 0 par le lot : retirée du fichier, fichier trié et terminé par un saut de ligne', () => {
    const unsorted = `{\n  "${C}": 3,\n  "${B}": 6,\n  "${A}": 5\n}\n`;
    const s = scene({ start: { [A]: 5, [B]: 4, [C]: 3 }, main: unsorted, lot: [{ [B]: 4, [C]: 3 }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(s.read()).toBe(`{\n  "${B}": 6,\n  "${C}": 3\n}\n`);
  });
});

describe('R2 — une clé baissée des deux côtés', () => {
  it('R2 — clé baissée par main (3→1) et par le lot (3→1) : la valeur écrite dans qualite-baseline.json est 0 et la clé est retirée', () => {
    const s = scene({ start: { [A]: 3, [B]: 4 }, main: { [A]: 1, [B]: 5 }, lot: [{ [A]: 1, [B]: 2 }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(JSON.parse(s.read())).toEqual({ [B]: 3 }); // A : 1 + 1 - 3 = -1, ramené à 0 donc retiré
  });
});

describe('R3 — le contrôle de la porte sur chaque commit du lot', () => {
  it('R3 — le lot monte une clé d\'un fichier existant : conflit signalé, branche du lot et de main inchangées', () => {
    const s = scene({ start: { [A]: 3, [B]: 3 }, main: { [A]: 3, [B]: 1 }, lot: [{ [A]: 4, [B]: 2 }] });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    untouched(s, shas);
  });
  it('R3 — le lot découpe un fichier (clés neuves, total non en hausse) : rebase réussi, base de main plus la différence du commit', () => {
    const [ta, tb, tn] = [key('src/a.ts', 'r|total'), key('src/b.ts', 'r|total'), key('src/new.ts', 'r|total')];
    const s = scene({ start: { [ta]: 10, [tb]: 5 }, main: { [ta]: 10, [tb]: 4 }, lot: [{ [ta]: 6, [tb]: 5, [tn]: 4 }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(JSON.parse(s.read())).toEqual({ [ta]: 6, [tb]: 4, [tn]: 4 });
  });
  it('R3 — le lot ajoute un chemin neuf qui fait monter le total : conflit signalé', () => {
    const [ta, tb, tn] = [key('src/a.ts', 'r|total'), key('src/b.ts', 'r|total'), key('src/new.ts', 'r|total')];
    const s = scene({ start: { [ta]: 10, [tb]: 5 }, main: { [ta]: 10, [tb]: 4 }, lot: [{ [ta]: 10, [tb]: 5, [tn]: 2 }] });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    untouched(s, shas);
  });
  it('R3 — commit intermédiaire qui monte une clé puis commit qui la rebaisse : rebase abandonné', () => {
    const s = scene({ start: { [A]: 3, [B]: 3 }, main: { [A]: 3, [B]: 1 }, lot: [{ [A]: 4, [B]: 2 }, { [A]: 3, [B]: 2 }] });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    untouched(s, shas);
  });
  it('R3 — un fichier créé par le commit lui-même part libre : « existe » se lit au parent du commit rejoué, pas dans l\'arbre de main', () => {
    // src/new.ts est créé par main : un lot qui monte sa clé neuve (et baisse a) y est refusé s'il existe à l'arbre de main, accepté s'il n'existe qu'au parent.
    const tn = key('src/new.ts', 'r|total');
    const ta = key('src/a.ts', 'r|total');
    const s = scene({ start: { [ta]: 10, [B]: 5 }, main: { 'src/new.ts': 'n\n', [BASE]: bl({ [ta]: 10, [B]: 4 }) }, lot: [{ [ta]: 6, [B]: 5, [tn]: 4 }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 1 });
    expect(JSON.parse(s.read())).toEqual({ [ta]: 6, [B]: 4, [tn]: 4 });
  });
});

describe('R4 — un autre fichier en conflit', () => {
  it('R4 — base et un autre fichier en conflit : rebase abandonné, fichiers listés', () => {
    const s = scene({
      start: { [A]: 3, [B]: 3 },
      startFiles: { 'f.txt': 'f\n' },
      main: { 'f.txt': 'f de main\n', [BASE]: bl({ [A]: 3, [B]: 1 }) },
      lot: [{ 'f.txt': 'f du lot\n', [BASE]: bl({ [A]: 2, [B]: 3 }) }],
    });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: ['f.txt', BASE] });
    untouched(s, shas);
  });
});

describe('R6 — commit par commit', () => {
  it('R6 — deux commits du lot qui baissent la même clé : baisses cumulées sur la base de main', () => {
    const s = scene({
      start: { [A]: 6, [B]: 3, [C]: 5 },
      main: { [A]: 6, [B]: 1, [C]: 7 },
      lot: [{ [A]: 4, [B]: 2, [C]: 5 }, { [A]: 2, [B]: 2, [C]: 5 }],
    });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 2 });
    expect(JSON.parse(s.read())).toEqual({ [A]: 2, [C]: 7 });
  });
});

describe('R8 — sans conflit sur la base', () => {
  it('R8 — lot qui ne touche pas la base : qualite-baseline.json identique à celui de main après le rebase', () => {
    const s = scene({ start: { [A]: 3, [B]: 3 }, main: { [A]: 3, [B]: 1 }, lot: [{ 'x.txt': 'x\n' }] });
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'rebased', baseline: 0 });
    expect(s.read()).toBe(git(s.repo, 'show', `main:${BASE}`) + '\n');
  });
});

describe('R9 — une des trois versions manque ou est illisible', () => {
  it('R9 — le lot crée qualite-baseline.json (étape 1 absente) : rebase abandonné, conflit signalé', () => {
    const s = scene({ start: null, main: { [A]: 3 }, lot: [{ [A]: 2 }] });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    untouched(s, shas);
  });
  it('R9 — main ou le lot supprime le fichier (étape 2 ou 3 absente) : rebase abandonné', () => {
    const mainDeletes = scene({ start: { [A]: 3 }, main: { [BASE]: null }, lot: [{ [A]: 2 }] });
    const lotDeletes = scene({ start: { [A]: 3 }, main: { [A]: 2 }, lot: [{ [BASE]: null }] });
    for (const s of [mainDeletes, lotDeletes]) {
      const shas = s.shas();
      expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
      untouched(s, shas);
    }
  });
  it.each([
    ['JSON invalide', '{ "a": 1'],
    ['valeur non numérique', '{\n  "eslint|src/a.ts|r": "2"\n}\n'],
    ['valeur imbriquée', '{\n  "eslint|src/a.ts|r": { "n": 2 }\n}\n'],
    ['tableau', '[1, 2]\n'],
    ['null', 'null\n'],
  ])('R9 — version du lot en %s : rebase abandonné', (_nom, lot) => {
    const s = scene({ start: { [A]: 3, [B]: 3 }, main: { [A]: 3, [B]: 1 }, lot: [lot] });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    untouched(s, shas);
  });
  it('R9 — version de main illisible : rebase abandonné', () => {
    const s = scene({ start: { [A]: 3, [B]: 3 }, main: '{ pas du json', lot: [{ [A]: 2, [B]: 3 }] });
    const shas = s.shas();
    expect(rebaseOnto(s.t.dir, 'main')).toMatchObject({ kind: 'conflict', files: [BASE] });
    untouched(s, shas);
  });
});

// De bout en bout : deux lots qui baissent la base, le second rebasé sur le premier ; la porte de l'intégration rejoue un cliquet de poche.
describe('R5 / R7 — l\'intégration rejoue le cliquet et journalise la résolution', () => {
  const fileHome = process.env.CADENCE_HOME;
  beforeEach(() => {
    process.env.CADENCE_HOME = tempDir();
  });
  afterEach(() => {
    process.env.CADENCE_HOME = fileHome;
  });
  // La base doit couvrir la mesure quand les deux lots sont là ; chaque lot seul ne la rejoue pas.
  const CHECK =
    'if [ -f L1.txt ] && [ -f L2.txt ]; then node -e \'const b=require("./qualite-baseline.json"),m=require("./mesure.json");const bad=Object.keys(m).filter((k)=>(b[k]??0)<m[k]);if(bad.length){console.log("FAIL cliquet "+bad.join());process.exit(1)}\'; fi\n';
  const [EA, EB] = [key('a.ts'), key('b.ts')];
  async function wave(mesure: Mesure) {
    const files = { 'check.sh': CHECK, [BASE]: bl({ [EA]: 3, [EB]: 3 }), 'mesure.json': JSON.stringify(mesure), 'a.ts': 'a\n', 'b.ts': 'b\n' };
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', files);
    const lot = (cwd: string, name: string, m: Mesure) => {
      writeFileSync(join(cwd, BASE), bl(m));
      git(cwd, 'add', '--', BASE);
      git(cwd, 'commit', '-q', '-m', `feat(${name}): base`);
      return claudeOut(workReport({ commits: [commitFile(cwd, `${name}.txt`, `feat(${name}): travail`)] }));
    };
    const f = fake({
      implement: async (cwd, brief) => {
        const name = lotOf(brief);
        if (name === 'L1') await until(() => existsSync(join(repo, 'L2.txt'))); // L1 s'intègre après L2 : main a bougé sur la base
        return lot(cwd, name, name === 'L1' ? { [EA]: 1, [EB]: 3 } : { [EA]: 3, [EB]: 1 });
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    return { parent, repo, r };
  }
  it('R7 — résolution de la base : une ligne de journal avec le nombre de commits', async () => {
    const { parent, repo, r } = await wave({ [EA]: 1, [EB]: 1 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/a:L1 qualite-baseline\.json : base recalculée sur main \+ baisses du lot \(1 commit\(s\)\)/);
    expect(JSON.parse(git(repo, 'show', `main:${BASE}`))).toEqual({ [EA]: 1, [EB]: 1 });
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
  });
  it('R5 — base recalculée trop basse pour la mesure : intégration refusée, main inchangé', async () => {
    const { parent, repo, r } = await wave({ [EA]: 2, [EB]: 1 }); // la mesure de a est 2 : la base recalculée (1) est trop basse
    expect(r.code).toBe(1);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).toMatch(/^intégration refusée : tests rouges au sommet intégré \(.*FAIL cliquet/);
    expect(subjects(repo).some((s) => s.startsWith('feat(L1)'))).toBe(false);
    expect(JSON.parse(git(repo, 'show', `main:${BASE}`))).toEqual({ [EA]: 3, [EB]: 1 });
  });
});
