import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { convergeText } from '../src/orchestrate/cycle/retreci.js';
import { preflight } from '../src/orchestrate/preflight.js';
import { type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const GOAL = 'corriger quatre erreurs de calcul';
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());

function project(screen: 'page' | 'component' | 'journey' | undefined, estimate: number, commits: number): string {
  const dir = join(tempDir(), 'a');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  plan.add('Un lot', '2026-10-01', { estimate, visible: !!screen, screen });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-qm', 'chore: plan');
  for (let i = 0; i < commits; i++) commitFile(dir, `old${i}.txt`, 'feat(L1): déjà intégré');
  return dir;
}

async function launch(dir: string) {
  const io: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-10-04', CADENCE_HOME: tempDir() }, out: () => {}, err: () => {}, now: () => new Date('2026-10-04T14:12:00') };
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('pas de session'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  const r = await preflight({ dryRun: true, goal: GOAL }, [{ project: 'a', projectDir: dir, repo: dir, lot: 'L1', model: 'sonnet' }], io, deps, tempDir());
  expect(r.refusals).toEqual([]);
  return r.lots[0]!;
}

describe('L634 — express lit le screen du plan', () => {
  for (const screen of ['component', 'journey'] as const) {
    it(`L634 — screen: ${screen} d'estimate 0,1 rétréci : pas de voie express`, async () => {
      const s = await launch(project(screen, 0.1, 1));
      expect(s.screen).toBeUndefined();
      expect(s.express).toBeUndefined();
    });
  }
  it('L634 — screen: page d\'estimate 0,05 rétréci : pas de voie express', async () => {
    expect((await launch(project('page', 0.05, 2))).express).toBeUndefined();
  });
});

describe('L634 — revue d\'intégration de rang 2 : sans plage rétrécie, avec la consigne de convergence', () => {
  it('L634 — c.integration posé au rang 2 : pas de from..HEAD, la consigne de convergence reste', async () => {
    const h = harness({ script: { implement: [impl], review: [ok] } });
    commitFile(h.repo, 'old.txt', 'feat(L1): déjà intégré');
    const c = h.lot('L1', { goal: GOAL });
    await runLot(c);
    const from = c.lot.steps[0]!.headBefore!;
    c.integration = { base: 'main' };
    for (const kind of ['review', 'review-small'] as const) {
      const text = convergeText(c, kind);
      expect(text).not.toContain(`${from}..HEAD`);
      expect(text).not.toContain('Judge ONLY');
    }
  });
});
