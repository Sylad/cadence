import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo, tempDir } from './helpers.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

async function raf(cwd: string, argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd, env: process.env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-27T12:00:00Z') });
  return { code, out, err };
}

describe('L376 — raf --version, raf -v et le dossier de projet introuvable (accrocs A3 et A9)', () => {
  it('R1 — raf --version et raf -v répondent la version du paquet, comme cadence --version, code 0', async () => {
    for (const flag of ['--version', '-v']) {
      const r = await raf(tempDir(), [flag]);
      expect(r.code).toBe(0);
      expect(r.out).toEqual([VERSION]);
      expect(r.err).toEqual([]);
    }
  });

  it('R2 — la version ne se lit qu\'en premier argument : « raf show --version » reste une option inconnue', async () => {
    const r = await raf(tempDir(), ['show', '--version']);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain(VERSION);
  });

  it('R3 — « cadence orchestrate alpha:L1 » dont le dossier est introuvable dit que le projet est un sous-dossier du dossier courant et que « .:L1 » marche dans un dépôt', async () => {
    const parent = tempDir();
    const alpha = gitRepo(parent);
    mkdirSync(join(alpha, 'x'), { recursive: true });
    const r = await raf(alpha, ['orchestrate', 'alpha:L1', '--dry-run']);
    expect(r.code).toBe(2);
    const msg = r.err.join('\n');
    expect(msg).toMatch(/alpha:L1 : dossier .*alpha.* introuvable/);
    expect(msg).toContain('sous-dossier du dossier courant');
    expect(msg).toContain('.:L1');
  });

  it('R4 — la doc et le CHANGELOG décrivent les deux changements', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelog).toMatch(/raf --version[^\n]*L376/);
    const page = (name: string): string => readFileSync(new URL(`../docs/${name}.md`, import.meta.url), 'utf8');
    expect(page('raf')).toMatch(/`raf --version`[^\n]*`raf -v`|`raf -v`[^\n]*`raf --version`/);
    expect(page('orchestrate')).toMatch(/dossier [^\n]*introuvable[^\n]*`\.:L1`/);
  });
});
