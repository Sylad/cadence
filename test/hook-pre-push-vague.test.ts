import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { installPrePush, removePrePush } from '../src/orchestrate/guard.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { registerWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type LotState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const ZERO = '0'.repeat(40);

async function cli(dir: string, stdin: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-28T10:00:00'), stdin: () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const sha = (dir: string, rev: string) => execFileSync('git', ['rev-parse', rev], { cwd: dir, encoding: 'utf8' }).trim();

/** Un dépôt : commit de plan P, puis A (L1), B (L2), C (L1) ; une vague vivante qui tient le verrou du dépôt avec les lots donnés. */
async function vague(statuses: Record<string, LotState['status']>) {
  const dir = gitRepo();
  await cli(dir, '', 'init', '--no-hook');
  for (const t of ['Un', 'Deux']) await cli(dir, '', 'add', `${t} lot`);
  for (const l of ['L1', 'L2']) await cli(dir, '', 'start', l);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: plan');
  const shas: Record<string, string> = { P: sha(dir, 'HEAD') };
  for (const [name, lot] of [['A', 'L1'], ['B', 'L2'], ['C', 'L1']]) {
    writeFileSync(join(dir, `${name}.ts`), `export const ${name} = 1;\n`);
    execFileSync('git', ['add', `${name}.ts`], { cwd: dir });
    commit(dir, `feat(${lot}): ${name}`, '2026-10-28T10:00:00');
    shas[name] = sha(dir, 'HEAD');
  }
  const launch = tempDir();
  const home = tempDir();
  const store = RunStore.reserve(launch, 'w9')!;
  store.writeWave({ id: 'w9', status: 'running', created: 'x', lots: Object.keys(statuses) } as never);
  for (const [key, status] of Object.entries(statuses)) {
    const [project, lot] = key.split(':');
    store.writeLot({ ...newLot({ project, repo: dir, lot, title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status });
  }
  mkdirSync(sharedStateDir(dir), { recursive: true });
  writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
  registerWave(home, { pid: process.pid, wave: 'w9', started: 'x', cwd: launch, repos: [dir] });
  return { dir, shas, home };
}

/** La ligne que git écrit sur l'entrée standard d'un pre-push. */
const line = (local: string, remote: string, ref = 'refs/heads/main') => `${ref} ${local} ${ref} ${remote}\n`;

describe('hook pre-push posé par la vague : un push qui emporte un lot pas prêt (L405)', () => {
  let saved: string | undefined;
  afterEach(() => {
    process.env.CADENCE_HOME = saved;
  });
  const avec = async (statuses: Record<string, LotState['status']>) => {
    const w = await vague(statuses);
    saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = w.home;
    return w;
  };

  it('R1 — un push qui emporte le commit d\'un lot pas prêt est refusé (code 3), le lot est nommé avec son état', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('ici:L2');
    expect(r.err).toContain('vague w9');
  });

  it('R2 — le refus donne la commande sûre : git push origin <dernier sha livrable>:<branche>', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.err).toContain(`git push origin ${shas.A}:main`);
  });

  it('R3 — un push dont tous les commits citent des lots prêts ou le plan passe', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    expect((await cli(dir, line(shas.A, shas.P), 'hook', 'pre-push')).code).toBe(0);
    expect((await cli(dir, line(shas.P, ZERO), 'hook', 'pre-push')).code).toBe(0);
  });

  it('R4 — sans vague vivante qui tient le dépôt, rien n\'est refusé', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    writeFileSync(join(sharedStateDir(dir), REPO_LOCK), JSON.stringify({ pid: 2 ** 22 + 12345, wave: 'w9', started: 'x' }));
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(0);
  });

  it('R5 — le commit d\'un lot pas prêt déjà sur le distant n\'est pas emporté par le push : il ne bloque pas', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    // le distant est déjà en B (lot L2 pas prêt) : pousser C n'emporte que C, un commit de L1 prêt
    const r = await cli(dir, line(shas.C, shas.B), 'hook', 'pre-push');
    expect(r.code).toBe(0);
  });

  it('R6 — la suppression d\'une branche (sha local nul) n\'emporte aucun commit : acceptée', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(ZERO, shas.C, 'refs/heads/autre'), 'hook', 'pre-push');
    expect(r.code).toBe(0);
  });

  it('R7 — une branche créée (sha distant nul) est examinée sur toute son histoire, et la commande sûre vise cette branche', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, ZERO, 'refs/heads/feature'), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain(`git push origin ${shas.A}:feature`);
  });

  it('R8 — quand aucun commit de la plage n\'est livrable, le refus le dit au lieu de proposer une commande', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'implementing', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('aucun commit livrable');
    expect(r.err).not.toContain('git push origin');
  });

  it('R9 — l\'état de la vague illisible ne bloque pas un push : avertissement, code 0', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    process.env.CADENCE_HOME = tempDir();
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(0);
  });

  it('R10 — le hook posé par la vague appelle « raf hook pre-push » et ne refuse que sur le code 3, ses sessions restent refusées d\'abord', () => {
    const dir = gitRepo();
    expect(installPrePush(dir, 'w9').ok).toBe(true);
    const text = readFileSync(join(dir, '.git/hooks/pre-push'), 'utf8');
    removePrePush(dir, 'w9');
    expect(text).toMatch(/raf hook pre-push/);
    expect(text).toMatch(/\[ \$\? -ne 3 \] \|\| exit 1/);
    expect(text.indexOf('CADENCE_ORCHESTRATED')).toBeLessThan(text.indexOf('raf hook pre-push'));
  });
});
