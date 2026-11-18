import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSectionOf, entreeDuLot, readsUnreleasedOnly, repoChangelog } from './changelog-section.js';
import { tempDir } from './helpers.js';

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

  // L778, correctif de publication : `cadence release` assemble changelog.d/<lot>.md dans CHANGELOG.md et le retire ; un test qui lisait le fragment
  // tombait en ENOENT dans le clone du commit de version (2.0.16 refusée le 18-11).
  describe('entreeDuLot — l\'entrée d\'un lot sous ses deux formes (L778)', () => {
    const ENTREE = '- `cadence sondes <url>`: interaction probes (L778, D-14).\n  Windows are closed by default.';
    const depot = (): string => {
      const d = tempDir();
      writeFileSync(join(d, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [1.2.2] - 2026-10-20\n\n### Fixed\n\n- autre (L8).\n');
      mkdirSync(join(d, 'changelog.d'));
      writeFileSync(join(d, 'changelog.d', 'L778.md'), `### Added\n\n${ENTREE}\n\n### Fixed\n\n- une suite de revue (L778).\n`);
      writeFileSync(join(d, 'changelog.d', 'L777.md'), '### Added\n\n- every popup is guarded (L777).\n');
      return d;
    };
    /** Ce que fait le commit de version : fragments assemblés, [Unreleased] renommée (une vide au-dessus), fragments retirés. */
    const publier = (d: string): void => {
      writeFileSync(join(d, 'CHANGELOG.md'), repoChangelog(d).replace('## [Unreleased]\n', '## [Unreleased]\n\n## [1.2.3] - 2026-11-18\n'));
      for (const f of ['L778.md', 'L777.md']) rmSync(join(d, 'changelog.d', f));
    };

    it('R7 — avant la publication : le fragment du lot, tel quel', () => {
      const d = depot();
      expect(entreeDuLot(d, 'L778')).toBe(readFileSync(join(d, 'changelog.d', 'L778.md'), 'utf8'));
    });

    it('R8 — après le commit de version (fragment retiré) : les entrées du lot dans la section de CHANGELOG.md, lignes de suite comprises, sans celles des autres lots', () => {
      const d = depot();
      publier(d);
      expect(changelogSectionOf(readFileSync(join(d, 'CHANGELOG.md'), 'utf8'), 'L778')).toMatch(/^## \[1\.2\.3\]/);
      const t = entreeDuLot(d, 'L778');
      expect(t).toBe(`${ENTREE}\n- une suite de revue (L778).\n`);
      expect(t).not.toMatch(/L777|L8\b|every popup|^#/m);
      expect(entreeDuLot(d, 'L8')).toBe('- autre (L8).\n');
    });

    it('R9 — un lot sans fragment ni entrée : une erreur qui nomme les deux endroits, jamais un texte vide', () => {
      expect(() => entreeDuLot(depot(), 'L77')).toThrow(/L77 introuvable : ni changelog\.d\/L77\.md, ni entrée qui cite L77/);
    });

    it('R10 — le vrai dépôt : l\'entrée de L778 se lit, et dit la même chose une fois publiée', () => {
      const avant = entreeDuLot(root, 'L778');
      expect(avant).toContain('cadence sondes');
      const d = tempDir();
      writeFileSync(join(d, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
      mkdirSync(join(d, 'changelog.d'));
      writeFileSync(join(d, 'changelog.d', 'L778.md'), avant.startsWith('###') ? avant : `### Added\n\n${avant}`);
      writeFileSync(join(d, 'changelog.d', 'L777.md'), '### Added\n\n- every popup is guarded (L777).\n');
      publier(d);
      const apres = entreeDuLot(d, 'L778');
      for (const ligne of avant.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('###'))) expect(apres).toContain(ligne);
      expect(apres).not.toContain('L777');
    });

    it('R11 — aucun test ne lit le fragment d\'un lot du dépôt par son chemin : il passe par entreeDuLot', () => {
      const fautifs = readdirSync(dir)
        .filter((f) => f.endsWith('.test.ts') && f !== 'changelog-garde.test.ts')
        .filter((f) => /for \(const f of \[[^\]]*'changelog\.d\/L\d+\.md'|read\w*\([^)\n]*(?:root|import\.meta\.dirname)[^)\n]*'changelog\.d\/?'?[^)\n]*L\d+\.md/.test(readFileSync(join(dir, f), 'utf8')));
      expect(fautifs, 'utiliser entreeDuLot (test/changelog-section.ts)').toEqual([]);
    });
  });
});
