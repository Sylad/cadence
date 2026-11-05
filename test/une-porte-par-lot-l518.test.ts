import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { gateText, renderBrief } from '../src/orchestrate/briefs.js';
import { renderTable } from '../src/orchestrate/table.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import type { LotState, WaveState } from '../src/orchestrate/state.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const vars = { chemin: '/r', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };
const WRITING = ['implement', 'fix', 'fix-minors', 'fix-docs'] as const;
const wave = { id: 'w1', created: '2026-11-01T10:00:00Z', cwd: '/x', budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: [] } as unknown as WaveState;

describe('L518 R1 — la session ne joue que les tests ciblés, la porte complète est celle du programme', () => {
  it('R1 — gateText : le programme joue la suite une fois, la session joue les tests du code touché une fois avant de commiter', () => {
    const text = gateText({ test: 'npx vitest run', build: 'npx tsc --noEmit' });
    expect(text).toContain('`npx vitest run`');
    expect(text).toMatch(/played by the program/);
    expect(text).toMatch(/only the tests of the code you touch/);
    expect(text).toMatch(/once, before committing/);
  });

  it('R1 — gateText sans orchestrate.test : le programme ne joue pas la suite, la session la joue elle-même, une fois', () => {
    const text = gateText({ build: 'npx tsc --noEmit' });
    expect(text).toContain('`npx tsc --noEmit`');
    expect(text).toMatch(/play the full suite yourself, once/);
    expect(text).not.toMatch(/never the full suite/);
    expect(text).not.toMatch(/not yours to replay/);
  });

  it('R1 — gateText : le build reste joué tel quel par la session (L399)', () => {
    expect(gateText({ build: 'npx tsc --noEmit' })).toMatch(/build.*as written/s);
  });

  it('R1 — les quatre briefs d\'écriture demandent des tests ciblés et ne demandent plus la suite complète avant le rapport', () => {
    for (const kind of WRITING) {
      const b = renderBrief(kind, vars);
      expect(b, kind).toMatch(/targeted tests/);
      expect(b, kind).not.toMatch(/run the project's\s+full test suite/);
      expect(b, kind).not.toContain('{{');
    }
  });

  it('R1 — sans porte déclarée, le brief dit que la session joue la suite elle-même, une fois (personne d\'autre ne la joue)', () => {
    for (const kind of WRITING) expect(renderBrief(kind, vars), kind).toMatch(/no gate below[^.]*play the full suite yourself, once/);
  });

  it('R1 — implement et fix : l\'auto-vérification repart des tests ciblés verts, pas de la suite entière', () => {
    for (const kind of ['implement', 'fix'] as const) {
      const out = renderBrief(kind, vars);
      const bloc = out.slice(out.indexOf('Auto-verification once the tests are green')).split('\n\n')[0]!;
      expect(bloc, kind).toContain('targeted tests and the build pass');
      expect(bloc, kind).not.toContain('full test suite');
      expect(bloc, kind).not.toMatch(/rerun the suite/);
      expect(bloc, kind).toContain('rerun the targeted tests and the build');
    }
  });

  it('R1 — le brief réel d\'une session d\'écriture porte la consigne avec la porte du lot', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, { test: 'true', build: 'true' }));
    expect(h.calls[0].brief).toMatch(/played by the program/);
  });
});

describe('L518 R2 — la vague mesure les rejeux de la suite par lot', () => {
  it('R2 — une porte verte jouée une fois : la colonne « suites » du tableau dit 1', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true', build: 'true' });
    await runLot(c);
    expect(c.lot.suiteRuns).toBe(1);
    const t = renderTable(wave, [c.lot]);
    expect(t[0]).toMatch(/durée +après revue +suites$/);
    expect(t[1]).toMatch(/ +1$/);
  });

  it('R2 — sans orchestrate.test aucune suite jouée : « — » (non mesuré), pas 0', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { build: 'true' });
    await runLot(c);
    expect(c.lot.suiteRuns).toBeUndefined();
    expect(renderTable(wave, [c.lot])[1]).toMatch(/ +—$/);
  });

  it('R2 — un état écrit avant ce lot (sans le compteur) se lit « — », le tableau ne plante pas', () => {
    const l = { project: 'p', lot: 'L1', repo: '/x', status: 'ready', pass: 0, steps: [], constats: [], proposals: [], warnings: [], questions: [] } as unknown as LotState;
    expect(renderTable(wave, [l], { lotCommits: () => [] })[1]).toMatch(/ +—$/);
  });
});
