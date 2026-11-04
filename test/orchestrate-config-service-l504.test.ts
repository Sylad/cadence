import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, run, setup, store, WAVE } from './orchestrate-worktree-harness.js';
import { lotTreeDir } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

// L504 — une clé de config posée avant sa mise en service ne casse plus ni le dépôt ni la vague.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));

async function handedBack() {
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
  const f = fake({ review: blocking, fix: (cwd) => claudeOut({ commits: [commitFile(cwd, 'L1-fix.txt', 'fix(L1): travail')], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok' } as never) });
  const first = await run(parent, ['a:L1', 'a:L2'], f);
  if (first.code === 2) throw new Error(first.err);
  const dir = lotTreeDir(store(parent).dir, 'a', 'L1', repo);
  commitFile(dir, 'lead.txt', 'fix(L1): correction du lead hors vague');
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.recordReview('L1', 'conforme : relu par le lead', '2026-10-27', git(dir, 'rev-parse', 'HEAD'));
  plan.save();
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: revue du lead L1');
  return { parent, repo, dir };
}

const ORIGINAL = 'orchestrate:\n  precheck: false\n  worktrees: true\n';

/** Commite dans le worktree un cadence.yaml qui pose `extra` dans orchestrate. */
function setConfig(cwd: string, extra: string, lot = 'L1') {
  writeFileSync(join(cwd, 'cadence.yaml'), `${ORIGINAL}${extra}`);
  git(cwd, 'add', '--', 'cadence.yaml');
  git(cwd, 'commit', '-q', '-m', `feat(${lot}): config`);
  return { sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): config` };
}

describe('R1 — la porte refuse un lot qui pose une clé inconnue de la copie en service', () => {
  it('R1 — clé inconnue posée dans cadence.yaml : correction avec le nom de la clé, le lot repart prêt une fois la clé retirée', async () => {
    const { parent } = setup([{ title: 'un' }]);
    const f = fake({
      implement: (cwd) => claudeOut(workReport({ commits: [setConfig(cwd, '  cleInconnue: true\n')] })),
      fix: (cwd) => claudeOut(workReport({ commits: [setConfig(cwd, '')] })),
    });
    const r = await run(parent, ['a:L1'], f);
    expect(r.code).toBe(0);
    const fixes = f.calls.filter((c) => c.kind === 'fix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.brief).toContain('cleInconnue');
    expect(fixes[0]!.brief).toContain('npm run service');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
  });
  it('R1 — clé connue posée dans cadence.yaml : aucune correction', async () => {
    const { parent } = setup([{ title: 'un' }]);
    const f = fake({ implement: (cwd) => claudeOut(workReport({ commits: [setConfig(cwd, '  probe: true\n')] })) });
    const r = await run(parent, ['a:L1'], f);
    expect(r.code).toBe(0);
    expect(f.calls.filter((c) => c.kind === 'fix')).toHaveLength(0);
  });
  it('R1 — cadence.yaml déjà invalide au départ et non touché par le lot : pas de correction (ce n\'est pas son défaut)', async () => {
    const { parent, repo } = setup([{ title: 'un' }]);
    // `news: 42` : la vague démarre (le départ ne relit qu'`orchestrate:`) et seule la relecture complète de la porte la refuserait.
    writeFileSync(join(repo, 'cadence.yaml'), `${ORIGINAL}news: 42\n`);
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: clé');
    const f = fake();
    const r = await run(parent, ['a:L1'], f);
    expect(r.code).toBe(0);
    expect(f.calls.filter((c) => c.kind === 'implement')).toHaveLength(1);
    expect(f.calls.filter((c) => c.kind === 'fix')).toHaveLength(0);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
  });
});

describe('R2 — une reprise --integrate qui meurt sur une erreur de config ne laisse rien de suspendu', () => {
  it('R2 — config illisible : refus (2) avant toute écriture, le lot reste rendu à l\'intégration et la vague terminée', async () => {
    const { parent, repo } = await handedBack();
    writeFileSync(join(repo, 'cadence.yaml'), `${ORIGINAL}  cleInconnue: true\n`);
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: clé');
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestrate.cleInconnue inconnu');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(store(parent).readWave()!.status).toBe('done');
  });
  it('R2 — la config corrigée, la même commande intègre le lot', async () => {
    const { parent, repo } = await handedBack();
    writeFileSync(join(repo, 'cadence.yaml'), `${ORIGINAL}  cleInconnue: true\n`);
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: clé');
    await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    writeFileSync(join(repo, 'cadence.yaml'), ORIGINAL);
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: clé retirée');
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.err).toBe('');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
  });
  it('R2 — lot déjà resté « suspended » à l\'intégration dans une vague terminée : --integrate le reprend', async () => {
    const { parent } = await handedBack();
    const s = store(parent);
    const l = s.readLot('a', 'L1')!;
    l.status = 'suspended';
    l.next = 'integrate';
    l.outcome = null;
    s.writeLot(l);
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.err).toBe('');
    expect(s.readLot('a', 'L1')!.status).toBe('ready');
  });
  it('R2 — lot suspendu à l\'intégration dans une vague non terminée : --integrate reste refusé', async () => {
    const { parent } = await handedBack();
    const s = store(parent);
    const l = s.readLot('a', 'L1')!;
    l.status = 'suspended';
    l.next = 'integrate';
    l.outcome = null;
    s.writeLot(l);
    const w = s.readWave()!;
    w.status = 'interrupted';
    s.writeWave(w);
    const r = await run(parent, ['--resume', WAVE, '--integrate', 'a:L1'], fake());
    expect(r.code).toBe(2);
    expect(r.err).toContain("le lot n'est pas rendu");
  });
});
