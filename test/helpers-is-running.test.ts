import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStat } from '../src/proc.js';
import { isRunning, processRunning, tempDir } from './helpers.js';

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

  // L732 : cause du rouge « SIGHUP relayé » sous npm publish --dry-run — un processus déjà vu mort redevenait « vivant » le temps que son zombie soit recueilli.
  it('stat illisible après un signal 0 réussi (recueilli entre les deux) : mort sous Linux ; sans /proc, le signal 0 fait foi', () => {
    expect(processRunning(process.pid, tempDir())).toBe(false); // /proc présent mais sans ce pid : il vient de partir
    expect(processRunning(process.pid, join(tempDir(), 'absent'))).toBe(true); // pas de /proc (macOS) : vivant d'après kill
  });

  it('état lu dans stat : X (mort, en cours de retrait) et Z comptent pour morts, S pour vivant', () => {
    const proc = tempDir();
    mkdirSync(join(proc, String(process.pid)));
    const stat = (state: string) => writeFileSync(join(proc, String(process.pid), 'stat'), `${process.pid} (sleep) ${state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4242 0 0\n`);
    for (const [state, running] of [['S', true], ['R', true], ['Z', false], ['X', false]] as const) {
      stat(state);
      expect(processRunning(process.pid, proc), state).toBe(running);
    }
  });

  it('vu mort, jamais revu vivant pendant son recueil (300 orphelins tués, recueillis par init)', async () => {
    let flips = 0;
    for (let i = 0; i < 300; i++) {
      const sh = spawn('sh', ['-c', 'sleep 300 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const pid = Number(await new Promise<string>((r) => sh.stdout.once('data', (d: Buffer) => r(d.toString()))));
      await new Promise((r) => sh.once('exit', r)); // orphelin : son recueil revient à init, hors de ce processus
      process.kill(pid, 'SIGKILL');
      let seenDead = false;
      // jusqu'à ce que le pid disparaisse : chaque lecture après une première « mort » doit dire mort. Lectures par paquets de 100, puis la main
      // est rendue : la sonde ne bloque ni son worker ni un cœur pendant que init recueille sous charge.
      for (let gone = false; !gone; await new Promise((r) => setImmediate(r))) {
        for (let k = 0; k < 100 && !gone; k++) {
          if (!isRunning(pid)) seenDead = true;
          else if (seenDead) flips++;
          try {
            process.kill(pid, 0);
          } catch {
            gone = true;
          }
        }
      }
    }
    expect(flips).toBe(0);
  }, 60_000);
});
