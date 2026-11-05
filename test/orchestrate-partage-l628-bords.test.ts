import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealedAtRisk } from '../src/orchestrate/partage.js';
import { git } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

const DIR = 'docs/specs';
const ACC = `${DIR}/ecran/acceptation-L10.json`;

function repoWith(testText: string, fichiers = ['test/a.test.ts']): string {
  const repo = gitRepo();
  for (const d of ['test', 'src', `${DIR}/ecran`]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'test/a.test.ts'), testText);
  for (const f of ['src/x.ts', `${DIR}/ecran/fiche.yaml`]) writeFileSync(join(repo, f), `${f}\n`);
  writeFileSync(join(repo, ACC), JSON.stringify({ lot: 'L10', fiche: `${DIR}/ecran/fiche.yaml`, fichiers, vert: true, empreintes: { 'test/a.test.ts': 'abc' } }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

describe('L628 bords — import de code cité par un test scellé', () => {
  it("un import sans clause (side-effect) d'un fichier cité liste le test", () => {
    expect(sealedAtRisk(repoWith("import '../src/x.js';\n"), DIR, 'L628', ['src/x.ts']).map((s) => s.via)).toEqual(['src/x.ts']);
  });
  it('un import multi-ligne liste le test', () => {
    expect(sealedAtRisk(repoWith("import {\n  a,\n  b,\n} from\n  '../src/x.js';\n"), DIR, 'L628', ['src/x.ts']).map((s) => s.via)).toEqual(['src/x.ts']);
  });
  it('un test listé deux fois dans fichiers de l\'acceptation n\'est listé qu\'une fois', () => {
    const r = sealedAtRisk(repoWith("import { x } from '../src/x.js';\n", ['test/a.test.ts', './test/a.test.ts']), DIR, 'L628', ['src/x.ts']);
    expect(r).toHaveLength(1);
  });
  it('un import « type » est lu', () => {
    expect(sealedAtRisk(repoWith("import type { X } from '../src/x.js';\n"), DIR, 'L628', ['src/x.ts']).length).toBe(1);
  });
});
