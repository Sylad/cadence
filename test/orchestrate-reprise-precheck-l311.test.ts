import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '../src/orchestrate/state.js';
import { MAX_PASSES } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, WAVE } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L311 — la reprise d'une branche conservée (L301) ne repasse pas par le contrôle préalable : ses propres commits lui feraient dire « livrable déjà présent ».
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const majeur = { gravite: 'majeur', fichier: 'f.txt', ligne: 1, texte: 'le cas vide plante' };
const nonConforme = reviewReport({ majeurs: 1, constats: [majeur], verdict: 'non conforme' });

/** Première vague : L2 (qui cite L1, donc soumis au contrôle préalable) est rendu sur une revue non conforme ; le contrôle préalable est ensuite activé pour la vague suivante. */
async function premiereVague() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux, suite de L1' }]);
  const f1 = fake({ review: async (_cwd, brief) => claudeOut(lotOf(brief) === 'L2' ? nonConforme : reviewReport()) });
  await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f1);
  expect(new RunStore(parent, WAVE).readLot('a', 'L2')!.status).toBe('handed-back');
  writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: true\n  worktrees: true\n');
  git(repo, 'add', '--', 'cadence.yaml');
  git(repo, 'commit', '-q', '-m', 'chore: precheck actif');
  return { parent, repo };
}

describe('R5 — la correction de départ d\'un lot repris est une passe de correction', () => {
  const fixer = () => async (cwd: string, brief: string) => claudeOut(workReport({ commits: [commitFile(cwd, `corr-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`, `fix(${lotOf(brief)}): corrige`)] }));

  it('R5 — après la correction de départ, pass vaut 1 et le verdict dit « 1 passe(s) de correction »', async () => {
    const { parent } = await premiereVague();
    const f2 = fake({ review: async () => claudeOut(reviewReport()), fix: fixer() });
    await run(parent, ['a:L2'], f2);
    expect(f2.calls.map((c) => c.kind)[0]).toBe('fix');
    const lot = new RunStore(parent, `${WAVE}-2`).readLot('a', 'L2')!;
    expect(lot.status).toBe('ready');
    expect(lot.pass).toBe(1);
    expect(lot.verdict).toContain('1 passe(s) de correction');
    expect(lot.verdict).not.toContain('0 passe(s)');
  });

  it('R6 — revues toujours non conformes : au plus MAX_PASSES corrections en tout, reprise comprise, puis le lot est rendu', async () => {
    const { parent } = await premiereVague();
    const f2 = fake({ review: async () => claudeOut(nonConforme), fix: fixer() });
    await run(parent, ['a:L2'], f2);
    const lot = new RunStore(parent, `${WAVE}-2`).readLot('a', 'L2')!;
    expect(f2.calls.filter((c) => c.kind === 'fix')).toHaveLength(MAX_PASSES);
    expect(lot.pass).toBe(MAX_PASSES);
    expect(lot.status).toBe('handed-back');
    expect(lot.outcome ?? '').toContain(`${MAX_PASSES} passe(s) de correction`);
  });
});

describe('R1 — un lot repris de sa branche ne repasse pas par le contrôle préalable', () => {
  it('R1 — la branche porte des commits du lot : aucune session precheck, le lot repart à la correction avec les constats de sa dernière revue', async () => {
    const { parent } = await premiereVague();
    const f2 = fake({
      review: async () => claudeOut(reviewReport()),
      fix: async (cwd, brief) => claudeOut(workReport({ commits: [commitFile(cwd, 'L2-corrige.txt', `fix(${lotOf(brief)}): corrige`)] })),
    });
    const r = await run(parent, ['a:L2'], f2);
    const kinds = f2.calls.map((c) => c.kind);
    expect(kinds).not.toContain('precheck');
    expect(kinds).not.toContain('implement');
    expect(kinds[0]).toBe('fix');
    expect(f2.calls[0].brief).toContain('le cas vide plante');
    expect(r.out).toContain('reprise');
    expect(new RunStore(parent, `${WAVE}-2`).readLot('a', 'L2')!.status).toBe('ready');
  });

  it('R2 — la dernière revue n\'a laissé aucun constat : le lot repart à la revue, pas à une implémentation', async () => {
    const { parent } = await premiereVague();
    const file = join(new RunStore(parent, WAVE).dir, 'a--L2.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...old, constats: [] }));
    const f2 = fake();
    await run(parent, ['a:L2'], f2);
    const kinds = f2.calls.map((c) => c.kind);
    expect(kinds).not.toContain('precheck');
    expect(kinds).not.toContain('implement');
    expect(kinds[0]).toMatch(/^review/);
  });

  it('R4 — un lot rendu avant sa première revue (aucune étape review, aucun constat) ne repasse pas par le contrôle préalable : il rejoue la chaîne d\'un lot neuf à partir de l\'écriture', async () => {
    const { parent } = await premiereVague();
    const file = join(new RunStore(parent, WAVE).dir, 'a--L2.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...old, constats: [], steps: old.steps.filter((s: { kind: string }) => !s.kind.startsWith('review')) }));
    const f2 = fake();
    await run(parent, ['a:L2'], f2);
    const kinds = f2.calls.map((c) => c.kind);
    expect(kinds).not.toContain('precheck');
    expect(kinds).not.toContain('fix');
    expect(kinds[0]).toBe('implement');
  });

  it('L318 — un lot rendu pour tests rouges sans aucune revue (constat source tests, aucune étape review) n\'est pas tenu pour déjà revu (resumedReviewed faux), il repart à la correction de ses tests rouges', async () => {
    const { parent } = await premiereVague();
    const file = join(new RunStore(parent, WAVE).dir, 'a--L2.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    const rouges = [{ source: 'tests', gravite: 'majeur', description: 'npm test : 2 failed' }];
    writeFileSync(file, JSON.stringify({ ...old, constats: rouges, steps: old.steps.filter((s: { kind: string }) => !s.kind.startsWith('review')) }));
    const f2 = fake();
    await run(parent, ['a:L2'], f2);
    const kinds = f2.calls.map((c) => c.kind);
    expect(kinds).not.toContain('precheck');
    expect(kinds[0]).toBe('fix');
    expect(new RunStore(parent, `${WAVE}-2`).readLot('a', 'L2')!.resumedReviewed).toBe(false);
  });

  it('R3 — un lot neuf qui cite un autre lot passe toujours par le contrôle préalable', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux, suite de L1' }]);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  precheck: true\n  worktrees: true\n');
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: precheck actif');
    const f = fake();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(f.calls.filter((c) => c.kind === 'precheck' && c.lot === 'L2')).toHaveLength(1);
  });
});
