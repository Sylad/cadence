import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

// L467 — raf quickwins : les lots prêts de petite estimation, groupés par un champ d'extension (plan.extras), avec les non estimés ; lu par session start.
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

describe('R1 — quels lots sont des gains rapides', () => {
  it('R1 — un lot prêt de 0,25 j y est, 0,26 j non, un lot ⚡ gros y est', () => {
    const dir = project();
    cadence(dir, 'add', 'Petit', '--estimate', '0.25');
    cadence(dir, 'add', 'Moyen', '--estimate', '0.26');
    cadence(dir, 'add', 'Drapeau', '--estimate', '3', '--quickwin');
    const { code, out } = cadence(dir, 'quickwins');
    expect(code).toBe(0);
    expect(out).toContain('L1  Petit');
    expect(out).not.toContain('Moyen');
    expect(out).toContain('⚡ L3  Drapeau');
  });
  it('R1 — --max change le seuil ; une valeur nulle, négative ou non numérique est refusée', () => {
    const dir = project();
    cadence(dir, 'add', 'Moyen', '--estimate', '0.5');
    expect(cadence(dir, 'quickwins').out).not.toContain('Moyen');
    expect(cadence(dir, 'quickwins', '--max', '0.5').out).toContain('L1  Moyen');
    for (const bad of ['0', '-1', 'abc', '']) {
      const r = cadence(dir, 'quickwins', '--max', bad);
      expect(r.code, bad).toBe(2);
      expect(r.err).toContain('--max');
    }
  });
  it('R1 — un lot bloqué par un after ouvert, en cours, terminé ou récurrent n’y est pas ; livré, la dépendance le libère', () => {
    const dir = project();
    cadence(dir, 'add', 'Base', '--estimate', '0.1');
    cadence(dir, 'add', 'Après', '--estimate', '0.1', '--after', 'L1');
    cadence(dir, 'add', 'Récurrent', '--estimate', '0.1', '--every', '7');
    cadence(dir, 'add', 'En cours', '--estimate', '0.1');
    cadence(dir, 'start', 'L4');
    let out = cadence(dir, 'quickwins').out;
    expect(out).toContain('L1  Base');
    expect(out).not.toMatch(/L2 |Récurrent|En cours/);
    edit(dir, (t) => t.replace(/(- id: L1\n\s+title: Base\n\s+status: )todo/, '$1done'));
    out = cadence(dir, 'quickwins').out;
    expect(out).not.toContain('Base');
    expect(out).toContain('L2  Après');
  });
  it('R1 — rien de prêt : le dit, code 0', () => {
    const r = cadence(project(), 'quickwins');
    expect(r.code).toBe(0);
    expect(r.out).toContain('aucun gain rapide prêt');
  });
});

describe('R2 — groupés par un champ d’extension', () => {
  it('R2 — --by theme : un groupe par valeur, trié, « sans theme » à la fin ; la valeur par défaut compte', () => {
    const dir = project();
    cadence(dir, 'add', 'A', '--estimate', '0.1', '--set', 'theme=ui');
    cadence(dir, 'add', 'B', '--estimate', '0.1');
    cadence(dir, 'add', 'C', '--estimate', '0.1', '--set', 'theme=data');
    cadence(dir, 'add', 'D', '--estimate', '0.1', '--set', 'theme=ui');
    const { out } = cadence(dir, 'quickwins', '--by', 'theme');
    const at = (s: string) => out.indexOf(s);
    expect(at('theme : data')).toBeGreaterThan(-1);
    expect(at('theme : data')).toBeLessThan(at('theme : ui'));
    expect(at('theme : ui')).toBeLessThan(at('sans theme'));
    expect(out).toMatch(/theme : ui\n\s+L1  A.*\n\s+L4  D/);
    expect(out).toMatch(/sans theme\n\s+L2  B/);
    const byOwner = cadence(dir, 'quickwins', '--by', 'owner').out;
    expect(byOwner).toMatch(/owner : claude\n\s+L1  A.*\n\s+L2  B.*\n\s+L3  C.*\n\s+L4  D/);
    expect(byOwner).not.toContain('sans owner');
  });
  it('R2 — un champ non déclaré est refusé en listant les déclarés ; sans plan.extras, le dit', () => {
    const dir = project();
    const r = cadence(dir, 'quickwins', '--by', 'couleur');
    expect(r.code).toBe(2);
    expect(r.err).toContain('couleur : champ d\'extension non déclaré (theme, owner)');
    const bare = project('plan: {}\n');
    const r2 = cadence(bare, 'quickwins', '--by', 'theme');
    expect(r2.code).toBe(2);
    expect(r2.err).toContain('aucun champ d\'extension déclaré');
  });
  it('R2 — sans --by, une seule liste', () => {
    const dir = project();
    cadence(dir, 'add', 'A', '--estimate', '0.1', '--set', 'theme=ui');
    const { out } = cadence(dir, 'quickwins');
    expect(out).not.toContain('theme :');
    expect(out).toContain('L1  A');
  });
});

describe('R3 — les non estimés', () => {
  it('R3 — un lot prêt sans estimate est listé à part, jamais comme gain rapide ; ⚡ sans estimate reste un gain rapide', () => {
    const dir = project();
    cadence(dir, 'add', 'Sans', '--estimate', '1');
    cadence(dir, 'add', 'Flag', '--quickwin');
    cadence(dir, 'add', 'Bloqué', '--after', 'L1');
    edit(dir, (t) => t.replace(/\n\s+estimate: 1\n(\s+quickwin: true\n)?/g, (m, q) => `\n${q ?? ''}`));
    const { out } = cadence(dir, 'quickwins');
    expect(out).toMatch(/Non estimés\n\s+L1  Sans/);
    expect(out).not.toMatch(/Non estimés[\s\S]*(Flag|Bloqué)/);
    expect(out).toContain('⚡ L2  Flag');
    expect(out.split('Non estimés')[0]).not.toContain('L1  Sans');
  });
  it('R3 — l’absence d’estimation n’apparaît pas dans raf list --json', () => {
    const dir = project();
    cadence(dir, 'add', 'Sans');
    edit(dir, (t) => t.replace(/\n\s+estimate: 1\n/, '\n'));
    const lot = JSON.parse(cadence(dir, 'list', '--json').out)[0];
    expect(Object.keys(lot)).not.toContain('unestimated');
  });
});

describe('R4 — lu par session start', () => {
  it('R4 — la section « Gains rapides » liste les gains rapides prêts et les non estimés ; absente sans eux', async () => {
    const dir = project();
    expect(cadence(dir, 'session', 'start').out).not.toContain('Gains rapides');
    cadence(dir, 'add', 'Petit', '--estimate', '0.1');
    cadence(dir, 'add', 'Gros', '--estimate', '2');
    const out = cadence(dir, 'session', 'start').out;
    expect(out).toMatch(/Gains rapides[^\n]*\n\s+L1  Petit/);
    expect(out.split('Gains rapides')[1].split('\n\n')[0]).not.toContain('Gros');
  });
  it('R4 — un prêt sans estimation y figure sous « Non estimés »', () => {
    const dir = project();
    cadence(dir, 'add', 'Sans');
    edit(dir, (t) => t.replace(/\n\s+estimate: 1\n/, '\n'));
    const out = cadence(dir, 'session', 'start').out;
    expect(out).toMatch(/Gains rapides[^\n]*\n\s+Non estimés\n\s+L1  Sans/);
  });
});
