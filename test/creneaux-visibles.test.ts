import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { run } from '../src/cli.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { tempDir } from './helpers.js';

// L416 : les créneaux libres se lisent toujours, et le release montre ce qu'il laisse (29-10 : plafond 3 pris pour 2, un créneau vide plus d'une heure).
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});

const T0 = new Date('2026-10-29T10:00:00Z');

async function cad(dir: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-29', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => T0 });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Dossier qui est lui-même un projet git, avec `lots` lots prêts. */
async function project(lots = 0): Promise<string> {
  const dir = tempDir();
  await cad(dir, {}, 'init', '--project', 'alpha', '--no-hook');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  for (let i = 1; i <= lots; i++) plan.add(`Lot prêt ${i}`, '2026-10-29', { estimate: 1 });
  plan.save();
  return dir;
}

describe('L416 — créneaux toujours visibles', () => {
  it('R1 — lead tour affiche « créneaux libres : N sur M » sans vague ni session du lead, au plafond réglé', async () => {
    const root = await project();
    const out = (await cad(root, { CADENCE_MAX_SESSIONS: '3' }, 'lead', 'tour')).out;
    expect(out).toContain('vagues en cours : 0 · sessions en cours : 0 · créneaux libres : 3 sur 3');
    expect(out).not.toContain('sessions du lead');
  });

  it('R1 — lead tour --json reste un JSON pur : la ligne n\'y entre pas', async () => {
    const root = await project();
    expect(Array.isArray(JSON.parse((await cad(root, {}, 'lead', 'tour', '--json')).out))).toBe(true);
  });

  it('R2 — lead tour affiche « prêts, ressources libres » sans vague ni session du lead', async () => {
    const root = await project(1);
    expect((await cad(root, {}, 'lead', 'tour')).out).toMatch(/prêts, ressources libres : .*L\d+ Lot prêt 1/);
  });

  it('R3 — lead release affiche les créneaux libres après la libération, avec la ligne des lots prêts et un ⚠ quand un créneau reste libre', async () => {
    const root = await project(1);
    await cad(root, { CADENCE_MAX_SESSIONS: '3' }, 'lead', 'hold', 'qa');
    const r = await cad(root, { CADENCE_MAX_SESSIONS: '3' }, 'lead', 'release', 'qa');
    const lines = r.out.split('\n');
    expect(r.code).toBe(0);
    expect(lines[0]).toBe('session « qa » rendue');
    expect(lines[1]).toBe('vagues en cours : 0 · sessions en cours : 0 · créneaux libres : 3 sur 3');
    expect(lines[2]).toMatch(/^prêts, ressources libres : .*L\d+ Lot prêt 1/);
    expect(lines[3]).toBe('⚠ 3 créneaux libres sur 3 : lancer un lot prêt ou une session, un créneau vide ne sert à rien');
  });

  it('R3 — le ⚠ dit « 1 créneau libre » au singulier, et se tait quand plus aucun créneau n\'est libre', async () => {
    const root = await project();
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-29-1000', started: '2026-10-29T10:00:00Z', cwd: root, repos: ['/x/a'], cap: 2 });
    await cad(root, {}, 'lead', 'hold', 'qa');
    await cad(root, {}, 'lead', 'hold', 'revue');
    const one = (await cad(root, {}, 'lead', 'release', 'qa')).out;
    expect(one).toContain('créneaux libres : 0 sur 2'); // la vague (1) + revue (1) = 2 pris
    expect(one).not.toContain('⚠');
    const two = (await cad(root, {}, 'lead', 'release', 'revue')).out;
    expect(two).toContain('⚠ 1 créneau libre sur 2 : ');
    unregisterWave(cadenceHome(), process.ppid);
  });

  it('R3 — rendre une session qui n\'est pas inscrite montre aussi les créneaux, et sort en 0', async () => {
    const root = await project();
    const r = await cad(root, {}, 'lead', 'release', 'inconnue');
    expect(r.code).toBe(0);
    expect(r.out).toContain('aucune session « inconnue » inscrite');
    expect(r.out).toContain('créneaux libres : 2 sur 2');
  });

  it('R3 — hold n\'affiche pas les créneaux : seule la libération le fait', async () => {
    const root = await project();
    expect((await cad(root, {}, 'lead', 'hold', 'qa')).out).not.toContain('vagues en cours');
  });
});
