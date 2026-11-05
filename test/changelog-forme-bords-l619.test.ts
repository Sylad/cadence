import { describe, expect, it } from 'vitest';
import { changelogShapeProblems } from '../src/orchestrate/changelog-merge.js';

// L619 — bords du contrôle de forme : une entrée dupliquée reste signalée même quand le bloc porte autre chose que des entrées.
const PUBLISHED = '## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version (L1)\n';
const log = (unreleased: string, tail = PUBLISHED) => `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n${tail}`;
const main = log('### Added\n\n- autre lot (L5)\n');

describe('L619 — bords de changelogShapeProblems', () => {
  it('une entrée dupliquée est signalée même avec une ligne de texte libre sous [Unreleased]', () => {
    const p = changelogShapeProblems(log('Note libre\n\n### Added\n\n- a (L6)\n- a (L6)\n'), main);
    expect(p.some((m) => m.includes('a (L6)'))).toBe(true);
  });
  it('une entrée nue (avant tout titre) dupliquée est signalée', () => {
    expect(changelogShapeProblems(log('- a (L6)\n- a (L6)\n'), main)).toHaveLength(1);
  });
  it('un titre dupliqué à fins de ligne CRLF est signalé', () => {
    const p = changelogShapeProblems(log('### Added\r\n\r\n- a (L6)\r\n\r\n### Added\r\n\r\n- b (L7)\r\n').replace(/\n/g, '\n'), main);
    expect(p.length).toBeGreaterThan(0);
  });
});
