import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isRunning } from './helpers.js';

describe('L579 — isRunning, bords', () => {
  it('le processus courant tourne', () => {
    expect(isRunning(process.pid)).toBe(true);
  });
  it('pid 0 : ce n\'est pas un processus (kill(0, 0) vise le groupe)', () => {
    expect(isRunning(0)).toBe(false);
  });
  it('pid négatif : ce n\'est pas un processus (kill(-n, 0) vise un groupe)', () => {
    expect(isRunning(-process.pid)).toBe(false);
    expect(isRunning(-1)).toBe(false);
  });
  it('NaN, non entier, énorme : faux, sans lever', () => {
    expect(isRunning(NaN)).toBe(false);
    expect(isRunning(1.5)).toBe(false);
    expect(isRunning(2 ** 40)).toBe(false);
    expect(isRunning('abc' as unknown as number)).toBe(false);
    expect(isRunning(undefined as unknown as number)).toBe(false);
  });
  it('pid inexistant : faux', () => {
    expect(isRunning(4_194_300)).toBe(false);
  });
  it('commande dont le nom contient « ) » et des espaces : vivant, pas confondu avec un zombie', async () => {
    const child = spawn('bash', ['-c', 'exec -a "x) Z 1 (y" sleep 5'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(isRunning(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
  });
  it('deux appels de suite : même réponse', () => {
    expect(isRunning(process.pid)).toBe(isRunning(process.pid));
  });
});
