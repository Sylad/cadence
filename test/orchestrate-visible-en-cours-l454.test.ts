import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

// L454 — un lot rendu `visible` par sa propre session (warhammer L37 et L43, 30-10) ne sort pas « prêt » sans étape UX.

const NOTE = 'visible ajouté en cours de vague, étape UX à jouer';
const ok: Handler = () => claudeOut(reviewReport());
const uxOk: Handler = () => claudeOut(reviewReport({ verdict: 'ergonomie conforme (UX)' }));
const withUx = { ux: { url: 'http://localhost:4200' } };
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

/** Session d'écriture qui commite son travail puis pose `visible:` sur son lot dans le plan (commit de plan seul). `h` est lu à l'appel : le scénario est donné au harnais qui le crée. */
const implMakesVisible = (h: () => ReturnType<typeof harness>): Handler => (call) => {
  const { repo } = h();
  const work = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
  const file = join(repo, '.cadence/raf.yaml');
  const plan = Plan.load(file);
  plan.setVisible('L1', true);
  plan.save();
  git(repo, 'add', '--', '.cadence/raf.yaml');
  git(repo, 'commit', '-q', '-m', 'plan: visible', '--', '.cadence/raf.yaml');
  return claudeOut(workReport({ commits: [work] }));
};
const implPlain: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));

describe('R1 — visible posé par la session : l\'étape UX est jouée', () => {
  it('R1 — lot non visible au lancement, visible dans le plan après implement : review puis ux, le lot conclut avec un verdict UX', async () => {
    const h: ReturnType<typeof harness> = harness({ script: { implement: [implMakesVisible(() => h)], review: [ok], ux: [uxOk] } });
    const c = h.lot('L1', {}, withUx);
    expect(c.lot.visible).toBe(false);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review', 'ux']);
    expect(c.lot.visible).toBe(true);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.uxVerdict).toBe('ergonomie conforme (UX)');
    expect(c.lot.uxNote).toBeUndefined();
  });

  it('R1 — petit lot rendu visible par sa session : la revue courte (qui porte l\'ergonomie) remplace la revue de code', async () => {
    const h: ReturnType<typeof harness> = harness({ lots: [{ title: 'Petit', estimate: 0.25 }], script: { implement: [implMakesVisible(() => h)], 'review-small': [ok] } });
    const c = h.lot('L1', { small: true }, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review-small']);
    expect(c.lot.uxVerdict).toBeDefined();
  });
});

describe('R2 — sans application déclarée, le lot est rendu avec la note', () => {
  it('R2 — visible ajouté en cours de vague et pas d\'orchestrate.ux : aucune session ux, la note « visible ajouté en cours de vague, étape UX à jouer » est portée par le lot', async () => {
    const h: ReturnType<typeof harness> = harness({ script: { implement: [implMakesVisible(() => h)], review: [ok] } });
    const c = h.lot('L1', {});
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.uxNote).toContain(NOTE);
  });
});

describe('R3 — rien ne change quand le lot n\'est pas devenu visible', () => {
  it('R3 — lot non visible qui le reste : pas d\'ux, pas de note', async () => {
    const h = harness({ script: { implement: [implPlain], review: [ok] } });
    const c = h.lot('L1', {}, withUx);
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.visible).toBe(false);
    expect(c.lot.uxNote).toBeUndefined();
  });

  it('R3 — lot déjà visible au lancement : la note « ajouté en cours de vague » n\'est jamais posée', async () => {
    const h = harness({ lots: [{ title: 'Écran', visible: true }], script: { implement: [implPlain], review: [ok] } });
    const c = h.lot('L1', { visible: true });
    await runLot(c);
    expect(c.lot.uxNote ?? '').not.toContain(NOTE);
  });

  it('R3 — plan illisible à la relecture : le lot garde son état, sans erreur', async () => {
    const h = harness({ script: { implement: [implPlain], review: [ok] } });
    const c = h.lot('L1', {});
    c.loadPlan = () => {
      throw new Error('plan illisible');
    };
    await expect(runLot(c)).resolves.not.toThrow();
    expect(c.lot.visible).toBe(false);
  });
});
