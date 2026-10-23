import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

async function cli(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-23' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-23T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const sha = (dir: string, rev: string) => execFileSync('git', ['rev-parse', rev], { cwd: dir, encoding: 'utf8' }).trim();

/** Un dépôt avec trois commits de travail : A (L1), B (L2), C (L1), puis une vague vivante qui tient le verrou du dépôt. */
async function vague(statuses: Record<string, LotState['status']>, commits = true) {
  const dir = gitRepo();
  await cli(dir, 'init', '--no-hook');
  for (const t of ['Un', 'Deux', 'Trois']) await cli(dir, 'add', `${t} lot`);
  for (const l of ['L1', 'L2', 'L3']) await cli(dir, 'start', l);
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: plan');
  const shas: Record<string, string> = {};
  if (commits) {
    for (const [name, lot] of [['A', 'L1'], ['B', 'L2'], ['C', 'L1']]) {
      // un commit qui ne touche aucun fichier est « du plan » pour git : le travail d'un lot change du code
      writeFileSync(join(dir, `${name}.ts`), `export const ${name} = 1;\n`);
      execFileSync('git', ['add', `${name}.ts`], { cwd: dir });
      commit(dir, `feat(${lot}): ${name}`, '2026-10-23T10:00:00');
      shas[name] = sha(dir, 'HEAD');
    }
  }
  const launch = tempDir();
  const home = tempDir();
  const store = RunStore.reserve(launch, 'w7')!;
  store.writeWave({ id: 'w7', status: 'running', created: 'x', lots: Object.keys(statuses) } as never);
  for (const [key, status] of Object.entries(statuses)) {
    const [project, lot] = key.split(':');
    store.writeLot({ ...newLot({ project, repo: dir, lot, title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
  }
  mkdirSync(sharedStateDir(dir), { recursive: true });
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w7', started: 'x' }));
  registerWave(home, { pid: process.pid, wave: 'w7', started: 'x', cwd: launch, repos: [dir] });
  return { dir, shas, home };
}

describe('livrer au fil de l\'eau pendant une vague (L277)', () => {
  let saved: string | undefined;
  afterEach(() => {
    process.env.CADENCE_HOME = saved;
  });
  const avec = async (statuses: Record<string, LotState['status']>, commits = true) => {
    const w = await vague(statuses, commits);
    saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = w.home;
    return w;
  };

  it('R1 — --sha d\'un commit sous tout lot non prêt : la vague ne bloque plus la livraison', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', shas.A);
    expect(r.err).not.toContain('orchestration en cours');
    // le garde-fou suivant de deliver (sha non poussé) est atteint : la livraison est bien examinée
    expect(r.err).toContain('non poussé');
  });

  it('R2 — --sha qui contient un commit d\'un lot non prêt : refus qui nomme le lot et son état', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w7');
    expect(r.err).toContain('ici:L2');
    expect(r.err).toContain(shas.C.slice(0, 7));
    expect(r.err).not.toContain('non poussé');
  });

  it('R3 — sans --sha la vague refuse comme avant, même quand un lot est prêt', async () => {
    const { dir } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w7');
  });

  it('R4 — un lot en file ou en cours sans aucun commit ne bloque pas le sha d\'un lot prêt', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L3': 'queued' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(r.err).not.toContain('orchestration en cours');
  });

  it('R5 — un lot rendu au lead bloque le sha qui contient ses commits, comme un lot en cours', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'handed-back', 'ici:L3': 'implementing' });
    const refuse = await cli(dir, 'deliver', '--dry-run', '--sha', shas.C);
    expect(refuse.code).toBe(2);
    expect(refuse.err).toContain('ici:L2');
    const accepte = await cli(dir, 'deliver', '--dry-run', '--sha', shas.A);
    expect(accepte.err).not.toContain('orchestration en cours');
  });

  it('R6 — un sha introuvable est refusé sous la vague, sans exception', async () => {
    const { dir } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', 'deadbeef');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w7');
    expect(r.err).toContain('deadbeef');
  });

  it('R7 — état de la vague illisible : on ne peut rien affirmer, --sha refusé aussi', async () => {
    const dir = gitRepo();
    await cli(dir, 'init', '--no-hook');
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n  deploy: echo ok\n  verify:\n    - command: "true"\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: plan');
    mkdirSync(sharedStateDir(dir), { recursive: true });
    writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
    const r = await cli(dir, 'deliver', '--dry-run', '--sha', 'HEAD');
    expect(r.code).toBe(2);
    expect(r.err).toContain('orchestration en cours (vague w9');
  });
});
