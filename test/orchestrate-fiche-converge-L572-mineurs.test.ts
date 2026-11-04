import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, harness, reviewReport, specReport, type Handler } from './orchestrate-harness.js';
import { ecritBack } from './spec-helpers.js';

// L572, passe des mineurs : compte de passes du message spec, totaux annoncés, texte du rendu « la spec a déjà joué ».
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const lots = [{ title: 'Un comportement', spec: true }];
const back = { specLot: true as const };
const config = { fiche: true };
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) }));
const hors: Handler = () => claudeOut(specReport({ fiche: '/etc/hors.yaml' }));
const M = (texte: string, ligne = 7) => ({ gravite: 'majeur' as const, fichier: 'a.ts', ligne, texte });
const rev = (cs: ReturnType<typeof M>[], totaux: { bloquants?: number; majeurs?: number } = {}): Handler => () =>
  claudeOut(reviewReport({ bloquants: totaux.bloquants ?? 0, majeurs: totaux.majeurs ?? cs.length, constats: cs, verdict: 'non conforme' }));

describe('L572 mineurs', () => {
  it('3ᵉ session spec refusée par le programme : le message compte 3 passes', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, hors], fiche: [rev([M('a', 1), M('b', 2)]), rev([M('b', 2)])] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.specRuns).toBe(3);
    expect(c.lot.outcome).toContain('spec non conforme après 3 passes');
  });

  it('totaux annoncés : 1 bloquant + 2 majeurs annoncés, 1 majeur listé → pas de 3ᵉ revue ni de « un seul majeur »', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], fiche: [rev([M('a', 1), M('b', 2), M('c', 3)]), rev([M('b', 2)], { bloquants: 1, majeurs: 2 })] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche']);
    expect(c.lot.outcome).toContain('fiche non conforme après 2 revues');
    expect(c.lot.outcome).not.toContain('un seul majeur');
  });

  it('« la spec a déjà joué N sessions » porte aussi « un seul majeur, corrigeable par le lead : fichier:ligne »', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [rev([M('R5 : sans source', 12)])] } });
    const c = h.lot('L1', { ...back, specRuns: 1 }, config);
    await runLot(c);
    expect(c.lot.outcome).toContain('la spec a déjà joué 2 sessions');
    expect(c.lot.outcome).toContain('un seul majeur, corrigeable par le lead : a.ts:12');
  });
});
