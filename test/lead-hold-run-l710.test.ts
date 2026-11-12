import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { liveRuns, runNamedBy } from '../src/orchestrate/registry.js';
import { slotsLine } from '../src/orchestrate/status.js';
import { dead, reap, writeRun } from './creneaux-libres-commun-l598.js';
import { tempDir } from './helpers.js';

// Revue L710, constat 1 : un cadence run se compte seul dans les créneaux ; le lead qui le tenait aussi par `lead hold` (consigne de la skill
// d'avant) le comptait deux fois — 1 run + hold run-L710 → « 1 sur 3 » au lieu de 2. `lead hold` refuse une étiquette qui nomme un run vivant.

let home: string, dir: string, before: string | undefined;
// L711 : une seule horloge pour inscrire les holds (TTL 60 min) et les compter ; slotsLine sur l'heure réelle les voyait échus après 16:00Z le 12-11.
const NOW = new Date('2026-11-12T15:00:00Z');
beforeEach(() => {
  dir = tempDir();
  home = join(dir, 'home');
  before = process.env.CADENCE_HOME;
  process.env.CADENCE_HOME = home;
});
afterEach(() => {
  process.env.CADENCE_HOME = before;
  reap();
});

async function cad(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-12' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('lead hold d\'un cadence run vivant (L710)', () => {
  it('R1 — une étiquette qui nomme le lot ou l\'id d\'un run vivant est refusée (code 2), rien n\'est inscrit, le run compte une fois', async () => {
    writeRun(home, dir, '20261112143710-1', { lot: 'L710' });
    for (const label of ['run-L710', 'L710', 'revue 20261112143710-1']) {
      const r = await cad('lead', 'hold', label);
      expect(r.code, label).toBe(2);
      expect(r.err).toContain('nomme le cadence run vivant 20261112143710-1 (lot L710) de proj');
      expect(r.err).toContain('il se compte déjà dans les créneaux');
    }
    expect(existsSync(join(home, 'holds'))).toBe(false);
    expect(slotsLine(3, NOW).free).toBe(2);
  });

  it('R2 — une étiquette qui ne le nomme pas passe : autre lot, préfixe d\'un autre id (L71, L7100)', async () => {
    writeRun(home, dir, 'r1', { lot: 'L710' });
    for (const label of ['qa-L71', 'fix-L7100', 'revue-L12']) expect((await cad('lead', 'hold', label)).code, label).toBe(0);
    expect(slotsLine(3, NOW).free).toBe(0);
  });

  it('R3 — un run mort, fini ou sans lot ne bloque pas l\'étiquette de son lot', async () => {
    writeRun(home, dir, 'mort', { lot: 'L1', pid: dead() });
    writeRun(home, dir, 'fini', { lot: 'L2', etat: 'integre' });
    writeRun(home, dir, 'sans', {});
    expect(liveRuns(home)).toEqual([{ id: 'sans', repo: join(dir, 'proj') }]);
    for (const label of ['run-L1', 'run-L2']) expect((await cad('lead', 'hold', label)).code, label).toBe(0);
    expect((await cad('lead', 'hold', 'run-sans')).code).toBe(2);
  });

  it('R4 — runNamedBy : le mot entier, id ou lot, caractères spéciaux du lot compris', () => {
    const runs = [{ id: 'a1', repo: '/p', lot: 'L12/3' }];
    expect(runNamedBy('fix L12/3', runs)).toBe(runs[0]);
    expect(runNamedBy('fix L12/34', runs)).toBeUndefined();
    expect(runNamedBy('fix L12', runs)).toBeUndefined();
    expect(runNamedBy('ba1', runs)).toBeUndefined();
  });
});
