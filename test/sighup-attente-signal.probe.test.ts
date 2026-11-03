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

  it('verify.test : le contrôle de mort après relais de signal passe par until() avec un délai ≥ 10 s', () => {
    const lines = src('verify.test.ts').join('\n');
    const m = [...lines.matchAll(/until\(\(\) => !alive\(checkPid\), (\d[\d_]*)\)/g)].map((x) => Number(x[1].replace(/_/g, '')));
    expect(m.length).toBeGreaterThan(0);
    for (const ms of m) expect(ms).toBeGreaterThanOrEqual(10_000);
  });
});
