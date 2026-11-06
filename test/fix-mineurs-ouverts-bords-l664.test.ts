import { describe, expect, it } from 'vitest';
import { fixConstatsText } from '../src/orchestrate/constat-classes.js';
import type { Constat } from '../src/orchestrate/state.js';

// L664 (bords) : les mineurs ouverts du brief de fix ne se redisent pas et n'altèrent ni les autres gabarits ni l'absence de données.

const major: Constat = { source: 'code', gravite: 'majeur', fichier: 'src/a.ts', ligne: 3, texte: 'majeur A' };
const minor = (n: number, extra: Partial<Constat> = {}): Constat => ({ source: 'code', gravite: 'mineur', fichier: `src/m${n}.ts`, ligne: n, texte: `mineur ${n}`, ...extra });
const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe('L664 — bords des mineurs ouverts', () => {
  it('B1 — un mineur présent deux fois dans codeConstats n’est listé qu’une fois', () => {
    expect(count(fixConstatsText([major], 'fix', [major, minor(1), minor(1)]), 'mineur 1')).toBe(1);
  });
  it('B3 — gabarits fix-docs et fix-minors : liste plate, aucune section de mineurs ouverts', () => {
    for (const t of ['fix-docs', 'fix-minors']) expect(fixConstatsText([major], t, [minor(1)])).not.toContain('Open minor');
  });
  it('B4 — mineur sans fichier ni ligne : listé, une seule fois même répété dans les constats', () => {
    const sans = minor(1, { fichier: undefined, ligne: undefined });
    const t = fixConstatsText([major, sans], 'fix', [sans, minor(2)]);
    expect(count(t, 'mineur 1')).toBe(1);
    expect(t).toContain('mineur 2');
  });
  it('B5 — même texte mais fichiers différents : les deux mineurs restent distincts', () => {
    const t = fixConstatsText([minor(1, { texte: 'x' })], 'fix', [minor(1, { texte: 'x' }), minor(2, { texte: 'x' })]);
    expect(t).toContain('src/m2.ts');
  });
  it('B7 — les constats classés (groupés par classe) reçoivent aussi la section, après la consigne de classe', () => {
    const t = fixConstatsText([{ ...major, classe: 'bug-code' }], 'fix', [major, minor(2)]);
    expect(t).toContain('Class « bug-code »');
    expect(t.indexOf('Open minor')).toBeGreaterThan(t.indexOf('every other instance'));
  });
});
