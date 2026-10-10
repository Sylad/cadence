import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error gabarit .mjs livré tel quel, sans déclaration de types
import { acceptationIgnored, acceptationOnly } from '../templates/acceptation-runner.mjs';
import { tempDir } from './helpers.js';

// L173 (spec etape-spec, S5) : le gabarit que la config du lanceur de tests du projet importe (exclusion de config.test et de la CI, config dédiée).
function projet(): string {
  const root = tempDir();
  for (const [ecran, vert, fichiers] of [['a', false, ['test/a.acceptation.test.ts']], ['b', true, ['test/b.acceptation.test.ts']], ['c', false, ['test/c1.test.ts', 'test/c2.test.ts']]] as const) {
    mkdirSync(join(root, 'docs/specs', ecran), { recursive: true });
    writeFileSync(join(root, 'docs/specs', ecran, 'acceptation.json'), JSON.stringify({ lot: ecran, fiche: 'f', fichiers, vert }));
  }
  mkdirSync(join(root, 'docs/specs/sans'), { recursive: true });
  writeFileSync(join(root, 'docs/specs/illisible.json'), '{');
  return root;
}

describe('gabarit acceptation-runner.mjs', () => {
  it('exclut les fichiers des acceptation.json à vert: false, pas ceux d’un lot vert', () => {
    expect(acceptationIgnored(projet())).toEqual(['test/a.acceptation.test.ts', 'test/c1.test.ts', 'test/c2.test.ts']);
  });

  it('format regex pour testPathIgnorePatterns (jest)', () => {
    const r = acceptationIgnored(projet(), 'docs/specs', 'regex') as string[];
    expect(r[0]).toBe('test/a\\.acceptation\\.test\\.ts$');
    expect(new RegExp(r[0]).test('/x/test/a.acceptation.test.ts')).toBe(true);
  });

  it('un dossier de specs absent exclut rien', () => {
    expect(acceptationIgnored(tempDir())).toEqual([]);
  });

  it('la config dédiée n’inclut que les fichiers de l’acceptation.json donné', () => {
    const root = projet();
    expect(acceptationOnly(join(root, 'docs/specs/c/acceptation.json'))).toEqual(['test/c1.test.ts', 'test/c2.test.ts']);
  });

  it('sans CADENCE_ACCEPTATION ni chemin, la config dédiée échoue haut et clair (elle ne lancerait rien)', () => {
    expect(() => acceptationOnly(undefined)).toThrow(/CADENCE_ACCEPTATION/);
  });
});
