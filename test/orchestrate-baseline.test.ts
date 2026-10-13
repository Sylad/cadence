import { describe, expect, it } from 'vitest';
import { compareBaseline, failedTests, hasUnnamedFailure } from '../src/orchestrate/baseline.js';

describe('failedTests : les tests en échec lus dans la sortie du lanceur', () => {
  it('vitest : une ligne FAIL par test, durées et couleurs écartées', () => {
    const out = [
      '\u001b[31m FAIL \u001b[39m test/a.test.ts > suite > cas un 12ms',
      ' ✓ test/a.test.ts > suite > cas deux',
      ' FAIL  test/b.test.ts > autre > cas trois',
      ' Test Files  2 failed (2)',
    ].join('\n');
    expect(failedTests(out)).toEqual(['test/a.test.ts > suite > cas un', 'test/b.test.ts > autre > cas trois']);
  });

  it('pytest, go, TAP, jest', () => {
    const out = ['FAILED tests/test_x.py::test_a - AssertionError: 1 != 2', '--- FAIL: TestB (0.01s)', 'not ok 3 - cas c', '  ● suite › cas d'].join('\n');
    expect(failedTests(out)).toEqual(['TestB', 'cas c', 'suite › cas d', 'tests/test_x.py::test_a']);
  });

  it('pytest : le message d\'un assert simple ou variable n\'entre pas dans le nom', () => {
    const a = failedTests('FAILED test_x.py::test_a - assert 1 == 2\nFAILED test_x.py::test_b - assert /tmp/pytest-3/x == 0x7f1\nFAILED t.py::test_c[a - b] - assert 0\nERROR t.py::test_d - fixture \'x\' not found');
    const b = failedTests('FAILED test_x.py::test_a - assert 3 == 4\nFAILED test_x.py::test_b - assert /tmp/pytest-9/x == 0x7f9\nFAILED t.py::test_c[a - b]\nERROR t.py::test_d');
    expect(a).toEqual(['t.py::test_c[a - b]', 't.py::test_d', 'test_x.py::test_a', 'test_x.py::test_b']);
    expect(b).toEqual(a);
  });

  it('sans doublon, trié, vide quand rien n\'est identifiable', () => {
    expect(failedTests(' FAIL  b\n FAIL  a\n FAIL  b')).toEqual(['a', 'b']);
    expect(failedTests('boom\nexit 3')).toEqual([]);
  });
});

describe('compareBaseline', () => {
  it('sépare les échecs nouveaux de ceux déjà présents au départ', () => {
    expect(compareBaseline(['a', 'b', 'c'], ['a', 'c', 'z'])).toEqual({ nouveaux: ['b'], existants: ['a', 'c'] });
    expect(compareBaseline(['a'], ['a'])).toEqual({ nouveaux: [], existants: ['a'] });
  });
});

describe('hasUnnamedFailure : jest « Test suite failed to run »', () => {
  it('un fichier de spec qui ne se charge plus est un échec sans nom, même si son FAIL existait au départ', () => {
    const now = ' FAIL  src/db.spec.ts\n  ● Test suite failed to run\n\n    Cannot find module';
    expect(hasUnnamedFailure(now)).toBe(true);
    expect(hasUnnamedFailure(' FAIL  src/db.spec.ts (5.2 s)\n  ● Repo › reads timescale')).toBe(false);
  });
});

describe('hasUnnamedFailure : vitest, fichier de test qui ne se charge pas', () => {
  // Sortie réelle de vitest 2.1.9 (a.test.ts importe un module absent, b.test.ts a un test rouge).
  const real = [
    ' RUN  v2.1.9 /tmp/x',
    '',
    ' ❯ a.test.ts (0 test)',
    ' ❯ b.test.ts (1 test | 1 failed) 5ms',
    '   × suite > name 4ms',
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  a.test.ts [ a.test.ts ]',
    'Error: Failed to load url ./missing.js (resolved id: ./missing.js) in /tmp/x/a.test.ts. Does the file exist?',
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  b.test.ts > suite > name',
    'AssertionError: expected 1 to be 2 // Object.is equality',
    '',
    ' Test Files  2 failed (2)',
    '      Tests  1 failed (1)',
  ].join('\n');

  it('un fichier qui échoue au chargement est un échec sans nom, jamais excusé par la ligne de base', () => {
    expect(hasUnnamedFailure(real)).toBe(true);
    // Comparée à elle-même, la sortie ne doit pas passer pour « que des échecs existants ».
    const names = failedTests(real);
    expect(compareBaseline(names, names).nouveaux).toEqual([]);
  });

  it('le fichier en échec de chargement n\'est pas lu comme un test nommé', () => {
    expect(failedTests(real)).toEqual(['b.test.ts > suite > name']);
  });

  it('un test vitest en échec ordinaire reste un test nommé, sans échec sans nom', () => {
    const ok = ' FAIL  b.test.ts > suite > name\nAssertionError: expected 1 to be 2\n Test Files  1 failed (1)';
    expect(failedTests(ok)).toEqual(['b.test.ts > suite > name']);
    expect(hasUnnamedFailure(ok)).toBe(false);
  });
});

describe('hasUnnamedFailure : vitest, chemin entre crochets différent du nom du fichier', () => {
  // vitest 2.1.9, espace de travail dont le projet a pour racine un sous-dossier : le fichier est relatif au projet, les crochets à la racine du lancement.
  const workspace = ' FAIL  |pa|  src/a.test.ts [ packages/a/src/a.test.ts ]';

  it('espace de travail : le fichier qui ne se charge pas est un échec sans nom, pas un test nommé', () => {
    expect(hasUnnamedFailure(workspace)).toBe(true);
    expect(failedTests(workspace)).toEqual([]);
  });

  it('chemin avec des espaces', () => {
    const spaced = ' FAIL  my dir/a.test.ts [ my dir/a.test.ts ]';
    expect(hasUnnamedFailure(spaced)).toBe(true);
    expect(failedTests(spaced)).toEqual([]);
  });

  it.each([
    [' FAIL  b.test.ts > suite > name', ['b.test.ts > suite > name']],
    [' FAIL  b.test.ts > x [ b.test.ts ]', ['b.test.ts > x [ b.test.ts ]']],
    [' FAIL  src/db.spec.ts (5.2 s)', ['src/db.spec.ts']],
    ['FAIL\tgithub.com/x/y [build failed]', ['github.com/x/y [build failed]']],
    ['FAILED tests/t.py::test_a[ x ] - assert 1', ['tests/t.py::test_a[ x ]']],
    ['not ok 1 - a [ a ]', ['a [ a ]']],
  ])('ligne qui n\'est pas un fichier non chargé : %j', (line, names) => {
    expect(hasUnnamedFailure(line)).toBe(false);
    expect(failedTests(line)).toEqual(names);
  });
});
