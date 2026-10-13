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
