import { describe, expect, it } from 'vitest';
import { run, type Io } from '../src/cli.js';

export function ioTest(env: NodeJS.ProcessEnv = {}): Io & { sortie: string[]; erreurs: string[] } {
  const sortie: string[] = []; const erreurs: string[] = [];
  return { cwd: '/', env, now: () => new Date('2026-11-09T10:00:00Z'), out: (l) => sortie.push(l), err: (l) => erreurs.push(l), sortie, erreurs };
}

describe('cadence2', () => {
  it('sans argument, affiche l\'aide et sort en 0', async () => {
    const io = ioTest();
    expect(await run([], io)).toBe(0);
    expect(io.sortie.join('\n')).toMatch(/cadence2 bench/);
  });
  it('commande inconnue : code 2', async () => {
    const io = ioTest();
    expect(await run(['zorglub'], io)).toBe(2);
    expect(io.erreurs[0]).toMatch(/inconnue/);
  });
});
