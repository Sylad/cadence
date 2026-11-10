import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { release } from '../src/release.js';
import type { Day } from '../src/dates.js';
import { commit, gitRepo } from './helpers.js';

// Demande de Sylvain (10-11) : faire évoluer la version du HUD quand on le modifie. Vécu : cadence-hud resté 0.7.0 de la 1.39.0 à la 2.0.2
// alors que son code changeait ; le compte pro devait comparer les fichiers pour s'en apercevoir. La release le fait, mécaniquement.
function depot(): string {
  const dir = gitRepo();
  const ecrire = (f: string, t: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); };
  ecrire('package.json', '{\n  "name": "acme",\n  "version": "1.0.0"\n}\n');
  ecrire('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-11-01\n\n- Base.\n');
  ecrire('.claude-plugin/plugin.json', '{\n  "name": "acme",\n  "version": "1.0.0"\n}\n');
  ecrire('.claude-plugin/marketplace.json', JSON.stringify({ name: 'acme', plugins: [
    { name: 'acme', version: '1.0.0', source: './' }, { name: 'hud', version: '0.1.0', source: './plugins/hud' }] }, null, 2) + '\n');
  ecrire('plugins/hud/.claude-plugin/plugin.json', '{\n  "name": "hud",\n  "version": "0.1.0"\n}\n');
  ecrire('plugins/hud/index.js', 'export const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir }); commit(dir, 'chore: base');
  execFileSync('git', ['tag', 'v1.0.0'], { cwd: dir });
  return dir;
}
const changer = (dir: string, f: string, t: string, message: string) => {
  writeFileSync(join(dir, f), t); execFileSync('git', ['add', '.'], { cwd: dir }); commit(dir, message);
};
const lancer = (dir: string, dry: boolean) => { const out: string[] = []; release(['patch'], dry, dir, '2026-11-10' as Day, (l) => out.push(l)); return out.join('\n'); };
const json = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

describe('release : la version d un autre plugin du marketplace suit son code', () => {
  it('code du HUD changé depuis la dernière release, même version : patch du HUD dans son plugin.json et le marketplace', () => {
    const dir = depot();
    changer(dir, 'plugins/hud/index.js', 'export const a = 2;\n', 'feat: hud');
    changer(dir, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- Le HUD change.\n\n## [1.0.0] - 2026-11-01\n\n- Base.\n', 'docs: changelog');
    expect(lancer(dir, true)).toContain('hud 0.1.0 → 0.1.1 (code changé depuis v1.0.0)');
    expect(json(dir, 'plugins/hud/.claude-plugin/plugin.json').version).toBe('0.1.0'); // --dry-run n'écrit rien
    const sortie = lancer(dir, false);
    expect(json(dir, 'plugins/hud/.claude-plugin/plugin.json').version).toBe('0.1.1');
    expect(json(dir, '.claude-plugin/marketplace.json').plugins.map((p: { version: string }) => p.version)).toEqual(['1.0.1', '0.1.1']);
    expect(sortie).toContain('plugins/hud/.claude-plugin/plugin.json'); // dans le git add du commit de version
  });
  it('HUD inchangé, ou sa version déjà montée à la main : rien', () => {
    const dir = depot();
    changer(dir, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- Autre chose.\n\n## [1.0.0] - 2026-11-01\n\n- Base.\n', 'docs: changelog');
    expect(lancer(dir, true)).not.toContain('hud 0.1.0 →');
    changer(dir, 'plugins/hud/index.js', 'export const a = 3;\n', 'feat: hud');
    changer(dir, 'plugins/hud/.claude-plugin/plugin.json', '{\n  "name": "hud",\n  "version": "0.2.0"\n}\n', 'chore: hud 0.2.0');
    expect(lancer(dir, true)).not.toMatch(/hud 0\.\d\.\d →/);
  });
});
