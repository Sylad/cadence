import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeConfigDir } from '../src/orchestrate/launch.js';
import { realOrchestrateDeps } from '../src/orchestrate/command.js';
import * as clean from '../src/clean.js';
import * as state from '../src/state.js';

// probe(L485) : bords du retrait de staleFiles / readFailedDeliveries et de l'alignement de claudeConfigDir
const root = join(__dirname, '..');
const lire = (f: string) => readFileSync(join(root, f), 'utf8');
const fichiers = (d: string): string[] =>
  readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fichiers(join(d, e.name)) : [join(d, e.name)]));

describe('L485 — claudeConfigDir aux bords', () => {
  it('CLAUDE_CONFIG_DIR vide est traité comme absent', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '', HOME: '/h' })).toBe('/h/.claude');
  });
  it('HOME vide retombe sur le dossier de l’utilisateur', () => {
    expect(claudeConfigDir({ HOME: '' })).toBe(join(homedir(), '.claude'));
  });
  it('environnement vide : dossier de l’utilisateur', () => {
    expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'));
  });
  it('realOrchestrateDeps : CLAUDE_CONFIG_DIR vide et HOME vide donnent la même réponse que claudeConfigDir', () => {
    for (const env of [{ CLAUDE_CONFIG_DIR: '', HOME: '' }, { CLAUDE_CONFIG_DIR: '' , HOME: '/x' }, {}]) {
      expect(realOrchestrateDeps(env).claudeHome).toBe(claudeConfigDir(env));
    }
  });
  it('realOrchestrateDeps appelé deux fois donne le même dossier', () => {
    const env = { HOME: '/x' };
    expect(realOrchestrateDeps(env).claudeHome).toBe(realOrchestrateDeps(env).claudeHome);
  });
});

describe('L485 — fonctions retirées', () => {
  it('staleFiles et readFailedDeliveries ne sont plus exportées', () => {
    expect((clean as Record<string, unknown>).staleFiles).toBeUndefined();
    expect((state as Record<string, unknown>).readFailedDeliveries).toBeUndefined();
  });
  it('scanStale et readFailedEntries (les remplaçantes) restent exportées', () => {
    expect(typeof clean.scanStale).toBe('function');
    expect(typeof state.readFailedEntries).toBe('function');
  });
  it('aucune référence restante dans src, test (hors sondes) et scripts', () => {
    const cibles = [...fichiers('src'), ...fichiers('test'), ...fichiers('scripts')].filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.includes('probe-L485'));
    const restes = cibles.filter((f) => /\b(staleFiles|readFailedDeliveries)\b/.test(lire(f)));
    expect(restes).toEqual([]);
  });
  it('plus de recopie `join(homedir(), \'.claude\')` hors de launch.ts', () => {
    const restes = fichiers('src').filter((f) => f.endsWith('.ts') && !f.endsWith('orchestrate/launch.ts') && /CLAUDE_CONFIG_DIR\s*\|\|/.test(lire(f)));
    expect(restes).toEqual([]);
  });
});

describe('L485 — cliquet', () => {
  // le clone de la CI (actions/checkout) n'a pas de branche locale main : la base est alors origin/main, comme tests.yml
  const base = ['main', 'origin/main'].find((ref) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root }).status === 0);
  it.skipIf(!base)('node scripts/qualite.mjs --contre main passe', () => {
    const r = execFileSync('node', ['scripts/qualite.mjs', '--contre', base!], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r).toBeTypeOf('string');
  }, 300000);
});
