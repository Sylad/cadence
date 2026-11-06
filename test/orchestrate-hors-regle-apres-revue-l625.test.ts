import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { convergeBrief } from '../src/orchestrate/cycle/converge.js';
import { isNonConformingVerdict } from '../src/audit.js';
import { renderTable } from '../src/orchestrate/table.js';
import { newLot, type LotState, type StepState, type WaveState } from '../src/orchestrate/state.js';
import { claudeOut, commitFile, harness, probeReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

// L625 (issue #41, propositions 3 et 5) : une attente hors règle de la sonde n'achète jamais de passe et la revue suivante ne la transforme pas en majeur ;
// le tableau de vague imprime, pour chaque lot, les minutes passées après sa première revue.
const HORS = 'p.spec.ts > nom vide > rejette — le serveur refuse déjà ce nom — refus attendu';
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.ts', 'feat(L1): a')] }));
const probe = (over: Record<string, unknown>): Handler => (call) => claudeOut(probeReport({ commits: [commitFile(call.opts.cwd, 'p.spec.ts', 'probe(L1): p.spec.ts')], ...over }));
const fix: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'b.ts', 'fix(L1): b')] }));
const rev = (constats: { gravite: string; texte: string }[]): Handler => () => {
  const n = (g: string) => constats.filter((k) => k.gravite === g).length;
  return claudeOut(reviewReport({ bloquants: n('bloquant'), majeurs: n('majeur'), mineurs: n('mineur'), constats, verdict: 'non conforme' }));
};
const lotWith = (proposals: string[], reviews = 0): LotState => {
  const l = newLot({ project: 'demo', repo: '/r', lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
  l.proposals = proposals;
  l.reviewCounts = Array(reviews).fill(0);
  return l;
};

describe('R1 — une attente hors règle n\'achète jamais de passe', () => {
  it('R1 — la sonde ne rend que des attentes hors règle : ni correction, ni passe comptée', async () => {
    const h = harness({ script: { implement: [impl], probe: [probe({ horsRegle: [HORS] })], review: [() => claudeOut(reviewReport())] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.pass).toBe(0);
  });
});

describe('R1 — une attente hors règle n\'achète jamais de passe', () => {
  it('R1 — un mineur qui reprend l\'attente n\'ouvre pas la passe des mineurs (lot non léger) ; un autre mineur l\'ouvre', async () => {
    const minor = (texte: string): Handler => () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', texte }], verdict: 'conforme' }));
    const h = harness({ lots: [{ title: 't', estimate: 1 }], script: { implement: [impl], probe: [probe({ horsRegle: [HORS] })], review: [minor(`Cas non couvert : ${HORS}`)], fix: [fix] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.minorPass).toBeFalsy();
    expect(c.lot.code?.conforme).toBe(true);
    expect(c.lot.warnings.join('\n')).toContain('mineur qui reprend une attente hors règle de la sonde');
    expect(c.lot.proposals).toEqual([`[hors règle] ${HORS}`]);
    const other = harness({ lots: [{ title: 't', estimate: 1 }], script: { implement: [impl], probe: [probe({ horsRegle: [HORS] })], review: [minor('autre mineur')], fix: [fix], 'review-small': [() => claudeOut(reviewReport())] } });
    await runLot(other.lot('L1', {}, { probe: true }));
    expect(kinds(other)).toEqual(['implement', 'probe', 'review', 'fix', 'review-small']);
  });
  it('R1 — le brief demande de ne pas rapporter l\'attente du tout, pas « au plus un mineur »', () => {
    const brief = convergeBrief('review', lotWith([`[hors règle] ${HORS}`]));
    expect(brief).toContain('do not report them at all');
    expect(brief).not.toContain('at most a minor');
  });
});

describe('R2 — la revue suivante ne la transforme pas en majeur', () => {
  it('R2 — revue 1 : un majeur qui reprend l\'attente hors règle ne compte pas, aucune passe, un warning le dit', async () => {
    const h = harness({ script: { implement: [impl], probe: [probe({ horsRegle: [HORS] })], review: [rev([{ gravite: 'majeur', texte: `Cas non couvert : ${HORS}` }])], fix: [fix] } });
    const c = h.lot('L1', {}, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'probe', 'review']);
    expect(c.lot.code?.conforme).toBe(true);
    expect(c.lot.code?.verdict).toMatch(/^conforme/);
    expect(isNonConformingVerdict(c.lot.code?.verdict ?? '')).toBe(false);
    expect(c.lot.pass).toBe(0);
    expect(c.lot.warnings.join('\n')).toContain('reprend une attente hors règle de la sonde');
    expect(c.lot.proposals).toEqual([`[hors règle] ${HORS}`]);
  });
  it('R2 — un majeur qui n\'est pas l\'attente compte comme avant, et un bloquant qui la cite compte toujours', async () => {
    const other = harness({ script: { implement: [impl], probe: [probe({ horsRegle: [HORS] })], review: [rev([{ gravite: 'majeur', texte: 'autre défaut' }]), () => claudeOut(reviewReport())], fix: [fix] } });
    await runLot(other.lot('L1', {}, { probe: true }));
    expect(kinds(other)).toEqual(['implement', 'probe', 'review', 'fix', 'review']);
    const blocking = harness({ script: { implement: [impl], probe: [probe({ horsRegle: [HORS] })], review: [rev([{ gravite: 'bloquant', texte: HORS }]), () => claudeOut(reviewReport())], fix: [fix] } });
    await runLot(blocking.lot('L1', {}, { probe: true }));
    expect(kinds(blocking)).toEqual(['implement', 'probe', 'review', 'fix', 'review']);
  });
  it('R2 — sans attente hors règle, un majeur compte (rien n\'est ignoré)', async () => {
    const h = harness({ script: { implement: [impl], probe: [probe({})], review: [rev([{ gravite: 'majeur', texte: HORS }]), () => claudeOut(reviewReport())], fix: [fix] } });
    await runLot(h.lot('L1', {}, { probe: true }));
    expect(kinds(h)).toEqual(['implement', 'probe', 'review', 'fix', 'review']);
  });
  it('R2 — le brief de la revue 1 et celui de la revue 2 listent l\'attente ; sans attente, la revue 1 n\'a rien', () => {
    expect(convergeBrief('review', lotWith([`[hors règle] ${HORS}`]))).toContain(`- ${HORS}`);
    const two = convergeBrief('review', lotWith([`[hors règle] ${HORS}`], 1));
    expect(two).toContain(`- ${HORS}`);
    expect(two).toContain('not the first code review');
    expect(convergeBrief('review', lotWith([]))).toBe('');
    expect(convergeBrief('review', lotWith(['[hors règle]   ']))).toBe('');
    expect(convergeBrief('implement', lotWith([`[hors règle] ${HORS}`]))).toBe('');
  });
});

describe('R3 — le tableau imprime les minutes passées après la première revue', () => {
  const wave: WaveState = { id: 'w1', created: '2026-11-02T10:00:00Z', cwd: '/x', budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: [] };
  const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 10, m)).toISOString();
  const st = (kind: string, from: number, to?: number): StepState => ({ n: 1, kind, model: 'sonnet', status: 'ok', started: at(from), ...(to === undefined ? {} : { ended: at(to) }) }) as StepState;
  const row = (steps: StepState[]) => {
    const l = lotWith([]);
    l.status = 'ready';
    l.steps = steps;
    const out = renderTable(wave, [l], { lotCommits: () => [], isAncestor: () => false });
    const cells = (s: string) => s.split(/\s{2,}/);
    return { head: cells(out[0]), cells: cells(out[1]) };
  };
  const after = (r: ReturnType<typeof row>) => r.cells[r.head.indexOf('après revue')];

  it('R3 — les étapes après la première revue sont sommées, la revue elle-même et ce qui la précède non', () => {
    const r = row([st('implement', 0, 20), st('review', 20, 26), st('fix', 30, 40), st('review', 40, 45), st('integrate', 45, 47)]);
    expect(after(r)).toBe('17 min');
    expect(r.cells[r.head.indexOf('durée')]).toBe('43 min');
  });
  it('R3 — sans revue : « — » ; revue seule ou étape sans fin après elle : 0 min', () => {
    expect(after(row([st('implement', 0, 20)]))).toBe('—');
    expect(after(row([]))).toBe('—');
    expect(after(row([st('review', 0, 5)]))).toBe('0 min');
    expect(after(row([st('review', 0, 5), st('fix', 6)]))).toBe('0 min');
  });
  it('R3 — une revue UX ou précheck n\'est pas la première revue de code ; review-small l\'est', () => {
    expect(after(row([st('precheck', 0, 5), st('implement', 5, 10)]))).toBe('—');
    expect(after(row([st('implement', 0, 10), st('review-small', 10, 12), st('fix', 12, 15)]))).toBe('3 min');
  });
});

describe('L634 — lot rétréci (L621) × attente hors règle (L625), rangs 1 et 2', () => {
  const range = { goal: 'corriger quatre erreurs de calcul', from: 'abc1234' };
  const hors = `[hors règle] ${HORS}`;
  const MARK = 'Mark `inchange: true` on every major';
  it('L634 — rang 1 : la plage du lot, la marque inchange: true et l\'attente hors règle, dans cet ordre', () => {
    const text = convergeBrief('review', lotWith([hors]), range);
    expect(text).toContain('abc1234..HEAD');
    expect(text).toContain(MARK);
    expect(text).toContain(`- ${HORS}`);
    expect(text).not.toContain('not the first code review');
    expect(text.indexOf('abc1234..HEAD')).toBeLessThan(text.indexOf(MARK));
    expect(text.indexOf(MARK)).toBeLessThan(text.indexOf(`- ${HORS}`));
  });
  it('L634 — rang 2 : la plage, la consigne de convergence (qui porte la marque une seule fois) et l\'attente hors règle', () => {
    const text = convergeBrief('review', lotWith([hors], 1), range);
    expect(text).toContain('abc1234..HEAD');
    expect(text).toContain('not the first code review');
    expect(text.split(MARK).length - 1).toBe(1);
    expect(text).toContain(`- ${HORS}`);
    expect(text.indexOf('not the first code review')).toBeLessThan(text.indexOf(`- ${HORS}`));
  });
  it('L634 — lot rétréci sans attente hors règle : ni la section hors règle, à aucun rang', () => {
    expect(convergeBrief('review', lotWith([]), range)).not.toContain('OUTSIDE the rules');
    expect(convergeBrief('review', lotWith([], 1), range)).not.toContain('OUTSIDE the rules');
  });
});
