import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { toFix } from '../src/orchestrate/cycle/review.js';
import { MAX_PASSES, MAX_PASSES_CONVERGING } from '../src/orchestrate/cycle/ctx.js';
import { harness } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';
import type { Constat, LotState } from '../src/orchestrate/state.js';

// L650 : un lot dont le sujet est la revue (`spec: revue`) garde ses passes de fix bornées à MAX_PASSES : ni la passe de la revue qui converge, ni l'escalade ne en ajoutent ; il est rendu au lead avant la 3e.
const T = '2026-11-06';
const k = (texte: string): Constat => ({ source: 'code', gravite: 'majeur', texte });
const raf = (dir: string, ...argv: string[]) => {
  const out: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: T }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(`${T}T09:30:00`) });
  return { code, out: out.join('\n') };
};
const converging: Partial<LotState> = { pass: MAX_PASSES, reviewCounts: [3, 1] };

describe('R1 — le plan lit `spec: revue` : spec vraie et lot de revue', () => {
  const planWith = (value: string) => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--spec');
    const file = join(dir, '.cadence/raf.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('spec: true', `spec: ${value}`));
    return { dir, file };
  };
  it('R1 — `spec: revue` donne spec: true et revue: true, sans problème', () => {
    const { file } = planWith('revue');
    expect(Plan.load(file).lot('L1')).toMatchObject({ spec: true, revue: true, problems: [] });
  });
  it('R1 — `spec: true` ne donne pas revue', () => {
    const { file } = planWith('true');
    const lot = Plan.load(file).lot('L1');
    expect(lot.spec).toBe(true);
    expect(lot.revue).toBeUndefined();
  });
  it('R1 — une autre chaîne (« Revue », « review ») reste une erreur de raf check', () => {
    for (const bad of ['Revue', 'review', '"revue "']) {
      const { dir } = planWith(bad);
      const r = raf(dir, 'check');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/✗ L1 : spec : true ou false attendu/);
    }
  });
  it('R1 — raf show affiche `spec : revue`', () => {
    const { dir } = planWith('revue');
    expect(raf(dir, 'show', 'L1').out).toContain('spec : revue');
  });
  it('R1 — `raf spec on` sur un lot `spec: revue` garde revue ; `off` retire la clé', () => {
    const { dir, file } = planWith('revue');
    raf(dir, 'spec', 'L1', 'on');
    expect(readFileSync(file, 'utf8')).toContain('spec: revue');
    raf(dir, 'spec', 'L1', 'off');
    expect(readFileSync(file, 'utf8')).not.toContain('spec:');
  });
});

describe('R2 — la boucle de fix d’un lot de revue est bornée à MAX_PASSES', () => {
  it('R2 — au plafond, un lot de revue dont la revue converge est rendu au lead, sans 3e passe', () => {
    const c = harness({ script: {} }).lot('L1', { ...converging, revueLot: true });
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.pass).toBe(MAX_PASSES);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toBe(`revue non conforme après ${MAX_PASSES} passe(s) de correction`);
  });
  it('R2 — le même état sur un lot ordinaire reçoit la passe de plus (MAX_PASSES_CONVERGING) : la borne ne touche que les lots de revue', () => {
    const c = harness({ script: {} }).lot('L1', converging);
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.pass).toBe(MAX_PASSES + 1);
    expect(MAX_PASSES_CONVERGING).toBe(MAX_PASSES + 1);
    expect(c.lot.next).toBe('fix');
  });
  it('R2 — avant le plafond, un lot de revue reçoit ses passes', () => {
    const c = harness({ script: {} }).lot('L1', { pass: MAX_PASSES - 1, revueLot: true });
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.pass).toBe(MAX_PASSES);
    expect(c.lot.next).toBe('fix');
  });
});

describe('R3 — l’escalade ne rouvre pas la boucle d’un lot de revue', () => {
  it('R3 — au plafond avec escalation configurée, un lot de revue est rendu sans escalade', () => {
    const c = harness({ script: {} }).lot('L1', { pass: MAX_PASSES, revueLot: true });
    c.config.escalation = { model: 'fable' };
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.escalation).toBeUndefined();
  });
  it('R3 — le même lot ordinaire engage l’escalade (la configuration est bien lue)', () => {
    const c = harness({ script: {} }).lot('L1', { pass: MAX_PASSES });
    c.config.escalation = { model: 'fable' };
    toFix(c, [k('x')], 'revue non conforme');
    expect(c.lot.escalation).toMatchObject({ model: 'fable', stage: 'fix' });
  });
});
