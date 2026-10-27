import { describe, expect, it } from 'vitest';
import { mergeUnreleased } from '../src/orchestrate/changelog-merge.js';

// L383 — une entrée nue (sans rubrique) sous [Unreleased] d'un côté, une rubrique ajoutée de l'autre : l'union range l'entrée nue sous la rubrique.
const log = (unreleased: string) => `# Changelog\n\nintro\n\n## [Unreleased]\n\n${unreleased}\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- première version\n`;
const EMPTY = log('');

describe('R1 — entrée nue d\'un côté, rubrique ajoutée de l\'autre', () => {
  it('R1 — l\'entrée nue de theirs est rangée sous la ### Fixed ajoutée par ours, une entrée par lot', () => {
    const ours = log('### Fixed\n\n- correctif ours\n');
    const theirs = log('- entrée nue theirs\n');
    expect(mergeUnreleased(EMPTY, ours, theirs)).toBe(log('### Fixed\n\n- correctif ours\n- entrée nue theirs\n'));
  });
  it('R1 — l\'entrée nue de ours est rangée sous la rubrique ajoutée par theirs', () => {
    const ours = log('- entrée nue ours\n');
    const theirs = log('### Fixed\n\n- correctif theirs\n');
    expect(mergeUnreleased(EMPTY, ours, theirs)).toBe(log('### Fixed\n\n- entrée nue ours\n- correctif theirs\n'));
  });
  it('R1 — une entrée nue sur plusieurs lignes reste un bloc', () => {
    const ours = log('### Fixed\n\n- correctif ours\n');
    const theirs = log('- nue\n  suite\n');
    expect(mergeUnreleased(EMPTY, ours, theirs)).toBe(log('### Fixed\n\n- correctif ours\n- nue\n  suite\n'));
  });
  it('R1 — base avec une rubrique : l\'entrée nue va sous la seule rubrique nouvelle, pas sous celle de base', () => {
    const base = log('### Added\n\n- base A\n');
    const ours = log('### Added\n\n- base A\n\n### Fixed\n\n- correctif ours\n');
    const theirs = log('- nue\n\n### Added\n\n- base A\n');
    expect(mergeUnreleased(base, ours, theirs)).toBe(log('### Added\n\n- base A\n\n### Fixed\n\n- correctif ours\n- nue\n'));
  });
});

describe('R2 — pas de rubrique où ranger l\'entrée nue', () => {
  it('R2 — deux entrées nues et aucune rubrique : null, le conflit reste à la main', () => {
    expect(mergeUnreleased(EMPTY, log('- a\n'), log('- b\n'))).toBeNull();
  });
  it('R2 — deux rubriques nouvelles : le choix est ambigu, null', () => {
    const ours = log('### Fixed\n\n- f\n\n### Added\n\n- a\n');
    expect(mergeUnreleased(EMPTY, ours, log('- nue\n'))).toBeNull();
  });
});
