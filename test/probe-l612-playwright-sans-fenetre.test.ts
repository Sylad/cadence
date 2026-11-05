import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpServersFor, writeMcpConfig, type SessionKind } from '../src/orchestrate/launch.js';
import { tempDir } from './helpers.js';

const prev = process.env.CADENCE_PLAYWRIGHT_HEADED;
afterEach(() => {
  if (prev === undefined) delete process.env.CADENCE_PLAYWRIGHT_HEADED; else process.env.CADENCE_PLAYWRIGHT_HEADED = prev;
});

const LOADERS: Array<[SessionKind, boolean, boolean, boolean]> = [
  ['ux', false, false, true], ['maquette', false, false, true], ['spec', true, false, true],
  ['implement', true, false, true], ['fix', true, false, true], ['review-small', true, true, true],
];

describe('L612 — une session ne doit jamais ouvrir de fenêtre sur le poste', () => {
  it('toute étape qui charge Playwright porte --headless, une seule fois, avant --output-dir', () => {
    delete process.env.CADENCE_PLAYWRIGHT_HEADED;
    for (const [k, vis, small, screen] of LOADERS) {
      const a = mcpServersFor(k, vis, '/o', small, screen).playwright.args;
      expect(a.filter((x) => x === '--headless'), k).toHaveLength(1);
      expect(a.indexOf('--headless'), k).toBeLessThan(a.indexOf('--output-dir'));
    }
  });

  it('les valeurs voisines de « 1 » ne lèvent pas le mode sans fenêtre', () => {
    for (const v of ['true', 'yes', ' 1', '1 ', '01', 'TRUE', 'on']) {
      process.env.CADENCE_PLAYWRIGHT_HEADED = v;
      expect(mcpServersFor('ux', true, '/o').playwright.args, v).toContain('--headless');
    }
  });

  it('le fichier mcp-<étape>.json réellement écrit porte --headless ; avec =1 il ne le porte pas', () => {
    delete process.env.CADENCE_PLAYWRIGHT_HEADED;
    const dir = tempDir();
    const file = writeMcpConfig(dir, 'ux', true);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    expect(cfg.mcpServers.playwright.args).toContain('--headless');
    expect(cfg.mcpServers.playwright.args).toContain(join(dir, 'playwright'));
    process.env.CADENCE_PLAYWRIGHT_HEADED = '1';
    const dir2 = tempDir();
    const cfg2 = JSON.parse(readFileSync(writeMcpConfig(dir2, 'maquette', false), 'utf8'));
    expect(cfg2.mcpServers.playwright.args).not.toContain('--headless');
    expect(cfg2.mcpServers.playwright.args).toContain('--allow-unrestricted-file-access');
  });

  it('une étape sans Playwright reste sans serveur, quel que soit le réglage', () => {
    process.env.CADENCE_PLAYWRIGHT_HEADED = '1';
    expect(mcpServersFor('review', true, '/o')).toEqual({});
    expect(mcpServersFor('implement', false, '/o')).toEqual({});
  });

  it('appeler deux fois rend le même résultat (pas d\'état partagé)', () => {
    delete process.env.CADENCE_PLAYWRIGHT_HEADED;
    expect(mcpServersFor('ux', true, '/o')).toEqual(mcpServersFor('ux', true, '/o'));
  });
});
