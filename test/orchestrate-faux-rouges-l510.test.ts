import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { replayRed } from '../src/orchestrate/workers.js';
import { timeoutLimits } from '../src/orchestrate/baseline.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const replaying = (test: string) => ({ test, testReplay: `${test} {files}` });

const SUITE = ' FAIL  test/a.test.ts > plan-data\nError: Test timed out in 30000ms.\n FAIL  test/b.test.ts > autre\nAssertionError: x\n';

describe('L510 R1 — un test qui expire près de sa limite même seul est un « délai trop juste », pas un bug', () => {
  it('R1 — timeoutLimits lit le délai de chaque test expiré dans la sortie de la suite, et lui seul', () => {
    expect([...timeoutLimits(SUITE)]).toEqual([['test/a.test.ts > plan-data', 30000]]);
    expect(timeoutLimits('').size).toBe(0);
    expect(timeoutLimits('Error: Test timed out in 30000ms.\n').size).toBe(0); // aucun test nommé avant : rien à rattacher
    expect([...timeoutLimits(' ● Suite › lent\n    thrown: "Exceeded timeout of 5000 ms for a test."\n')]).toEqual([['Suite › lent', 5000]]);
  });
  const run = (out: string, code = 0) => async () => ({ code, output: out });
  it('R1 — vert seul à 25 s pour 30 s : instable ET délai trop juste, avec sa durée et sa limite', async () => {
    const r = await replayRed(run(' ✓ test/a.test.ts > plan-data 25012ms\n'), 'vitest {files}', ['test/a.test.ts > plan-data'], SUITE);
    expect(r.red).toEqual([]);
    expect(r.unstable).toEqual(['test/a.test.ts > plan-data']);
    expect(r.tight).toEqual([{ test: 'test/a.test.ts > plan-data', ms: 25012, limit: 30000 }]);
  });
  it('R1 — vert seul à 2 s pour 30 s : instable sous charge, pas de délai trop juste', async () => {
    const r = await replayRed(run(' ✓ test/a.test.ts > plan-data 2.1s\n'), 'vitest {files}', ['test/a.test.ts > plan-data'], SUITE);
    expect(r.unstable).toEqual(['test/a.test.ts > plan-data']);
    expect(r.tight).toEqual([]);
  });
  it('R1 — durée de fichier « (3 tests) 24s » prise faute de ligne du test ; pile à 80 % compte, juste en dessous non', async () => {
    const at = async (line: string) => (await replayRed(run(line), 'v {files}', ['test/a.test.ts > plan-data'], SUITE)).tight.length;
    expect(await at(' ✓ test/a.test.ts (3 tests) 24s\n')).toBe(1);
    expect(await at(' ✓ test/a.test.ts (3 tests) 23999ms\n')).toBe(0);
  });
  it('R1 — durée illisible ou test sans délai dans la suite : pas de délai trop juste', async () => {
    expect((await replayRed(run(' ✓ test/a.test.ts\n'), 'v {files}', ['test/a.test.ts > plan-data'], SUITE)).tight).toEqual([]);
    expect((await replayRed(run(' ✓ test/b.test.ts > autre 29000ms\n'), 'v {files}', ['test/b.test.ts > autre'], SUITE)).tight).toEqual([]);
  });
  it('R1 — un rejeu seul qui reste rouge (expire seul) n\'est jamais un délai trop juste', async () => {
    const r = await replayRed(run(' FAIL  test/a.test.ts > plan-data\nError: Test timed out in 30000ms.\n', 1), 'v {files}', ['test/a.test.ts > plan-data'], SUITE);
    expect(r.red).toEqual(['test/a.test.ts > plan-data']);
    expect(r.tight).toEqual([]);
  });

  it('R1 — dans la porte du lot : pas de passe de correction, le test est nommé dans les avertissements avec durée et limite, et dans le lot', async () => {
    const h = harness({ script: { implement: [impl], fix: [fix('b.txt')], review: [ok] } });
    const gate = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo " ✓ $1 > plan-data 25012ms"; exit 0; fi; echo ' FAIL  test/a.test.ts > plan-data'; echo 'Error: Test timed out in 30000ms.'; exit 1; }; f`;
    const c = h.lot('L1', {}, replaying(gate));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.delaisJustes).toEqual([{ test: 'test/a.test.ts > plan-data', ms: 25012, limit: 30000 }]);
    expect(c.lot.warnings.some((w) => /délai trop juste.*test\/a\.test\.ts > plan-data.*25 s.*30 s/.test(w))).toBe(true);
    expect(c.lot.instables ?? []).toEqual([]); // compté à part, pas parmi les instables de charge
  });
});

describe('L510 R2 — un rouge déjà rouge à la ligne de base ne déclenche ni correction ni escalade', () => {
  it('R2 — suite verte au départ mais test rouge SEUL au sha de départ aussi : pas de passe de correction, « déjà rouge »', async () => {
    const log = join(tempDir(), 'base.log');
    const h = harness({ script: { implement: [impl], fix: [fix('b.txt')], review: [ok] } });
    // Au départ : la suite entière passe (le test ne rougit que dans certaines conditions), seul il est rouge. Dans le lot : rouge partout.
    const gate = `f() { case "$PWD" in *cadence-baseline*) if [ -n "$1" ]; then echo "base $@" >> ${log}; echo ' FAIL  test/a.test.ts > tiroir'; exit 1; fi; exit 0;; esac; [ -f a.txt ] || exit 0; echo ' FAIL  test/a.test.ts > tiroir'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(gate));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['base test/a.test.ts', 'base test/a.test.ts']);
    expect(c.lot.warnings.some((w) => /déjà rouge\(s\) au sha de départ/.test(w))).toBe(true);
    expect(c.lot.escalation).toBeUndefined();
  });
  it('R2 — vert seul au sha de départ : le lot a cassé le test, la correction a lieu (rien n\'est excusé)', async () => {
    const h = harness({ script: { implement: [impl], fix: [fix('b.txt')], review: [ok] } });
    const gate = `f() { case "$PWD" in *cadence-baseline*) exit 0;; esac; [ -f b.txt ] && exit 0; [ -f a.txt ] || exit 0; echo ' FAIL  test/a.test.ts > tiroir'; exit 1; }; f "$@"`;
    await runLot(h.lot('L1', {}, replaying(gate)));
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
  });
  it('R2 — un rouge déjà rouge et un vrai nouveau rouge : seul le nouveau est corrigé, l\'autre est dit déjà rouge', async () => {
    const h = harness({ script: { implement: [impl], fix: [fix('b.txt')], review: [ok] } });
    const gate = `f() { case "$PWD" in *cadence-baseline*) if [ -n "$1" ]; then echo ' FAIL  test/a.test.ts > tiroir'; exit 1; fi; exit 0;; esac; [ -f a.txt ] || exit 0; [ -f b.txt ] || echo ' FAIL  test/n.test.ts > nouveau'; echo ' FAIL  test/a.test.ts > tiroir'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, replaying(gate));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/n.test.ts > nouveau');
    expect(h.calls[1].brief).not.toMatch(/- test\/a\.test\.ts > tiroir/);
  });
  it('R2 — sans orchestrate.testReplay rien n\'est rejoué au départ : le rouge est compté comme avant', async () => {
    const log = join(tempDir(), 'base.log');
    const h = harness({ script: { implement: [impl], fix: [fix('b.txt')], review: [ok] } });
    const gate = `case "$PWD" in *cadence-baseline*) echo base >> ${log}; exit 0;; esac; [ -f b.txt ] && exit 0; [ -f a.txt ] || exit 0; echo ' FAIL  test/a.test.ts > tiroir'; exit 1`;
    await runLot(h.lot('L1', {}, { test: gate }));
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0).toBeLessThanOrEqual(1); // la ligne de base de L213 seule
  });
});
