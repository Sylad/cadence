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
const line = (local: string, remote: string, ref = 'refs/heads/main', remoteRef = ref) => `${ref} ${local} ${remoteRef} ${remote}\n`;

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

  it('R5 — le commit d\'un lot pas prêt déjà sur le distant bloque encore : la garde est celle de la vague (toute l\'ascendance du sha poussé), qui s\'arrêterait sur « push détecté »', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    // le distant est déjà en B (lot L2 pas prêt) : C a B dans son ascendance, `blockingLots` rend L2 comme pour `deliver --sha`
    const r = await cli(dir, line(shas.C, shas.B), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('ici:L2');
    expect(r.err).toContain('aucun commit livrable');
    expect(r.err).not.toContain('git push origin');
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

  it('R11 — la commande sûre vise la branche DISTANTE (3e champ), pas la réf locale : « git push origin <sha>:main » donne « <sha> … refs/heads/main »', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    for (const localRef of [shas.C, 'HEAD', 'refs/heads/feature']) {
      const r = await cli(dir, line(shas.C, shas.P, localRef, 'refs/heads/main'), 'hook', 'pre-push');
      expect(r.code).toBe(3);
      expect(r.err).toContain(`git push origin ${shas.A}:main`);
      expect(r.err).not.toContain(`${shas.A}:${localRef}`);
    }
  });

  it('R12 — la commande sûre nomme le remote reçu en premier argument du hook, « origin » à défaut', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push', 'upstream', 'git@example.com:x/y.git');
    expect(r.err).toContain(`git push upstream ${shas.A}:main`);
    const d = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(d.err).toContain(`git push origin ${shas.A}:main`);
  });

  it('R8 — quand aucun commit de la plage n\'est livrable, le refus le dit au lieu de proposer une commande', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'implementing', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('aucun commit livrable');
    expect(r.err).not.toContain('git push origin');
  });

  it('R13 — un lot pas prêt dont les commits ne se lisent pas (plan qui ne le connaît plus) refuse le push comme deliver --sha, et nomme le lot', async () => {
    // L3 est dans la vague mais pas dans le plan : `gitCommitsIn` jette, la garde le rend « illisible » ; le push de C (L1 prêt + plan) ne bloque sinon rien
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L3': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('commits illisibles');
    expect(r.err).toContain('ici:L3');
    expect(r.err).toContain('vague w9');
    expect(r.err).not.toContain('git push origin');
  });

  it('R14 — un lot illisible et un lot pas prêt dans le même push : le refus nomme les deux, et aucune commande sûre n\'est proposée (aucun sha ne passe la garde)', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing', 'ici:L3': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('ici:L2 (implémentation)');
    expect(r.err).toContain('commits illisibles');
    expect(r.err).toContain('ici:L3');
    expect(r.err).not.toContain(`git push origin ${shas.A}:main`);
  });

  it('R15 — un tag annoté posé au-dessus d\'un lot pas prêt est refusé sans commande sûre : « <sha>:refs/tags/<tag> » publierait un tag qui ne nomme pas son commit', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    execFileSync('git', ['tag', '-a', 'v1', '-m', 'release', shas.C], { cwd: dir });
    const tagObject = sha(dir, 'refs/tags/v1');
    expect(tagObject).not.toBe(shas.C);
    const r = await cli(dir, line(tagObject, ZERO, 'refs/tags/v1'), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('ici:L2');
    expect(r.err).toContain('refs/tags/v1 doit nommer son propre commit');
    expect(r.err).not.toContain('git push origin');
    expect(r.err).not.toContain(':refs/tags/');
    // même pour un tag poussé sous un autre nom distant
    const autre = await cli(dir, line(tagObject, ZERO, 'refs/tags/v1', 'refs/tags/v2'), 'hook', 'pre-push');
    expect(autre.code).toBe(3);
    expect(autre.err).not.toContain('git push origin');
  });

  it('R16 — une branche garde sa commande sûre (refs/heads/ : seul le tag en est privé)', async () => {
    const { dir, shas } = await avec({ 'ici:L1': 'ready', 'ici:L2': 'implementing' });
    const r = await cli(dir, line(shas.C, shas.P, 'refs/heads/release'), 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain(`git push origin ${shas.A}:release`);
    expect(r.err).not.toContain('doit nommer son propre commit');
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
    expect(text).toMatch(/raf hook pre-push "\$@"/);
    expect(text).toMatch(/\[ \$\? -ne 3 \] \|\| exit 1/);
    expect(text.indexOf('CADENCE_ORCHESTRATED')).toBeLessThan(text.indexOf('raf hook pre-push'));
  });
});
