import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { partageBrief, partageLines, partageOf, sealedAtRisk } from '../src/orchestrate/partage.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const DIR = 'docs/specs';
const ACC = `${DIR}/ecran/acceptation-L10.json`;

/** Dépôt où le test scellé de L10 (`test/a.test.ts`) importe `src/x.ts` ; `test/b.test.ts` importe `src/y.ts` et n'est pas scellé. */
function repoWithImport(testText = "import { x } from '../src/x.js';\n"): string {
  const repo = gitRepo();
  for (const d of ['test', 'src', `${DIR}/ecran`]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'test/a.test.ts'), testText);
  writeFileSync(join(repo, 'test/b.test.ts'), "import { y } from '../src/y.js';\n");
  for (const f of ['src/x.ts', 'src/y.ts', `${DIR}/ecran/fiche.yaml`]) writeFileSync(join(repo, f), `${f}\n`);
  writeFileSync(join(repo, ACC), JSON.stringify({ lot: 'L10', fiche: `${DIR}/ecran/fiche.yaml`, fichiers: ['test/a.test.ts'], vert: true, empreintes: { 'test/a.test.ts': 'abc' } }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

describe('L628 — sealedAtRisk : les tests scellés qui figent un fichier de code cité', () => {
  it('R1 — un fichier de code cité qu\'importe un test scellé d\'un autre lot liste ce test, avec le fichier de code (via)', () => {
    expect(sealedAtRisk(repoWithImport(), DIR, 'L628', ['src/x.ts'])).toEqual([{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: ACC, via: 'src/x.ts' }]);
  });
  it('R1 — l\'import se lit sous toutes ses formes relatives : .ts, sans extension, require, import dynamique, export from', () => {
    for (const spec of ["from '../src/x.ts'", "from '../src/x'", "require('../src/x.js')", "import('../src/x.js')", "export * from '../src/x.js'"]) {
      expect(sealedAtRisk(repoWithImport(`const a = 1; ${spec};\n`), DIR, 'L628', ['src/x.ts']).map((s) => s.via)).toEqual(['src/x.ts']);
    }
  });
  it('R1 — un test qui n\'importe pas le fichier cité, un import non relatif de même nom, ou un fichier de code d\'un autre dossier, ne sont pas listés', () => {
    expect(sealedAtRisk(repoWithImport(), DIR, 'L628', ['src/y.ts'])).toEqual([]);
    expect(sealedAtRisk(repoWithImport("import x from 'src/x.js';\nimport z from 'x';\n"), DIR, 'L628', ['src/x.ts'])).toEqual([]);
    expect(sealedAtRisk(repoWithImport("import { x } from '../lib/x.js';\n"), DIR, 'L628', ['src/x.ts'])).toEqual([]);
  });
  it('R1 — le test scellé du lot lui-même n\'est pas listé par import non plus', () => {
    expect(sealedAtRisk(repoWithImport(), DIR, 'L10', ['src/x.ts'])).toEqual([]);
  });
  it('R1 — un test scellé absent de git (supprimé) ne lève pas et n\'est pas listé', () => {
    const repo = repoWithImport();
    git(repo, 'rm', '-q', 'test/a.test.ts');
    git(repo, 'commit', '-q', '-m', 'rm');
    expect(sealedAtRisk(repo, DIR, 'L628', ['src/x.ts'])).toEqual([]);
  });
  it('R1 — le test cité lui-même et le code qu\'il importe, cités ensemble, donnent une seule ligne (la citation directe, sans via)', () => {
    expect(sealedAtRisk(repoWithImport(), DIR, 'L628', ['test/a.test.ts', 'src/x.ts'])).toEqual([{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: ACC }]);
  });
  it('R1 — deux fichiers de code cités qu\'importe le même test : une ligne par test, le premier fichier cité en via', () => {
    const repo = repoWithImport("import { x } from '../src/x.js';\nimport { y } from '../src/y.js';\n");
    expect(sealedAtRisk(repo, DIR, 'L628', ['src/y.ts', 'src/x.ts'])).toEqual([{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: ACC, via: 'src/y.ts' }]);
  });
});

describe('L628 — partageOf, le brief et le tableau', () => {
  it('R1 — le précheck complet liste le test scellé qui importe le code que le titre du lot cite, sans que le titre cite aucun test', () => {
    const repo = repoWithImport();
    const found = partageOf({ root: repo, repo, specDir: DIR, lot: 'L628', key: 'p:L628', text: 'Changer la sortie de src/x.ts', others: () => [] });
    expect(found?.scelles.map((s) => s.fichier)).toEqual(['test/a.test.ts']);
  });
  const p = { scelles: [{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: ACC, via: 'src/x.ts' }], fichiers: [] };
  it('R2 — le brief nomme le fichier de code qui rend le test concerné et dit de s\'arrêter avec le geste de rescellement du lead', () => {
    const out = partageBrief(p);
    expect(out).toContain('- test/a.test.ts (sealed by L10, docs/specs/ecran/acceptation-L10.json; it imports src/x.ts)');
    expect(out).toContain('cadence spec reseal');
    expect(out).toContain('stop');
    expect(out).toContain('under "questions"');
  });
  it('R2 — le tableau dit le fichier de code par lequel le test scellé est concerné', () => {
    expect(partageLines(p, 'p:L628')).toEqual(['p:L628 — ⚠ test scellé de L10 que le lot risque de toucher : test/a.test.ts (docs/specs/ecran/acceptation-L10.json), il importe src/x.ts']);
  });
});

describe('L628 — le cycle joue le précheck pour un lot light ou small', () => {
  const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, `f-${Math.random().toString(36).slice(2)}.txt`, 'feat(L1): a')] }));
  const ok: Handler = () => claudeOut(reviewReport());
  for (const flag of ['small', 'light'] as const) {
    it(`R3 — un lot ${flag} dont le titre cite src/x.ts reçoit dans son brief le test scellé par L10 qui l'importe`, async () => {
      const h = harness({ lots: [{ title: 'Changer la sortie de src/x.ts' }], script: { implement: [impl], review: [ok] } });
      for (const d of ['test', 'src', `${DIR}/ecran`]) mkdirSync(join(h.repo, d), { recursive: true });
      writeFileSync(join(h.repo, 'src/x.ts'), 'x\n');
      writeFileSync(join(h.repo, 'test/a.test.ts'), "import { x } from '../src/x.js';\n");
      writeFileSync(join(h.repo, `${DIR}/ecran/fiche.yaml`), 'f\n');
      writeFileSync(join(h.repo, ACC), JSON.stringify({ lot: 'L10', fiche: `${DIR}/ecran/fiche.yaml`, fichiers: ['test/a.test.ts'], vert: true, empreintes: { 'test/a.test.ts': 'abc' } }));
      git(h.repo, 'add', '--', 'test', 'src', DIR);
      git(h.repo, 'commit', '-q', '-m', 'chore: tests scellés de L10');
      const c = h.lot('L1', { [flag]: true }, { precheck: false });
      await runLot(c);
      expect(c.lot.partage?.scelles).toEqual([{ fichier: 'test/a.test.ts', lot: 'L10', acceptation: ACC, via: 'src/x.ts' }]);
      expect(h.calls.find((x) => x.kind === 'implement')!.brief).toContain('it imports src/x.ts');
    });
  }
});
