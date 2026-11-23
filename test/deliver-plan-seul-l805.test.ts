// L805 : deliver --sha comptait comme du travail un commit de plan au sens du hook pre-push (L784) — registre .cadence/demandes, fichiers de plan.onWrite.
// Vécu ol 22-11 : 8c12b1d « plan(L269): … » (plan + demande) a bloqué la livraison de L262, contourné par `raf ignore`.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveryLots } from '../src/audit.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Plan de deux lots : L1 (livré, terminé) et L2 (ouvert, à faire) ; `onWrite` déclare public/plan.json régénéré par le plan. */
function repo(onWrite = false): { dir: string; planFile: string; base: string } {
  const dir = gitRepo();
  const planFile = join(dir, '.cadence/raf.yaml');
  const plan = Plan.create(planFile, 'demo', 'L', '2026-09-28');
  plan.add('Livré', '2026-09-28');
  plan.add('Ouvert', '2026-09-28');
  plan.save();
  if (onWrite) writeFileSync(join(dir, 'cadence.yaml'), "plan:\n  path: .cadence/raf.yaml\n  onWrite: { command: 'true', files: [public/plan.json] }\n");
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  return { dir, planFile, base: headSha(dir)! };
}

function change(dir: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(dir, 'add', file);
  }
  commit(dir, message);
  return headSha(dir)!;
}

const demande = (n: number) => ({ [`.cadence/demandes/D-${n}.json`]: `${JSON.stringify({ id: `D-${n}`, texte: 'x', etat: 'ouverte' })}\n` });

function lotsAt(dir: string, planFile: string, sha: string, base: string) {
  const plan = Plan.load(planFile);
  plan.setStatus('L1', 'done', '2026-09-28', { force: true });
  return deliveryLots(plan, dir, sha, base);
}

describe('deliver --sha : un commit de plan au sens du hook pre-push n\'est pas du travail du lot qu\'il cite (L805)', () => {
  it('R1 — plan + demande du registre, sujet « plan(L2): … » : L2 ne bloque pas la livraison de L1 (8c12b1d, ol 22-11)', () => {
    const { dir, planFile, base } = repo();
    change(dir, { 'src/a.ts': '1\n' }, 'feat(L1): un');
    const plan = Plan.load(planFile);
    plan.add('Suite', '2026-09-28');
    plan.save();
    git(dir, 'add', '.cadence/raf.yaml');
    const sha = change(dir, demande(7), 'plan(L2): suite ouverte (D-7)');
    const lots = lotsAt(dir, planFile, sha, base);
    expect(lots.map((l) => l.id)).toEqual(['L1']);
    expect(lots.filter((l) => l.blocking)).toEqual([]);
  });

  it('R2 — demande seule + sortie de plan.onWrite (public/plan.json) : L2 ne bloque pas', () => {
    const { dir, planFile, base } = repo(true);
    change(dir, { 'src/a.ts': '1\n' }, 'feat(L1): un');
    const sha = change(dir, { 'public/plan.json': '{}\n', ...demande(8) }, 'plan(L2): demande D-8');
    const lots = lotsAt(dir, planFile, sha, base);
    expect(lots.filter((l) => l.blocking)).toEqual([]);
  });

  it('R3 — le même commit qui touche aussi du code reste du travail de L2 : il bloque, non relu', () => {
    const { dir, planFile, base } = repo();
    change(dir, { 'src/a.ts': '1\n' }, 'feat(L1): un');
    const sha = change(dir, { 'src/b.ts': '2\n', ...demande(9) }, 'feat(L2): code et demande');
    const lots = lotsAt(dir, planFile, sha, base);
    expect(lots.filter((l) => l.blocking).map((l) => [l.id, l.state])).toEqual([['L2', 'à faire, non relu']]);
  });

  it('R4 — un lot relu dont un commit de plan au sens du hook suit la revue reste prêt (pas « relu avant 1 commit »)', () => {
    const { dir, planFile, base } = repo();
    const reviewed = change(dir, { 'src/a.ts': '1\n' }, 'feat(L2): code');
    const sha = change(dir, demande(10), 'plan(L2): demande D-10');
    const plan = Plan.load(planFile);
    plan.setStatus('L2', 'doing', '2026-09-28');
    plan.recordReview('L2', 'conforme', '2026-09-28', reviewed);
    const lots = deliveryLots(plan, dir, sha, base);
    expect(lots.map((l) => [l.id, l.state, l.blocking])).toEqual([['L2', 'prêt', false]]);
  });
});
