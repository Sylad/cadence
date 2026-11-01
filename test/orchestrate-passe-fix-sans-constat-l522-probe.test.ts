import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { noteUnstable } from '../src/orchestrate/gate-notes.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const rev = (over: Record<string, unknown>): Handler => () => claudeOut(reviewReport({ verdict: 'non conforme', ...over }));

describe('L522 R1/R3 probe — bords de l\'actionnable', () => {
  it('R3 probe — constat bloquant au texte blanc (espaces) : pas de passe, lot rendu', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rev({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'a.txt', ligne: 1, texte: '   ' }] })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('handed-back');
  });
  it('R3 probe — constat bloquant au texte vide : pas de passe, lot rendu', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rev({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'a.txt', ligne: 1, texte: '' }] })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).not.toContain('fix');
    expect(c.lot.status).toBe('handed-back');
  });
  it('R3 probe — un constat lisible parmi d\'autres vides : la passe s\'ouvre', async () => {
    const constats = [{ gravite: 'bloquant', texte: ' ' }, { gravite: 'majeur', fichier: 'a.txt', ligne: 2, texte: 'vrai bug' }];
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rev({ bloquants: 1, majeurs: 1, constats }), ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h).slice(0, 3)).toEqual(['implement', 'review', 'fix']);
  });
  it('R3 probe — totaux annoncés plus grands que les constats listés, un lisible : la passe s\'ouvre', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rev({ bloquants: 5, majeurs: 5, constats: [{ gravite: 'majeur', texte: 'x' }] }), ok] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h).slice(0, 3)).toEqual(['implement', 'review', 'fix']);
  });
  it('R1 probe — mineurs listés et majeur annoncé sans constat : lot rendu, mineurs gardés en propositions', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [rev({ majeurs: 1, mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'a.txt', ligne: 4, texte: 'nit' }] })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.proposals.some((p) => p.includes('nit'))).toBe(true);
    expect(c.lot.constats).toEqual([]);
  });
  it('R2 probe — revue aux totaux 0/0 : conforme, ni rendue ni corrigée', async () => {
    const h = harness({ script: { implement: [impl()], review: [rev({ bloquants: 0, majeurs: 0 })] } });
    const c = h.lot('L1');
    await runLot(c);
    // le verdict seul ne rend pas le lot non conforme : conforme (totaux 0) → conclusion normale, jamais handed-back
    expect(c.lot.status).not.toBe('handed-back');
    expect(kinds(h)).not.toContain('fix');
  });
  it('R2 probe — rendu sans constat : reviewCounts n\'est pas alimenté', async () => {
    const h = harness({ script: { implement: [impl()], review: [rev({ bloquants: 1 })] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(c.lot.reviewCounts ?? []).toEqual([]);
  });
  it('R2 probe — escalade déjà tranchée : issue conservée', async () => {
    const h = harness({ script: { implement: [impl()], review: [rev({ bloquants: 1 })] } });
    const c = h.lot('L1', {}, { escalation: { model: 'fable' } });
    c.lot.escalation = { ...(c.lot.escalation ?? {}), issue: 'conforme' } as NonNullable<typeof c.lot.escalation>;
    await runLot(c);
    expect(c.lot.escalation?.issue).toBe('conforme');
  });
});

describe('L522 R6 probe — bords de noteUnstable', () => {
  const proposal = (t: string) => `[instable] ${t} — rouge dans la suite, vert rejoué seul : à stabiliser`;
  it('R6 probe — liste vide : aucune proposition, aucun avertissement', () => {
    const c = harness({ script: {} }).lot('L1');
    noteUnstable(c, []);
    expect(c.lot.proposals).toEqual([]);
    expect(c.lot.warnings).toEqual([]);
  });
  it('R6 probe — doublon dans le même appel : une seule proposition', () => {
    const c = harness({ script: {} }).lot('L1');
    noteUnstable(c, ['t > x', 't > x']);
    expect(c.lot.proposals.filter((p) => p === proposal('t > x'))).toHaveLength(1);
    expect(c.lot.instables).toEqual(['t > x']);
  });
  it('R6 probe — proposition déjà présente (ex. reprise) : pas de doublon', () => {
    const c = harness({ script: {} }).lot('L1');
    c.lot.proposals.push(proposal('t > x'));
    noteUnstable(c, ['t > x']);
    expect(c.lot.proposals.filter((p) => p === proposal('t > x'))).toHaveLength(1);
  });
  it('R6 probe — deux tests distincts : deux propositions dans l\'ordre', () => {
    const c = harness({ script: {} }).lot('L1');
    noteUnstable(c, ['a', 'b']);
    expect(c.lot.proposals).toEqual([proposal('a'), proposal('b')]);
  });
});
