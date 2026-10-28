import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { gateText, renderBrief } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());

describe('L399 R1 — la session joue les commandes exactes de la porte', () => {
  const vars = { chemin: '/r', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };

  it('R1 — gateText nomme les deux commandes déclarées et interdit une commande plus étroite', () => {
    const text = gateText({ test: 'npx vitest run', build: 'npx tsc --noEmit' });
    expect(text).toContain('`npx vitest run`');
    expect(text).toContain('`npx tsc --noEmit`');
    expect(text).toMatch(/not a narrower one/);
  });

  it('R1 — une seule commande déclarée : seule celle-là est nommée', () => {
    expect(gateText({ build: 'make check' })).toContain('`make check`');
    expect(gateText({ build: 'make check' })).not.toContain('tests:');
    expect(gateText({ test: 'pytest' })).not.toContain('build:');
  });

  it('R1 — sans commande déclarée, aucune consigne (le projet n\'a pas de porte)', () => {
    expect(gateText({})).toBe('');
  });

  it('R1 — implement, fix, passe des mineurs et passe du bibliothécaire portent la consigne ; sans elle, pas de trou', () => {
    for (const kind of ['implement', 'fix', 'fix-minors', 'fix-docs'] as const) {
      expect(renderBrief(kind, { ...vars, gate: gateText({ test: 'npx vitest run', build: 'npx tsc --noEmit' }) }), kind).toContain('`npx tsc --noEmit`');
      expect(renderBrief(kind, vars), kind).not.toContain('{{');
    }
  });

  it('R1 — le brief réel d\'une session d\'écriture porte les commandes de la porte du lot', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, { test: 'true', build: 'true' }));
    expect(h.calls[0].brief).toContain('The program\'s gate');
    expect(h.calls[0].brief).toContain('`true`');
  });

  it('R1 — la revue ne reçoit pas la consigne d\'écriture', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, { test: 'true', build: 'true' }));
    const review = h.calls.find((c) => c.kind === 'review');
    expect(review?.brief).not.toContain('The program\'s gate');
  });
});
