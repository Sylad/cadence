import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error gabarit .mjs livré tel quel, sans déclaration de types
import { acceptationE2e, acceptationIgnored, acceptationOnly } from '../templates/acceptation-runner.mjs';
import { tempDir } from './helpers.js';
import { parseAcceptation, acceptText } from '../src/orchestrate/accept.js';

// L173 (spec etape-spec, S5) : le gabarit que la config du lanceur de tests du projet importe (exclusion de config.test et de la CI, config dédiée).
function projet(): string {
  const root = tempDir();
  for (const [ecran, vert, fichiers] of [['a', false, ['test/a.acceptation.test.ts']], ['b', true, ['test/b.acceptation.test.ts']], ['c', false, ['test/c1.test.ts', 'test/c2.test.ts']]] as const) {
    mkdirSync(join(root, 'docs/specs', ecran), { recursive: true });
    writeFileSync(join(root, 'docs/specs', ecran, `acceptation-${ecran}.json`), JSON.stringify({ lot: ecran, fiche: 'f', fichiers, vert }));
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

  it('plusieurs acceptations sur un même écran (un fichier par lot) : chacune compte, l’ancien acceptation.json aussi', () => {
    const root = projet();
    const d = join(root, 'docs/specs/a');
    writeFileSync(join(d, 'acceptation-L2.json'), JSON.stringify({ lot: 'L2', fiche: 'f', fichiers: ['test/a2.test.ts'], vert: false }));
    writeFileSync(join(d, 'acceptation.json'), JSON.stringify({ lot: 'L0', fiche: 'f', fichiers: ['test/a0.test.ts'], vert: false }));
    writeFileSync(join(d, 'notes.json'), JSON.stringify({ fichiers: ['test/pas-un-lot.test.ts'], vert: false }));
    expect(acceptationIgnored(root)).toEqual(['test/a2.test.ts', 'test/a.acceptation.test.ts', 'test/a0.test.ts', 'test/c1.test.ts', 'test/c2.test.ts']);
  });

  it('un dossier de specs absent exclut rien', () => {
    expect(acceptationIgnored(tempDir())).toEqual([]);
  });

  it('la config dédiée n’inclut que les fichiers de l’acceptation.json donné', () => {
    const root = projet();
    expect(acceptationOnly(join(root, 'docs/specs/c/acceptation-c.json'))).toEqual(['test/c1.test.ts', 'test/c2.test.ts']);
  });

  it('sans CADENCE_ACCEPTATION ni chemin, la config dédiée échoue haut et clair (elle ne lancerait rien)', () => {
    expect(() => acceptationOnly(undefined)).toThrow(/CADENCE_ACCEPTATION/);
  });

  // L203 : une acceptation e2e (navigateur, build requis) ne rejoint jamais le lanceur ordinaire, même à vert: true.
  function projetE2e(vert: boolean): string {
    const root = tempDir();
    mkdirSync(join(root, 'docs/specs/e'), { recursive: true });
    writeFileSync(join(root, 'docs/specs/e/acceptation-e.json'), JSON.stringify({ lot: 'e', fiche: 'f', fichiers: ['e2e/e.spec.ts'], vert, e2e: true }));
    writeFileSync(join(root, 'docs/specs/e/acceptation-u.json'), JSON.stringify({ lot: 'u', fiche: 'f', fichiers: ['test/u.test.ts'], vert: true }));
    return root;
  }

  it('une acceptation e2e à vert: true reste hors du lanceur ordinaire (sans dist ni Chromium, il serait rouge)', () => {
    expect(acceptationIgnored(projetE2e(true))).toEqual(['e2e/e.spec.ts']);
    expect(acceptationIgnored(projetE2e(false))).toEqual(['e2e/e.spec.ts']);
  });

  it('acceptationE2e() liste les fichiers e2e, verts ou rouges, pour la suite e2e lancée après le build', () => {
    expect(acceptationE2e(projetE2e(true))).toEqual(['e2e/e.spec.ts']);
    expect(acceptationE2e(projet())).toEqual([]);
  });

  it('le programme lit la clé e2e et le brief accept demande de la poser', () => {
    const a = parseAcceptation(JSON.stringify({ lot: 'e', fiche: 'f', fichiers: ['x'], vert: false, e2e: true }));
    expect(a).toMatchObject({ e2e: true });
    expect(parseAcceptation(JSON.stringify({ lot: 'e', fiche: 'f', fichiers: ['x'], vert: false }))).not.toHaveProperty('e2e');
    expect(acceptText({ fiche: 'f', maquette: 'm', acceptation: 'a.json', command: 'vt' })).toMatch(/"e2e": true/);
  });
});
