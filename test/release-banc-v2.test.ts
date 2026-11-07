import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  // Le faux cadence2 écrit ses arguments dans un marqueur : preuve que la garde l'a bien appelé.
  const FAUX = "require('node:fs').writeFileSync('.banc-appele', process.argv.slice(2).join(' '));\nconsole.log(\"banc vert sur l'empreinte test\");\nprocess.exit(CODE);\n";
  const fixture = (code: number | null): string => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Une chose (L7).\n');
    if (code !== null) {
      mkdirSync(join(dir, 'v2', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'v2', 'bin', 'cadence2.js'), FAUX.replace('CODE', String(code)));
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: initial');
    return dir;
  };
  it('major sur un dépôt sans v2/bin/cadence2.js : refus qui parle du banc vert', () => {
    expect(() => release(['major'], true, fixture(null), '2026-11-07' as Day, () => {})).toThrow(/banc vert/);
  });
  it('major avec un cadence2 qui rend 1 : refus, et la garde a bien appelé le banc', () => {
    const dir = fixture(1);
    expect(() => release(['major'], true, dir, '2026-11-07' as Day, () => {})).toThrow(/banc vert/);
    expect(readFileSync(join(dir, '.banc-appele'), 'utf8')).toContain('bench verifier-publication');
  });
  it('major avec un banc vert : le dry-run passe, le banc a été appelé, la ligne → 2.0.0 est sortie', () => {
    const dir = fixture(0);
    const out: string[] = [];
    const code = release(['major'], true, dir, '2026-11-07' as Day, (l) => out.push(l));
    expect(code).toBe(0);
    expect(readFileSync(join(dir, '.banc-appele'), 'utf8')).toContain('bench verifier-publication');
    expect(out.some((l) => l.includes('→ 2.0.0'))).toBe(true);
  });
});
