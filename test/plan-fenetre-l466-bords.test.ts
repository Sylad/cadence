import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { run } from '../src/cli.js';
import { isCalendarDay } from '../src/dates.js';
import { Plan } from '../src/plan.js';
import { normalizeLot } from '../src/plan-read.js';
import { proposeWindows, windowIssues, windowLines } from '../src/plan-window.js';
import { gitRepo, NO_BACKGROUND_GIT } from './helpers.js';

// Sonde L466 — les bords de la fenêtre prévue (planned: from..to), de raf plan et de --propose.
const PLAN = '.cadence/raf.yaml';
const TODAY = '2026-11-02'; // un lundi

async function cad(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T09:00:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function projectRaw(yamlText: string, config = ''): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, PLAN), yamlText);
  if (config) writeFileSync(join(dir, 'cadence.yaml'), config);
  execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const project = (lots: Record<string, unknown>[], config = '') => projectRaw(stringify({ version: 1, project: 'demo', prefix: 'L', since: '2999-12-31', lots }), config);
const lot = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Lot ${id}`, status: 'todo', estimate: 1, ...extra });
const file = (dir: string) => readFileSync(join(dir, PLAN), 'utf8');
const lotsOf = (...raws: Record<string, unknown>[]) => raws.map((r) => normalizeLot(r));

describe('bords — isCalendarDay', () => {
  it.each([['2024-02-29', true], ['2026-02-29', false], ['2026-04-31', false], ['2026-00-10', false], ['2026-12-32', false], ['0000-01-01', true], ['9999-12-31', true], ['2026-1-01', false], [20261102, false], [null, false], [undefined, false]])('isCalendarDay(%s) = %s', (v, ok) => {
    expect(isCalendarDay(v)).toBe(ok);
  });
});

describe('bords — planned: lu dans un vrai fichier à la main', () => {
  it('dates non quotées en bloc YAML, ou en flux : lues comme des jours', () => {
    const dir = projectRaw(`version: 1\nproject: demo\nprefix: L\nsince: 2999-12-31\nlots:\n  - id: L1\n    title: A\n    status: todo\n    estimate: 1\n    planned:\n      from: 2026-11-03\n      to: 2026-11-05\n  - id: L2\n    title: B\n    status: todo\n    estimate: 1\n    planned: { from: 2026-11-04, to: 2026-11-04 }\n`);
    const lots = Plan.load(join(dir, PLAN), {}).lots();
    expect(lots[0]!.planned).toEqual({ from: '2026-11-03', to: '2026-11-05' });
    expect(lots[1]!.planned).toEqual({ from: '2026-11-04', to: '2026-11-04' });
  });
  it('planned: null écrit « planned: » sans valeur : pas de fenêtre, pas de problème', () => {
    const l = normalizeLot({ id: 'L1', planned: null });
    expect(l.planned).toBeUndefined();
    expect(l.problems).toEqual([]);
  });
  it('planned: nombre ou booléen est un problème du lot', () => {
    for (const raw of [5, true, 'x', [] as unknown[]]) {
      const l = normalizeLot({ id: 'L1', planned: raw });
      expect(l.planned).toBeUndefined();
      expect(l.problems.join('\n')).toMatch(/^planned/);
    }
  });
});

describe('bords — raf plan', () => {
  it('poser deux fois la même fenêtre laisse le fichier identique ; --clear sans fenêtre est sans effet', async () => {
    const dir = project([lot('L1', { created: '2026-11-01' })]);
    expect((await cad(dir, 'plan', 'L1', '2026-11-03..2026-11-05')).code).toBe(0);
    const once = file(dir);
    expect((await cad(dir, 'plan', 'L1', '2026-11-03..2026-11-05')).code).toBe(0);
    expect(file(dir)).toBe(once);
    expect(once.match(/planned:/g)).toHaveLength(1);
    expect((await cad(dir, 'plan', 'L1', '--clear')).code).toBe(0);
    const cleared = file(dir);
    expect(cleared).not.toMatch(/planned/);
    const r = await cad(dir, 'plan', 'L1', '--clear');
    expect(r.code).toBe(0);
    expect(file(dir)).toBe(cleared);
  });
  it('un seul jour, avec des espaces, est une fenêtre d\'un jour', async () => {
    const dir = project([lot('L1')]);
    const r = await cad(dir, 'plan', 'L1', ' 2026-11-03 ');
    expect(r.code).toBe(0);
    expect(file(dir)).toMatch(/from: 2026-11-03/);
    expect(file(dir)).toMatch(/to: 2026-11-03/);
  });
  it('une date qui n\'existe pas est refusée, plan intact', async () => {
    const dir = project([lot('L1')]);
    const before = file(dir);
    const r = await cad(dir, 'plan', 'L1', '2026-02-30..2026-03-02');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/AAAA-MM-JJ/);
    expect(file(dir)).toBe(before);
  });
  it('raf plan sans rien : l\'usage', async () => {
    const dir = project([lot('L1')]);
    const r = await cad(dir, 'plan');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/usage/);
  });
  it('la fenêtre se pose sur un lot fini ou abandonné', async () => {
    const dir = project([lot('L1', { status: 'done' }), lot('L2', { status: 'dropped' })]);
    expect((await cad(dir, 'plan', 'L1', '2026-11-03..2026-11-04')).code).toBe(0);
    expect((await cad(dir, 'plan', 'L2', '2026-11-03..2026-11-04')).code).toBe(0);
  });
  it('la clé planned se range avant created et après les autres, même avec after', async () => {
    const dir = project([lot('L0'), lot('L1', { after: ['L0'], created: '2026-11-01' })]);
    await cad(dir, 'plan', 'L1', '2026-11-03..2026-11-05');
    const text = file(dir);
    expect(text.indexOf('planned:')).toBeGreaterThan(text.indexOf('after:'));
    expect(text.indexOf('planned:')).toBeLessThan(text.indexOf('created: 2026-11-01'));
  });
});

describe('bords — --propose', () => {
  it.each([['0.01', 0], ['2', 0], [' 2 ', 0], ['00.5', 0], ['0.005', 1], ['0', 1], ['1e1', 1], ['.5', 1], ['5.', 1], ['Infinity', 1], ['abc', 1], ['', 1]])('--per-day « %s » : code %s', async (v, bad) => {
    const dir = project([lot('L1')]);
    const r = await cad(dir, 'plan', '--propose', `--per-day=${v}`);
    expect(r.code === 0).toBe(bad === 0);
    if (bad) expect(r.err).toMatch(/--per-day invalide/);
  });
  it('--from un dimanche, ou une date impossible', async () => {
    const dir = project([lot('L1')]);
    const r = await cad(dir, 'plan', '--propose', '--from', '2026-11-08');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2026-11-09\.\.2026-11-09/);
    const bad = await cad(dir, 'plan', '--propose', '--from', '2026-02-30');
    expect(bad.code).not.toBe(0);
  });
  it('--apply sans lot à proposer n\'écrit rien et ne commite rien', async () => {
    const dir = project([lot('L1', { status: 'doing' }), lot('L2', { status: 'done' }), lot('L3', { planned: { from: '2026-11-03', to: '2026-11-03' } })]);
    const before = file(dir);
    const r = await cad(dir, 'plan', '--propose', '--apply');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/rien à proposer/);
    expect(file(dir)).toBe(before);
  });
  it('--apply deux fois : la seconde ne propose plus rien', async () => {
    const dir = project([lot('L1'), lot('L2')]);
    expect((await cad(dir, 'plan', '--propose', '--apply')).code).toBe(0);
    const once = file(dir);
    const r = await cad(dir, 'plan', '--propose', '--apply');
    expect(r.out).toMatch(/rien à proposer/);
    expect(file(dir)).toBe(once);
  });
  it('--apply avec un lot sous-lot qui hérite : seul le lot sans fenêtre reçoit la sienne', async () => {
    const dir = project([lot('L1', { planned: { from: '2026-11-03', to: '2026-11-04' } }), lot('L2', { parent: 'L1' }), lot('L3')]);
    const r = await cad(dir, 'plan', '--propose');
    expect(r.out).toMatch(/L3/);
    expect(r.out).not.toMatch(/^L2/m);
  });
});

describe('bords — proposeWindows', () => {
  const from = '2026-11-02';
  it('une estimation de 0 tient en un jour, sans NaN', () => {
    const out = proposeWindows(lotsOf(lot('L1', { estimate: 0 }), lot('L2', { estimate: 0 })), { from, perDay: 1 });
    for (const p of out) expect(p.window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out[0]!.window.to >= out[0]!.window.from).toBe(true);
    expect(out[1]!.window.to >= out[1]!.window.from).toBe(true);
  });
  it('une estimation de 2,5 j couvre trois jours ouvrés, le lot suivant commence dans le dernier', () => {
    const out = proposeWindows(lotsOf(lot('L1', { estimate: 2.5 }), lot('L2', { estimate: 1 })), { from, perDay: 1 });
    expect(out[0]!.window).toEqual({ from: '2026-11-02', to: '2026-11-04' });
    expect(out[1]!.window.from).toBe('2026-11-04');
  });
  it('un lot qui se suit lui-même, ou qui se répète dans after : une fenêtre, pas de boucle', () => {
    const out = proposeWindows(lotsOf(lot('L1', { after: ['L1', 'L1'] })), { from, perDay: 1 });
    expect(out).toHaveLength(1);
  });
  it('un id en double dans le plan ne fait pas boucler', () => {
    const out = proposeWindows(lotsOf(lot('L1'), lot('L1')), { from, perDay: 1 });
    expect(out.length).toBeGreaterThan(0);
  });
  it('une dépendance dont la fenêtre finit un week-end retarde au lundi', () => {
    const out = proposeWindows(lotsOf(lot('L1', { planned: { from: '2026-11-06', to: '2026-11-08' } }), lot('L2', { after: ['L1'] })), { from, perDay: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.window.from).toBe('2026-11-09');
  });
  it('une dépendance dont la fenêtre est héritée de son parent compte', () => {
    const out = proposeWindows(lotsOf(lot('P', { status: 'doing', planned: { from: '2026-11-02', to: '2026-11-06' } }), lot('C', { parent: 'P', status: 'done' }), lot('L2', { after: ['C'] })), { from, perDay: 1 });
    expect(out[0]!.window.from).toBe('2026-11-09');
  });
});

describe('bords — session et check', () => {
  const day = '2026-11-02';
  it('un lot à faire dont tout (début et fin) est passé : en retard, une seule ligne', () => {
    const lines = windowLines(lotsOf(lot('L1', { planned: { from: '2026-10-01', to: '2026-10-05' } })), day);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/en retard de 28 j/);
  });
  it('fin aujourd\'hui, lot à faire commencé avant : « devait démarrer » prime sur l\'échéance', () => {
    const lines = windowLines(lotsOf(lot('L1', { planned: { from: '2026-10-30', to: day } })), day);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/devait démarrer/);
  });
  it('un lot en cours dont la fin est aujourd\'hui : échéance aujourd\'hui', () => {
    const lines = windowLines(lotsOf(lot('L1', { status: 'doing', planned: { from: '2026-10-30', to: day } })), day);
    expect(lines[0]).toMatch(/échéance aujourd'hui/);
  });
  it('les retards les plus longs d\'abord', () => {
    const lines = windowLines(lotsOf(lot('L1', { planned: { from: '2026-10-30', to: '2026-10-31' } }), lot('L2', { planned: { from: '2026-10-01', to: '2026-10-02' } })), day);
    expect(lines[0]).toMatch(/^L2/);
  });
  it('un lot dans une boucle de parents ne fait pas planter windowLines', () => {
    const lines = windowLines(lotsOf(lot('A', { parent: 'B' }), lot('B', { parent: 'A' }), lot('C', { parent: 'C' })), day);
    expect(lines).toEqual([]);
  });
  it('windowIssues : le petit-enfant est jugé sur la fenêtre héritée du grand-parent, bornes comprises', () => {
    const base = [lot('G', { planned: { from: '2026-11-02', to: '2026-11-10' } }), lot('P', { parent: 'G' })];
    expect(windowIssues(lotsOf(...base, lot('C', { parent: 'P', planned: { from: '2026-11-02', to: '2026-11-10' } })))).toEqual([]);
    const out = windowIssues(lotsOf(...base, lot('C', { parent: 'P', planned: { from: '2026-11-02', to: '2026-11-11' } })));
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatch(/G/);
  });
  it('windowIssues : parent sans fenêtre, ou parent inconnu : aucun avertissement', () => {
    expect(windowIssues(lotsOf(lot('P'), lot('C', { parent: 'P', planned: { from: '2026-11-02', to: '2026-11-03' } })))).toEqual([]);
    expect(windowIssues(lotsOf(lot('C', { parent: 'ZZ', planned: { from: '2026-11-02', to: '2026-11-03' } })))).toEqual([]);
  });
});

describe('bords — plan.requirePlanned', () => {
  const cfg = 'plan:\n  requirePlanned: true\n';
  it('--under un parent inconnu est refusé, plan intact', async () => {
    const dir = project([lot('L1')], cfg);
    const before = file(dir);
    const r = await cad(dir, 'add', 'x', '--id', 'AB-1.1', '--under', 'AB-9');
    expect(r.code).not.toBe(0);
    expect(file(dir)).toBe(before);
  });
  it('--planned vide est refusé avec la forme attendue', async () => {
    const dir = project([lot('L1')], cfg);
    const r = await cad(dir, 'add', 'x', '--planned', '');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/AAAA-MM-JJ/);
  });
  it('--planned à l\'envers est refusé même sans requirePlanned', async () => {
    const dir = project([lot('L1')]);
    const r = await cad(dir, 'add', 'x', '--planned', '2026-11-05..2026-11-03');
    expect(r.code).not.toBe(0);
  });
  it('requirePlanned: null (clé vide) n\'exige rien', async () => {
    const dir = project([lot('L1')], 'plan:\n  requirePlanned:\n');
    expect((await cad(dir, 'add', 'x')).code).toBe(0);
  });
  it('--planned avec --every : le récurrent porte la fenêtre sans refus', async () => {
    const dir = project([lot('L1')], cfg);
    const r = await cad(dir, 'add', 'x', '--every', '7');
    expect(r.code).toBe(0);
  });
});
