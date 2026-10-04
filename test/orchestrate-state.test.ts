import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore, excludeState, newLot, type WaveState } from '../src/orchestrate/state.js';
import { activeLock, releaseLock, takeLock } from '../src/orchestrate/lock.js';
import { gitRepo, tempDir } from './helpers.js';

const wave = (id: string): WaveState => ({ id, created: '2026-10-04T14:12:00.000Z', cwd: '/x', budget: 2_000_000, consumed: 0, cacheRead: 0, status: 'running', pid: process.pid, lots: ['a:L1'] });

describe('RunStore', () => {
  it('écrit la vague et un fichier par lot, de façon atomique', () => {
    const dir = tempDir();
    const store = new RunStore(dir, '2026-10-04-1412');
    store.writeWave(wave('2026-10-04-1412'));
    const lot = newLot({ project: 'ol', repo: '/r', lot: 'L22', title: 't', visible: true, small: false, model: 'sonnet', readOnlyPlan: false });
    store.writeLot(lot);
    store.writeLot({ ...lot, pass: 1 });
    const base = join(dir, '.cadence/runs/2026-10-04-1412');
    expect(readdirSync(base).sort()).toEqual(['ol--L22.json', 'wave.json']);
    expect(store.readLot('ol', 'L22')?.pass).toBe(1);
    expect(store.readWave()?.budget).toBe(2_000_000);
    expect(store.lots().map((l) => l.lot)).toEqual(['L22']);
    expect(lot.status).toBe('queued');
    expect(lot.steps).toEqual([]);
  });

  it('deux projets peuvent avoir chacun un L3', () => {
    const store = new RunStore(tempDir(), 'w');
    for (const project of ['a', 'b']) store.writeLot(newLot({ project, repo: `/${project}`, lot: 'L3', title: '', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }));
    expect(store.lots().map((l) => l.project).sort()).toEqual(['a', 'b']);
  });

  it('journal : une ligne par transition', () => {
    const store = new RunStore(tempDir(), 'w');
    store.journal('a:L1 → implementing');
    store.journal('a:L1 → reviewing');
    const lines = readFileSync(join(store.dir, 'journal.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/a:L1 → reviewing$/);
  });

  it('la dernière vague, et la dernière non terminée', () => {
    const dir = tempDir();
    const a = new RunStore(dir, '2026-10-03-0900');
    a.writeWave({ ...wave('2026-10-03-0900'), status: 'suspended-budget' });
    const b = new RunStore(dir, '2026-10-04-1412');
    b.writeWave({ ...wave('2026-10-04-1412'), status: 'done' });
    expect(RunStore.last(dir)?.id).toBe('2026-10-04-1412');
    expect(RunStore.last(dir, { unfinished: true })?.id).toBe('2026-10-03-0900');
    expect(RunStore.last(tempDir())).toBeNull();
  });
});

describe('.git/info/exclude', () => {
  it('ajoute .cadence/ une fois, dans un dépôt', () => {
    const repo = gitRepo();
    excludeState(repo);
    excludeState(repo);
    const text = readFileSync(join(repo, '.git/info/exclude'), 'utf8');
    expect(text.match(/\.cadence\//g)).toHaveLength(1);
  });
  it('ne fait rien hors d\'un dépôt', () => {
    const dir = tempDir();
    excludeState(dir);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});

describe('verrous', () => {
  it('un seul porteur ; un pid mort est retiré avec avertissement', () => {
    const file = join(tempDir(), 'orchestrate.lock');
    expect(takeLock(file, { pid: process.pid, wave: 'w1', started: 'now' })).toEqual({ ok: true });
    const second = takeLock(file, { pid: process.pid + 1, wave: 'w2', started: 'now' });
    expect(second.ok).toBe(false);
    expect(activeLock(file)?.wave).toBe('w1');
    releaseLock(file, process.pid);
    expect(activeLock(file)).toBeNull();

    writeFileSync(file, JSON.stringify({ pid: 99_999_999, wave: 'mort', started: 'avant' }));
    expect(activeLock(file)).toBeNull();
    const again = takeLock(file, { pid: process.pid, wave: 'w3', started: 'now' });
    expect(again).toEqual({ ok: true, stale: expect.objectContaining({ wave: 'mort' }) });
    releaseLock(file, process.pid + 5); // pas le sien : reste
    expect(activeLock(file)?.wave).toBe('w3');
  });
});
