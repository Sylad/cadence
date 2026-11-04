import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { citedFiles, partageBrief, partageLines, partageOf, sealedAtRisk, sharedFiles, touchedByOthers } from '../src/orchestrate/partage.js';
import { renderTable } from '../src/orchestrate/table.js';
import { newLot, type WaveState } from '../src/orchestrate/state.js';
import { prepareTree } from '../src/orchestrate/worktree.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

const DIR = 'docs/specs';

/** Dépôt avec deux fichiers de test, une fiche, et l'acceptation SCELLÉE (empreintes) du lot L10 sur `test/a.test.ts`. */
function repoWithSeal(sealed = true): string {
  const repo = gitRepo();
  mkdirSync(join(repo, 'test'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, DIR, 'ecran'), { recursive: true });
  for (const f of ['test/a.test.ts', 'test/b.test.ts', 'src/x.ts', 'src/y.ts', `${DIR}/ecran/fiche.yaml`]) writeFileSync(join(repo, f), `${f}\n`);
  const acc = { lot: 'L10', fiche: `${DIR}/ecran/fiche.yaml`, fichiers: ['test/a.test.ts'], vert: false, ...(sealed ? { empreintes: { 'test/a.test.ts': 'abc' } } : {}) };
  writeFileSync(join(repo, DIR, 'ecran', 'acceptation-L10.json'), JSON.stringify(acc));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

const tracked = ['src/x.ts', 'src/y.ts', 'test/a.test.ts', 'docs/a/README.md', 'docs/b/README.md', 'CHANGELOG.md'];

describe('L500 — citedFiles : les fichiers que le lot risque de toucher', () => {
  it('un chemin exact est reconnu, avec :ligne, ponctuation finale, guillemets et ./ devant', () => {
    expect(citedFiles('voir src/x.ts:12, puis (./src/y.ts).', tracked).sort()).toEqual(['src/x.ts', 'src/y.ts']);
  });
  it('un nom de fichier sans dossier est reconnu s\'il est unique, jamais s\'il est porté par deux fichiers', () => {
    expect(citedFiles('CHANGELOG.md et README.md', tracked)).toEqual(['CHANGELOG.md']);
  });
  it('un texte vide, ou qui ne cite aucun fichier suivi, ne donne rien', () => {
    expect(citedFiles('', tracked)).toEqual([]);
    expect(citedFiles('src/inconnu.ts et un mot', tracked)).toEqual([]);
  });
  it('un fichier cité deux fois est listé une fois', () => {
    expect(citedFiles('src/x.ts src/x.ts', tracked)).toEqual(['src/x.ts']);
  });
});

describe('L500 — sealedAtRisk : tests scellés d\'un autre lot', () => {
  it('un test scellé par un autre lot et cité est listé, avec le lot et le fichier d\'acceptation', () => {
    const repo = repoWithSeal();
    expect(sealedAtRisk(repo, DIR, 'L500', ['test/a.test.ts'])).toEqual([{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: `${DIR}/ecran/acceptation-L10.json` }]);
  });
  it('la fiche d\'un autre lot, citée, est listée aussi', () => {
    const repo = repoWithSeal();
    expect(sealedAtRisk(repo, DIR, 'L500', [`${DIR}/ecran/fiche.yaml`]).map((s) => s.lot)).toEqual(['L10']);
  });
  it('le test scellé du lot lui-même n\'est pas listé', () => {
    expect(sealedAtRisk(repoWithSeal(), DIR, 'L10', ['test/a.test.ts'])).toEqual([]);
  });
  it('un test non cité, ou un fichier d\'acceptation sans empreinte (pas scellé), n\'est pas listé', () => {
    expect(sealedAtRisk(repoWithSeal(), DIR, 'L500', ['test/b.test.ts'])).toEqual([]);
    expect(sealedAtRisk(repoWithSeal(false), DIR, 'L500', ['test/a.test.ts'])).toEqual([]);
  });
  it('un dossier de fiches absent, ou un fichier d\'acceptation illisible, ne lève pas', () => {
    const repo = repoWithSeal();
    expect(sealedAtRisk(repo, 'docs/absent', 'L500', ['test/a.test.ts'])).toEqual([]);
    writeFileSync(join(repo, DIR, 'ecran', 'acceptation-L11.json'), '{pas du json');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'cassé');
    expect(sealedAtRisk(repo, DIR, 'L500', ['test/a.test.ts'])).toHaveLength(1);
  });
});

describe('L500 — sharedFiles et touchedByOthers : fichiers que touche un autre lot', () => {
  it('sharedFiles : un couple par fichier cité et par autre lot qui le touche', () => {
    const others = [{ label: 'p:L1 (vague en cours)', files: new Set(['src/x.ts', 'src/z.ts']) }, { label: 'p:L2 (worktree conservé)', files: new Set(['src/x.ts']) }];
    expect(sharedFiles(['src/x.ts', 'src/y.ts'], others)).toEqual([{ fichier: 'src/x.ts', avec: 'p:L1 (vague en cours)' }, { fichier: 'src/x.ts', avec: 'p:L2 (worktree conservé)' }]);
    expect(sharedFiles(['src/x.ts'], [])).toEqual([]);
  });

  it('touchedByOthers : le worktree conservé d\'un autre lot est lu, pas celui du lot lui-même ni un worktree sans commit', () => {
    const repo = repoWithSeal();
    const specs = Object.fromEntries(['L1', 'L500', 'L3'].map((lot) => [lot, { repo, branch: `cadence/w0/p--${lot}`, dir: join(tempDir(), lot), base: 'main', lot: `p:${lot}` }]));
    for (const s of Object.values(specs)) expect(prepareTree(s)).toMatchObject({ ok: true });
    for (const lot of ['L1', 'L500']) {
      writeFileSync(join(specs[lot]!.dir, 'src/x.ts'), `${lot}\n`);
      git(specs[lot]!.dir, 'commit', '-q', '-am', `feat(${lot}): x`);
    }
    const out = touchedByOthers(repo, 'p:L500');
    expect(out.map((o) => o.label)).toEqual(['p:L1 (worktree conservé)']);
    expect([...out[0]!.files]).toEqual(['src/x.ts']);
  });

  it('touchedByOthers : un dépôt sans branche de cadence ne donne rien', () => {
    expect(touchedByOthers(repoWithSeal(), 'p:L500')).toEqual([]);
  });
});

describe('L500 — partageOf : le précheck complet', () => {
  const base = (repo: string) => ({ root: repo, repo, specDir: DIR, lot: 'L500', key: 'p:L500' });
  it('liste le test scellé et le fichier partagé que le texte du lot cite', () => {
    const repo = repoWithSeal();
    const others = () => [{ label: 'p:L1 (vague en cours)', files: new Set(['src/x.ts']) }];
    const p = partageOf({ ...base(repo), text: 'corriger src/x.ts et test/a.test.ts', others });
    expect(p?.scelles.map((s) => s.fichier)).toEqual(['test/a.test.ts']);
    expect(p?.fichiers).toEqual([{ fichier: 'src/x.ts', avec: 'p:L1 (vague en cours)' }]);
  });
  it('rend null quand le lot ne cite aucun fichier, ou que rien n\'est partagé ni scellé', () => {
    const repo = repoWithSeal();
    expect(partageOf({ ...base(repo), text: 'rien de précis', others: () => [{ label: 'x', files: new Set(['src/x.ts']) }] })).toBeNull();
    expect(partageOf({ ...base(repo), text: 'src/y.ts', others: () => [] })).toBeNull();
  });
  it('lève quand git ne lit pas le dépôt (l\'appelant l\'écrit au journal)', () => {
    expect(() => partageOf({ ...base(tempDir()), text: 'src/x.ts' })).toThrow();
  });
});

describe('L500 — le brief et le tableau', () => {
  const p = { scelles: [{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: `${DIR}/ecran/acceptation-L10.json` }], fichiers: [{ fichier: 'src/x.ts', avec: 'p:L1 (vague en cours)' }] };
  it('le brief nomme chaque test scellé (avec son lot) et chaque fichier partagé, et dit quoi faire', () => {
    const out = partageBrief(p);
    expect(out).toContain('- test/a.test.ts (sealed by L10');
    expect(out).toContain('do not modify, rewrite or reseal');
    expect(out).toContain('- src/x.ts (also touched by p:L1 (vague en cours))');
  });
  it('sans partage le brief n\'ajoute rien', () => {
    expect(partageBrief(undefined)).toBe('');
  });
  it('le tableau compact porte une ligne par test scellé et par fichier partagé', () => {
    const wave: WaveState = { id: 'w1', created: '2026-11-04T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'running', pid: 1, lots: ['p:L500'] };
    const l = newLot({ project: 'p', repo: '/r', lot: 'L500', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    l.partage = p;
    const out = renderTable(wave, [l], { compact: true });
    expect(out).toContain('p:L500 — ⚠ test scellé de L10 que le lot risque de toucher : test/a.test.ts (docs/specs/ecran/acceptation-L10.json)');
    expect(out).toContain('p:L500 — ⚠ fichier que touche aussi p:L1 (vague en cours) : src/x.ts');
    expect(partageLines(undefined, 'p:L500')).toEqual([]);
  });
});

describe('L500 — le cycle range le partage au départ et le met dans le brief implement', () => {
  const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, `f-${Math.random().toString(36).slice(2)}.txt`, 'feat(L1): a')] }));
  const ok: Handler = () => claudeOut(reviewReport());
  /** Un dépôt de harnais où le lot L1 cite `test/a.test.ts`, scellé par L10. */
  function jeu(title: string) {
    const h = harness({ lots: [{ title }], script: { implement: [impl], review: [ok] } });
    mkdirSync(join(h.repo, 'test'), { recursive: true });
    mkdirSync(join(h.repo, DIR, 'ecran'), { recursive: true });
    writeFileSync(join(h.repo, 'test/a.test.ts'), 'a\n');
    writeFileSync(join(h.repo, DIR, 'ecran/fiche.yaml'), 'f\n');
    writeFileSync(join(h.repo, DIR, 'ecran/acceptation-L10.json'), JSON.stringify({ lot: 'L10', fiche: `${DIR}/ecran/fiche.yaml`, fichiers: ['test/a.test.ts'], vert: false, empreintes: { 'test/a.test.ts': 'abc' } }));
    git(h.repo, 'add', '--', 'test', DIR);
    git(h.repo, 'commit', '-q', '-m', 'chore: tests scellés de L10');
    return h;
  }

  it('le lot qui cite un test scellé par L10 reçoit la liste dans le brief de la première implémentation et dans son état', async () => {
    const h = jeu('Adapter test/a.test.ts à la nouvelle sortie');
    const c = h.lot('L1', {}, { precheck: false });
    await runLot(c);
    expect(c.lot.partage?.scelles).toEqual([{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: `${DIR}/ecran/acceptation-L10.json` }]);
    const brief = h.calls.find((x) => x.kind === 'implement')!.brief;
    expect(brief).toContain('- test/a.test.ts (sealed by L10');
  });

  it('un lot qui ne cite aucun fichier partagé n\'a ni état partage ni ligne dans le brief', async () => {
    const h = jeu('Un lot sans fichier cité');
    const c = h.lot('L1', {}, { precheck: false });
    await runLot(c);
    expect(c.lot.partage).toBeUndefined();
    expect(h.calls.find((x) => x.kind === 'implement')!.brief).not.toContain('sealed by');
  });

  it('un lot repris de sa branche conservée ne refait pas le précheck de partage', async () => {
    const h = jeu('Adapter test/a.test.ts à la nouvelle sortie');
    const c = h.lot('L1', {}, { precheck: false });
    c.lot.resumedFrom = 'w0';
    await runLot(c);
    expect(c.lot.partage).toBeUndefined();
  });
});
