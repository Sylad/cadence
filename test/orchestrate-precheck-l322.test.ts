import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { precheckNothingToFind, runLot } from '../src/orchestrate/cycle.js';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, git, harness, precheckReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const ok: Handler = () => claudeOut(reviewReport());
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, `f-${Math.random().toString(36).slice(2)}.txt`, 'feat(L1): a')] }));
const localCfg = { precheck: true, precheckLocal: true } as const;
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Date le commit du plan (le dernier du dépôt jetable) dans le futur et fait de même pour `created` : le lot est « créé après » le commit de code. */
function lotCreatedLater(h: ReturnType<typeof harness>, day = '2099-01-01'): void {
  const file = join(h.repo, '.cadence/raf.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/created: \d{4}-\d{2}-\d{2}/g, `created: ${day}`));
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit', '--date', `${day}T12:00:00Z`, '--', '.cadence/raf.yaml'], { cwd: h.repo, env: { ...process.env, GIT_COMMITTER_DATE: `${day}T12:00:00Z` } });
  commitFile(h.repo, 'code.txt', 'feat: du code, daté d\'avant le lot'); // le dernier commit de code est celui d'aujourd'hui, le lot est de 2099
}

describe('L322 R1 — pas de précheck pour un lot créé après le dernier commit de code', () => {
  it('R1 — un lot dont l\'ajout au plan est postérieur au dernier commit de code n\'a rien à retrouver : la raison est donnée', () => {
    const h = harness({ lots: [{ title: 'un' }] });
    lotCreatedLater(h);
    expect(precheckNothingToFind(h.plan(), h.repo, 'L1')!).toMatch(/créé après le dernier commit de code/);
  });

  it('R1 — un lot plus ancien que le dernier commit de code garde son précheck', () => {
    const h = harness({ lots: [{ title: 'un' }] });
    commitFile(h.repo, 'code.txt', 'feat: du code après le lot');
    expect(precheckNothingToFind(h.plan(), h.repo, 'L1')).toBeNull();
  });

  it('R1 — un commit qui ne touche que le plan n\'est pas un commit de code : il ne rend pas le lot « ancien »', () => {
    const h = harness({ lots: [{ title: 'un' }] });
    lotCreatedLater(h);
    const file = join(h.repo, '.cadence/raf.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}# entretien\n`);
    git(h.repo, 'commit', '-q', '-m', 'plan: entretien', '--', '.cadence/raf.yaml');
    expect(precheckNothingToFind(h.plan(), h.repo, 'L1')).not.toBeNull();
  });

  it('R1 — un lot qui travaille dans des dépôts voisins n\'est jamais sauté (leur historique n\'est pas lu)', () => {
    const h = harness({ lots: [{ title: 'un' }] });
    lotCreatedLater(h);
    expect(precheckNothingToFind(h.plan(), h.repo, 'L1', [{ rel: '../autre', path: '/x' } as never])).toBeNull();
  });

  it('R1 — l\'id introuvable dans l\'historique du plan (plan non commité) : pas de saut, le précheck reste', () => {
    const h = harness({ lots: [{ title: 'un' }] });
    expect(precheckNothingToFind(h.plan(), h.repo, 'L9')).toBeNull();
  });

  it('R2 — le cycle saute la session precheck, le dit dans le journal du lot et ouvre l\'implémentation', async () => {
    const h = harness({ lots: [{ title: 'un, suite de la revue' }], script: { implement: [impl], review: [ok] } });
    lotCreatedLater(h);
    const c = h.lot('L1', {}, { precheck: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.warnings.join('\n')).toMatch(/contrôle préalable sauté : lot créé après le dernier commit de code/);
    expect(c.lot.precheckVerdict).toBeUndefined();
  });

  it('R2 — même sur le modèle local : aucune session locale pour un lot créé après le dernier commit de code', async () => {
    const h = harness({ lots: [{ title: 'un' }], script: { implement: [impl], review: [ok] } });
    lotCreatedLater(h);
    const c = h.lot('L1', {}, localCfg);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });

  it('R2 — un lot ancien garde son précheck', async () => {
    const h = harness({ lots: [{ title: 'un, suite de la revue' }], script: { precheck: [() => claudeOut(precheckReport())], implement: [impl], review: [ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code après le lot');
    const c = h.lot('L1', {}, { precheck: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['precheck', 'implement', 'review']);
  });
});

const textCall = () => claudeOut(undefined, {}, { result: '<function=Bash>\n<parameter=command>git log</parameter>\n</function>' });
const thrash = () => ({ code: 1, stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'Autocompact is thrashing: the context refilled immediately', session_id: 's-thrash', num_turns: 3, duration_ms: 1, usage: { input_tokens: 10, output_tokens: 1 } }), stderr: '', timedOut: false });

describe('L322 R3 — le local fiable, ou écarté vite', () => {
  it('R3 — un appel d\'outil écrit en texte (pas de structured_output) est un échec du local au premier tour : pas de relance locale, Sonnet répond, la cause est nommée', async () => {
    const h = harness({ lots: [{ title: 'un' }], script: { precheck: [textCall, () => claudeOut(precheckReport())], implement: [impl], review: [ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    const c = h.lot('L1', {}, localCfg);
    await runLot(c);
    expect(h.calls.filter((k) => k.kind === 'precheck').map((k) => k.local)).toEqual([true, false]);
    expect(c.lot.warnings.join('\n')).toContain('appel d\'outil écrit en texte');
  });

  it('R4 — après un échec du local, les lots suivants de la vague vont droit à Sonnet, avec la raison au journal', async () => {
    const h = harness({ lots: [{ title: 'un' }, { title: 'deux' }], script: { precheck: [textCall, () => claudeOut(precheckReport()), () => claudeOut(precheckReport())], implement: [impl, impl], review: [ok, ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    const a = h.lot('L1', {}, localCfg);
    await runLot(a);
    const b = h.lot('L2', {}, localCfg);
    await runLot(b);
    expect(h.calls.filter((k) => k.kind === 'precheck').map((k) => k.local)).toEqual([true, false, false]);
    expect(b.lot.warnings.join('\n')).toMatch(/modèle local écarté pour la vague/);
    expect(b.lot.status).toBe('ready');
  });

  it('R4 — « Autocompact is thrashing » écarte aussi le local pour la vague', async () => {
    const h = harness({ lots: [{ title: 'un' }, { title: 'deux' }], script: { precheck: [thrash, () => claudeOut(precheckReport()), () => claudeOut(precheckReport())], implement: [impl, impl], review: [ok, ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    await runLot(h.lot('L1', {}, localCfg));
    await runLot(h.lot('L2', {}, localCfg));
    expect(h.calls.filter((k) => k.kind === 'precheck').map((k) => k.local)).toEqual([true, false, false]);
  });

  it('R4 — un rapport local illisible écarte lui aussi le local pour la vague', async () => {
    const h = harness({ lots: [{ title: 'un' }, { title: 'deux' }], script: { precheck: [() => claudeOut({ nimporte: 1 }), () => claudeOut(precheckReport()), () => claudeOut(precheckReport())], implement: [impl, impl], review: [ok, ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    await runLot(h.lot('L1', {}, localCfg));
    await runLot(h.lot('L2', {}, localCfg));
    expect(h.calls.filter((k) => k.kind === 'precheck').map((k) => k.local)).toEqual([true, false, false]);
  });

  it('R4 — un local qui a répondu reste utilisé pour le lot suivant', async () => {
    const h = harness({ lots: [{ title: 'un' }, { title: 'deux' }], script: { precheck: [() => claudeOut(precheckReport()), () => claudeOut(precheckReport())], implement: [impl, impl], review: [ok, ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    await runLot(h.lot('L1', {}, localCfg));
    await runLot(h.lot('L2', {}, localCfg));
    expect(h.calls.filter((k) => k.kind === 'precheck').map((k) => k.local)).toEqual([true, true]);
  });

  it('R5 — le brief local porte le lot (titre, notes, sous-tâches) et interdit d\'ouvrir le plan : la fenêtre de 64 k ne se remplit plus d\'un plan de plusieurs centaines de ko', async () => {
    const h = harness({ lots: [{ title: 'un lot à contrôler' }], script: { precheck: [() => claudeOut(precheckReport()), () => claudeOut(precheckReport())], implement: [impl], review: [ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    const c = h.lot('L1', {}, localCfg);
    await runLot(c);
    const local = h.calls[0].brief;
    expect(h.calls[0].local).toBe(true);
    expect(local).toContain('un lot à contrôler');
    expect(local).toMatch(/do not open the plan file/i);
    expect(local).not.toMatch(/Read the lot, its notes and sub-tasks in the plan/);
  });

  it('R5 — le brief de Sonnet reste celui d\'avant : il lit le plan lui-même', async () => {
    const h = harness({ lots: [{ title: 'un, suite de la revue' }], script: { precheck: [() => claudeOut(precheckReport())], implement: [impl], review: [ok] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    await runLot(h.lot('L1', {}, { precheck: true }));
    expect(h.calls[0].local).toBe(false);
    expect(h.calls[0].brief).toMatch(/Read the lot, its notes and sub-tasks in the plan/);
  });

  it('R5 — le gabarit rendu sans variable de lecture garde la lecture du plan par la session', () => {
    const brief = renderBrief('precheck', { chemin: '/r', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' });
    expect(brief).toMatch(/Read the lot, its notes and sub-tasks in the plan/);
  });

  it('R6 — un « oui » local reste confirmé par Sonnet', async () => {
    const yes = precheckReport({ dejaPresent: 'oui', preuves: ['a.ts:1'], resume: 'fait' });
    const h = harness({ lots: [{ title: 'un' }], script: { precheck: [() => claudeOut(yes), () => claudeOut(yes)] } });
    commitFile(h.repo, 'code.txt', 'feat: du code');
    const c = h.lot('L1', {}, localCfg);
    await runLot(c);
    expect(h.calls.filter((k) => k.kind === 'precheck').map((k) => k.local)).toEqual([true, false]);
    expect(c.lot.status).toBe('handed-back');
  });
});
