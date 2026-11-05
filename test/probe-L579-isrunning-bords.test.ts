import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStat } from '../src/proc.js';
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
    // `exec -a` ne change que argv[0] : le champ comm de /proc/<pid>/stat reste le nom de l'exécutable. On copie donc le binaire sous ce nom.
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'l579-comm-'));
    const exe = join(dir, 'x) Z 1 (y');
    copyFileSync(realpathSync(execFileSync('which', ['sleep'], { encoding: 'utf8' }).trim()), exe);
    chmodSync(exe, 0o755);
    const child = spawn(exe, ['5'], { stdio: 'ignore' });
    try {
      await new Promise((r) => child.once('spawn', r));
      // Attente d'événement : le comm bascule sur le nom du binaire une fois l'exec fait.
      for (let i = 0; i < 200 && readStat('/proc', child.pid!)?.name !== 'x) Z 1 (y'; i++) await new Promise((r) => setTimeout(r, 10));
      expect(readStat('/proc', child.pid!)?.name).toBe('x) Z 1 (y'); // témoin : le comm contient bien « ) »
      expect(isRunning(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('deux appels de suite : même réponse', () => {
    expect(isRunning(process.pid)).toBe(isRunning(process.pid));
  });
});
