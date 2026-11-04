import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { ficheConverging, specMax, specBudget } from '../src/orchestrate/cycle/brief.js';
import { ficheReviewText } from '../src/orchestrate/fiche.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecritBack } from './spec-helpers.js';

// Sonde L572 : la revue de fiche converge (2 puis 1 → 3ᵉ revue), verdict « un seul majeur, corrigeable par le lead ».
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const lots = [{ title: 'Un comportement', spec: true }];
const back = { specLot: true as const };
const config = { fiche: true };
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) }));
const rev = (cs: { gravite: 'bloquant' | 'majeur' | 'mineur'; fichier?: string; ligne?: number; texte: string }[]): Handler => () =>
  claudeOut(reviewReport({ bloquants: cs.filter((k) => k.gravite === 'bloquant').length, majeurs: cs.filter((k) => k.gravite === 'majeur').length, constats: cs, verdict: 'non conforme' }));
const M = (texte: string, ligne = 7) => ({ gravite: 'majeur' as const, fichier: 'a.ts', ligne, texte });
const B = (texte: string) => ({ gravite: 'bloquant' as const, fichier: 'b.ts', ligne: 3, texte });

describe('L572 ficheConverging / specMax : bornes', () => {
  const lot = (n?: number[]) => ({ ficheCounts: n }) as never;
  it('absent, vide, une seule revue : ne converge pas', () => {
    expect(ficheConverging(lot(undefined))).toBe(false);
    expect(ficheConverging(lot([]))).toBe(false);
    expect(ficheConverging(lot([1]))).toBe(false);
    expect(ficheConverging(lot([2]))).toBe(false);
  });
  it('2→1 et 3→1 convergent ; 1→1, 0→1, 3→2, 2→0, 1→2 non', () => {
    expect(ficheConverging(lot([2, 1]))).toBe(true);
    expect(ficheConverging(lot([3, 1]))).toBe(true);
    expect(ficheConverging(lot([1, 1]))).toBe(false);
    expect(ficheConverging(lot([0, 1]))).toBe(false);
    expect(ficheConverging(lot([3, 2]))).toBe(false);
    expect(ficheConverging(lot([2, 0]))).toBe(false);
    expect(ficheConverging(lot([1, 2]))).toBe(false);
  });
  it('une 3ᵉ valeur n’annule pas la convergence déjà acquise', () => {
    expect(ficheConverging(lot([2, 1, 5]))).toBe(true);
  });
  it('specMax : 3 si converge, sinon le budget ; jamais sous le budget d’un lot à maquette plus large', () => {
    const c = (n: number[] | undefined, screen: boolean, mr: number) => ({ lot: { ficheCounts: n, screen }, config: { maquette: true, maquetteReviews: mr } }) as never;
    expect(specMax(c(undefined, false, 2))).toBe(2);
    expect(specMax(c([2, 1], false, 2))).toBe(3);
    expect(specMax(c([2, 1], true, 5))).toBe(5);
    expect(specMax(c([2, 1], true, 5))).toBe(specBudget(c([2, 1], true, 5)));
    expect(specMax(c([2, 1], true, 2))).toBe(3);
  });
});

describe('L572 ficheReviewText : brief de la 3ᵉ revue', () => {
  it('passes 2 : « third and last », points « previous », et jamais « second »', () => {
    const t = ficheReviewText({ fiche: 'f.yaml', passes: 2, previous: [{ source: 'code', gravite: 'majeur', texte: 'R9 : x', fichier: 'a.ts', ligne: 1 }] });
    expect(t).toMatch(/third and last/);
    expect(t).not.toMatch(/second and last/);
    expect(t).toContain('R9 : x');
  });
  it('passes 2 sans constats précédents : pas de ligne de points, pas d’exception', () => {
    expect(() => ficheReviewText({ fiche: 'f.yaml', passes: 2 })).not.toThrow();
    expect(ficheReviewText({ fiche: 'f.yaml', passes: 2 })).not.toMatch(/Points of/);
  });
  it('passes 0 et 1 inchangés', () => {
    expect(ficheReviewText({ fiche: 'f.yaml', passes: 0 })).toMatch(/first review/);
    expect(ficheReviewText({ fiche: 'f.yaml', passes: 1 })).toMatch(/second and last/);
  });
});

describe('L572 la revue de fiche converge : cas limites de bout en bout', () => {
  it('3 puis 1 : converge aussi, 3ᵉ revue', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], fiche: [rev([M('a', 1), M('b', 2), M('c', 3)]), rev([M('b', 2)]), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche', 'spec', 'fiche', 'implement', 'review']);
  });

  it('2 puis 1 bloquant : 3ᵉ revue quand même, mais pas de « un seul majeur » dans le rendu', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], fiche: [rev([M('a', 1), M('b', 2)]), rev([B('R1 : contradiction')]), rev([B('R1 : toujours')])] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche', 'spec', 'fiche']);
    expect(c.lot.outcome).toContain('fiche non conforme après 3 revues');
    expect(c.lot.outcome).not.toContain('un seul majeur');
  });

  it('le brief de la 3ᵉ spec et de la 3ᵉ revue reprend le point restant de la 2ᵉ revue', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], fiche: [rev([M('a', 1), M('b', 2)]), rev([M('R42 : le point restant', 9)]), ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    expect(h.calls[4].brief).toContain('R42 : le point restant');
    expect(h.calls[5].brief).toContain('R42 : le point restant');
    expect(h.calls[5].brief).not.toContain('R1 :');
  });

  it('les mineurs ne comptent pas : 2 majeurs + mineurs puis 1 majeur + mineurs converge', async () => {
    const m = (t: string) => ({ gravite: 'mineur' as const, fichier: 'm.ts', ligne: 1, texte: t });
    const h = harness({ lots, script: { spec: [spec, spec, spec], fiche: [rev([M('a', 1), M('b', 2), m('x'), m('y'), m('z')]), rev([M('b', 2), m('x'), m('y')]), ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', back, config));
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche', 'spec', 'fiche', 'implement', 'review']);
  });

  it('un majeur avec fichier mais sans ligne : « fichier — texte », pas de « :undefined »', async () => {
    const one = rev([{ gravite: 'majeur', fichier: 'a.ts', texte: 'R5 : sans ligne' }]);
    const h = harness({ lots, script: { spec: [spec, spec], fiche: [one, one] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.outcome).toContain('un seul majeur, corrigeable par le lead : a.ts');
    expect(c.lot.outcome).not.toMatch(/undefined|:0|:null/);
  });

  it('un majeur à la ligne 0 : pas de « :0 »', async () => {
    const one = rev([M('R5 : ligne zéro', 0)]);
    const h = harness({ lots, script: { spec: [spec, spec], fiche: [one, one] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.outcome).toContain('un seul majeur, corrigeable par le lead');
    expect(c.lot.outcome).not.toContain(':0');
  });

  it('un seul majeur plus des mineurs : « un seul majeur » (les mineurs ne sont pas des majeurs)', async () => {
    const one = rev([M('R5 : le seul', 12), { gravite: 'mineur', fichier: 'm.ts', ligne: 1, texte: 'nom vague' }]);
    const h = harness({ lots, script: { spec: [spec, spec], fiche: [one, one] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.outcome).toContain('un seul majeur, corrigeable par le lead : a.ts:12');
  });

  it('la 3ᵉ revue conforme : ficheConstats vidé, statut non rendu, specRuns = 3', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], fiche: [rev([M('a', 1), M('b', 2)]), rev([M('b', 2)]), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.ficheConstats).toBeUndefined();
    expect(c.lot.status).not.toBe('handed-back');
    expect(c.lot.specRuns).toBe(3);
    expect(c.lot.ficheCounts).toEqual([2, 1]);
  });

  it('fiche conforme du premier coup : ficheCounts reste vide, aucune 3ᵉ passe', async () => {
    const h = harness({ lots, script: { spec: [spec], fiche: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', back, config);
    await runLot(c);
    expect(c.lot.ficheCounts ?? []).toEqual([]);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'implement', 'review']);
  });
});
