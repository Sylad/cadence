import { afterEach, describe, expect, it } from 'vitest';
import { briefFor } from '../src/orchestrate/cycle/brief.js';
import type { Constat } from '../src/orchestrate/state.js';
import { harness } from './orchestrate-harness.js';
import { cleanupTempDirs } from './helpers.js';

// L664 : la passe de fix ordinaire reçoit les mineurs ouverts de la dernière revue de code et les traite ; sans cela la revue suivante les relit et les compte.

afterEach(cleanupTempDirs);

const major: Constat = { source: 'code', gravite: 'majeur', fichier: 'src/a.ts', ligne: 3, texte: 'majeur A' };
const minor = (n: number): Constat => ({ source: 'code', gravite: 'mineur', fichier: `src/m${n}.ts`, ligne: n, texte: `mineur ${n}` });

function fixBrief(constats: Constat[], codeConstats: Constat[], flags: { minorFix?: boolean; docsFix?: boolean } = {}): string {
  const h = harness();
  const c = h.lot('L1', {}, { test: 'true' });
  Object.assign(c.lot, { constats, codeConstats, ...flags });
  try {
    return briefFor(c, 'fix');
  } finally {
    h.store.removeTmpDir(c.lot.project, c.lot.lot);
  }
}

describe('L664 — le brief fix liste les mineurs ouverts', () => {
  it('R1 — les mineurs de la dernière revue de code sont listés à côté des constats bloquants, avec la consigne de les traiter', () => {
    const brief = fixBrief([major], [major, minor(1), minor(2)]);
    expect(brief).toContain('Open minor findings');
    expect(brief).toContain('src/m1.ts:1 — mineur 1');
    expect(brief).toContain('src/m2.ts:2 — mineur 2');
    expect(brief).toContain('"choix"');
  });
  it('R2 — sans mineur ouvert, le brief ne porte pas la section', () => {
    expect(fixBrief([major], [major])).not.toContain('Open minor findings');
    expect(fixBrief([major], [])).not.toContain('Open minor findings');
  });
  it('R3 — un mineur déjà dans les constats à corriger n’est pas listé deux fois', () => {
    const brief = fixBrief([major, minor(1)], [major, minor(1), minor(2)]);
    expect(brief.split('mineur 1').length - 1).toBe(1);
    expect(brief).toContain('mineur 2');
  });
  it('R4 — la passe des mineurs et la passe docs gardent leur périmètre : pas de section en plus', () => {
    expect(fixBrief([minor(1)], [minor(1), minor(2)], { minorFix: true })).not.toContain('Open minor findings');
    expect(fixBrief([major], [minor(2)], { docsFix: true })).not.toContain('Open minor findings');
  });
});
