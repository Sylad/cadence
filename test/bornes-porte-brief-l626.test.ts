import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { briefFor } from '../src/orchestrate/cycle/brief.js';
import { programChecks } from '../src/orchestrate/cycle/checks.js';
import { commitFile, git, harness } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L626 : la porte ciblée joue les tests déclarés par `bounds` et le brief d'écriture reçoit les bornes des fichiers que le lot cite.

afterEach(cleanupTempDirs);
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

// briefFor crée le dossier temporaire du lot (state.tmpDir) hors de tempDir() : on le retire à la fin de chaque test.
const briefed: Array<() => void> = [];
afterEach(() => {
  for (const f of briefed.splice(0)) f();
});
function briefOf(h: ReturnType<typeof harness>, c: ReturnType<typeof lot>['c']): void {
  briefed.push(() => h.store.removeTmpDir(c.lot.project, c.lot.lot));
}

const YAML = 'bounds:\n  - paths: [README.md]\n    lines: 64\n    columns: 160\n    tests: [test/readme.test.ts, test/absent.test.ts]\n';

function lot(yaml: string | null) {
  const log = join(tempDir(), 'portes.log');
  const h = harness();
  const config = { test: 'true', testRelated: `echo "REL {files}" >> ${log}; true` };
  const c = Object.assign(h.lot('L1', {}, config), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
  mkdirSync(join(h.repo, 'test'));
  commitFile(h.repo, 'test/readme.test.ts', 'test: readme');
  if (yaml !== null) {
    writeFileSync(join(h.repo, 'cadence.yaml'), yaml);
    git(h.repo, 'add', '--', 'cadence.yaml');
    git(h.repo, 'commit', '-q', '-m', 'chore: config', '--', 'cadence.yaml');
  }
  return { h, c, log };
}

async function joues(files: string[], yaml: string | null): Promise<string[]> {
  const { h, c, log } = lot(yaml);
  for (const f of ['a.txt', ...files]) commitFile(h.repo, f, 'feat(L1): x');
  await programChecks(c, [], []);
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return (lines.at(-1) ?? '').replace(/^REL /, '').split(' ').filter(Boolean);
}

describe('L626 — la porte ciblée joue les tests déclarés', () => {
  it('R6 — un lot qui touche README.md joue test/readme.test.ts avec ses fichiers', async () => {
    expect(await joues(['README.md'], YAML)).toEqual(['README.md', 'a.txt', 'test/readme.test.ts']);
  });
  it('R6 — un lot qui ne touche pas README.md : rien ne s’ajoute ; un test déclaré absent du dépôt n’est pas joué', async () => {
    expect(await joues(['b.txt'], YAML)).toEqual(['a.txt', 'b.txt']);
  });
  it('R6 — sans clé bounds, ou avec une clé refusée : comme avant, les fichiers du diff seuls', async () => {
    expect(await joues(['README.md'], null)).toEqual(['README.md', 'a.txt']);
    expect(await joues(['README.md'], 'bounds: 3\n')).toEqual(['README.md', 'a.txt']);
  });
});

describe('L626 — le brief d’implémentation reçoit les bornes', () => {
  it('R4 — implement et fix reçoivent les bornes chiffrées du dépôt, que le lot cite le fichier ou non ; la revue non', () => {
    const { h, c } = lot(YAML);
    briefOf(h, c);
    c.lot.goal = 'mettre à jour la page de configuration';
    for (const kind of ['implement', 'fix'] as const) {
      const brief = briefFor(c, kind);
      expect(brief, kind).toContain('`README.md`: 64 lines, 160 columns');
    }
    expect(briefFor(c, 'review')).not.toContain('64 lines');
  });

  it('R4 — dépôt sans bounds, ou bornes sans limite chiffrée : pas de ligne de bornes', () => {
    const la = lot('bounds:\n  - paths: [CHANGELOG.md]\n    tests: [test/readme.test.ts]\n');
    briefOf(la.h, la.c);
    expect(briefFor(la.c, 'implement')).not.toContain('Size bounds');
    const lb = lot(null);
    briefOf(lb.h, lb.c);
    expect(briefFor(lb.c, 'implement')).not.toContain('Size bounds');
  });
});
