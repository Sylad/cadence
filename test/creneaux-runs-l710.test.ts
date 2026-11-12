import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireSlot, liveRuns, SlotAbandoned, type LiveRun } from '../src/orchestrate/registry.js';
import { liveLines, slotsLine } from '../src/orchestrate/status.js';
import { both, dead, reap, writeRun } from './creneaux-libres-commun-l598.js';
import { tempDir } from './helpers.js';

// L710 (issue #55 du compte pro) : lead tour disait « créneaux libres : 3 sur 3 » alors que deux cadence run tournaient.
// Un run vivant (état en-cours, processus vivant au verrou : le contrôle de « interrompu » de cadence run --liste, L709) prend un créneau,
// des deux côtés de la formule (registre et bande) ; un run mort ou fini n'en prend pas.

afterEach(reap);

/** Un CADENCE_HOME neuf pour le temps de `f`. */
function withHome<T>(f: (home: string, dir: string) => T): T {
  const dir = tempDir(), home = join(dir, 'home'), before = process.env.CADENCE_HOME;
  process.env.CADENCE_HOME = home;
  try {
    return f(home, dir);
  } finally {
    process.env.CADENCE_HOME = before;
  }
}

describe('L710 — les runs de cadence run comptent dans les créneaux', () => {
  it('R1 — un run vivant prend un créneau, du registre comme de la bande', () => {
    expect(both(3, [], [], [{}])).toEqual({ registre: 2, bande: 2 });
    expect(both(3, [{ cap: 3, lanes: 1, repos: 1 }], [{ label: 'qa', ttlMinutes: 30 }], [{}])).toEqual({ registre: 0, bande: 0 });
  });

  it('R2 — un run au pid mort, ou fini (ou en quota) avec son processus encore là, ne prend rien', () => {
    expect(both(3, [], [], [{ pid: dead() }])).toEqual({ registre: 3, bande: 3 });
    expect(both(3, [], [], [{ etat: 'integre' }])).toEqual({ registre: 3, bande: 3 });
    expect(both(3, [], [], [{ etat: 'quota' }])).toEqual({ registre: 3, bande: 3 });
  });

  it('R3 — la ligne compte le run dans les sessions en cours et le nomme ; --status la montre sans vague', () => {
    withHome((home, dir) => {
      writeRun(home, dir, '20261112141141-1');
      writeRun(home, dir, '20261112141141-2', { pid: dead() });
      expect(slotsLine(3).line).toBe('vagues en cours : 0 · sessions en cours : 1 · runs cadence run : 1 (proj 20261112141141-1) · créneaux libres : 2 sur 3');
      expect(liveLines(3)).toHaveLength(1);
      // l'inscription du run mort est écartée au passage
      expect(readdirSync(join(home, 'runs')).sort()).toEqual(['20261112141141-1.json']);
    });
  });

  it('R4 — sans run vivant, rien ne change : --status se tait, lead tour dit 3 sur 3', () => {
    withHome((home, dir) => {
      writeRun(home, dir, 'mort', { pid: dead() });
      expect(slotsLine(3).line).toBe('vagues en cours : 0 · sessions en cours : 0 · créneaux libres : 3 sur 3');
      expect(liveLines(3)).toEqual([]);
      expect(existsSync(join(home, 'runs', 'mort.json'))).toBe(false);
    });
  });

  it('R5 — une vague attend le créneau tenu par un run, et le dit', async () => {
    const dir = tempDir(), home = join(dir, 'home');
    writeRun(home, dir, 'r1');
    expect(liveRuns(home)).toEqual([{ id: 'r1', repo: join(dir, 'proj') }]);
    const seen: LiveRun[][] = [];
    let waits = 0;
    const p = acquireSlot(home, 1, { wave: 'w', pollMs: 5, onWait: (_h, _ms, _l, _lead, runs) => seen.push(runs), abandon: () => (++waits > 2 ? 'fin du test' : null) });
    await expect(p).rejects.toBeInstanceOf(SlotAbandoned);
    expect(seen[0]).toEqual([{ id: 'r1', repo: join(dir, 'proj') }]);
    // le run mort, le créneau se prend
    writeRun(home, dir, 'r1', { pid: dead() });
    const free = await acquireSlot(home, 1, { wave: 'w', pollMs: 5 });
    free();
  });
});
