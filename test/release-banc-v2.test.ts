import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gardeBancV2, release } from '../src/release.js';
import type { Day } from '../src/dates.js';
import { commit, gitRepo } from './helpers.js';

// Refonte du 07-11 (docs/v2/2026-11-07-cadence-2-design.md §4.1) : aucune 2.x sans banc vert sur l'empreinte publiée.
describe('garde de publication 2.x', () => {
  it('1.62.2 : pas de banc demandé (v1 gelée, correctifs)', () => {
    expect(() => gardeBancV2('1.62.2', () => ({ code: 1, sortie: '' }))).not.toThrow();
  });
  it('2.0.0 sans banc vert : refus, avec la raison', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 1, sortie: 'aucun banc vert sur l\'empreinte e1' }))).toThrow(/banc vert.*e1/s);
  });
  it('2.0.0 avec banc vert : permis', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 0, sortie: 'banc vert' }))).not.toThrow();
  });
});

describe('release() de bout en bout', () => {
  const fixture = (avecBanc: boolean): string => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Une chose (L7).\n');
    if (avecBanc) {
      mkdirSync(join(dir, 'v2', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'v2', 'bin', 'cadence2.js'), "console.log(\"banc vert sur l'empreinte test\");\n");
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: initial');
    return dir;
  };
  it('major sur un dépôt sans v2/bin/cadence2.js : refus qui parle du banc vert', () => {
    expect(() => release(['major'], true, fixture(false), '2026-11-07' as Day, () => {})).toThrow(/banc vert/);
  });
  it('major avec un banc vert (cadence2 factice) : pas de refus du banc', () => {
    let refus = '';
    try { release(['major'], true, fixture(true), '2026-11-07' as Day, () => {}); } catch (e) { refus = String((e as Error).message); }
    expect(refus).not.toMatch(/banc vert/);
  });
});
