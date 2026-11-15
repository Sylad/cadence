import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// L505 : un test qui contrôle la mort d'un processus juste après `await exited` est instable (même défaut que le lot corrige).
const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').split('\n');

describe('L505 : la mort d\'un processus se constate par attente, jamais sans délai après la sortie', () => {
  it('orchestrate-e2e : aucun expect(alive(..)).toBe(false) / kill(..,0).toThrow immédiat après un await exited', () => {
    const lines = src('orchestrate-e2e.test.ts');
    const bad: string[] = [];
    lines.forEach((l, i) => {
      if (/expect\(alive\(.*\)\)\.toBe\(false\)|expect\(\(\) => process\.kill\(.*0\)\)\.toThrow/.test(l)) {
        const before = lines.slice(Math.max(0, i - 3), i).join('\n');
        if (/await exited/.test(before)) bad.push(`ligne ${i + 1}: ${l.trim()}`);
      }
    });
    expect(bad).toEqual([]);
  });

  // L732 : la mort se lit sur un événement (fin de fichier de la FIFO que la vérification tient), plus en relisant /proc ; la borne d'échec reste ≥ 10 s.
  it('verify.test : le contrôle de mort après relais de signal attend la fin de la FIFO, bornée à ≥ 10 s', () => {
    const lines = src('verify.test.ts').join('\n');
    expect(lines).toMatch(/const died = new Promise<true>\(\(r\) => reader\.once\('end', \(\) => r\(true\)\)\)/);
    expect(lines).not.toMatch(/!alive\(checkPid\)/);
    const m = [...lines.matchAll(/Promise\.race\(\[died, bound\((\d[\d_]*)\)\]\)/g)].map((x) => Number(x[1].replace(/_/g, '')));
    expect(m.length).toBeGreaterThan(0);
    for (const ms of m) expect(ms).toBeGreaterThanOrEqual(10_000);
  });
});
