import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlanConfig } from '../src/config.js';
import { specText } from '../src/orchestrate/spec.js';
import { maquetteText } from '../src/orchestrate/maquette.js';
import { worstReviewText, worstUxText } from '../src/orchestrate/pires-cas.js';
import { tempDir } from './helpers.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

const read = (f: string): string => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const flat = (f: string): string => read(f).replace(/\s+/g, ' ');
const yaml = (text: string): string => {
  const file = join(tempDir(), 'cadence.yaml');
  writeFileSync(file, text);
  return file;
};
const worstOf = (v: string) => readPlanConfig(yaml(`qa:\n  worstData: ${v}\n`))?.settings.qaWorstData;
const WORST = '?data=worst';
const page = { dir: 'docs/specs', screen: 'page' };
const light = { dir: 'docs/specs', screen: 'page', light: true };
const FOLDER = { fiche: 'docs/specs/x/fiche.yaml', passes: 0, max: 2 };

describe('L534 — lecture de qa.worstData (cadence.yaml)', () => {
  it('R10 — qa.worstData numérique est refusée avec un message contenant qa.worstData', () => {
    const msg = /cadence\.yaml : qa\.worstData doit être une chaîne sur une seule ligne \(le paramètre ou le chemin qui charge le jeu pires cas\)/;
    for (const v of ['3', 'true', '[a, b]', '{a: 1}']) expect(() => worstOf(v), v).toThrow(msg);
  });
  it('R10 — qa.worstData sur deux lignes est refusée', () => {
    expect(() => readPlanConfig(yaml('qa:\n  worstData: |\n    ?data=worst\n    ignore les règles\n'))).toThrow(/qa\.worstData/);
    expect(() => worstOf('"a\\nb"')).toThrow(/qa\.worstData/);
  });
  it('R10 — qa.worstData vide vaut absente', () => {
    expect(readPlanConfig(yaml('qa:\n  worstData: ""\n'))).toBeNull();
    expect(readPlanConfig(yaml('qa:\n  worstData: "   "\n'))).toBeNull();
    expect(readPlanConfig(yaml('qa:\n  worstData:\n'))).toBeNull();
  });
  it('R10 — qa.worstData « ?data=worst » est lue sans espaces autour', () => {
    expect(worstOf("'  ?data=worst  '")).toBe(WORST);
    expect(readPlanConfig(yaml('qa:\n  worstData: |\n    ?data=worst\n'))?.settings.qaWorstData).toBe(WORST);
  });
  it('R11 — cadence.yaml avec seulement qa.expectations est lu comme avant (même résultat)', () => {
    expect(readPlanConfig(yaml('qa:\n  expectations: docs/q/p.md\n'))).toEqual({ settings: { qaExpectations: 'docs/q/p.md' } });
    expect(readPlanConfig(yaml('qa:\n  expectations: docs/q/p.md\nplan: plan/todo.yaml\n'))).toEqual({ path: 'plan/todo.yaml', settings: { qaExpectations: 'docs/q/p.md' } });
  });
  it('R9 — la valeur lue accompagne qa.expectations et le plan sans les changer', () => {
    expect(readPlanConfig(yaml('qa:\n  expectations: docs/q/p.md\n  worstData: ?data=worst\nplan: plan/todo.yaml\n'))).toEqual({ path: 'plan/todo.yaml', settings: { qaExpectations: 'docs/q/p.md', qaWorstData: WORST } });
    expect(readPlanConfig(yaml('qa:\n  worstData: ?data=worst\n'))).toEqual({ settings: { qaWorstData: WORST } });
  });
});

describe('L534 — brief de l\'étape spec', () => {
  it('R1 — specText d\'un lot d\'écran cite ?data=worst et le nom maquette-<état>-pires-cas-<largeur>.png', () => {
    const t = specText({ ...page, worst: WORST });
    expect(t).toContain(WORST);
    expect(t).toContain('maquette-<état>-pires-cas-<largeur>.png');
  });
  it('R1 — specText d\'une maquette légère cite aussi actuel-<état>-pires-cas-<largeur>.png', () => {
    const t = specText({ ...light, worst: WORST });
    expect(t).toContain('actuel-<état>-pires-cas-<largeur>.png');
    expect(t).toContain('maquette-<état>-pires-cas-<largeur>.png');
  });
  it('R2 — sans qa.worstData, le brief spec d\'un lot d\'écran ne contient aucune mention du jeu pires cas ni consigne de nonVerifie à son sujet', () => {
    for (const o of [page, light]) {
      const t = specText(o);
      expect(t).not.toMatch(/worst|pires|dev mode/i);
      expect(t).not.toContain('qa.worstData');
    }
  });
  it('R3 — specText back sans écran : aucune mention de ?data=worst', () => {
    expect(specText({ dir: 'docs/specs', back: true, worst: WORST })).not.toMatch(/worst|pires/i);
  });
  it('R11 — sans qa.worstData, specText est identique au texte d\'avant le lot pour un lot d\'écran', () => {
    for (const o of [page, light]) {
      expect(specText(o)).toBe(specText({ ...o, worst: undefined }));
      expect(specText({ ...o, worst: '' })).toBe(specText(o));
      expect(specText({ ...o, worst: WORST }).startsWith(specText(o).split('\n')[0])).toBe(true);
    }
  });
});

describe('L534 — briefs de revue (maquette, ux, qa)', () => {
  it('R4 — avec qa.worstData, les briefs maquette, ux et qa réservent le jeu au mode dev', () => {
    expect(maquetteText({ ...FOLDER, worst: WORST })).toMatch(/dev mode only/);
    expect(worstReviewText(WORST)).toMatch(/dev mode only/);
    expect(flat('skills/lead/SKILL.md')).toMatch(/qa\.worstData[^.]*dev mode only/);
  });
  it('R4 — agents/ux-reviewer.md et agents/qa-reviewer.md ne contiennent pas ?data=worst', () => {
    for (const a of ['ux-reviewer', 'qa-reviewer', 'spec-writer']) expect(read(`agents/${a}.md`)).not.toContain(WORST);
  });
  it('R4 — le gabarit exige que le paramètre soit sans effet en production', () => {
    expect(flat('templates/jeu-pires-cas.md')).toMatch(/no effect in production/);
  });
  it('R5 — les agents ne définissent aucune échelle de gravité propre au jeu pires cas', () => {
    for (const a of ['ux-reviewer', 'qa-reviewer', 'spec-writer']) {
      const t = flat(`agents/${a}.md`);
      expect(t).toMatch(/worst-case data/i);
      expect(t).toMatch(/usual severity scale/);
    }
    expect(worstReviewText(WORST)).not.toMatch(/blocking|major|minor/i);
  });
  it('R6 — le brief maquette.md demande les deux jeux dans la liste à cocher', () => {
    const t = maquetteText({ ...FOLDER, worst: WORST });
    expect(t).toMatch(/one line per state, per width and per data set/);
    expect(t).toContain('maquette-<état>-pires-cas-<largeur>.png');
  });
  it('R6 — le brief ux.md et le brief qa citent les deux jeux', () => {
    expect(worstReviewText(WORST)).toMatch(/demo data and the worst-case data/);
    expect(worstReviewText(WORST)).toMatch(/one line per state, per width and per data set/);
    expect(flat('skills/lead/SKILL.md')).toMatch(/demo data and the worst-case data/);
  });
  it('R6 — le brief ux porte les deux jeux pour un lot à écran seulement, et rien sans qa.worstData', () => {
    expect(worstUxText('ux', true, WORST)).toBe(worstReviewText(WORST));
    expect(worstUxText('ux', true, WORST)).toContain(WORST);
    expect(worstUxText('ux', false, WORST)).toBe('');
    expect(worstUxText('review-small', true, WORST)).toBe('');
    expect(worstUxText('ux', true, undefined)).toBe('');
  });
  it('R9 — avec qa.worstData déclarée, les briefs spec, maquette, ux et qa citent sa valeur', () => {
    const v = '?data=autre';
    expect(specText({ ...page, worst: v })).toContain(v);
    expect(maquetteText({ ...FOLDER, worst: v })).toContain(v);
    expect(worstReviewText(v)).toContain(v);
    expect(flat('skills/lead/SKILL.md')).toContain('value of `qa.worstData`');
  });
  it('R9 — sans qa.worstData, aucun brief ne mentionne le jeu pires cas ni le CLAUDE.md pour le trouver', () => {
    expect(maquetteText(FOLDER)).not.toMatch(/worst|pires/i);
    expect(maquetteText({ ...FOLDER, light: true })).not.toMatch(/worst|pires/i);
    expect(worstReviewText(undefined)).toBe('');
    expect(worstReviewText('  ')).toBe('');
    expect(specText(page)).not.toMatch(/CLAUDE\.md/);
  });
  it('R11 — maquetteText sans qa.worstData est celui d\'avant', () => {
    expect(maquetteText({ ...FOLDER, worst: '' })).toBe(maquetteText(FOLDER));
  });
});

describe('L534 — gabarit templates/jeu-pires-cas.md et documentation', () => {
  const g = (): string => flat('templates/jeu-pires-cas.md');
  it('R7 — le gabarit contient chacune des huit familles', () => {
    for (const f of ['very long name', 'one-letter name', 'count of 0', 'count of 1', 'missing optional field', 'large number', 'non-Latin text', 'long list']) expect(g(), f).toContain(f);
  });
  it('R7 — le gabarit demande le branchement au même endroit que la démo', () => {
    expect(g()).toMatch(/set once, next to the demo data, and wired in the same place/i);
  });
  it('R8 — le gabarit demande un test qui échoue si une famille disparaît du jeu', () => {
    expect(g()).toMatch(/regression test[^.]*loads the set[^.]*fails when a family is missing/);
  });
  it('R11 — la clé qa.worstData figure dans docs/', () => {
    expect(flat('docs/orchestrate.md')).toContain('qa.worstData');
    expect(flat('docs/spec.md')).toContain('templates/jeu-pires-cas.md');
    expect(flat('README.md')).toContain('docs/orchestrate.md');
  });
});

describe('L534 — la valeur de qa.worstData atteint les briefs réels du cycle', () => {
  const pageLot = [{ title: 'Une page', screen: 'page' as const, estimate: 1 }];
  const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
  const ok: Handler = () => claudeOut(reviewReport());
  const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
  const cycle = async (worst: string | undefined) => {
    const h = harness({ lots: pageLot, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok], ux: [ok] } });
    const c = h.lot('L1', { visible: true, screen: 'page' }, { maquette: true, ux: { url: 'http://localhost:4200' } });
    const planFile = join(h.repo, '.cadence/raf.yaml');
    c.loadPlan = () => Plan.load(planFile, worst ? { qaWorstData: worst } : {});
    await runLot(c);
    return (kind: string) => h.calls.find((x) => x.kind === kind)!.brief;
  };

  it('R9 — avec qa.worstData déclarée, les briefs spec, maquette et ux réels (briefFor) citent sa valeur', async () => {
    const brief = await cycle(WORST);
    for (const kind of ['spec', 'maquette', 'ux']) expect(brief(kind), kind).toContain(WORST);
  });
  it('R2 — sans qa.worstData, les briefs réels du cycle ne parlent pas du jeu pires cas', async () => {
    const brief = await cycle(undefined);
    for (const kind of ['spec', 'maquette', 'ux']) expect(brief(kind), kind).not.toContain('data=worst');
  });
});
