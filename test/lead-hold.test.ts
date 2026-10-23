import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { addHold, cadenceHome, freeSlots, liveHolds, registerWave, releaseHold, unregisterWave } from '../src/orchestrate/registry.js';
import { tempDir } from './helpers.js';

// L255 : les sessions lancées à la main par le lead comptent dans les créneaux libres (23-10 : 4 sessions pour un plafond de 3).
// un registre neuf par test : les réservations d'un test ne comptent pas dans le suivant
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});

const T0 = new Date('2026-10-23T10:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** Dossier qui est lui-même un projet : le tour imprime alors sa ligne, puis celle des créneaux. */
async function project(): Promise<string> {
  const dir = tempDir();
  await cad(dir, {}, T0, 'init', '--project', 'alpha', '--no-hook');
  return dir;
}

async function cad(dir: string, env: Record<string, string>, now: Date, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-23', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => now });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('registre des sessions externes du lead (L255)', () => {
  it('R1 — addHold inscrit une session, liveHolds la liste avec son échéance', () => {
    const home = tempDir();
    addHold(home, 'correctif-L12', 30, T0);
    expect(liveHolds(home, minutes(1))).toEqual([{ label: 'correctif-L12', since: T0.toISOString(), expires: minutes(30).toISOString() }]);
  });

  it('R2 — une session dont le TTL est passé ne compte plus et son fichier est écarté', () => {
    const home = tempDir();
    addHold(home, 'revue', 10, T0);
    expect(liveHolds(home, minutes(9))).toHaveLength(1);
    expect(liveHolds(home, minutes(10))).toEqual([]);
    expect(liveHolds(home, minutes(0))).toEqual([]); // écartée par la lecture précédente
  });

  it('R3 — le même libellé posé deux fois se renouvelle, il ne compte pas deux fois', () => {
    const home = tempDir();
    addHold(home, 'qa', 10, T0);
    addHold(home, 'qa', 10, minutes(8));
    const holds = liveHolds(home, minutes(12));
    expect(holds.map((h) => h.label)).toEqual(['qa']);
    expect(holds[0]!.expires).toBe(minutes(18).toISOString());
  });

  it('R4 — releaseHold retire la session ; rendre deux fois ou un inconnu ne casse rien', () => {
    const home = tempDir();
    addHold(home, 'qa', 10, T0);
    expect(releaseHold(home, 'qa')).toBe(true);
    expect(releaseHold(home, 'qa')).toBe(false);
    expect(liveHolds(home, T0)).toEqual([]);
  });

  it('R5 — un libellé avec des « / » ou des espaces est un libellé comme un autre', () => {
    const home = tempDir();
    addHold(home, '../évadé/ L1', 10, T0);
    expect(liveHolds(home, T0).map((h) => h.label)).toEqual(['../évadé/ L1']);
    expect(releaseHold(home, '../évadé/ L1')).toBe(true);
  });

  it('R6 — freeSlots soustrait une session du lead par créneau pris (4 sessions pour un plafond de 3)', () => {
    const wave = { pid: 1, wave: 'w', started: 'x', cwd: '/p', repos: ['/p/a', '/p/b'], cap: 3 };
    expect(freeSlots([wave], 3)).toBe(1);
    expect(freeSlots([wave], 3, 1)).toBe(0);
    expect(freeSlots([wave], 3, 2)).toBe(0); // jamais négatif
    expect(freeSlots([], 3, 2)).toBe(1);
  });
});

describe('cadence lead hold / release (L255)', () => {
  it('R7 — lead hold inscrit la session, lead release la rend', async () => {
    const dir = tempDir();
    const h = await cad(dir, {}, T0, 'lead', 'hold', 'correctif-L12', '--ttl', '30');
    expect(h.code).toBe(0);
    expect(h.out).toContain('correctif-L12');
    expect(liveHolds(cadenceHome(), minutes(1)).map((x) => x.label)).toEqual(['correctif-L12']);
    const r = await cad(dir, {}, T0, 'lead', 'release', 'correctif-L12');
    expect(r.code).toBe(0);
    expect(liveHolds(cadenceHome(), minutes(1))).toEqual([]);
    const again = await cad(dir, {}, T0, 'lead', 'release', 'correctif-L12');
    expect(again.code).toBe(0);
    expect(again.out).toContain('aucune session');
  });

  it('R8 — sans --ttl, la réservation dure 60 minutes', async () => {
    const dir = tempDir();
    await cad(dir, {}, T0, 'lead', 'hold', 'revue');
    expect(liveHolds(cadenceHome(), minutes(59))).toHaveLength(1);
    expect(liveHolds(cadenceHome(), minutes(60))).toEqual([]);
  });

  it('R9 — libellé absent ou vide, --ttl invalide : refus avant d\'écrire', async () => {
    const dir = tempDir();
    for (const argv of [['lead', 'hold'], ['lead', 'hold', ' '], ['lead', 'hold', 'a', 'b'], ['lead', 'hold', 'a', '--ttl', '0'], ['lead', 'hold', 'a', '--ttl', 'abc'], ['lead', 'release'], ['lead', 'release', 'a', 'b'], ['lead', 'release', 'a', '--ttl', '5']]) {
      const r = await cad(dir, {}, T0, ...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toMatch(/usage|ttl/);
    }
    expect(liveHolds(cadenceHome(), T0)).toEqual([]);
  });

  it('R10 — lead tour compte les sessions du lead : 4 sessions pour un plafond de 3 ne se voient plus libres', async () => {
    const root = await project();
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-23-1000', started: '2026-10-23T10:00:00Z', cwd: root, repos: ['/x/a', '/x/b'], cap: 3 });
    const env = { CADENCE_MAX_SESSIONS: '3' };
    const before = await cad(root, env, T0, 'lead', 'tour');
    expect(before.out).toContain('créneaux libres : 1 sur 3');
    await cad(root, env, T0, 'lead', 'hold', 'correctif');
    const after = await cad(root, env, minutes(1), 'lead', 'tour');
    expect(after.out).toContain('sessions du lead : 1 (correctif) · créneaux libres : 0 sur 3');
    await cad(root, env, T0, 'lead', 'release', 'correctif');
    expect((await cad(root, env, minutes(2), 'lead', 'tour')).out).toContain('créneaux libres : 1 sur 3');
    unregisterWave(cadenceHome(), process.ppid);
  });

  it('R11 — sans vague, une session du lead suffit à afficher la ligne ; sans rien, aucune ligne', async () => {
    const root = await project();
    expect((await cad(root, {}, T0, 'lead', 'tour')).out).not.toContain('créneaux libres');
    await cad(root, {}, T0, 'lead', 'hold', 'qa');
    expect((await cad(root, {}, minutes(1), 'lead', 'tour')).out).toContain('vagues en cours : 0 · sessions en cours : 0 · sessions du lead : 1 (qa) · créneaux libres : 1 sur 2');
  });

  it('R12 — orchestrate --status affiche la même ligne, TTL passé écarté', async () => {
    const dir = tempDir();
    const status = async (now: Date) => {
      const out: string[] = [];
      const i: OrchestrateIo = { cwd: dir, env: { RAF_TODAY: '2026-10-23', CADENCE_MAX_SESSIONS: '3' }, out: (l) => out.push(l), err: () => {}, now: () => now };
      await orchestrate(['--status'], i, {} as never);
      return out.join('\n');
    };
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-23-1000', started: '2026-10-23T10:00:00Z', cwd: '/ailleurs', repos: ['/x/a'], cap: 3 });
    addHold(cadenceHome(), 'revue', 30, T0);
    expect(await status(minutes(5))).toContain('sessions du lead : 1 (revue) · créneaux libres : 1 sur 3');
    expect(await status(minutes(31))).not.toContain('sessions du lead');
    unregisterWave(cadenceHome(), process.ppid);
  });
});

describe('documentation (L255)', () => {
  const root = join(import.meta.dirname, '..');
  const read = (f: string) => readFileSync(join(root, f), 'utf8');

  it('R13 — le skill lead dit de poser et de rendre une réservation pour chaque session lancée à la main', () => {
    const skill = read('skills/lead/SKILL.md');
    expect(skill).toContain('cadence lead hold');
    expect(skill).toContain('cadence lead release');
    expect(skill).toContain('sessions du lead');
  });

  it('R14 — docs/lead.md, le README et le CHANGELOG décrivent la commande', () => {
    expect(read('docs/lead.md')).toContain('cadence lead hold');
    expect(read('docs/orchestrate.md')).toContain('sessions du lead');
    expect(read('README.md')).toContain('lead hold');
    const unreleased = read('CHANGELOG.md').split('## [Unreleased]')[1]!.split(/\n## \[/)[0]!;
    expect(unreleased).toContain('L255');
  });
});
