import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

const lot = (id: string, title: string, status = 'done', notes = '') => `  - id: ${id}\n    title: ${JSON.stringify(title)}\n    status: ${status}\n    estimate: 1\n${notes ? `    notes:\n      - { date: 2026-11-03, text: ${JSON.stringify(notes)} }\n` : ''}`;

function project(lots: string, unreleased: string, rest = '## [1.2.3] - 2026-10-01\n\n- Old (L1).\n'): string {
  const dir = gitRepo();
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n${rest}`);
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}

function release(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-03' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-03T09:00:00') });
  return { code, out: out.join('\n') };
}

describe('cadence release — issues, bords (L548)', () => {
  it('commandes triées par numéro croissant, même si citées dans l’ordre inverse', () => {
    const dir = project(lot('L1', 'a (issue #30)') + lot('L2', 'b (issue #4)'), '- a (L1).\n- b (L2).\n');
    const { out } = release(dir, 'patch', '--dry-run');
    expect(out.indexOf('gh issue close 4 ')).toBeGreaterThan(-1);
    expect(out.indexOf('gh issue close 4 ')).toBeLessThan(out.indexOf('gh issue close 30 '));
  });
  it('un lot cité dans l’ancienne version seulement (pas dans [Unreleased]) : rien', () => {
    const dir = project(lot('L1', 'a (issue #30)'), '- autre (L7).\n');
    expect(release(dir, 'patch', '--dry-run').out).not.toContain('gh issue close');
  });
  it('lot cité deux fois dans le corps : l’id n’est répété qu’une fois dans le commentaire', () => {
    const dir = project(lot('L1', 'a (issue #30)'), '- a (L1).\n- encore (L1).\n');
    const { out } = release(dir, 'patch', '--dry-run');
    expect(out).toContain('Réglée par L1, publiée en 1.2.4"');
  });
  it('plan illisible (YAML cassé) : la release se prépare sans section d’issues', () => {
    const dir = project(lot('L1', 'a (issue #30)'), '- a (L1).\n');
    writeFileSync(join(dir, '.cadence/raf.yaml'), 'version: 1\nlots: [ {{{\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: casse le plan');
    const { out } = release(dir, 'patch', '--dry-run');
    expect(out).not.toContain('gh issue close');
    expect(out).toMatch(/étapes du lead/);
  });
  it('minor et major : la version du commentaire suit le bump', () => {
    const dir = project(lot('L1', 'a (issue #30)'), '- a (L1).\n');
    expect(release(dir, 'minor', '--dry-run').out).toContain('publiée en 1.3.0"');
    expect(release(dir, 'major', '--dry-run').out).toContain('publiée en 2.0.0"');
  });
  it('lot non clos (todo) cité dans le corps : la commande est tout de même imprimée (le lead tranche)', () => {
    const dir = project(lot('L1', 'a (issue #30)', 'todo'), '- a (L1).\n');
    expect(release(dir, 'patch', '--dry-run').out).toContain('gh issue close 30 ');
  });
});
