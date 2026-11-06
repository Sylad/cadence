import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsPrecheck, runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, harness, precheckReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit } from './spec-helpers.js';

// L666 (correction) : la moitié « le precheck liste les cas limites avant la spec » ne jouait que sur un lot qui cite un constat ou un autre lot ;
// un lot à étape de spec (`screen:` ou `spec: true`) sans commit passe désormais par le precheck, même quand il n'a rien à retrouver.
const root = join(__dirname, '..');
const plat = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\s+/g, ' ');
const ok: Handler = () => claudeOut({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' } as never);
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const pre: Handler = () => claudeOut(precheckReport({ lu: 'src/x.ts:1\nEdge cases of the rule: LECTURE-L666' }));
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Le lot est « créé après » le dernier commit de code (même montage que L322) : sans étape de spec, il n'aurait rien à retrouver. */
function lotCreatedLater(h: ReturnType<typeof harness>, day = '2099-01-01'): void {
  const file = join(h.repo, '.cadence/raf.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/created: \d{4}-\d{2}-\d{2}/g, `created: ${day}`));
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--date', `${day}T12:00:00Z`, '--', '.cadence/raf.yaml'], { cwd: h.repo, env: { ...process.env, GIT_COMMITTER_DATE: `${day}T12:00:00Z` } });
  commitFile(h.repo, 'code.txt', 'feat: du code, daté d\'avant le lot');
}

describe('L666 — le precheck d\'un lot à étape de spec', () => {
  it('R6 — un lot `spec: true` ou `screen:` sans commit est pré-vérifié même si son titre ne cite ni constat ni lot', () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }, { title: 'Un comportement', spec: true }, { title: 'Un lot ordinaire' }] });
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L1')).toBe(true);
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L2')).toBe(true);
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L3')).toBe(false);
  });
  it('R6 — `orchestrate.precheck: false` et des commits déjà présents coupent aussi le precheck d\'un lot à spec', () => {
    const h = harness({ lots: [{ title: 'Un comportement', spec: true }] });
    expect(needsPrecheck({ precheck: false }, h.plan(), h.repo, 'L1')).toBe(false);
    commitFile(h.repo, 'pre.txt', 'spec(L1): déjà là');
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L1')).toBe(false);
  });
  it('R6 — l\'écran posé au lancement (état du lot, plan muet) compte comme `screen:` du plan', () => {
    const h = harness({ lots: [{ title: 'Un lot ordinaire' }] });
    expect(needsPrecheck({ precheck: true }, h.plan(), h.repo, 'L1', { specStage: true })).toBe(true);
  });
  it('R6 — un lot à spec créé après le dernier commit de code garde son precheck (il a les cas limites à lister) et la spec reçoit sa lecture', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { precheck: [pre], spec: [spec], maquette: [ok], implement: [impl], ux: [ok], review: [ok] } });
    lotCreatedLater(h);
    const c = h.lot('L1', { visible: true, screen: 'page' }, { precheck: true, maquette: true, ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['precheck', 'spec']);
    expect(c.lot.warnings.some((w) => w.includes('contrôle préalable sauté'))).toBe(false);
    expect(h.calls.find((k) => k.kind === 'spec')!.brief).toContain('LECTURE-L666');
  });
  it('R6 — un lot sans étape de spec créé après le dernier commit de code est toujours sauté (L322 inchangé)', async () => {
    const h = harness({ lots: [{ title: 'Corriger le constat' }], script: { implement: [impl], review: [ok] } });
    lotCreatedLater(h);
    const c = h.lot('L1', {}, { precheck: true });
    await runLot(c);
    expect(kinds(h)[0]).toBe('implement');
    expect(c.lot.warnings.some((w) => w.includes('contrôle préalable sauté'))).toBe(true);
  });
  it('R7 — la réponse du lead à une question posée par la session de spec reçoit la même consigne : la réponse est une règle avec ses cas limites', async () => {
    const h = harness({ lots: [{ title: 'Un écran', screen: 'page' }], script: { spec: [spec], maquette: [ok], implement: [impl], ux: [ok], review: [ok] } });
    const c = h.lot('L1', { visible: true, screen: 'page', pendingAnswer: 'le contenu vient de cette source', specAsked: undefined }, { maquette: true, ux: { url: 'http://localhost:4200' } });
    await runLot(c);
    const b = h.calls.find((k) => k.kind === 'spec')!.brief;
    expect(b).toContain('Answer from the human to your earlier question: le contenu vient de cette source');
    expect(b).toMatch(/edge cases of the answer/);
  });
  it('R8 — la documentation suit : critère du precheck étendu aux lots à spec, section des cas limites gardée à la troncature, lecture jointe à chaque passe de spec', () => {
    const spec = plat('docs/orchestrate-spec.md');
    expect(spec).not.toContain('the end `[…tronqué]` included');
    expect(spec).toMatch(/Edge cases of the rule:[^.]*(kept|survives)[^.]*(cut|truncat)/i);
    expect(spec).toMatch(/precheck: local[^.]*(no reading|not stored|is not kept)/i);
    expect(plat('docs/orchestrate-cycle.md')).toMatch(/spec step[^.]*pre-check|pre-check[^.]*spec step/i);
    expect(plat('docs/concepts.md')).toMatch(/spec step[^.]*precheck|precheck[^.]*spec step/i);
    expect(plat('CHANGELOG.md')).toMatch(/L666[^\n]*spec step/);
    expect(plat('src/orchestrate/state.ts')).not.toContain('jamais à une reprise ni à une correction');
  });
});
