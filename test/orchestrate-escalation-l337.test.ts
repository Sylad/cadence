import { describe, expect, it } from 'vitest';
import { readOrchestrateConfig } from '../src/config.js';
import { REVIEW_RESERVE, lotSpent, runLot } from '../src/orchestrate/cycle.js';
import { renderTable } from '../src/orchestrate/table.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const redFix = (file: string): Handler => (call) =>
  claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)], tests: { commande: 'npm test', resultat: '1 failed', vert: false } }));
const ok: Handler = () => claudeOut(reviewReport());
const major: Handler = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }));
const nMajors = (n: number): Handler => () =>
  claudeOut(reviewReport({ majeurs: n, constats: Array.from({ length: n }, (_, i) => ({ gravite: 'majeur', fichier: 'a.txt', ligne: i + 1, texte: `bug ${i}` })), verdict: 'non conforme' }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const esc = { escalation: { model: 'fable' } };

describe('escalade de modèle avant de rendre un lot (L337)', () => {
  it('R1 — orchestrate.escalation: { model } est lu tel quel, absent = pas d\'escalade, une forme invalide est refusée', () => {
    const read = (yaml: string) => {
      const dir = tempDir();
      const file = join(dir, 'cadence.yaml');
      writeFileSync(file, yaml);
      return readOrchestrateConfig(file);
    };
    expect(read('orchestrate: {}\n').escalation).toBeUndefined();
    expect(read('orchestrate:\n  escalation:\n    model: fable\n').escalation).toEqual({ model: 'fable' });
    expect(read('orchestrate:\n  escalation:\n    model: claude-opus-4-7\n').escalation).toEqual({ model: 'claude-opus-4-7' });
    expect(() => read('orchestrate:\n  escalation: fable\n')).toThrow(/escalation/);
    expect(() => read('orchestrate:\n  escalation: {}\n')).toThrow(/escalation\.model/);
    expect(() => read('orchestrate:\n  escalation:\n    model: ""\n')).toThrow(/escalation\.model/);
    expect(() => read('orchestrate:\n  escalation:\n    model: fable\n    effort: max\n')).toThrow(/escalation\.effort inconnu/);
  });

  it('R2 — sans orchestrate.escalation, deux passes épuisées rendent le lot comme avant', async () => {
    const h = harness({ script: { implement: [impl], review: [major, major, major], fix: [fix('b.txt'), fix('c.txt')] } });
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.escalation).toBeUndefined();
    expect(c.lot.outcome).not.toContain('escalade');
  });

  it('R3 — revue non conforme après les passes : UNE correction puis UNE revue neuve au modèle d\'escalade, lot prêt si elle est conforme', async () => {
    const h = harness({ script: { implement: [impl], review: [major, major, major, ok], fix: [fix('b.txt'), fix('c.txt'), fix('d.txt')] } });
    const c = h.lot('L1', {}, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review', 'fix', 'review']);
    expect(h.calls.map((x) => x.model)).toEqual(['sonnet', 'opus', 'sonnet', 'opus', 'sonnet', 'opus', 'fable', 'fable']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.escalation).toMatchObject({ model: 'fable', issue: 'conforme' });
    expect(c.lot.steps.filter((s) => s.model === 'fable').map((s) => s.kind)).toEqual(['fix', 'review']);
  });

  it('R4 — la revue escaladée non conforme rend le lot, sans deuxième escalade ni passe de plus', async () => {
    const h = harness({ script: { implement: [impl], review: [major, major, major, major], fix: [fix('b.txt'), fix('c.txt'), fix('d.txt'), fix('e.txt')] } });
    const c = h.lot('L1', {}, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.escalation).toMatchObject({ model: 'fable', issue: 'rendu' });
    expect(c.lot.outcome).toContain("malgré l'escalade fable");
    expect(c.lot.constats[0].texte).toBe('bug nommé');
  });

  it('R5 — une revue qui converge joue ses trois passes avant l\'escalade', async () => {
    const h = harness({ script: { implement: [impl], review: [nMajors(3), nMajors(2), nMajors(1), nMajors(1), ok], fix: [fix('b.txt'), fix('c.txt'), fix('d.txt'), fix('e.txt')] } });
    const c = h.lot('L1', {}, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review', 'fix', 'review', 'fix', 'review']);
    expect(h.calls.slice(-2).map((x) => x.model)).toEqual(['fable', 'fable']);
    expect(c.lot.pass).toBe(4);
    expect(c.lot.status).toBe('ready');
  });

  it('R6 — un lot rendu « tests rouges » après ses passes escalade aussi : correction puis revue au modèle d\'escalade', async () => {
    const h = harness({ script: { implement: [impl], review: [nMajors(2), nMajors(1), ok], fix: [fix('b.txt'), redFix('c.txt'), fix('d.txt')] } });
    const c = h.lot('L1', {}, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'fix', 'review']);
    expect(h.calls[5].model).toBe('fable');
    expect(h.calls[6].model).toBe('fable');
    expect(c.lot.status).toBe('ready');
    expect(c.lot.escalation?.issue).toBe('conforme');
  });

  it('R7 — la correction escaladée qui laisse les tests rouges rend le lot sans revue', async () => {
    const h = harness({ script: { implement: [impl], review: [nMajors(2), nMajors(1)], fix: [fix('b.txt'), redFix('c.txt'), redFix('d.txt')] } });
    const c = h.lot('L1', {}, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'fix']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain("malgré l'escalade fable");
    expect(c.lot.escalation?.issue).toBe('rendu');
  });

  it('R8 — un budget du lot qui paie les passes mais pas l\'escalade la laisse non jouée, et le dit', async () => {
    const script = () => ({ implement: [impl], review: [major, major, major], fix: [fix('b.txt'), fix('c.txt')] });
    const probe = harness({ script: script() });
    const p = probe.lot('L1');
    await runLot(p);
    const spent = lotSpent(p.lot); // les six sessions des deux passes
    const h = harness({ script: script() });
    const c = h.lot('L1', { budget: spent + REVIEW_RESERVE - 1 }, esc);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'fix', 'review', 'fix', 'review']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('escalade fable non jouée (budget du lot');
    expect(c.lot.escalation).toMatchObject({ model: 'fable', issue: 'non jouée' });
  });

  it('R9 — le tableau final dit « escalade <modèle> » avec l\'issue, et le journal la trace', async () => {
    const h = harness({ script: { implement: [impl], review: [major, major, major, ok], fix: [fix('b.txt'), fix('c.txt'), fix('d.txt')] } });
    const logs: string[] = [];
    h.wave.log = (line: string) => logs.push(line);
    const c = h.lot('L1', {}, esc);
    await runLot(c);
    const table = renderTable({ id: 'w1', consumed: 0, budget: 1, cacheRead: 0, status: 'done' } as never, [c.lot], { isAncestor: () => false, lotCommits: () => [] });
    expect(table.some((l) => /demo:L1 — escalade fable : .*conforme/.test(l))).toBe(true);
    expect(logs.some((l) => l.includes('escalade fable'))).toBe(true);
  });
});

describe('L337 R11 — la documentation suit', () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  it('R11 — docs/orchestrate.md, docs/perf.md, le skill lead et le CHANGELOG décrivent l\'escalade', () => {
    expect(read('docs/orchestrate.md')).toMatch(/orchestrate\.escalation[\s\S]*claude --model/);
    expect(read('docs/perf.md')).toContain('escalades de modèle');
    expect(read('skills/lead/SKILL.md')).toMatch(/rendu malgré l'escalade[\s\S]*arbitration/);
    expect(read('CHANGELOG.md').split('## [1.11.0]')[0]).toContain('orchestrate.escalation');
  });
});
