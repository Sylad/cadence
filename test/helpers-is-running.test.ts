import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readStat } from '../src/proc.js';
import { isRunning } from './helpers.js';

describe('isRunning (L579) : un zombie n\'est pas un processus qui tourne', () => {
  it('vivant : vrai ; mort et recueilli : faux ; mort mais pas recueilli (zombie) : faux, là où kill(pid, 0) répond encore', async () => {
    // le shell lance `sleep 300` en arrière-plan puis devient `sleep 300`, qui ne recueille personne : le premier, tué par le test, reste zombie
    const parent = spawn('sh', ['-c', 'sleep 300 & echo $!; exec sleep 300'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const pid = Number(await new Promise<string>((r) => parent.stdout.once('data', (d: Buffer) => r(d.toString()))));
      expect(isRunning(pid)).toBe(true);
      process.kill(pid, 'SIGKILL'); // l'étape « vivant » ne dépend d'aucun délai : la mort vient du test
      for (let i = 0; i < 200 && readStat('/proc', pid)?.state !== 'Z'; i++) await new Promise((r) => setTimeout(r, 50));
      expect(readStat('/proc', pid)?.state).toBe('Z'); // témoin : il est bien zombie
      expect(() => process.kill(pid, 0)).not.toThrow(); // …et le signal 0 le dit vivant
      expect(isRunning(pid)).toBe(false);
    } finally {
      parent.kill('SIGKILL');
    }
    const gone = parent.pid!;
    await new Promise((r) => parent.once('exit', r));
    expect(isRunning(gone)).toBe(false);
  });
});
