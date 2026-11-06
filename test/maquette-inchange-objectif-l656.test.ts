import { describe, expect, it } from 'vitest';
import { maquetteText } from '../src/orchestrate/maquette.js';
import { REVIEW_SCHEMA } from '../src/orchestrate/schemas.js';

// L656 (issue #46) : un majeur sur un point de l'objectif du lot n'est jamais « inchangé » : la marque le mettrait en suite alors que la revue de code le reprend en majeur.
const later = maquetteText({ fiche: 'a/b/fiche.yaml', passes: 1, max: 3 });
const first = maquetteText({ fiche: 'a/b/fiche.yaml', passes: 0, max: 3 });
const markDescription = () => JSON.stringify(REVIEW_SCHEMA);

describe('L656 — la marque inchange: true ne s’applique pas à un point de l’objectif du lot', () => {
  it('L656 — revue 2 : la consigne exclut de la marque un point de l’objectif du lot', () => {
    expect(later).toMatch(/NEVER[^.]*goal of the lot/);
    expect(later).toContain('outside the goal of the lot');
  });
  it('L656 — revue 2 : un majeur sur un point de l’objectif est à garder comme majeur compté (non marqué)', () => {
    expect(later).toMatch(/goal of the lot[^.]*(leave|do not mark)/i);
  });
  it('L656 — revue 1 : pas de consigne de marque (inchangé)', () => {
    expect(first).not.toContain('inchange');
  });
  it('L656 — le schéma de la marque dit la même exclusion', () => {
    expect(markDescription()).toContain('never on a point of the goal of the lot');
  });
});
