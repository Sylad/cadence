import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { configSet } from '../src/config-set.js';
import { Plan } from '../src/plan.js';
import { normalizeLot } from '../src/plan-read.js';
import { parseWindow, proposeWindows, windowIssues, windowOf } from '../src/plan-window.js';
import { schedule } from '../src/schedule.js';
import { ganttData } from '../src/gantt.js';
import { gitRepo, NO_BACKGROUND_GIT, tempDir } from './helpers.js';

// L466 — plans riches : fenêtre prévue (planned: from..to), raf plan, --propose / --apply, plan.requirePlanned (M4).
const PLAN = '.cadence/raf.yaml';
const TODAY = '2026-11-02'; // un lundi

async function cad(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T09:00:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt avec un plan natif écrit à la main (lots donnés tels quels) et le cadence.yaml donné. */
function project(lots: Record<string, unknown>[], config = ''): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, PLAN), stringify({ version: 1, project: 'demo', prefix: 'L', since: '2999-12-31', lots }));
  if (config) writeFileSync(join(dir, 'cadence.yaml'), config);
  execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const lot = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Lot ${id}`, status: 'todo', estimate: 1, ...extra });
const file = (dir: string) => readFileSync(join(dir, PLAN), 'utf8');
const planOf = (dir: string, config = 'cadence.yaml') => Plan.load(join(dir, PLAN), readPlanConfig(join(dir, config), dir)?.settings ?? {});
const normal = (raw: Record<string, unknown>) => normalizeLot({ id: 'L1', ...raw });
const W = (from: string, to: string) => ({ from, to });
const lotsOf = (...raws: Record<string, unknown>[]) => raws.map(normal);

describe('R1 — la fenêtre « J1..J2 » se lit', () => {
  it('R1 — deux jours, ou un seul (la fenêtre d\'un jour), espaces autour tolérés', () => {
    expect(parseWindow('2026-11-03..2026-11-05')).toEqual(W('2026-11-03', '2026-11-05'));
    expect(parseWindow(' 2026-11-03 ')).toEqual(W('2026-11-03', '2026-11-03'));
  });
  it.each(['', '..', '2026-11-03..', '..2026-11-03', '2026-11-05..2026-11-03', '2026-11-03..2026-11-04..2026-11-05', 'demain', '2026-02-30', '2026-13-01..2026-13-02', '2026-11-03...2026-11-05'])(
    'R1 — « %s » est refusé en nommant la forme attendue',
    (text) => {
      expect(() => parseWindow(text)).toThrow(/AAAA-MM-JJ/);
    },
  );
});

describe('R2 — planned: se lit dans le fichier du plan', () => {
  it('R2 — la clé bien formée est lue ; absente, le lot n\'a pas de fenêtre', () => {
    const l = normal({ planned: { from: '2026-11-03', to: '2026-11-05' } });
    expect(l.planned).toEqual(W('2026-11-03', '2026-11-05'));
    expect(l.problems).toEqual([]);
    expect(normal({}).planned).toBeUndefined();
    expect(normal({ planned: null }).planned).toBeUndefined();
  });
  it.each([
    ['une chaîne', '2026-11-03..2026-11-05'],
    ['une liste', ['2026-11-03', '2026-11-05']],
    ['sans fin', { from: '2026-11-03' }],
    ['sans début', { to: '2026-11-03' }],
    ['vide', {}],
    ['une date fausse', { from: '2026-02-30', to: '2026-03-02' }],
    ['non datée', { from: 'lundi', to: 'mardi' }],
    ['à l\'envers', { from: '2026-11-05', to: '2026-11-03' }],
    ['avec une clé en trop', { from: '2026-11-03', to: '2026-11-05', by: 'x' }],
  ])('R2 — planned: %s est un problème du lot, jamais une fenêtre', (_name, raw) => {
    const l = normal({ planned: raw });
    expect(l.planned).toBeUndefined();
    expect(l.problems.join('\n')).toMatch(/^planned/);
  });
});

describe('R3 — le sous-lot hérite de la fenêtre de son parent', () => {
  const lots = lotsOf(
    { id: 'P', planned: W('2026-11-03', '2026-11-10') },
    { id: 'C', parent: 'P' },
    { id: 'G', parent: 'C' },
    { id: 'O', parent: 'P', planned: W('2026-11-04', '2026-11-05') },
    { id: 'N', parent: 'ABSENT' },
    { id: 'X', parent: 'Y' },
    { id: 'Y', parent: 'X' },
  );
  const of = (id: string) => windowOf(lots, lots.find((l) => l.id === id)!);
  it('R3 — la fenêtre propre l\'emporte ; sinon celle du parent, de toute profondeur, avec le lot dont elle vient', () => {
    expect(of('P')).toEqual({ window: W('2026-11-03', '2026-11-10') });
    expect(of('O')).toEqual({ window: W('2026-11-04', '2026-11-05') });
    expect(of('C')).toEqual({ window: W('2026-11-03', '2026-11-10'), from: 'P' });
    expect(of('G')).toEqual({ window: W('2026-11-03', '2026-11-10'), from: 'P' });
  });
  it('R3 — parent inconnu, parent sans fenêtre, parents en boucle : pas de fenêtre, et pas de boucle infinie', () => {
    expect(of('N')).toBeUndefined();
    expect(of('X')).toBeUndefined();
    expect(of('Y')).toBeUndefined();
  });
});

describe('R4 — raf plan <lot> J1..J2 pose, remplace ou retire la fenêtre', () => {
  it('R4 — pose la clé planned en une ligne, la remplace, la retire avec --clear', async () => {
    const dir = project([lot('L1', { created: '2026-10-01' })]);
    const set = await cad(dir, 'plan', 'L1', '2026-11-03..2026-11-05');
    expect(set.code).toBe(0);
    expect(file(dir)).toMatch(/planned: \{ from: 2026-11-03, to: 2026-11-05 \}/);
    expect(planOf(dir).lot('L1').planned).toEqual(W('2026-11-03', '2026-11-05'));
    await cad(dir, 'plan', 'L1', '2026-11-09');
    expect(file(dir).match(/planned:/g)).toHaveLength(1);
    expect(planOf(dir).lot('L1').planned).toEqual(W('2026-11-09', '2026-11-09'));
    expect(file(dir).indexOf('planned:')).toBeLessThan(file(dir).indexOf('created:'));
    expect((await cad(dir, 'plan', 'L1', '--clear')).code).toBe(0);
    expect(file(dir)).not.toContain('planned');
    expect((await cad(dir, 'plan', 'L1', '--clear')).code).toBe(0); // retirer ce qui n'y est pas : rien à faire
  });
  it('R4 — refuse, plan intact : lot inconnu, sous-tâche, fenêtre fausse, ni fenêtre ni --clear, les deux, argument en trop', async () => {
    const dir = project([lot('L1', { tasks: [{ id: 't1', title: 'x', status: 'todo' }] })]);
    const before = file(dir);
    for (const [args, re] of [
      [['L9', '2026-11-03'], /lot inconnu/],
      [['L1/t1', '2026-11-03'], /sous-tâche/],
      [['L1', '2026-11-05..2026-11-03'], /AAAA-MM-JJ/],
      [['L1'], /usage/],
      [['L1', '2026-11-03', '--clear'], /--clear/],
      [['L1', '2026-11-03', '2026-11-04'], /usage/],
      [[], /usage/],
    ] as [string[], RegExp][]) {
      const r = await cad(dir, 'plan', ...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(re);
    }
    expect(file(dir)).toBe(before);
  });
  it('R4 — un lot archivé garde sa fenêtre dans son fichier d\'archive', async () => {
    const dir = project([lot('L1', { status: 'done', finished: '2026-10-05' }), lot('L2')]);
    expect((await cad(dir, 'archive')).code).toBe(0);
    expect((await cad(dir, 'plan', 'L1', '2026-10-01..2026-10-05')).code).toBe(0);
    expect(planOf(dir).lot('L1').planned).toEqual(W('2026-10-01', '2026-10-05'));
    expect(file(dir)).not.toContain('planned');
  });
  it('R4 — un plan tenu par un autre outil (lecture seule) est refusé', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'taches.yaml'), stringify({ taches: [{ id: 'T1', titre: 'x', etat: 'a faire' }] }));
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: taches.yaml\n  lots: taches\n  fields: { title: [titre], status: [etat] }\n  statuses: { done: [fait], doing: [en cours], todo: [a faire] }\n');
    const r = await cad(dir, 'plan', 'T1', '2026-11-03');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/lecture seule/);
  });
});

describe('R4 — raf plan --propose : sous-lots sans fenêtre', () => {
  it('R4 — un sous-lot sans fenêtre dont le parent est à placer hérite de lui : pas de fenêtre propre qui sorte de celle du parent', () => {
    const lots = [lot('AB-1'), lot('AB-1.1', { parent: 'AB-1' }), lot('AB-1.2', { parent: 'AB-1' })].map((l) => normalizeLot(l));
    const out = proposeWindows(lots, { from: '2026-11-02', perDay: 1 });
    expect(out.map((p) => p.id)).toEqual(['AB-1']);
    expect(windowIssues(lots.map((l) => (l.id === 'AB-1' ? { ...l, planned: out[0]!.window } : l)))).toEqual([]);
  });
});

describe('R5 — plan.requirePlanned : raf add exige une fenêtre', () => {
  const REQUIRE = 'plan:\n  requirePlanned: true\n';
  it('R5 — sans la clé, ou à false, raf add n\'exige rien', async () => {
    for (const config of ['', 'plan:\n  requirePlanned: false\n']) {
      const dir = project([], config);
      expect((await cad(dir, 'add', 'Sans fenêtre')).code).toBe(0);
    }
  });
  it('R5 — avec la clé, raf add sans fenêtre est refusé et n\'écrit rien ; avec --planned, la fenêtre est posée', async () => {
    const dir = project([], REQUIRE);
    const refused = await cad(dir, 'add', 'Nu');
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/requirePlanned.*--planned/);
    expect(file(dir)).not.toContain('Nu');
    const ok = await cad(dir, 'add', 'Daté', '--planned', '2026-11-03..2026-11-04');
    expect(ok.code).toBe(0);
    expect(planOf(dir).lot(ok.out.trim()).planned).toEqual(W('2026-11-03', '2026-11-04'));
  });
  it('R5 — un sous-lot (--under) d\'un parent planifié hérite : accepté sans --planned ; sous un parent sans fenêtre, refusé', async () => {
    const dir = project([lot('L1', { planned: W('2026-11-03', '2026-11-06') }), lot('L2')], `${REQUIRE}  idPattern: 'AB-\\d+'\n`);
    expect((await cad(dir, 'add', 'Fils', '--id', 'AB-1', '--under', 'L1')).code).toBe(0);
    const refused = await cad(dir, 'add', 'Fils', '--id', 'AB-2', '--under', 'L2');
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/requirePlanned/);
  });
  it('R5 — le contrôle est celui de raf add : config set et les lots ouverts par le programme ne sont pas refusés', () => {
    const dir = project([lot('L1', { planned: W('2026-11-03', '2026-11-04') })], REQUIRE);
    const r = configSet(dir, 'orchestrate.test', 'npm test', { depth: 0 }, TODAY);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).not.toMatch(/requirePlanned : une fenêtre/);
    expect(r.lines.join('\n')).toMatch(/✓/);
    const plan = Plan.load(join(dir, PLAN), { requirePlanned: true });
    expect(() => plan.add('Article', TODAY, { estimate: 0.5 })).not.toThrow();
  });
  it('R5 — un lot récurrent (--every) ne se planifie pas : exempté', async () => {
    const dir = project([], REQUIRE);
    expect((await cad(dir, 'add', 'Ménage', '--every', '7')).code).toBe(0);
  });
  it('R5 — --planned est une fenêtre valide ou un refus ; jamais sur une sous-tâche (--parent)', async () => {
    const dir = project([lot('L1')]);
    expect((await cad(dir, 'add', 'x', '--planned', '2026-11-05..2026-11-03')).err).toMatch(/AAAA-MM-JJ/);
    const sub = await cad(dir, 'add', 'x', '--parent', 'L1', '--planned', '2026-11-03');
    expect(sub.code).toBe(2);
    expect(sub.err).toMatch(/sous-tâche/);
  });
  it('R5 — la clé doit être un booléen, et ne va pas avec un plan tenu par un autre outil', () => {
    const read = (yaml: string) => () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'cadence.yaml'), yaml);
      return readPlanConfig(join(dir, 'cadence.yaml'), dir);
    };
    expect(read(REQUIRE)()?.settings.requirePlanned).toBe(true);
    expect(read('plan:\n  requirePlanned: oui\n')).toThrow(/plan\.requirePlanned/);
    expect(read('plan:\n  requirePlanned: 1\n')).toThrow(/plan\.requirePlanned/);
    expect(read('plan:\n  requirePlanned: true\n  lots: taches\n')).toThrow(/plan\.requirePlanned.*autre outil/);
  });
  it('R5 — plan.extras ne peut pas prendre le nom planned (clé de raf)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  extras:\n    planned: {}\n');
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'), dir)).toThrow(/planned/);
  });
});

describe('R6 — proposeWindows : jours ouvrés, prêts d\'abord', () => {
  const propose = (lots: ReturnType<typeof lotsOf>, opts: { from?: string; perDay?: number } = {}) =>
    Object.fromEntries(proposeWindows(lots, { from: opts.from ?? TODAY, perDay: opts.perDay ?? 1 }).map((p) => [p.id, [p.window.from, p.window.to]]));
  it('R6 — rien à proposer : plan vide, tous planifiés', () => {
    expect(propose([])).toEqual({});
    expect(propose(lotsOf({ id: 'A', planned: W('2026-11-03', '2026-11-03') }))).toEqual({});
  });
  it('R6 — les lots à faire se suivent dans l\'ordre du plan, en jours ouvrés (le week-end saute)', () => {
    expect(propose(lotsOf({ id: 'A', estimate: 4 }, { id: 'B', estimate: 2 }))).toEqual({ A: ['2026-11-02', '2026-11-05'], B: ['2026-11-06', '2026-11-09'] });
  });
  it('R6 — --from un samedi commence le lundi ; un lot d\'un jour tient en une journée', () => {
    expect(propose(lotsOf({ id: 'A' }), { from: '2026-11-07' })).toEqual({ A: ['2026-11-09', '2026-11-09'] });
  });
  it('R6 — n\'écrit rien pour : un lot déjà daté, un sous-lot qui hérite, un lot en cours, fini, abandonné, récurrent', () => {
    const lots = lotsOf(
      { id: 'P', planned: W('2026-11-03', '2026-11-04') },
      { id: 'C', parent: 'P' },
      { id: 'D', status: 'doing' },
      { id: 'F', status: 'done' },
      { id: 'X', status: 'dropped' },
      { id: 'R', every: 7 },
      { id: 'T' },
    );
    expect(Object.keys(propose(lots))).toEqual(['T']);
  });
  it('R6 — un lot prêt passe avant un lot qui attend un lot encore à placer (même déclaré avant lui)', () => {
    expect(propose(lotsOf({ id: 'A', after: ['B'] }, { id: 'B' }))).toEqual({ B: ['2026-11-02', '2026-11-02'], A: ['2026-11-03', '2026-11-03'] });
  });
  it('R6 — après un lot déjà daté : pas avant le lendemain de sa fin ; après un lot fini ou inconnu : libre', () => {
    const lots = lotsOf({ id: 'F', status: 'done' }, { id: 'B', after: ['F', 'INCONNU'] }, { id: 'D', planned: W('2026-11-03', '2026-11-05') }, { id: 'A', after: ['D'] });
    expect(propose(lots)).toEqual({ A: ['2026-11-06', '2026-11-06'], B: ['2026-11-02', '2026-11-02'] });
  });
  it('R6 — une dépendance déjà passée au regard de --from ne retarde pas', () => {
    expect(propose(lotsOf({ id: 'D', planned: W('2026-10-01', '2026-10-02') }, { id: 'A', after: ['D'] }))).toEqual({ A: ['2026-11-02', '2026-11-02'] });
  });
  it('R6 — dépendances circulaires : le plan est tout de même rendu, sans boucle', () => {
    expect(Object.keys(propose(lotsOf({ id: 'A', after: ['B'] }, { id: 'B', after: ['A'] })))).toEqual(['A', 'B']);
  });
  it('R6 — --per-day : 2 jours de travail par jour ouvré font tenir deux lots d\'un jour dans la même journée ; 0.5 double la durée', () => {
    expect(propose(lotsOf({ id: 'A' }, { id: 'B' }, { id: 'C' }), { perDay: 2 })).toEqual({ A: ['2026-11-02', '2026-11-02'], B: ['2026-11-02', '2026-11-02'], C: ['2026-11-03', '2026-11-03'] });
    expect(propose(lotsOf({ id: 'A' }), { perDay: 0.5 })).toEqual({ A: ['2026-11-02', '2026-11-03'] });
  });
  it('R6 — des demi-journées s\'additionnent sans dérive de virgule flottante (10 lots de 0,1 j = 1 j)', () => {
    const tenth = Array.from({ length: 11 }, (_, i) => ({ id: `T${i}`, estimate: 0.1 }));
    const w = propose(lotsOf(...tenth));
    expect(w.T9).toEqual(['2026-11-02', '2026-11-02']);
    expect(w.T10).toEqual(['2026-11-03', '2026-11-03']);
  });
});

describe('R7 — raf plan --propose [--per-day n] [--from J], puis --apply', () => {
  const lots = () => [lot('L1', { estimate: 2 }), lot('L2'), lot('L3', { planned: W('2026-11-03', '2026-11-03') })];
  it('R7 — --propose liste les fenêtres et n\'écrit rien', async () => {
    const dir = project(lots());
    const before = file(dir);
    const r = await cad(dir, 'plan', '--propose');
    expect(r.code).toBe(0);
    expect(r.out).toContain('L1  2026-11-02..2026-11-03');
    expect(r.out).toContain('L2  2026-11-04..2026-11-04');
    expect(r.out).not.toContain('L3');
    expect(r.out).toMatch(/2 lot\(s\) proposé\(s\).*--apply/);
    expect(file(dir)).toBe(before);
  });
  it('R7 — --apply écrit toutes les fenêtres d\'un coup, dit la commande du commit unique ; le rejouer ne propose plus rien', async () => {
    const dir = project(lots());
    const r = await cad(dir, 'plan', '--propose', '--apply');
    expect(r.code).toBe(0);
    expect(planOf(dir).lot('L1').planned).toEqual(W('2026-11-02', '2026-11-03'));
    expect(planOf(dir).lot('L2').planned).toEqual(W('2026-11-04', '2026-11-04'));
    expect(planOf(dir).lot('L3').planned).toEqual(W('2026-11-03', '2026-11-03')); // intact
    expect(r.out).toMatch(/git add -- \.cadence\/raf\.yaml && git commit -m 'plan: L1 2 fenêtre\(s\) prévue\(s\) posée\(s\)'/);
    const again = await cad(dir, 'plan', '--propose', '--apply');
    expect(again.out).toContain('rien à proposer');
    expect(again.out).not.toContain('git commit');
  });
  it('R7 — --from et --per-day sont lus', async () => {
    const dir = project([lot('L1'), lot('L2')]);
    const r = await cad(dir, 'plan', '--propose', '--from', '2026-11-09', '--per-day', '2');
    expect(r.out).toContain('L1  2026-11-09..2026-11-09');
    expect(r.out).toContain('L2  2026-11-09..2026-11-09');
  });
  it('R7 — refusés : --apply sans --propose, --from/--per-day sans --propose, --per-day faux, --from faux, un lot avec --propose', async () => {
    const dir = project(lots());
    const before = file(dir);
    for (const [args, re] of [
      [['L1', '--apply'], /--propose/],
      [['L1', '2026-11-03', '--from', '2026-11-03'], /--propose/],
      [['L1', '2026-11-03', '--per-day', '2'], /--propose/],
      [['--propose', '--per-day', '0'], /--per-day/],
      [['--propose', '--per-day', '0.001'], /--per-day/], // 1 j de travail ferait 1000 jours ouvrés : refusé plutôt que de calculer longtemps
      [['--propose', '--per-day', '-1'], /--per-day/],
      [['--propose', '--per-day', 'beaucoup'], /--per-day/],
      [['--propose', '--per-day', 'Infinity'], /--per-day/],
      [['--propose', '--from', 'demain'], /--from/],
      [['--propose', '--from', '2026-02-30'], /--from/],
      [['--propose', 'L1'], /usage/],
      [['--propose', '--clear'], /usage/],
    ] as [string[], RegExp][]) {
      const r = await cad(dir, 'plan', ...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(re);
    }
    expect(file(dir)).toBe(before);
  });
  it('R7 — sur un plan en lecture seule, --apply est refusé sans rien écrire (--propose seul se lit)', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'taches.yaml'), stringify({ taches: [{ id: 'T1', titre: 'x', etat: 'a faire' }] }));
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: taches.yaml\n  lots: taches\n  fields: { title: [titre], status: [etat] }\n  statuses: { done: [fait], doing: [en cours], todo: [a faire] }\n');
    expect((await cad(dir, 'plan', '--propose', '--apply')).err).toMatch(/lecture seule/);
    expect((await cad(dir, 'plan', '--propose')).code).toBe(0);
  });
});

describe('R8 — raf show, raf list --json et raf check lisent la fenêtre', () => {
  it('R8 — show dit la fenêtre, et le lot dont un sous-lot l\'hérite ; list --json la garde sous la clé du fichier', async () => {
    const dir = project([lot('L1', { planned: W('2026-11-03', '2026-11-05') }), lot('AB-1', { parent: 'L1' })], "plan:\n  idPattern: 'AB-\\d+'\n");
    expect((await cad(dir, 'show', 'L1')).out).toContain('prévu : 2026-11-03..2026-11-05');
    expect((await cad(dir, 'show', 'AB-1')).out).toContain('prévu : 2026-11-03..2026-11-05 (hérité de L1)');
    const json = JSON.parse((await cad(dir, 'list', '--json')).out) as { id: string; planned?: unknown }[];
    expect(json.find((l) => l.id === 'L1')?.planned).toEqual(W('2026-11-03', '2026-11-05'));
    expect(json.find((l) => l.id === 'AB-1')?.planned).toBeUndefined();
  });
  it('R8 — un lot sans fenêtre n\'imprime pas de ligne « prévu »', async () => {
    const dir = project([lot('L1')]);
    expect((await cad(dir, 'show', 'L1')).out).not.toContain('prévu');
  });
  it('R8 — check : planned mal formé est un écart (code 1) ; un sous-lot hors de la fenêtre du parent est un avertissement (code 0)', async () => {
    const bad = project([lot('L1', { planned: { from: '2026-11-05', to: '2026-11-03' } })]);
    const r = await cad(bad, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ L1 : planned/);
    const out = project(
      [lot('L1', { planned: W('2026-11-03', '2026-11-05') }), lot('AB-1', { parent: 'L1', planned: W('2026-11-04', '2026-11-09') }), lot('AB-2', { parent: 'L1', planned: W('2026-11-03', '2026-11-05') }), lot('AB-3', { parent: 'L2', planned: W('2026-11-03', '2026-11-05') }), lot('L2')],
      "plan:\n  idPattern: 'AB-\\d+'\n",
    );
    const w = await cad(out, 'check');
    expect(w.code).toBe(0);
    expect(w.out).toContain('⚠ AB-1 : fenêtre prévue 2026-11-04..2026-11-09 hors de celle de L1 (2026-11-03..2026-11-05)');
    expect(w.out).not.toContain('AB-2 :');
    expect(w.out).not.toContain('AB-3 :');
  });
});

describe('R9 — session start lit les retards et les échéances', () => {
  const start = async (lots: Record<string, unknown>[]) => (await cad(project(lots), 'session', 'start', '--since', '2026-10-01')).out;
  it('R9 — un lot ouvert dont la fin est passée est en retard (jours comptés) ; un lot à faire dont le début est passé « devait démarrer »', async () => {
    const out = await start([lot('L1', { planned: W('2026-10-26', '2026-10-30') }), lot('L2', { planned: W('2026-10-28', '2026-11-06') }), lot('L3', { status: 'doing', started: '2026-10-20', planned: W('2026-10-20', '2026-10-30') })]);
    expect(out).toContain('Fenêtres prévues');
    expect(out).toContain('L1  Lot L1 — en retard de 3 j (prévu jusqu\'au 2026-10-30)');
    expect(out).toContain('L3  Lot L3 — en retard de 3 j (prévu jusqu\'au 2026-10-30)');
    expect(out).toContain('L2  Lot L2 — devait démarrer le 2026-10-28');
  });
  it('R9 — échéance : une fin dans les 7 prochains jours (aujourd\'hui compris) est annoncée, pas au-delà', async () => {
    const out = await start([lot('L1', { status: 'doing', started: '2026-10-30', planned: W('2026-10-30', '2026-11-02') }), lot('L2', { status: 'doing', started: '2026-10-30', planned: W('2026-10-30', '2026-11-09') }), lot('L3', { status: 'doing', started: '2026-10-30', planned: W('2026-10-30', '2026-11-10') })]);
    expect(out).toContain("L1  Lot L1 — échéance aujourd'hui (2026-11-02)");
    expect(out).toContain('L2  Lot L2 — échéance dans 7 j (2026-11-09)');
    expect(out.slice(out.indexOf('Fenêtres prévues'), out.indexOf('Dépôt'))).not.toContain('L3');
    expect(out).not.toContain('en retard');
  });
  it('R9 — rien de dit pour : un lot fini ou abandonné, un récurrent, un lot qui commence aujourd\'hui ou plus tard, un lot sans fenêtre', async () => {
    const out = await start([
      lot('L1', { status: 'done', finished: '2026-10-05', planned: W('2026-10-01', '2026-10-05') }),
      lot('L2', { status: 'dropped', planned: W('2026-10-01', '2026-10-05') }),
      lot('L3', { every: 7, planned: W('2026-10-01', '2026-10-05') }),
      lot('L4', { planned: W('2026-11-02', '2026-11-20') }),
      lot('L5', { planned: W('2026-11-16', '2026-11-20') }),
      lot('L6'),
    ]);
    expect(out).not.toContain('Fenêtres prévues');
  });
  it('R9 — un sous-lot sans fenêtre propre est jugé sur celle de son parent', async () => {
    const dir = project([lot('L1', { planned: W('2026-10-20', '2026-10-30') }), lot('AB-1', { parent: 'L1' })], "plan:\n  idPattern: 'AB-\\d+'\n");
    const out = (await cad(dir, 'session', 'start', '--since', '2026-10-01')).out;
    expect(out).toContain('AB-1  Lot AB-1 — en retard de 3 j (prévu jusqu\'au 2026-10-30, hérité de L1)');
  });
});

describe('R10 — le Gantt lit les bornes de la fenêtre', () => {
  const lots = (...raws: Record<string, unknown>[]) => lotsOf(...raws);
  const span = (bars: ReturnType<typeof schedule>) => Object.fromEntries(bars.map((b) => [b.lot.id, [b.start, b.end, b.planned ?? false]]));
  it('R10 — un lot à faire daté prend ses bornes et ne consomme pas la file des autres', () => {
    const bars = schedule(lots({ id: 'A', estimate: 2 }, { id: 'B', planned: W('2026-12-01', '2026-12-04') }, { id: 'C' }), new Map(), TODAY);
    expect(span(bars)).toEqual({ A: ['2026-11-02', '2026-11-03', false], B: ['2026-12-01', '2026-12-04', true], C: ['2026-11-04', '2026-11-04', false] });
  });
  it('R10 — un sous-lot sans fenêtre propre prend celle du parent', () => {
    const bars = schedule(lots({ id: 'P', status: 'done', started: '2026-10-01', finished: '2026-10-02' }, { id: 'Q', planned: W('2026-11-10', '2026-11-12') }, { id: 'S', parent: 'Q' }), new Map(), TODAY);
    expect(span(bars).S).toEqual(['2026-11-10', '2026-11-12', true]);
  });
  it('R10 — un lot qui suit un lot daté attend la fin de sa fenêtre ; un lot daté dans le passé ne retient personne', () => {
    const later = schedule(lots({ id: 'B', planned: W('2026-11-04', '2026-11-06') }, { id: 'A', after: ['B'] }), new Map(), TODAY);
    expect(span(later).A).toEqual(['2026-11-09', '2026-11-09', false]);
    const past = schedule(lots({ id: 'B', planned: W('2026-10-01', '2026-10-06') }, { id: 'A', after: ['B'] }), new Map(), TODAY);
    expect(span(past).A).toEqual(['2026-11-02', '2026-11-02', false]);
  });
  it('R10 — un lot en cours ou fini garde ses dates réelles, fenêtre ou non', () => {
    const bars = schedule(lots({ id: 'D', status: 'doing', started: '2026-11-02', planned: W('2026-12-01', '2026-12-02') }), new Map(), TODAY);
    expect(span(bars).D).toEqual(['2026-11-02', '2026-11-02', false]);
  });
  it('R10 — la page porte le drapeau « fenêtre prévue » de chaque barre', () => {
    const data = ganttData('demo', schedule(lots({ id: 'B', planned: W('2026-12-01', '2026-12-04') }, { id: 'A' }), new Map(), TODAY), TODAY, 'now');
    expect(data.bars.map((b) => [b.id, b.planned])).toEqual([['B', true], ['A', false]]);
  });
});
