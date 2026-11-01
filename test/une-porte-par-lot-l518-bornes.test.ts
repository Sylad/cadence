import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { gateText } from '../src/orchestrate/briefs.js';
import { renderTable } from '../src/orchestrate/table.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import type { LotState, WaveState } from '../src/orchestrate/state.js';

const impl = (file = 'a.txt', msg = 'feat(L1): a'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, msg)] }));
const ok: Handler = () => claudeOut(reviewReport());
const wave = { id: 'w1', created: '2026-11-01T10:00:00Z', cwd: '/x', budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: [] } as unknown as WaveState;
const bare = (over: Partial<LotState> = {}) => ({ project: 'p', lot: 'L1', repo: '/x', status: 'ready', pass: 0, steps: [], constats: [], proposals: [], warnings: [], questions: [], ...over }) as unknown as LotState;

describe('L518 bornes — compteur « suites » de la porte', () => {
  it('build rouge : les tests ne sont pas joués, le compteur n’avance pas', async () => {
    const h = harness({ script: { implement: [impl()], fix: [impl('b.txt', 'fix(L1): b')], review: [ok] } });
    const c = h.lot('L1', {}, { build: 'false', test: 'true' });
    await runLot(c);
    expect(c.lot.suiteRuns ?? 0).toBe(0);
    expect(renderTable(wave, [c.lot])[1]).toMatch(/ +(—|0)$/);
  });

  it('suite rouge puis corrigée : une suite par passe d’écriture, soit 2', async () => {
    const h = harness({ script: { implement: [impl()], fix: [impl('fixed.txt', 'fix(L1): ok')], review: [ok] } });
    const c = h.lot('L1', {}, { build: 'true', test: 'test -f fixed.txt' });
    await runLot(c);
    expect(c.lot.suiteRuns).toBeGreaterThanOrEqual(2);
    expect(c.lot.suiteRuns).toBeLessThanOrEqual(3);
  });

  it('porte en parties : une passe compte une suite, pas une par partie', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { build: 'true', test: [{ dir: '.', run: 'true' }, { dir: '.', run: 'true' }] } as never);
    await runLot(c);
    expect(c.lot.suiteRuns).toBe(1);
  });

  it('même lot relancé deux fois (reprise) : le compteur est cumulé, jamais remis à zéro ni NaN', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok, ok] } });
    const c = h.lot('L1', {}, { build: 'true', test: 'true' });
    c.lot.suiteRuns = 4;
    await runLot(c);
    expect(c.lot.suiteRuns).toBeGreaterThanOrEqual(5);
    expect(Number.isNaN(c.lot.suiteRuns)).toBe(false);
  });
});

describe('L518 bornes — tableau', () => {
  it('liste vide : l’en-tête porte « suites » et rien ne plante', () => {
    const t = renderTable(wave, []);
    expect(t[0]).toMatch(/suites$/);
  });

  it('suiteRuns = 0 s’affiche « 0 », pas « — » (0 est une mesure)', () => {
    expect(renderTable(wave, [bare({ suiteRuns: 0 })], { lotCommits: () => [] })[1]).toMatch(/ 0$/);
  });

  it('deux chiffres : la colonne s’aligne (largeur du plus long)', () => {
    const t = renderTable(wave, [bare({ suiteRuns: 12 }), bare({ lot: 'L2', suiteRuns: 3 })], { lotCommits: () => [] });
    expect(t[1]).toMatch(/ 12$/);
    expect(t[2]).toMatch(/ 3$/);
    expect(t[1].lastIndexOf('12')).toBe(t[2].lastIndexOf('3'));
  });

  it('mode compact (--status) : la colonne est aussi là', () => {
    expect(renderTable(wave, [bare({ suiteRuns: 2 })], { compact: true, lotCommits: () => [] })[0]).toMatch(/suites$/);
  });

  it('compteur d’un état corrompu (chaîne) : le tableau ne plante pas', () => {
    expect(() => renderTable(wave, [bare({ suiteRuns: '3' as never })], { lotCommits: () => [] })).not.toThrow();
  });
});

describe('L518 bornes — gateText', () => {
  it('gate vide {} : texte vide, aucune consigne orpheline', () => {
    expect(gateText({})).toBe('');
  });
  it('tests seuls (sans build) : pas de phrase sur le build jouée « as written » à vide', () => {
    const t = gateText({ test: 'npx vitest run' });
    expect(t).not.toMatch(/- build:/);
    expect(t).toMatch(/targeted/);
  });
  it('porte en parties : chaque partie est listée et la consigne ciblée reste', () => {
    const t = gateText({ test: [{ dir: 'a', run: 'x' }, { dir: 'b', run: 'y' }] as never });
    expect(t).toContain('run in `a/`');
    expect(t).toContain('run in `b/`');
    expect(t).toMatch(/never the full suite/);
  });
});
