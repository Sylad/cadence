import { describe, expect, it } from 'vitest';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { maquetteText } from '../src/orchestrate/maquette.js';
import { REVIEW_SCHEMA } from '../src/orchestrate/schemas.js';

// L656 (issue #46) — bords : la consigne « jamais sur un point de l'objectif » tient à tout rang, en revue légère, avec constats précédents, et dans le brief réellement rendu avec l'objectif.
const fiche = 'a/b/fiche.yaml';
const never = /NEVER mark a finding about a point of the goal of the lot/;

describe('L656 — bords de la consigne inchange / objectif', () => {
  it('L656 — dernière revue (max 1, passes 1) : la consigne d’exclusion est là', () => {
    const t = maquetteText({ fiche, passes: 1, max: 1 });
    expect(t).toContain('the last review');
    expect(t).toMatch(never);
  });
  it('L656 — passes au-delà du plafond : la consigne reste', () => {
    expect(maquetteText({ fiche, passes: 9, max: 3 })).toMatch(never);
  });
  it('L656 — revue légère avec constats précédents : la consigne reste', () => {
    const t = maquetteText({ fiche, passes: 2, max: 3, light: true, previous: [{ gravite: 'majeur', texte: 'x' }] });
    expect(t).toMatch(never);
  });
  it('L656 — la consigne n’est dite qu’une fois (pas de doublon)', () => {
    const t = maquetteText({ fiche, passes: 1, max: 3 });
    expect(t.match(/NEVER mark/g)).toHaveLength(1);
  });
  it('L656 — revue 1 : ni marque ni exclusion', () => {
    const t = maquetteText({ fiche, passes: 0, max: 3 });
    expect(t).not.toMatch(/NEVER mark/);
    expect(t).not.toContain('inchange');
  });
  it('L656 — brief rendu de la revue 2 : l’objectif du lot et l’exclusion y figurent ensemble', () => {
    const vars = { lot: 'L1', titre: 'T', chemin: '/x', objectif: 'OBJECTIF-SENTINELLE', maquette: maquetteText({ fiche, passes: 1, max: 3 }) } as unknown as Parameters<typeof renderBrief>[1];
    const out = renderBrief('maquette', vars);
    expect(out).toContain('Goal of the lot: OBJECTIF-SENTINELLE');
    expect(out).toMatch(never);
  });
  it('L656 — le schéma garde inchange booléen optionnel avec l’exclusion', () => {
    const k = (REVIEW_SCHEMA as any).properties.constats.items;
    expect(k.properties.inchange.type).toBe('boolean');
    expect(k.properties.inchange.description).toContain('never on a point of the goal of the lot');
    expect(k.required).not.toContain('inchange');
  });
});
