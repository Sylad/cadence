import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

describe('Node minimal (L365)', () => {
  it('R1 — package.json exige Node >=22.18, la première version qui exécute les .ts sans outil', () => {
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=22.18');
  });

  it('R2 — tests.yml essaie la suite en matrice sur Node 22 et 24, et nulle part sur Node 20', () => {
    const tests = read('.github/workflows/tests.yml');
    expect(tests).toMatch(/matrix:\n\s+node:\s*\[22, 24\]/);
    expect(tests).toContain('node-version: ${{ matrix.node }}');
    expect(tests).not.toMatch(/node-version: 20/);
  });

  it('R3 — le CHANGELOG annonce le changement sous [Unreleased] › Changed, avec un avertissement explicite', () => {
    const changelog = read('CHANGELOG.md');
    const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('\n## [1.'));
    const changed = unreleased.slice(unreleased.indexOf('### Changed'));
    expect(changed).toMatch(/L365[^\n]*Node >=22\.18[^\n]*Node 20/);
    expect(changed).toMatch(/\*\*Warning[^*]*Node 20 is no longer supported\*\*/);
  });

  it('R4 — docs/stabilite.md dit que la version minimale de Node suit les LTS maintenues, et que la monter est un changement mineur', () => {
    const s = read('docs/stabilite.md');
    expect(s).toMatch(/minimum Node version follows the maintained LTS/i);
    expect(s).toContain('22.18');
  });

  it('R5 — le README et docs/releasing.md disent la version de Node requise et la matrice de la CI', () => {
    expect(read('README.md')).toContain('Node 22.18');
    expect(read('docs/releasing.md')).toContain('Node 22 and 24');
  });
});
