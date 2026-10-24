import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realClaude } from '../src/orchestrate/launch.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { cutReport, workTimeoutMs } from '../src/orchestrate/timeouts.js';
import { claudeOut, commitFile, harness, workReport, type Handler } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

const MIN = 60_000;

describe('L298 — délai des étapes d’écriture', () => {
  it('R1 — le délai de base vaut pour 0,25 j ; 0,5 j le double, un lot sans estimate connue garde la base', () => {
    expect(workTimeoutMs(45 * MIN, 0.25, false)).toBe(45 * MIN);
    expect(workTimeoutMs(45 * MIN, 0.1, false)).toBe(45 * MIN);
    expect(workTimeoutMs(45 * MIN, 0.5, false)).toBe(90 * MIN);
    expect(workTimeoutMs(45 * MIN, undefined, false)).toBe(45 * MIN);
  });

  it('R2 — un lot à fiche a une moitié de plus (L279 : 0,5 j + fiche)', () => {
    expect(workTimeoutMs(45 * MIN, 0.5, true)).toBe(135 * MIN);
    expect(workTimeoutMs(45 * MIN, 0.25, true)).toBe(67.5 * MIN);
  });

  it('R3 — le délai proportionné ne dépasse jamais 4 fois le délai de base', () => {
    expect(workTimeoutMs(45 * MIN, 3, true)).toBe(180 * MIN);
  });

  it('R4 — la session reçoit le délai proportionné à l’estimate ; la revue garde le sien, sans prolongation', async () => {
    const made: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
    const h = harness({ script: { implement: [made] } });
    const c = h.lot('L1', { estimate: 0.5 });
    await runLot(c);
    expect(h.calls[0].opts.timeoutMs).toBe(90 * MIN);
    const rev = h.calls.find((x) => x.kind === 'review' || x.kind === 'review-small');
    expect(rev?.opts.timeoutMs).toBe(25 * MIN);
    expect(rev?.opts.extend).toBeUndefined();
  });

  it('R4b — un lot à fiche reçoit une moitié de plus', async () => {
    const h = harness({ script: { implement: [() => ({ code: 0, stdout: '', stderr: '', timedOut: true })] } });
    const c = h.lot('L1', { estimate: 0.5, specLot: true, spec: { sousSeuil: 'x' } });
    await runLot(c);
    const impl = h.calls.find((x) => x.kind === 'implement');
    expect(impl?.opts.timeoutMs).toBe(135 * MIN);
  });

  it('R4c — la session a progressé quand HEAD a bougé depuis la dernière échéance, pas sinon', async () => {
    const seen: boolean[] = [];
    const h = harness({
      script: {
        implement: [
          (call) => {
            const p = call.opts.extend!.progressed;
            seen.push(p()); // rien commité depuis le départ
            commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
            seen.push(p(), p()); // un commit, puis rien de plus
            return { code: 0, stdout: '', stderr: '', timedOut: true };
          },
        ],
      },
    });
    await runLot(h.lot('L1'));
    expect(seen).toEqual([false, true, false]);
  });

  describe('prolongation tant que la session commite', () => {
    const slow = (dir: string): string => {
      const bin = join(dir, 'fake-claude.sh');
      writeFileSync(bin, `#!/bin/sh\nsleep 60\n`, { mode: 0o755 });
      return bin;
    };

    it('R5 — à l’échéance, une session qui a commité reçoit du temps de plus et finit sans être coupée', async () => {
      const dir = tempDir();
      const bin = join(dir, 'fake.sh');
      writeFileSync(bin, `#!/bin/sh\nsleep 2.2\necho '{}'\n`, { mode: 0o755 });
      let asked = 0;
      const out = await realClaude(bin, process.env)([], { cwd: dir, env: {}, timeoutMs: 1_000, extend: { progressed: () => ++asked <= 2, ms: 1_000, max: 5 } });
      expect(out.timedOut).toBe(false);
      expect(out.code).toBe(0);
      expect(asked).toBe(2);
    }, 15_000);

    it('R6 — sans commit depuis la dernière échéance, la session est coupée', async () => {
      const dir = tempDir();
      const out = await realClaude(slow(dir), process.env)([], { cwd: dir, env: {}, timeoutMs: 1_000, extend: { progressed: () => false, ms: 1_000, max: 5 } });
      expect(out.timedOut).toBe(true);
    }, 15_000);

    it('R7 — la prolongation a un plafond : une session qui commite sans fin est coupée après `max` prolongations', async () => {
      const dir = tempDir();
      const t0 = Date.now();
      const out = await realClaude(slow(dir), process.env)([], { cwd: dir, env: {}, timeoutMs: 1_000, extend: { progressed: () => true, ms: 1_000, max: 2 } });
      expect(out.timedOut).toBe(true);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2_900);
      expect(Date.now() - t0).toBeLessThan(10_000);
    }, 15_000);
  });

  describe('travail non commité à l’échéance', () => {
    const cutWithWork: Handler = (call) => {
      commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
      writeFileSync(join(call.opts.cwd, 'a.txt'), 'modifié\nencore\n');
      writeFileSync(join(call.opts.cwd, 'a.test.ts'), 'it();\n');
      return { code: 0, stdout: '', stderr: '', timedOut: true };
    };

    it('R8 — le tableau dit les commits conservés, les fichiers non commités, ceux de test et les lignes, et rend le lot au lead', async () => {
      const h = harness({ script: { implement: [cutWithWork] } });
      const c = h.lot('L1');
      await runLot(c);
      expect(c.lot.status).toBe('handed-back');
      expect(c.lot.outcome).toMatch(/délai dépassé : implement coupé au délai de 45 min : 1 commit conservé/);
      expect(c.lot.outcome).toContain('travail NON commité : 2 fichiers (a.txt, a.test.ts)');
      expect(c.lot.outcome).toContain('dont 1 de test (a.test.ts)');
      expect(c.lot.outcome).toContain('2 lignes ajoutées');
      expect(c.lot.steps[0].cause).toContain('NON commité');
    });

    it('R9 — coupée sans rien commité ni laissé : un échec, qui le dit', async () => {
      const h = harness({ script: { implement: [() => ({ code: 0, stdout: '', stderr: '', timedOut: true })] } });
      const c = h.lot('L1');
      await runLot(c);
      expect(c.lot.status).toBe('failed');
      expect(c.lot.outcome).toContain('aucun commit, rien de non commité');
    });

    it('R10 — cutReport : au-delà de huit fichiers, les premiers seulement ; aucun test touché est dit', () => {
      const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
      const text = cutReport({ minutes: 90, commits: 6, files, numstat: '44\t0\tsrc/f0.ts\n-\t-\timg.png' });
      expect(text).toContain('6 commits conservés');
      expect(text).toContain('10 fichiers (src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts, src/f5.ts, src/f6.ts, src/f7.ts, …)');
      expect(text).toContain('aucun de test');
      expect(text).toContain('44 lignes ajoutées');
    });
  });
});
