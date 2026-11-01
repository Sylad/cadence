import { describe, expect, it } from 'vitest';
import { testDurationMs, timeoutLimits } from '../src/orchestrate/baseline.js';
import { redAlone, replayRed } from '../src/orchestrate/workers.js';
import { noteTight } from '../src/orchestrate/gate-notes.js';
import { renderTestsSansCode, testsSansCode } from '../src/corrections-sans-code.js';

const T = 'test/a.test.ts > plan';

describe('L510 probe — testDurationMs', () => {
  it('le nom « plan » ne prend pas la durée du test voisin « plan-data »', () => {
    const out = ' ✓ test/a.test.ts > plan-data 25012ms\n ✓ test/a.test.ts > plan 3ms\n';
    expect(testDurationMs(out, T, 'test/a.test.ts')).toBe(3);
  });
  it('durée décimale en secondes et millisecondes arrondies', () => {
    expect(testDurationMs(' ✓ a.test.ts > t 1.5s\n', 'a.test.ts > t', 'a.test.ts')).toBe(1500);
    expect(testDurationMs('', 'a.test.ts > t', 'a.test.ts')).toBeNull();
  });
  it('sortie avec séquences ANSI : la durée se lit encore', () => {
    expect(testDurationMs(' \u001b[32m✓\u001b[39m a.test.ts > t \u001b[2m25012ms\u001b[22m\n', 'a.test.ts > t', 'a.test.ts')).toBe(25012);
  });
  it('nom vide ou séparateur seul : pas d\'exception', () => {
    expect(() => testDurationMs(' ✓ a.test.ts 5s\n', '', 'a.test.ts')).not.toThrow();
    expect(() => testDurationMs(' ✓ a.test.ts 5s\n', ' > ', 'a.test.ts')).not.toThrow();
  });
  it('la durée d\'un test échoué du rejeu n\'est pas confondue avec un nom de fichier en « s »', () => {
    // un titre finissant par un nombre + s sans être une durée
    expect(testDurationMs(' ✓ a.test.ts > gère 3 cas 2s\n', 'a.test.ts > gère 3 cas', 'a.test.ts')).toBe(2000);
  });
});

describe('L510 probe — timeoutLimits', () => {
  it('deux tests expirés : chacun son délai', () => {
    const o = ' FAIL  a.test.ts > un\nError: Test timed out in 1000ms.\n FAIL  a.test.ts > deux\nError: Test timed out in 2000ms.\n';
    expect([...timeoutLimits(o)]).toEqual([['a.test.ts > un', 1000], ['a.test.ts > deux', 2000]]);
  });
  it('un échec d\'assertion après un test expiré ne reçoit pas son délai', () => {
    const o = ' FAIL  a.test.ts > un\nError: Test timed out in 1000ms.\n FAIL  a.test.ts > deux\nAssertionError: x\n';
    expect(timeoutLimits(o).has('a.test.ts > deux')).toBe(false);
  });
  it('le résumé « Tests 1 failed » coupe le rattachement', () => {
    const o = ' FAIL  a.test.ts > un\nAssertionError: x\n Tests  1 failed\nError: Test timed out in 1000ms.\n';
    expect(timeoutLimits(o).size).toBe(0);
  });
  it('délai avec séquences ANSI', () => {
    const o = ' \u001b[31mFAIL\u001b[39m  a.test.ts > un\nError: Test timed out in \u001b[1m1000\u001b[22mms.\n';
    // ANSI au milieu du nombre : au moins pas d'exception
    expect(() => timeoutLimits(o)).not.toThrow();
  });
  it('délai majuscule / « in 0ms » : pas de limite nulle retenue pour un faux tight', async () => {
    const o = ' FAIL  a.test.ts > un\nError: Test timed out in 0ms.\n';
    const r = await replayRed(async () => ({ code: 0, output: ' ✓ a.test.ts > un 5ms\n' }), 'v {files}', ['a.test.ts > un'], o);
    expect(r.tight).toEqual([]);
  });
});

describe('L510 probe — replayRed tight', () => {
  const SUITE = ' FAIL  a.test.ts > lent\nError: Test timed out in 30000ms.\n';
  it('même test deux fois dans names : un seul tight', async () => {
    const r = await replayRed(async () => ({ code: 0, output: ' ✓ a.test.ts > lent 29000ms\n' }), 'v {files}', ['a.test.ts > lent', 'a.test.ts > lent'], SUITE);
    expect(r.tight).toHaveLength(1);
  });
  it('durée supérieure au délai (rejeu plus lent) : encore « trop juste »', async () => {
    const r = await replayRed(async () => ({ code: 0, output: ' ✓ a.test.ts > lent 31000ms\n' }), 'v {files}', ['a.test.ts > lent'], SUITE);
    expect(r.tight.map((t) => t.ms)).toEqual([31000]);
  });
  it('names vide : rien', async () => {
    expect(await replayRed(async () => ({ code: 0, output: '' }), 'v {files}', [], SUITE)).toEqual({ red: [], unstable: [], tight: [] });
  });
  it('test jest (nom « Suite › test ») expiré : tight lu sous jest', async () => {
    const suite = 'FAIL src/a.test.ts\n  ● Suite › lent\n\n    thrown: "Exceeded timeout of 5000 ms for a test."\n';
    const r = await replayRed(async () => ({ code: 0, output: 'PASS src/a.test.ts\n  ✓ lent (4500 ms)\n' }), 'jest {files}', ['Suite › lent'], suite);
    expect(r.unstable).toEqual(['Suite › lent']);
    expect(r.tight).toEqual([{ test: 'Suite › lent', ms: 4500, limit: 5000 }]);
  });
});

describe('L510 probe — noteTight', () => {
  const mk = () => {
    const logs: string[] = []; let writes = 0;
    return { logs, get writes() { return writes; }, c: { lot: { project: 'p', lot: 'L1', warnings: [] as string[] }, wave: { log: (s: string) => logs.push(s), store: { writeLot: () => { writes++; } } } } as never };
  };
  it('deux appels avec le même test : une seule entrée, un seul avertissement', () => {
    const m = mk(); const lot = (m.c as { lot: { warnings: string[]; delaisJustes?: unknown[] } }).lot;
    const t = { test: 'a > t', ms: 25012, limit: 30000 };
    noteTight(m.c, [t]); noteTight(m.c, [t, { ...t, ms: 1 }]);
    expect(lot.delaisJustes).toHaveLength(1);
    expect(lot.warnings).toHaveLength(1);
    expect(m.writes).toBe(1);
  });
  it('liste vide : rien d\'écrit', () => {
    const m = mk(); noteTight(m.c, []);
    expect(m.writes).toBe(0);
  });
  it('arrondis : 24950 ms → 25 s, 1500 → 1.5 s, 100 → 0.1 s', () => {
    const m = mk(); const lot = (m.c as { lot: { warnings: string[] } }).lot;
    noteTight(m.c, [{ test: 'x', ms: 24950, limit: 30000 }, { test: 'y', ms: 1500, limit: 1800 }, { test: 'z', ms: 100, limit: 120 }]);
    expect(lot.warnings[0]).toMatch(/x \(25 s seul pour 30 s/);
    expect(lot.warnings[0]).toMatch(/y \(1\.5 s seul pour 1\.8 s/);
    expect(lot.warnings[0]).toMatch(/z \(0\.1 s seul pour 0\.1 s/);
  });
});

describe('L510 probe — redAlone', () => {
  const run = (code: number, out: string) => async () => ({ code, output: out });
  it('même test deux fois dans names : retenu (ou non), jamais deux fois', async () => {
    const r = await redAlone(run(1, ' FAIL  a.test.ts > t\n'), 'v {files}', ['a.test.ts > t', 'a.test.ts > t'], '');
    expect(new Set(r).size).toBe(r.length);
  });
  it('un nom de test à apostrophe est passé protégé à la commande', async () => {
    const cmds: string[] = [];
    await redAlone(async (c) => { cmds.push(c); return { code: 1, output: '' }; }, 'v {files}', ["it's.test.ts > t"], '');
    expect(cmds[0]).toBe("v 'it'\\''s.test.ts'");
  });
  it('un rejeu qui lève : l\'erreur remonte (l\'appelant la rattrape)', async () => {
    await expect(redAlone(async () => { throw new Error('boom'); }, 'v {files}', ['a.test.ts > t'], '')).rejects.toThrow('boom');
  });
  it('jest : le test est rejoué par son fichier lu dans la sortie', async () => {
    const cmds: string[] = [];
    const out = 'FAIL src/a.test.ts\n  ● Suite › t\n';
    const r = await redAlone(async (c) => { cmds.push(c); return { code: 1, output: 'FAIL src/a.test.ts\n  ● Suite › t\n' }; }, 'jest {files}', ['Suite › t'], out);
    expect(cmds[0]).toBe('jest src/a.test.ts');
    expect(r).toEqual(['Suite › t']);
  });
  it('« $& » dans le fichier ne se développe pas dans le gabarit', async () => {
    const cmds: string[] = [];
    await redAlone(async (c) => { cmds.push(c); return { code: 1, output: '' }; }, 'v {files}', ['a$&b.test.ts > t'], '');
    expect(cmds[0]).toContain('a$&b.test.ts');
  });
});

describe('L510 probe — testsSansCode', () => {
  const p = (findings: string[], commits: string[]) => ({ key: 'k', project: 'p', lot: 'L', visible: false, findings, commits });
  it('liste vide', () => {
    expect(testsSansCode([])).toEqual({ passes: 0, sansCode: 0 });
  });
  it('rapport : singulier, 100 %, arrondi', () => {
    expect(renderTestsSansCode({ passes: 1, sansCode: 1 })[0]).toBe('1 passe lancée sur des tests, 1 terminée sans changement de code (100 %, passes sans commit).');
    expect(renderTestsSansCode({ passes: 3, sansCode: 1 })[0]).toContain('(33 %');
    expect(renderTestsSansCode({ passes: 3, sansCode: 0 })[0]).toContain('0 terminée sans');
  });
});
