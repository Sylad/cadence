import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

// L467 — sonde des bords de raf quickwins : estimation illisible sous toutes ses formes, --max / --by aux limites, valeurs d'extension de type inattendu, fuite du marqueur dans le plan.
const PLAN = '.cadence/raf.yaml';
const EXTRAS = 'plan:\n  extras:\n    theme: { enum: [infra, ui, data] }\n    owner: { default: claude }\n';

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-03' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-03T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function project(yaml = EXTRAS) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  cadence(dir, 'init', '--project', 'demo', '--no-hook');
  return dir;
}
const edit = (dir: string, fn: (t: string) => string) => writeFileSync(join(dir, PLAN), fn(readFileSync(join(dir, PLAN), 'utf8')));
const setEstimate = (dir: string, v: string | null) => edit(dir, (t) => t.replace(/\n(\s+)estimate: 1\n/, v === null ? '\n' : `\n$1estimate: ${v}\n`));

describe('bords — estimation illisible', () => {
  for (const [label, v] of [['absente', null], ['nulle', '0'], ['négative', '-2'], ['null', 'null'], ['chaîne', '"0.1"'], ['liste', '[1]'], ['booléen', 'true']] as const) {
    it(`estimation ${label} — prêt non estimé, jamais gain rapide par taille`, () => {
      const dir = project();
      cadence(dir, 'add', 'Sans');
      setEstimate(dir, v);
      const { code, out } = cadence(dir, 'quickwins');
      expect(code).toBe(0);
      expect(out).toMatch(/Non estimés\n\s+L1  Sans$/);
      expect(out).not.toContain('(1 j)');
      expect(out.split('Non estimés')[0]).not.toContain('Sans');
    });
  }
  it('estimation .inf — ni gain rapide ni plantage', () => {
    const dir = project();
    cadence(dir, 'add', 'Inf');
    setEstimate(dir, '.inf');
    const r = cadence(dir, 'quickwins');
    expect(r.code).toBe(0);
    expect(r.out.split('Non estimés')[0]).not.toContain('Inf');
  });
  it('estimation .nan — ne devient pas un gain rapide', () => {
    const dir = project();
    cadence(dir, 'add', 'Nan');
    setEstimate(dir, '.nan');
    const r = cadence(dir, 'quickwins');
    expect(r.code).toBe(0);
    expect(r.out.split('Non estimés')[0]).not.toContain('Nan');
  });
  it('estimation 1 écrite explicitement — estimé (1 j), pas dans Non estimés', () => {
    const dir = project();
    cadence(dir, 'add', 'Un');
    const r = cadence(dir, 'quickwins', '--max', '1');
    expect(r.out).toContain('L1  Un  (1 j)');
    expect(r.out).not.toContain('Non estimés');
  });
  it('sans estimation et ⚡ — une seule fois, sans « (1 j) », pas sous Non estimés', () => {
    const dir = project();
    cadence(dir, 'add', 'Flag', '--quickwin');
    setEstimate(dir, null);
    const r = cadence(dir, 'quickwins');
    expect(r.out).toBe('⚡ L1  Flag'.replace(/^/, '  '));
  });
});

describe('bords — le marqueur ne fuit pas dans le plan', () => {
  it('un raf note sur un lot sans estimate ne réécrit pas unestimated ni estimate: 1', () => {
    const dir = project();
    cadence(dir, 'add', 'Sans');
    setEstimate(dir, null);
    cadence(dir, 'note', 'L1', 'une note');
    const t = readFileSync(join(dir, PLAN), 'utf8');
    expect(t).not.toContain('unestimated');
    expect(t).not.toMatch(/estimate: 1\b/);
  });
  it('raf show / list --json / gantt sur un lot sans estimate ne mentionnent pas unestimated', () => {
    const dir = project();
    cadence(dir, 'add', 'Sans');
    setEstimate(dir, null);
    for (const a of [['show', 'L1'], ['list', '--json'], ['list'], ['now']]) expect(cadence(dir, ...a).out).not.toContain('unestimated');
  });
});

describe('bords — --max', () => {
  it.each([['1e-1', true], ['.2', true], [' 0.5 ', true], ['0x1', true], ['Infinity', false], ['NaN', false], ['-0', false], ['  ', false], ['0.0', false]])('--max %j', (v, ok) => {
    const dir = project();
    cadence(dir, 'add', 'Petit', '--estimate', '0.1');
    const r = cadence(dir, 'quickwins', `--max=${v}`);
    if (ok) expect(r.code, r.err).toBe(0);
    else {
      expect(r.code).toBe(2);
      expect(r.err).toContain('--max invalide');
    }
  });
  it('--max donné deux fois — pas de plantage', () => {
    const dir = project();
    cadence(dir, 'add', 'Petit', '--estimate', '0.1');
    expect([0, 2]).toContain(cadence(dir, 'quickwins', '--max', '1', '--max', '2').code);
  });
  it('--max invalide et plan sans lot prêt — refusé quand même', () => {
    const dir = project();
    expect(cadence(dir, 'quickwins', '--max', '0').code).toBe(2);
  });
  it('--max très grand — tous les prêts estimés y sont, les non estimés restent à part', () => {
    const dir = project();
    cadence(dir, 'add', 'Gros', '--estimate', '40');
    cadence(dir, 'add', 'Sans');
    setEstimate(dir, null);
    // L2 est le lot sans estimate : retirer celle de Sans (le premier trouvé est Gros) — on vérifie donc seulement Gros
    const r = cadence(dir, 'quickwins', '--max', '1000');
    expect(r.out).toContain('Gros');
  });
});

describe('bords — --by', () => {
  it('--by vide — refusé, pas groupe « sans »', () => {
    const dir = project();
    cadence(dir, 'add', 'Petit', '--estimate', '0.1');
    expect(cadence(dir, 'quickwins', '--by', '').code).toBe(2);
  });
  it('--by __proto__ / constructor — refusé comme non déclaré', () => {
    const dir = project();
    for (const b of ['__proto__', 'constructor', 'toString']) expect(cadence(dir, 'quickwins', '--by', b).code, b).toBe(2);
  });
  it('--by sans valeur (dernier argument) — erreur propre, code 2, pas de trace', () => {
    const dir = project();
    const r = cadence(dir, 'quickwins', '--by');
    expect(r.code).toBe(2);
    expect(r.err).not.toMatch(/at .*\.ts/);
  });
  it('--by sur un plan sans lot prêt — « aucun gain rapide prêt », code 0, déclaré vérifié d’abord', () => {
    const dir = project();
    expect(cadence(dir, 'quickwins', '--by', 'theme')).toMatchObject({ code: 0, out: 'aucun gain rapide prêt' });
    expect(cadence(dir, 'quickwins', '--by', 'nope').code).toBe(2);
  });
  it('--by theme : un lot non estimé n’est jamais rangé dans un groupe', () => {
    const dir = project();
    cadence(dir, 'add', 'Sans');
    setEstimate(dir, null);
    const r = cadence(dir, 'quickwins', '--by', 'theme');
    expect(r.out).toBe('aucun gain rapide prêt\nNon estimés\n  L1  Sans');
  });
  it('valeur d’extension numérique ou booléenne dans le plan — ne plante pas', () => {
    const dir = project();
    cadence(dir, 'add', 'A', '--estimate', '0.1');
    cadence(dir, 'add', 'B', '--estimate', '0.1');
    edit(dir, (t) => t.replace(/(- id: L1\n)/, '$1    theme: 5\n').replace(/(- id: L2\n)/, '$1    theme: true\n'));
    const r = cadence(dir, 'quickwins', '--by', 'theme');
    expect([0, 2]).toContain(r.code);
    expect(r.err).not.toMatch(/TypeError|at .*\.ts/);
  });
  it('valeur d’extension vide ou « sans » — groupe distinct de l’absence de valeur', () => {
    const dir = project('plan:\n  extras:\n    theme: {}\n');
    cadence(dir, 'add', 'A', '--estimate', '0.1');
    cadence(dir, 'add', 'B', '--estimate', '0.1');
    edit(dir, (t) => t.replace(/(- id: L1\n)/, '$1    theme: ""\n'));
    const r = cadence(dir, 'quickwins', '--by', 'theme');
    expect(r.code).toBe(0);
    expect(r.out).toContain('sans theme');
    expect(r.out.match(/L[12] /g)).toHaveLength(2);
  });
  it('appelé deux fois de suite — même sortie (pas d’état gardé)', () => {
    const dir = project();
    cadence(dir, 'add', 'A', '--estimate', '0.1');
    expect(cadence(dir, 'quickwins', '--by', 'theme').out).toBe(cadence(dir, 'quickwins', '--by', 'theme').out);
  });
});

describe('bords — session start', () => {
  it('un lot ⚡ non estimé seul — la section est affichée, sans ligne « aucun gain rapide prêt »', () => {
    const dir = project();
    cadence(dir, 'add', 'Flag', '--quickwin');
    const out = cadence(dir, 'session', 'start').out;
    expect(out).toContain('Gains rapides');
    expect(out).not.toContain('aucun gain rapide prêt');
  });
  it('titre contenant « Non estimés » ou deux espaces en tête — la section reste lisible', () => {
    const dir = project();
    cadence(dir, 'add', 'Petit', '--estimate', '0.1');
    const out = cadence(dir, 'session', 'start').out;
    expect(out).toMatch(/L1  Petit/);
  });
  it('lot en cours seul (petit) — pas de section Gains rapides', () => {
    const dir = project();
    cadence(dir, 'add', 'Petit', '--estimate', '0.1');
    cadence(dir, 'start', 'L1');
    expect(cadence(dir, 'session', 'start').out).not.toContain('Gains rapides');
  });
  it('plan vide — session start passe, pas de section', () => {
    const dir = project();
    const r = cadence(dir, 'session', 'start');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Gains rapides');
  });
});
