import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L647 — raf done d'un lot rendu par une vague dont les commits de travail ne sont pas sur la branche principale (06-11 : L646 clos par le lead
// alors que son intégration venait d'être refusée, avec une porte verte qui ne portait pas son code).

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-11-06' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-06T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt sous un dossier de lancement, plan commité (L1 en cours) ; la vague w1 y a rendu L1 (`status`) avec un commit de travail sur sa branche. */
function depot(status: LotState['status'] = 'handed-back', opts: { branch?: boolean } = {}) {
  const launch = tempDir();
  const repo = gitRepo(launch);
  cli(repo, 'init', '--project', 'demo', '--no-hook');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  const store = RunStore.reserve(launch, 'w1')!;
  store.writeWave({ id: 'w1', status: 'done', created: 'x', lots: ['demo:L1'] } as never);
  store.writeLot({ ...newLot({ project: 'demo', repo, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
  if (opts.branch !== false) {
    git(repo, 'switch', '-q', '-c', 'cadence/w1/demo--L1');
    writeFileSync(join(repo, 'code.ts'), 'export const x = 1;\n');
    git(repo, 'add', 'code.ts');
    git(repo, 'commit', '-q', '-m', 'feat(L1): le code');
    git(repo, 'switch', '-q', '-');
  }
  return repo;
}

describe('raf done refuse un lot rendu dont le code n\'est pas sur la branche principale (L647)', () => {
  it('R1 — lot rendu, commits sur sa branche de vague seulement : refus (code 2) qui nomme la branche, le plan n\'est pas écrit', () => {
    const repo = depot();
    const r = cli(repo, 'done', 'L1');
    expect(r.code).toBe(2);
    expect(r.err).toContain('cadence/w1/demo--L1');
    expect(r.err).toContain('--force');
    expect(cli(repo, 'show', 'L1').out).not.toContain('done');
  });

  it('R2 — --force n\'en fait qu\'un avertissement : le lot est clos', () => {
    const repo = depot();
    const r = cli(repo, 'done', 'L1', '--force');
    expect(r.code).toBe(0);
    expect(r.err).toContain('avertissement');
    expect(r.out).toContain('L1 → done');
  });

  it('R3 — le code est sur la branche principale (fusionné) : done passe', () => {
    const repo = depot();
    git(repo, 'merge', '-q', '--no-edit', 'cadence/w1/demo--L1');
    expect(cli(repo, 'done', 'L1').code).toBe(0);
  });

  it('R4 — le code y est repris par cherry-pick (autre sha, même patch) : done passe', () => {
    const repo = depot();
    git(repo, 'cherry-pick', 'cadence/w1/demo--L1');
    expect(cli(repo, 'done', 'L1').code).toBe(0);
  });

  it('R5 — lot prêt (non rendu) ou branche disparue (intégrée puis supprimée) : done passe', () => {
    expect(cli(depot('ready'), 'done', 'L1').code).toBe(0);
    expect(cli(depot('handed-back', { branch: false }), 'done', 'L1').code).toBe(0);
  });
});
