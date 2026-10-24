import { describe, expect, it } from 'vitest';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { RunStore, type WaveState } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { tempDir } from './helpers.js';

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-24' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-24T14:12:00') };
  return { io: i, err };
}

function deps() {
  const calls: string[] = [];
  const claude: ClaudeFn = async (args) => {
    calls.push(args.join(' '));
    throw new Error('aucune session ne doit partir');
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  return { d, calls };
}

/** Une vague écrite à la main, sans lot : assez pour que `--resume` la trouve ; les refus testés tombent avant toute action. */
function wave(launch: string, id: string, created: string, status: WaveState['status']): RunStore {
  const store = new RunStore(launch, id);
  store.writeWave({ id, created, cwd: launch, budget: 1_000_000, consumed: 0, cacheRead: 0, status, pid: 1, lots: [] });
  return store;
}

describe('orchestrate --resume : une option ignorée est refusée (L309)', () => {
  it('R1 — --resume --wave <id> est un synonyme de --resume <id> ; deux vagues différentes sont refusées', () => {
    expect(parseOrchestrateArgs(['--resume', '--wave', 'vague-a', '--budget', '3M'])).toMatchObject({ resume: 'vague-a', budget: 3_000_000 });
    expect(parseOrchestrateArgs(['--wave', 'vague-a', '--resume'])).toMatchObject({ resume: 'vague-a' });
    expect(parseOrchestrateArgs(['--resume', 'vague-a', '--wave', 'vague-a'])).toMatchObject({ resume: 'vague-a' });
    expect(() => parseOrchestrateArgs(['--resume', 'vague-a', '--wave', 'vague-b'])).toThrow(/--resume vague-a et --wave vague-b/);
  });

  it('R2 — --resume --wave <inconnue> est refusée (aucune session) au lieu de reprendre une autre vague', async () => {
    const launch = tempDir();
    wave(launch, '2026-10-19-suite2', '2026-10-19T10:00:00', 'interrupted');
    const { d, calls } = deps();
    await expect(orchestrate(['--resume', '--wave', '2026-10-24-2030', '--budget', '3M'], io(launch).io, d)).rejects.toThrow(/vague inconnue : 2026-10-24-2030/);
    expect(calls).toEqual([]);
    expect(new RunStore(launch, '2026-10-19-suite2').readWave()!.budget).toBe(1_000_000);
  });

  it('R3 — --resume sans argument avec plusieurs vagues non terminées : les lister et refuser, sans rien écrire', async () => {
    const launch = tempDir();
    wave(launch, 'vieille', '2026-10-19T10:00:00', 'interrupted');
    wave(launch, 'recente', '2026-10-24T20:30:00', 'suspended-quota');
    wave(launch, 'finie', '2026-10-22T10:00:00', 'done');
    const { d, calls } = deps();
    const err = await orchestrate(['--resume', '--budget', '3M'], io(launch).io, d).then(() => '', (e: Error) => e.message);
    expect(err).toMatch(/plusieurs vagues non terminées[^]*recente[^]*vieille[^]*--resume <vague>/);
    expect(err).not.toMatch(/finie/);
    expect(calls).toEqual([]);
    expect(new RunStore(launch, 'vieille').readWave()!.budget).toBe(1_000_000);
  });

  it('R4 — les vagues non terminées : les terminées ne comptent pas, la plus récente d\'abord', () => {
    const launch = tempDir();
    wave(launch, 'finie', '2026-10-24T10:00:00', 'done');
    wave(launch, 'seule', '2026-10-19T10:00:00', 'interrupted');
    expect(RunStore.unfinished(launch).map((s) => s.id)).toEqual(['seule']);
    wave(launch, 'autre', '2026-10-20T10:00:00', 'interrupted');
    expect(RunStore.unfinished(launch).map((s) => s.id)).toEqual(['autre', 'seule']);
    expect(RunStore.unfinished(tempDir())).toEqual([]);
  });

  it('R5 — --resume refuse les arguments qu\'il ignorerait : lots à lancer', async () => {
    const { d } = deps();
    const launch = tempDir();
    await expect(orchestrate(['--resume', 'a:L1'], io(launch).io, d)).rejects.toThrow(/--resume ne se combine pas avec des lots à lancer/);
  });
});
