import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

const lot = (id: string, title: string, notes = '') => `  - id: ${id}\n    title: ${JSON.stringify(title)}\n    status: done\n    estimate: 1\n${notes ? `    notes:\n      - { date: 2026-11-03, text: ${JSON.stringify(notes)} }\n` : ''}`;

function project(lots: string | null, unreleased: string): string {
  const dir = gitRepo();
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [1.2.3] - 2026-10-01\n\n- Old (L1).\n`);
  if (lots !== null) {
    mkdirSync(join(dir, '.cadence'));
    writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}

function release(dir: string, ...argv: string[]) {
  const out: string[] = [];
  run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-03' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-03T09:00:00') });
  return out.join('\n');
}

describe('cadence release — issues à fermer (L548)', () => {
  it('R7 — un lot de la version qui cite « issue #n » : la commande gh issue close avec le lot et la version', () => {
    const dir = project(lot('L526', 'Réglée (issue #20)'), '- Corrigé (L526).\n');
    expect(release(dir, 'patch', '--dry-run')).toContain('gh issue close 20 --comment "Réglée par L526, publiée en 1.2.4"');
  });
  it('R7 — la citation peut être dans une note du lot ; plusieurs issues : une commande chacune', () => {
    const dir = project(lot('L526', 'Réglée', 'issues #20 et #21'), '- Corrigé (L526).\n');
    const out = release(dir, 'patch', '--dry-run');
    expect(out).toContain('gh issue close 20 --comment "Réglée par L526, publiée en 1.2.4"');
    expect(out).toContain('gh issue close 21 --comment "Réglée par L526, publiée en 1.2.4"');
  });
  it('R7 — deux lots de la version citent la même issue : une seule commande, les deux lots', () => {
    const dir = project(lot('L526', 'A (issue #20)') + lot('L527', 'B (issue #20)'), '- A (L526).\n- B (L527).\n');
    const out = release(dir, 'patch', '--dry-run');
    expect(out.match(/gh issue close 20 /g)).toHaveLength(1);
    expect(out).toContain('Réglée par L526, L527, publiée en 1.2.4');
  });
  it('R8 — un lot qui cite une issue mais que la version ne cite pas (autre version, ou numéro voisin) : rien', () => {
    const dir = project(lot('L526', 'Réglée (issue #20)') + lot('L52', 'x'), '- Corrigé (L52).\n');
    const out = release(dir, 'patch', '--dry-run');
    expect(out).not.toContain('gh issue close');
  });
  it('R8 — sans plan, ou sans lot qui cite une issue : aucune section d’issues, la release se prépare', () => {
    expect(release(project(null, '- Corrigé (L526).\n'), 'patch', '--dry-run')).not.toMatch(/issue/i);
    expect(release(project(lot('L526', 'Rien'), '- Corrigé (L526).\n'), 'patch', '--dry-run')).not.toMatch(/gh issue close/);
  });
  it('R9 — la commande n’est qu’imprimée : sous le titre qui dit que le lead décide, et sans --dry-run non plus rien n’est lancé', () => {
    const dir = project(lot('L526', 'Réglée (issue #20)'), '- Corrigé (L526).\n');
    const out = release(dir, 'patch');
    expect(out).toMatch(/issues à fermer[^\n]*lead[^\n]*\n\s+gh issue close 20 /);
  });
});
