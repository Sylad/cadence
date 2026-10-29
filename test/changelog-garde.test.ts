import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSectionOf, readsUnreleasedOnly } from './changelog-section.js';

const dir = import.meta.dirname;
const root = join(dir, '..');

const LOG = '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-27\n\n### Added\n\n- une chose (L9)\n\n## [1.2.2] - 2026-10-20\n\n- autre (L8)\n';

describe('lecture du CHANGELOG par les tests (L380)', () => {
  it('R1 — changelogSectionOf rend la section qui porte l\'entrée : [Unreleased] avant le commit de version, la version publiée après', () => {
    const avant = '## [Unreleased]\n\n- une chose (L9)\n\n## [1.2.2] - x\n\n- autre (L8)\n';
    expect(changelogSectionOf(avant, '(L9')).toMatch(/^## \[Unreleased\]/);
    expect(changelogSectionOf(LOG, '(L9')).toMatch(/^## \[1\.2\.3\]/);
    expect(changelogSectionOf(LOG, /\(L8\)/)).toMatch(/^## \[1\.2\.2\]/);
    expect(changelogSectionOf(LOG, '(L7')).toBe('');
  });

  it('R2 — la section rendue ne déborde pas sur la suivante', () => {
    expect(changelogSectionOf(LOG, '(L9')).not.toContain('(L8)');
  });

  it('R3 — le détecteur refuse un test qui lit le vrai CHANGELOG.md dans [Unreleased] seul, et laisse passer les autres', () => {
    const mauvais = "const non = read('CHANGELOG.md').split(/\\n(?=## \\[)/).find((s) => s.startsWith('## [Unreleased]')) ?? '';";
    expect(readsUnreleasedOnly(mauvais)).toBe(true);
    expect(readsUnreleasedOnly("readFileSync(join(root, 'CHANGELOG.md'), 'utf8')\n'## [Unreleased]'")).toBe(false);
    expect(readsUnreleasedOnly("changelogSectionOf(read('CHANGELOG.md'), 'L1')")).toBe(false);
    expect(readsUnreleasedOnly("// [Unreleased] cité en commentaire\nread('CHANGELOG.md')")).toBe(false);
    expect(readsUnreleasedOnly("const log = '## [Unreleased]\\n- x'; read(dir, 'CHANGELOG.md')")).toBe(false);
  });

  it('R6 — le détecteur refuse aussi la lecture par split(\'## [Unreleased]\') (L427 : R19 de L426 passait entre les mailles)', () => {
    const mauvais = "const unreleased = read('CHANGELOG.md').split('## [Unreleased]')[1]!.split('\\n## [')[0]!;";
    expect(readsUnreleasedOnly(mauvais)).toBe(true);
    expect(readsUnreleasedOnly("changelogSectionOf(read('CHANGELOG.md'), 'L426')")).toBe(false);
  });

  it('R4 — aucun test du dépôt ne cherche l\'entrée d\'un lot dans [Unreleased] seul hors de l\'utilitaire partagé', () => {
    const fautifs = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts') && f !== 'changelog-garde.test.ts')
      .filter((f) => readsUnreleasedOnly(readFileSync(join(dir, f), 'utf8')));
    expect(fautifs, 'utiliser changelogSectionOf (test/changelog-section.ts)').toEqual([]);
  });

  it('R5 — R10 de avec-vos-outils lit la section qui porte L363 : le vrai CHANGELOG la trouve', () => {
    expect(changelogSectionOf(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), 'L363')).not.toBe('');
  });
});
