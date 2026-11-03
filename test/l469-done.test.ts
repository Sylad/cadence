import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { run } from '../src/cli.js';
import { DAY, fx, head, planOf, sh, ship, STATES, write, type Fx } from './l469-fixture.js';
import { cleanupTempDirs } from './helpers.js';

afterEach(cleanupTempDirs);

const raf = (f: Fx, ...argv: string[]) => {
  const out: string[] = [];
  const code = run(argv, { cwd: f.dir, env: { RAF_TODAY: DAY }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(`${DAY}T10:00:00`) });
  return { code, out };
};
const log = (f: Fx, ...lines: string[]) => write(f.state, 'deliveries.log', `${lines.join('\n')}\n`);

/** Dépôt à blocs : L1 a un commit sur `files`, la tête est rendue. */
function worked(files: string[], o: Parameters<typeof fx>[0] = { blocks: true }) {
  const f = fx(o);
  ship(f, files, 'feat(L1): travail');
  return f;
}

describe('C2 — raf done après la livraison', () => {
  it('R14 — deux lignes atteignent le lot : la plus ancienne est retenue', () => {
    const f = worked(['src/a.ts'], {});
    const s1 = head(f);
    ship(f, ['src/b.ts'], 'fix(L1): suite');
    log(f, `2026-10-03 ${s1}`, `2026-10-07 ${head(f)}`);
    const r = raf(f, 'done', 'L1');
    expect(r.code).toBe(0);
    expect(planOf(f).lot('L1').delivered).toEqual({ date: '2026-10-03', sha: s1 });
  });
  it('R14 — commit plan seul seul : ligne non retenue', () => {
    const f = fx();
    write(f.dir, '.cadence/raf.yaml', `${readFileSync(f.planFile, 'utf8')}\n`);
    sh(f.dir, 'add', '-A', '.cadence');
    sh(f.dir, 'commit', '-q', '-m', 'plan: L1 noté');
    log(f, `2026-10-03 ${head(f)}`);
    expect(raf(f, 'done', 'L1').out.some((l) => l.includes('livré le'))).toBe(false);
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R14 — message « livré le » imprimé', () => {
    const f = worked(['src/a.ts'], {});
    log(f, `2026-10-03 ${head(f)}`);
    expect(raf(f, 'done', 'L1').out).toContain(`L1 livré le 2026-10-03 (${head(f).slice(0, 7)})`);
  });
  it('R14 — l\'état suit R6 : termine passe à livre', () => {
    const yaml = 'plan:\n  states: { a_faire: todo, en_cours: doing, termine: done, livre: done }\n  doneState: termine\n  deliveredState: livre\ndeliver:\n  ci: none\n  verify:\n    - command: "true"\n';
    const f = worked(['src/a.ts'], { settings: STATES, yaml });
    log(f, `2026-10-03 ${head(f)}`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1')).toMatchObject({ state: 'livre', delivered: { date: '2026-10-03' } });
  });
  it('R15 — ligne illisible sautée, la suivante retenue', () => {
    const f = worked(['src/a.ts'], {});
    log(f, 'n\'importe quoi', `jamais ${head(f)}`, '2026-10-01', `2026-10-02 ${'f'.repeat(40)}`, `2026-10-04 ${head(f)}`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1').delivered).toEqual({ date: '2026-10-04', sha: head(f) });
  });
  it('R15 — aucune ligne : lot done sans delivered, sans message', () => {
    const f = fx();
    const before = head(f);
    ship(f, ['src/a.ts'], 'feat(L1): travail');
    log(f, `2026-10-01 ${before}`); // livraison d'avant le travail
    const r = raf(f, 'done', 'L1');
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.includes('livré le'))).toBe(false);
    expect(planOf(f).lot('L1')).toMatchObject({ status: 'done' });
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R15 — journal absent : raf done inchangé', () => {
    const f = worked(['src/a.ts'], {});
    expect(raf(f, 'done', 'L1').out[0]).toBe('L1 → done');
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R16 — raf done L1/t1 : lot non marqué', () => {
    const f = fx({ prelude: (p) => { p.addTask('L1', 'étape'); p.save(); } });
    ship(f, ['src/a.ts'], 'feat(L1/t1): étape');
    log(f, `2026-10-03 ${head(f)}`);
    const r = raf(f, 'done', 'L1/t1');
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.includes('livré le'))).toBe(false);
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R16 — plan en lecture seule : raf done inchangé', () => {
    const f = worked(['src/a.ts'], {});
    write(f.dir, 'cadence.yaml', 'plan:\n  lots: lots\n');
    log(f, `2026-10-03 ${head(f)}`);
    const before = readFileSync(f.planFile, 'utf8');
    const r = raf(f, 'done', 'L1');
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toContain('plan en lecture seule');
    expect(readFileSync(f.planFile, 'utf8')).toBe(before);
  });
});

describe('C2 — blocs (R31, R32)', () => {
  it('R31 — lot touchant api et web, lignes api puis web : la ligne api est retenue', () => {
    const f = worked(['src/api/a.ts']);
    const a = head(f);
    ship(f, ['src/web/w.ts'], 'feat(L1): web');
    log(f, `2026-10-03 ${a} api`, `2026-10-05 ${head(f)} web`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1').delivered).toEqual({ date: '2026-10-03', sha: a });
  });
  it('R31 — ligne d\'un autre bloc non retenue pour ce lot', () => {
    const f = worked(['src/web/w.ts']);
    log(f, `2026-10-03 ${head(f)} api`, `2026-10-05 ${head(f)} web`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1').delivered?.date).toBe('2026-10-05');
  });
  it('R31 — sans deliver.blocks : règle R14 inchangée', () => {
    const f = worked(['src/web/w.ts'], {});
    log(f, `2026-10-03 ${head(f)} api`, `2026-10-05 ${head(f)} web`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1').delivered?.date).toBe('2026-10-03');
  });
  it('R32 — lot hors blocs, ligne --block api seule : non marqué', () => {
    const f = worked(['docs/x.md']);
    log(f, `2026-10-03 ${head(f)} api`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1').delivered).toBeUndefined();
  });
  it('R32 — lot hors blocs, ligne sans bloc : marqué', () => {
    const f = worked(['docs/x.md']);
    log(f, `2026-10-03 ${head(f)} api`, `2026-10-04 ${head(f)}`);
    raf(f, 'done', 'L1');
    expect(planOf(f).lot('L1').delivered?.date).toBe('2026-10-04');
  });
});
