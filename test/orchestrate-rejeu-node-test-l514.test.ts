import { describe, expect, it } from 'vitest';
import { failedTests, nodeTestFiles, nodeTestRan } from '../src/orchestrate/baseline.js';
import { redAlone, replayRed } from '../src/orchestrate/workers.js';

const red = (n: number, title: string, loc: string | null, indent = ''): string =>
  [`${indent}not ok ${n} - ${title}`, `${indent}  ---`, `${indent}  duration_ms: 1.5`, `${indent}  type: 'test'`, ...(loc ? [`${indent}  location: '${loc}'`] : []), `${indent}  failureType: 'testCodeFailure'`, `${indent}  ...`].join('\n');
const green = (n: number, title: string, suffix = ''): string => `ok ${n} - ${title}${suffix}\n  ---\n  duration_ms: 0.3\n  type: 'test'\n  ...`;

const SUITE = `TAP version 13\n# Subtest: rouge un\n${red(1, 'rouge un', '/w/scripts/a.test.mjs:2:1')}\n# Subtest: vert un\n${green(2, 'vert un')}\n# Subtest: rouge deux\n${red(3, 'rouge deux', '/w/scripts/b.test.mjs:9:3')}\n1..3\n# fail 2\n`;
const run = (output: string, code = 0) => async () => ({ code, output });
const GREEN_AFTER = 'TAP version 13\n# Subtest: rouge un\nok 1 - rouge un\n  ---\n  duration_ms: 1\n  ...\n1..1\n# pass 1\n';

describe('L514 — node --test nomme un test par son titre : le fichier se lit dans « location: » du bloc YAML de l\'échec', () => {
  it('L514 — nodeTestFiles rattache chaque titre rouge au fichier de son location:, sans ligne:colonne, et ignore les verts', () => {
    expect([...nodeTestFiles(SUITE)]).toEqual([['rouge un', '/w/scripts/a.test.mjs'], ['rouge deux', '/w/scripts/b.test.mjs']]);
  });
  it('L514 — un test imbriqué (sortie indentée) est lu, et le titre garde ses espaces internes', () => {
    const out = `TAP version 13\n# Subtest: suite\n    # Subtest: le cas : un\n${red(1, 'le cas : un', '/w/a.test.mjs:5:5', '    ')}\n${red(1, 'suite', '/w/a.test.mjs:3:1')}\n`;
    expect([...nodeTestFiles(out)]).toEqual([['le cas : un', '/w/a.test.mjs'], ['suite', '/w/a.test.mjs']]);
  });
  it('L514 — un rouge sans location: (Node ancien) n\'a pas de fichier, et le location: d\'un test suivant ne lui est pas prêté', () => {
    const out = `${red(1, 'sans', null)}\n${green(2, 'vert')}\n  location: '/w/z.test.mjs:1:1'\n`;
    expect(nodeTestFiles(out).size).toBe(0);
  });
  it('L514 — un titre rouge dans deux fichiers différents est ambigu : aucun fichier (jamais de faux vert)', () => {
    const out = `${red(1, 'même titre', '/w/a.test.mjs:2:1')}\n${red(2, 'même titre', '/w/b.test.mjs:2:1')}\n`;
    expect(nodeTestFiles(out).has('même titre')).toBe(false);
  });
  it('L514 — le même titre deux fois dans le même fichier garde son fichier', () => {
    const out = `${red(1, 'deux fois', '/w/a.test.mjs:2:1')}\n${red(2, 'deux fois', '/w/a.test.mjs:8:1')}\n`;
    expect(nodeTestFiles(out).get('deux fois')).toBe('/w/a.test.mjs');
  });
  it('L514 — sans changer failedTests : les titres restent les noms rouges, et vitest/jest/pytest ne donnent aucun fichier node', () => {
    expect(failedTests(SUITE)).toEqual(['rouge deux', 'rouge un']);
    expect(nodeTestFiles(' FAIL  test/a.test.ts > suite > cas\n FAILED tests/t.py::test_x - assert\n  ● Suite › test\n').size).toBe(0);
    expect(nodeTestFiles('').size).toBe(0);
  });
  it('L514 — nodeTestRan : « ok N - titre » exact seulement, ni skip, ni todo, ni « not ok », ni titre voisin', () => {
    expect(nodeTestRan(GREEN_AFTER, 'rouge un')).toBe(true);
    expect(nodeTestRan('    ok 4 - rouge un\n', 'rouge un')).toBe(true);
    expect(nodeTestRan('ok 1 - rouge un # SKIP\n', 'rouge un')).toBe(false);
    expect(nodeTestRan('ok 1 - rouge un # TODO\n', 'rouge un')).toBe(false);
    expect(nodeTestRan('not ok 1 - rouge un\n', 'rouge un')).toBe(false);
    expect(nodeTestRan('ok 1 - rouge un de plus\n', 'rouge un')).toBe(false);
    expect(nodeTestRan('', 'rouge un')).toBe(false);
  });
});

describe('L514 — replayRed et redAlone rejouent un test node --test par son fichier et prouvent son exécution sans fichier imprimé', () => {
  it('L514 — vert seul : sortie sans aucun fichier, mais « ok N - titre » : instable, et un seul rejeu avec les deux fichiers', async () => {
    const cmds: string[] = [];
    const r = await replayRed(async (c) => { cmds.push(c); return { code: 0, output: 'ok 1 - rouge un\nok 2 - rouge deux\n' }; }, 'node --test {files}', ['rouge un', 'rouge deux'], SUITE);
    expect(r).toEqual({ red: [], unstable: ['rouge un', 'rouge deux'], tight: [] });
    expect(cmds).toEqual(['node --test /w/scripts/a.test.mjs /w/scripts/b.test.mjs']);
  });
  it('L514 — le rejeu sort en 0 sans exécuter le titre (aucun test, titre sauté) : le test reste rouge', async () => {
    for (const out of ['TAP version 13\n1..0\n# tests 0\n', 'ok 1 - rouge un # SKIP\n']) {
      const r = await replayRed(run(out), 'node --test {files}', ['rouge un'], SUITE);
      expect(r.red).toEqual(['rouge un']);
      expect(r.unstable).toEqual([]);
    }
  });
  it('L514 — un rejeu en échec (même avec « ok - titre » d\'un voisin) ne prouve rien : rouge, et deux rejeux au plus', async () => {
    let n = 0;
    const r = await replayRed(async () => { n++; return { code: 1, output: `${red(1, 'rouge un', '/w/scripts/a.test.mjs:2:1')}\n` }; }, 'node --test {files}', ['rouge un'], SUITE);
    expect(r.red).toEqual(['rouge un']);
    expect(n).toBe(2);
  });
  it('L514 — rouge sans location: : jamais rejoué (rien à rejouer seul), toujours compté', async () => {
    let n = 0;
    const r = await replayRed(async () => { n++; return { code: 0, output: 'ok 1 - sans\n' }; }, 'node --test {files}', ['sans'], `${red(1, 'sans', null)}\n`);
    expect(r.red).toEqual(['sans']);
    expect(n).toBe(0);
  });
  it('L514 — un autre lanceur n\'est pas touché : le titre à la vitest se rejoue comme avant (fichier du nom, ligne ✓)', async () => {
    const r = await replayRed(run(' ✓ test/a.test.ts > cas 5ms\n'), 'vitest {files}', ['test/a.test.ts > cas'], ' FAIL  test/a.test.ts > cas\n');
    expect(r.unstable).toEqual(['test/a.test.ts > cas']);
  });
  it('L514 — redAlone : un titre node rouge seul aux deux rejeux est « déjà rouge », vert à l\'un il ne l\'est pas', async () => {
    const files: string[] = [];
    const failing = async (c: string) => { files.push(c); return { code: 1, output: `${red(1, 'rouge un', '/w/scripts/a.test.mjs:2:1')}\n` }; };
    expect(await redAlone(failing, 'node --test {files}', ['rouge un'], SUITE)).toEqual(['rouge un']);
    expect(files[0]).toBe('node --test /w/scripts/a.test.mjs');
    expect(await redAlone(run(GREEN_AFTER), 'node --test {files}', ['rouge un'], SUITE)).toEqual([]);
  });
});
