import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const GATE = { code: ['*.ts'], tests: ['*.spec.ts'], except: [] as string[], threshold: 1 };
const impl = (file = 'a.txt'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const models = (h: ReturnType<typeof harness>) => h.calls.filter((x) => x.kind === 'review' || x.kind === 'review-small').map((x) => x.model);
const RED = 'test -f b.txt || { echo boom >&2; exit 3; }';

describe('L565 — la revue légère après une passe du programme', () => {
  it('L565 R1 — porte « code sans test » seule : la revue d\'un lot léger reste Sonnet', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.25 }], script: { implement: [impl('a.ts')], fix: [fix('a.spec.ts')], review: [ok] } });
    const c = h.lot('L1', { light: true }, { testGate: GATE });
    await runLot(c);
    expect(h.calls.map((x) => x.kind)).toEqual(['implement', 'fix', 'review']);
    expect(models(h)).toEqual(['sonnet']);
    expect(c.lot.pass).toBe(c.lot.programFixes);
  });

  it('L565 R1 — deux passes de tests rouges de suite : la revue reste Sonnet, tous les passes du programme', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('c.txt'), fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', { light: true }, { test: RED });
    await runLot(c);
    expect(h.calls.map((x) => x.kind)).toEqual(['implement', 'fix', 'fix', 'review']);
    expect(models(h)).toEqual(['sonnet']);
    expect(c.lot.pass).toBe(c.lot.programFixes);
  });

  it('L565 R2 — un majeur trouvé par la revue fait dépasser pass de programFixes, ce qui reste vrai après des tests rouges réparés', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('c.txt'), fix('b.txt')], review: [major, ok] } });
    const c = h.lot('L1', { light: true }, { test: 'test -f c.txt && { test -f b.txt || exit 3; } || true' });
    await runLot(c);
    expect(c.lot.pass).toBeGreaterThan(c.lot.programFixes ?? 0);
    expect(models(h)[0]).toBe('sonnet');
    expect(models(h).slice(1).every((m) => m === 'opus')).toBe(true);
  });

  it('L565 R2 — état hérité (pass > 0, sans programFixes, d\'avant le lot) : la revue est Opus, pas Sonnet', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { light: true, pass: 1 });
    await runLot(c);
    expect(models(h)).toEqual(['opus']);
  });

  it('L565 R3 — lot léger : un lot non léger avec tous les passes du programme reste Opus après tests rouges', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', { light: false }, { test: RED });
    await runLot(c);
    expect(models(h)).toEqual(['opus']);
  });

  it('L565 R2 — lot léger : la passe d\'un lot repris (reprise de la branche) vaut une correction née d\'une revue → Opus', async () => {
    const h = harness({ script: { fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', { light: true, resumedFrom: 'abc', constats: [{ source: 'code', gravite: 'majeur', fichier: 'a.txt', texte: 'reste' }] } as never);
    await runLot(c);
    expect(models(h).every((m) => m === 'opus')).toBe(true);
  });
});
