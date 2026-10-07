import { describe, expect, it } from 'vitest';
import { renderTable } from '../src/orchestrate/table.js';
import { newLot, type LotState, type ReviewSummary, type StepState, type WaveState } from '../src/orchestrate/state.js';
import type { StepKind } from '../src/orchestrate/launch.js';

const wave: WaveState = { id: 'w1', created: '2026-10-04T10:00:00Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L1'] };
const lot = () => newLot({ project: 'demo', repo: '/r', lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });

describe('renderTable : choix et propositions', () => {
  it('un lot avec choix rend une ligne « choix fait : … » par choix', () => {
    const l = lot();
    l.status = 'ready';
    l.choix = ['SQLite plutôt que PostgreSQL', 'message en français'];
    const out = renderTable(wave, [l]);
    expect(out).toContain('demo:L1 — choix fait : SQLite plutôt que PostgreSQL');
    expect(out).toContain('demo:L1 — choix fait : message en français');
  });

  it('sans choix, aucune ligne « choix fait »', () => {
    const l = lot();
    l.status = 'ready';
    expect(renderTable(wave, [l]).join('\n')).not.toContain('choix fait');
  });

  it('un ancien état sans champ « choix » se rend sans erreur', () => {
    const l = lot();
    l.status = 'ready';
    delete (l as { choix?: string[] }).choix;
    expect(() => renderTable(wave, [l])).not.toThrow();
  });

  it('les mineurs non traités sont rendus « proposé : … »', () => {
    const l = lot();
    l.status = 'ready';
    l.proposals = ['[mineur code] a.txt:1 — nommage'];
    expect(renderTable(wave, [l])).toContain('demo:L1 — proposé : [mineur code] a.txt:1 — nommage');
  });
});

describe('renderTable : captures UX (L74)', () => {
  it('une ligne donne le dossier des captures quand l\'étape ux a tourné', () => {
    const l = lot();
    l.status = 'ready';
    l.uxCaptures = '/launch/.cadence/runs/w1/demo--L1/playwright';
    expect(renderTable(wave, [l])).toContain('demo:L1 — captures Playwright : /launch/.cadence/runs/w1/demo--L1/playwright');
  });

  it('sans étape ux, aucune ligne', () => {
    const l = lot();
    l.status = 'ready';
    expect(renderTable(wave, [l]).join('\n')).not.toContain('captures Playwright');
  });
});

describe('renderTable : colonne revue (L51)', () => {
  const step = (kind: StepKind): StepState => ({ n: 1, kind, model: 'sonnet', status: 'ok', started: '2026-10-04T10:00:00Z' });
  const summary = (over: Partial<ReviewSummary>): ReviewSummary => ({ conforme: true, bloquants: 0, majeurs: 0, mineurs: 0, verdict: 'v', sousTaches: [], nonVerifie: [], head: 'abc', ...over });
  const cell = (l: LotState) => renderTable(wave, [l])[1];

  it('revue conforme puis lot rendu pour dépôt sale : jamais « non conforme (0 bloquant, 0 majeur) »', () => {
    const l = lot();
    l.status = 'handed-back';
    l.outcome = 'dépôt sale après fix : oublie.txt';
    l.code = summary({});
    l.steps = [step('implement'), step('review'), step('fix')];
    expect(cell(l)).not.toContain('non conforme');
    expect(cell(l)).toContain('conforme (dernier verdict ; rendu pour une autre cause)');
  });

  it('revue non conforme ancienne, lot rendu après une correction pour une autre cause : dernier verdict + autre cause', () => {
    const l = lot();
    l.status = 'handed-back';
    l.code = summary({ conforme: false, bloquants: 1 });
    l.steps = [step('implement'), step('review'), step('fix')];
    expect(cell(l)).toContain('non conforme (1 bloquant, 0 majeur) (dernier verdict ; rendu pour une autre cause)');
  });

  it('rendu par la revue elle-même (passes épuisées) : verdict de la revue, sans mention d\'autre cause', () => {
    const l = lot();
    l.status = 'handed-back';
    l.code = summary({ conforme: false, majeurs: 2 });
    l.steps = [step('implement'), step('review'), step('fix'), step('review')];
    expect(cell(l)).toContain('non conforme (0 bloquant, 2 majeur)');
    expect(cell(l)).not.toContain('autre cause');
  });
});
