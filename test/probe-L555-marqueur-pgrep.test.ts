import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Sonde L555 : le marqueur `sleep 31337.<pid>` de porte-deportee.test.ts (R19) est cherché par `pgrep -f` (regex, sous-chaîne).
const pgrep = (pattern: string): boolean => {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('L555 — marqueur pgrep propre au test (porte-deportee R19)', () => {
  it('le marqueur ne reconnaît pas le sleep d’un autre processus de test dont le pid commence pareil', async () => {
    const src = readFileSync('test/porte-deportee.test.ts', 'utf8');
    expect(src).toMatch(/const marker = `sleep 31337\.\$\{process\.pid\}`/);
    // un autre worker dont le pid a ce pid pour préfixe (ex. 12 / 123) lance son propre marqueur
    const other = spawn('sleep', [`31337.${process.pid}0`], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const marker = `sleep 31337.${process.pid}`; // exactement la construction du test
      expect(pgrep(marker)).toBe(false); // attendu : seul NOTRE sleep compte
    } finally {
      other.kill();
    }
  });
});
