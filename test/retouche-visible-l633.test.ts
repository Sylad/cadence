import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLot } from '../src/orchestrate/cycle.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { budgetStage, lightLot, lightMaquette, stageScreen } from '../src/orchestrate/spec.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

// L633 (issue #43) : un correctif visible sans `screen:` ne joue plus la maquette légère ; implement, capture avant et après, revue UX du seul diff.
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'fix(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const ux = { url: 'http://localhost:4200' };
const FIX = /Visible fix \(L633\)/;
const DIFF_ONLY = /review the diff only/i;

const cycle = async (lot: { title: string; estimate: number; screen?: 'component' | 'page' | 'journey'; visible?: boolean; spec?: boolean }, config: Record<string, unknown> = {}) => {
  const h = harness({ lots: [lot], script: { implement: [impl], review: [ok], 'review-small': [ok], ux: [ok] } });
  const c = h.lot('L1', { visible: !!lot.visible || !!lot.screen, ...(lot.estimate <= 0.1 ? { express: true } : {}), small: lot.estimate <= 0.5, ...(lot.screen ? { screen: lot.screen } : {}) }, { maquette: true, ux, ...config });
  await runLot(c);
  return h;
};
const brief = (h: Awaited<ReturnType<typeof cycle>>, kind: string): string => h.calls.find((x) => x.kind === kind)?.brief ?? '';

describe('R1 — le classement : sans screen:, plus de maquette légère', () => {
  it('R1 — lightMaquette : un lot visible sans screen d\'estimate 0,3 n\'est plus léger ; component et journey le restent', () => {
    const base = { visible: true, estimate: 0.3 };
    expect(lightMaquette({ ...base }, true)).toBe(false);
    expect(lightMaquette({ ...base, screen: 'component' }, true)).toBe(true);
    expect(lightMaquette({ ...base, screen: 'journey' }, true)).toBe(true);
    expect(lightMaquette({ ...base, screen: 'page' }, true)).toBe(false);
  });

  it('R1 — sans screen : aucun écran d\'état, aucune catégorie de budget spec, lightLot faux', () => {
    const h = harness({ lots: [{ title: 'un correctif', estimate: 0.3, visible: true }] });
    const lot = h.plan().lot('L1');
    expect(stageScreen(h.repo, 'docs/specs', lot, true)).toBeUndefined();
    expect(budgetStage(lot, undefined, true, h.repo, 'docs/specs')).toBeUndefined();
    expect(lightLot({}, lot, true, h.repo, 'docs/specs')).toBe(false);
  });

  it('R1 — stageScreen d\'un lot component garde « component » (le plan le déclare)', () => {
    const h = harness({ lots: [{ title: 'un composant', estimate: 0.6, screen: 'component' }] });
    expect(stageScreen(h.repo, 'docs/specs', h.plan().lot('L1'), true)).toBe('component');
  });

  it('R1 — dry-run : un lot visible sans screen d\'estimate 0,3 joue implement puis review-small, sans spec ni maquette, au budget ordinaire', async () => {
    const { parent } = parentWith([{ title: 'un correctif', estimate: 0.3, visible: true }]);
    const r = await dry(parent, ['a:L1']);
    try {
      expect(r.line).toMatch(/étapes : implement \(\w+\)(?: → probe \(\w+\))? → review-small/);
      expect(r.text).not.toMatch(/spec \(|maquette \(/);
      expect(r.text).toContain('budget du lot : 600000');
    } finally {
      removeDryRunBriefs(r.text);
    }
  });

  it('R1 — lot component d\'estimate 0,6 : la chaîne légère est inchangée (spec, maquette)', async () => {
    const { parent } = parentWith([{ title: 'un composant', estimate: 0.6, screen: 'component', visible: true }]);
    const r = await dry(parent, ['a:L1']);
    try {
      expect(r.line).toMatch(/étapes : spec \(sonnet\) → maquette \(opus\) → implement/);
    } finally {
      removeDryRunBriefs(r.text);
    }
  });
});

describe('R2 — le correctif : capture avant et après, revue du seul diff', () => {
  it('R2 — le cycle d\'un lot visible sans screen : implement, review-small, ux ; ni spec ni maquette', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true });
    expect(h.calls.map((c) => c.kind)).not.toContain('spec');
    expect(h.calls.map((c) => c.kind)).not.toContain('maquette');
    expect(h.calls[0]?.kind).toBe('implement');
  });

  it('R2 — le brief implement demande une capture avant et une après, aux deux largeurs', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true });
    const b = brief(h, 'implement');
    expect(b).toMatch(FIX);
    expect(b).toMatch(/before.*after/is);
    expect(b).toContain('1440');
    expect(b).toContain('390');
  });

  it('R2 — le brief implement donne l\'URL et la commande de orchestrate.ux, et le repli nonVerifie sans capture avant', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true }, { ux: { url: 'http://localhost:4200', command: './run-ux.sh' } });
    const b = brief(h, 'implement');
    expect(b).toContain('http://localhost:4200');
    expect(b).toContain('./run-ux.sh');
    expect(b).toMatch(/cannot be captured.*nonVerifie.*never invent/s);
  });

  it('R2 — sans orchestrate.ux, le brief implement du correctif dit de lister la capture manquante sous nonVerifie', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true }, { ux: undefined });
    expect(brief(h, 'implement')).toMatch(/cannot be captured.*nonVerifie/s);
  });

  it('R2 — la revue signale une capture avant absente sous nonVerifie au lieu de la refaire sur l\'arbre modifié', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true });
    const b = brief(h, 'review-small');
    expect(b).toMatch(/avant-\*.*nonVerifie/s);
  });

  it('R2 — la revue UX (review-small d\'un petit lot) ne relit que le diff', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true });
    const b = brief(h, 'review-small');
    expect(b).toMatch(DIFF_ONLY);
    expect(b).toMatch(FIX);
    expect(b).toMatch(/before and after/i);
  });

  it('R2 — la passe ux d\'un lot visible plus gros (0,8) sans screen ne relit aussi que le diff', async () => {
    const h = await cycle({ title: 'un correctif large', estimate: 0.8, visible: true });
    expect(brief(h, 'ux')).toMatch(DIFF_ONLY);
  });

  it('R2 — un lot component garde la chaîne légère : son brief ne porte pas la consigne du correctif', async () => {
    const h = await cycle({ title: 'un composant', estimate: 0.6, screen: 'component' });
    for (const k of ['implement', 'ux']) expect(brief(h, k), k).not.toMatch(FIX);
  });

  it('R2 — un lot non visible et un lot express n\'ont pas la consigne du correctif', async () => {
    const a = await cycle({ title: 'interne', estimate: 0.3 });
    expect(brief(a, 'implement')).not.toMatch(FIX);
    const e = await cycle({ title: 'retouche express', estimate: 0.1, visible: true }, {});
    expect(brief(e, 'implement')).not.toMatch(FIX);
  });

  it('R2 — orchestrate.maquette: false : le correctif garde sa consigne (la voie ne dépend pas de la maquette)', async () => {
    const h = await cycle({ title: 'un correctif', estimate: 0.3, visible: true }, { maquette: false });
    expect(brief(h, 'implement')).toMatch(FIX);
  });
});

type Lot = { title: string; estimate?: number; screen?: 'component' | 'page' | 'journey'; visible?: boolean; spec?: boolean };

function parentWith(lotsOf: Lot[], orch = ''): { parent: string; dir: string } {
  const parent = tempDir();
  const dir = join(parent, 'a');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
  for (const l of lotsOf) plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, visible: l.visible || !!l.screen, screen: l.screen, spec: l.spec });
  plan.save();
  const lines = orch.split('\n').filter(Boolean);
  writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n${['precheck: false', ...lines].map((x) => `  ${x}`).join('\n')}\n`);
  git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
  git(dir, 'commit', '-qm', 'chore: plan');
  return { parent, dir };
}

async function dry(cwd: string, lotsArg: string[]): Promise<{ text: string; line: string }> {
  const out: string[] = [];
  const io: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04', CADENCE_HOME: tempDir() }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-10-04T14:12:00') };
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('pas de session en simulation'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  await orchestrate([...lotsArg, '--dry-run'], io, deps);
  const text = out.join('\n');
  return { text, line: text.split('\n').find((l) => l.includes('étapes :')) ?? '' };
}
