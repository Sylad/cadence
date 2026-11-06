import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, testPackage } from './helpers.js';

// L627 : `cadence inspect` répond depuis le binaire publié, pas seulement par `run()` (la liste blanche de bin/cadence.js est complète).
const bin = join(testPackage(), 'bin/cadence.js');

describe('cadence inspect depuis le binaire (L627)', () => {
  it('R6 — chaque outil « cadence <outil> » de l\'aide est dans la liste blanche de bin/cadence.js', () => {
    const help = readFileSync(join(import.meta.dirname, '../src/cli.ts'), 'utf8');
    const tools = [...new Set([...help.matchAll(/^  cadence ([a-z-]+)/gm)].map((m) => m[1]!))];
    const source = readFileSync(join(import.meta.dirname, '../bin/cadence.js'), 'utf8');
    const whitelist = [...source.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.filter((t) => !whitelist.includes(t))).toEqual([]);
  });

  it('R6 — `cadence inspect` lancé par bin/cadence.js imprime le tableau de la dernière vague et sort en 0', () => {
    const root = tempDir();
    mkdirSync(join(root, '.cadence', 'runs', '2026-11-06-0900'), { recursive: true });
    writeFileSync(join(root, '.cadence', 'runs', '2026-11-06-0900', 'journal.log'), '2026-11-06T09:00:00.000Z cadence:L1 → implementing\n');
    const r = spawnSync(process.execPath, [bin, 'inspect', root], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('inspection de la vague 2026-11-06-0900 : 1 lot(s)');
  });
});
