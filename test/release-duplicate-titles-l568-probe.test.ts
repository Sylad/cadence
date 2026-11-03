import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

function project(unreleased: string): string {
  const dir = gitRepo();
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [1.2.3] - 2026-10-01\n\n### Fixed\n\n- Old (L1).\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}
function play(dir: string, ...argv: string[]) {
  const err: string[] = [];
  const code = run(['release', 'patch', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-11-03' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-03T09:00:00') });
  return { code, err: err.join('\n') };
}

describe('L568 probe — release refuse un titre de section dupliqué', () => {
  it('le refus vaut aussi en --dry-run', () => {
    const { code, err } = play(project('### Fixed\n\n- A (L1).\n\n### Fixed\n\n- B (L2).\n'), '--dry-run');
    expect(code).toBe(2);
    expect(err).toMatch(/plus d'une fois/);
  });
  it('fins de ligne CRLF : le doublon est vu', () => {
    const { code } = play(project('### Fixed\r\n\r\n- A (L1).\r\n\r\n### Fixed\r\n\r\n- B (L2).\r\n'));
    expect(code).toBe(2);
  });
  it('espaces en fin de titre : le doublon est vu', () => {
    const { code } = play(project('### Fixed  \n\n- A (L1).\n\n### Fixed\n\n- B (L2).\n'));
    expect(code).toBe(2);
  });
  it('titre dupliqué à la casse près : refusé', () => {
    const { code } = play(project('### Fixed\n\n- A (L1).\n\n### fixed\n\n- B (L2).\n'));
    expect(code).toBe(2);
  });
  it('titres distincts, un seul chacun : accepté', () => {
    const { code } = play(project('### Added\n\n- A (L1).\n\n### Fixed\n\n- B (L2).\n'), '--dry-run');
    expect(code).toBe(0);
  });
  it('#### sous-titre répété sous deux ### différents : pas un doublon', () => {
    const { code } = play(project('### Added\n\n#### Notes\n\n- A (L1).\n\n### Fixed\n\n#### Notes\n\n- B (L2).\n'), '--dry-run');
    expect(code).toBe(0);
  });
  it('« ### Fixed » dans un bloc de code d\'une entrée : pas un doublon', () => {
    const { code } = play(project('### Fixed\n\n- A (L1):\n\n  ```md\n  ### Fixed\n  ```\n'), '--dry-run');
    expect(code).toBe(0);
  });
  it('la même ligne d\'entrée répétée sous un seul titre : pas refusée par le contrôle de titre', () => {
    const { code } = play(project('### Fixed\n\n- A (L1).\n- A (L1).\n'), '--dry-run');
    expect(code).toBe(0);
  });
});
