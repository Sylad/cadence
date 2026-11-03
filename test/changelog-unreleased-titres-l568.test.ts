import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refuseDuplicateTitles, splitUnreleased } from '../src/release.js';

// L568 — contrôle de la porte (`npx vitest run`, rejouée à l'intégration) : une intégration qui laisse un titre de section en double sous [Unreleased] la tient rouge.
describe('L568 — le CHANGELOG.md du projet', () => {
  it('L568 — son [Unreleased] porte chaque titre de section une seule fois', () => {
    const { body } = splitUnreleased(readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8'));
    expect(() => refuseDuplicateTitles(body)).not.toThrow();
  });
  it('L568 — le contrôle voit un second titre, casse comprise', () => {
    expect(() => refuseDuplicateTitles('### Fixed\n\n- a\n\n### Added\n\n- b\n\n### fixed\n\n- c\n')).toThrow(/plus d'une fois/);
  });
});
