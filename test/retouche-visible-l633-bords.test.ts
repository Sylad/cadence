import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { visibleFix } from '../src/orchestrate/spec.js';
import { visibleFixText } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

// L633 (issue #43), bords : la consigne du correctif ne touche que le lot visible sans screen, une seule fois, dans les bonnes étapes.
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'fix(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const FIX = /Visible fix \(L633\)/g;

describe('R2 — bords du correctif visible', () => {
  it('R2 — visibleFix : lot spec (specLot), express, non visible ou avec screen : faux ; visible seul : vrai', () => {
    expect(visibleFix({ visible: true }, {})).toBe(true);
    expect(visibleFix({ visible: true, specLot: true }, {})).toBe(false);
    expect(visibleFix({ visible: true, express: true }, {})).toBe(false);
    expect(visibleFix({}, {})).toBe(false);
    expect(visibleFix({ visible: true }, { screen: 'page' })).toBe(false);
  });

  it('R2 — la consigne porte le dossier de capture donné, avant et après, une seule fois par brief', async () => {
    const h = harness({ lots: [{ title: 'un correctif', estimate: 0.8 }], script: { implement: [impl], review: [ok], 'review-small': [ok], ux: [ok] } });
    const c = h.lot('L1', { visible: true, small: false }, { maquette: true, ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    for (const k of ['implement', 'ux']) {
      const b = h.calls.find((x) => x.kind === k)?.brief ?? '';
      expect(b.match(FIX)?.length, k).toBe(1);
    }
    const r = h.calls.find((x) => x.kind === 'review')?.brief ?? '';
    expect(r).not.toMatch(FIX);
  });

  it('R2 — visibleFixText : un dossier de capture vide ou à espaces ne casse pas la consigne', () => {
    expect(visibleFixText('implement', '')).toMatch(/avant-<state>-<width>px\.png/);
    expect(visibleFixText('review', '')).toMatch(/avant-\*/);
  });
});

describe('R2 — l\'agent ux-reviewer et le correctif visible', () => {
  const agent = readFileSync(new URL('../agents/ux-reviewer.md', import.meta.url), 'utf8');
  const grille = agent.slice(agent.indexOf('## Delivery grid'));

  it('R2 — la grille de livraison borne le correctif visible au diff, comme le brief « Visible fix »', () => {
    expect(grille).toMatch(/\*\*Visible fix\*\*/);
    expect(grille).toMatch(/limited to the lines the commits change/);
    expect(grille).toMatch(/a defect of the rest of the screen is not a finding/);
  });
});
