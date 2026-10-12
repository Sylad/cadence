import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RafError } from '../src/plan.js';
import { parseQuotaStops, parseWaitMs, parseWaits, readWaits, renderWaits } from '../src/orchestrate/waits.js';
import { orchestrate, parseOrchestrateArgs } from '../src/orchestrate/command.js';
import { tempDir } from './helpers.js';

const WAIT = (t: string, s: string) => `${t} en attente d'un créneau de session depuis 0 s (2/2 en cours : a, b)\n${t} créneau de session obtenu après ${s} d'attente\n`;

function wave(root: string, id: string, journal: string, wave: Record<string, unknown> = {}) {
  const dir = join(root, '.cadence', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'journal.log'), journal);
  writeFileSync(join(dir, 'wave.json'), JSON.stringify({ id, status: 'done', consumed: 1000, cacheRead: 5000, ...wave }));
}

describe('durée d\'attente lue dans le journal', () => {
  it('« 4 min 27 s » et « 45 s » en millisecondes', () => {
    expect(parseWaitMs('4 min 27 s')).toBe(267_000);
    expect(parseWaitMs('45 s')).toBe(45_000);
    expect(parseWaitMs('1 h 02 min 03 s')).toBe(3_723_000);
    expect(parseWaitMs('bientôt')).toBeNull();
  });
});

describe('parseWaits', () => {
  it('une attente est comptée à l\'obtention du créneau, avec son jour ; les lignes « depuis » seules ne comptent pas', () => {
    const j = WAIT('2026-10-12T10:00:00.000Z', '4 min 27 s') + `2026-10-12T11:00:00.000Z en attente d'un créneau de session depuis 3 s (2/2 en cours : a)\n` + WAIT('2026-10-13T09:00:00.000Z', '30 s');
    const w = parseWaits(j);
    expect(w.waits.map((x) => [x.day, x.ms])).toEqual([['2026-10-12', 267_000], ['2026-10-13', 30_000]]);
    expect(w.unfinished).toBe(1);
  });
  it('un journal sans attente : rien', () => {
    expect(parseWaits('2026-10-12T10:00:00.000Z cadence:L1 → implementing\n')).toEqual({ waits: [], unfinished: 0 });
  });
});

describe('parseQuotaStops', () => {
  it('compte les lignes « → suspended — quota atteint », au jour de la ligne ; les autres suspensions non', () => {
    const j = '2026-10-04T16:30:00.000Z cadence:L27 → suspended — quota atteint\n2026-10-04T17:00:00.000Z cadence:L28 → suspended — budget\n2026-10-05T01:00:00.000Z cadence:L27 → suspended — quota atteint\n';
    expect(parseQuotaStops(j)).toEqual(['2026-10-04', '2026-10-05']);
  });
});

describe('quota atteint après --resume', () => {
  it('une vague reprise (wave.json « done ») compte quand même son arrêt, lu dans le journal', () => {
    const root = tempDir();
    wave(root, '2026-10-04-1609', '2026-10-04T16:30:00.000Z cadence:L27 → suspended — quota atteint\n', { status: 'done' });
    expect(readWaits(root).days.map((d) => [d.day, d.quotaHits])).toEqual([['2026-10-04', 1]]);
  });
});

describe('readWaits / renderWaits', () => {
  it('attente par vague et par jour, jetons et quota de la vague', () => {
    const root = tempDir();
    wave(root, '2026-10-12-0800', WAIT('2026-10-12T08:05:00.000Z', '10 min 00 s') + WAIT('2026-10-12T09:05:00.000Z', '2 min 00 s'), { consumed: 2000 });
    wave(root, '2026-10-12-1100', WAIT('2026-10-12T11:05:00.000Z', '1 min 00 s') + '2026-10-12T11:30:00.000Z cadence:L27 → suspended — quota atteint\n');
    wave(root, '2026-10-11-1100', '', {});
    const r = readWaits(root);
    expect(r.waves.map((x) => [x.id, x.totalMs, x.count])).toEqual([['2026-10-11-1100', 0, 0], ['2026-10-12-0800', 720_000, 2], ['2026-10-12-1100', 60_000, 1]]);
    expect(r.days).toEqual([{ day: '2026-10-11', totalMs: 0, count: 0, waves: 1, quotaHits: 0, consumed: 1000 }, { day: '2026-10-12', totalMs: 780_000, count: 3, waves: 2, quotaHits: 1, consumed: 3000 }]);
    const text = renderWaits(r).join('\n');
    expect(text).toContain('2026-10-12');
    expect(text).toContain('13 min 00 s');
  });
  it('--since écarte les vagues d\'avant', () => {
    const root = tempDir();
    wave(root, '2026-10-10-0800', WAIT('2026-10-10T08:05:00.000Z', '9 s'));
    wave(root, '2026-10-12-0800', WAIT('2026-10-12T08:05:00.000Z', '8 s'));
    expect(readWaits(root, '2026-10-12').waves.map((x) => x.id)).toEqual(['2026-10-12-0800']);
  });
  it('un dossier dont l\'identifiant n\'est pas daté est ignoré', () => {
    const root = tempDir();
    wave(root, 'cadence-essai', WAIT('2026-10-12T08:05:00.000Z', '8 s'));
    expect(readWaits(root).waves).toEqual([]);
  });
  it('dossier sans vague : rendu qui le dit', () => {
    expect(renderWaits(readWaits(tempDir()))).toEqual(['aucune vague dans ce dossier']);
  });
});

describe('cadence orchestrate --waits', () => {
  it('s\'analyse avec --since, et refuse un jour invalide', () => {
    expect(parseOrchestrateArgs(['--waits', '--since', '2026-10-12'])).toMatchObject({ waits: true, since: '2026-10-12' });
    expect(() => parseOrchestrateArgs(['--waits', '--since', 'hier'])).toThrow(RafError);
  });
  it('refuse --since sans --waits et --waits combiné à une autre action, avant d\'agir', async () => {
    const root = tempDir();
    const run = (argv: string[]) => orchestrate(argv, { cwd: root, env: {}, now: () => new Date('2026-10-12T20:00:00Z'), out: () => {}, err: () => {} } as never, {} as never);
    await expect(run(['--since', '2026-10-12'])).rejects.toThrow(/s'utilise avec --waits/);
    for (const other of [['--status'], ['--resume', 'x'], ['--continue'], ['--dry-run'], ['--drop', 'L1'], ['--stop-after-current'], ['L1']]) {
      await expect(run(['--waits', ...other])).rejects.toThrow(/aucune autre action/);
    }
  });
  it('affiche le tableau du dossier de lancement, sans rien lancer', async () => {
    const root = tempDir();
    wave(root, '2026-10-12-0800', WAIT('2026-10-12T08:05:00.000Z', '1 min 30 s'));
    const out: string[] = [];
    const code = await orchestrate(['--waits'], { cwd: root, env: {}, now: () => new Date('2026-10-12T20:00:00Z'), out: (l: string) => out.push(l), err: () => {} } as never, {} as never);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1 min 30 s');
  });
});
