import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
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

describe('release() de bout en bout, sans banc v2', () => {
  it('major sur un dépôt sans v2/bin/cadence2.js : refus qui parle du banc vert', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Une chose (L7).\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: initial');
    expect(() => release(['major'], true, dir, '2026-11-07' as Day, () => {})).toThrow(/banc vert/);
  });
});
