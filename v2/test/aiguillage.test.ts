import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiguiller, BRAS_COMPLET, BRAS_LEGER } from '../src/run/aiguillage.js';
import { dossierTemp } from './temp.js';

function depot(yaml?: string): string {
  const d = dossierTemp('aig-');
  mkdirSync(join(d, 'docs', 'normes'), { recursive: true });
  writeFileSync(join(d, 'docs', 'normes', 'sigwx.md'), '# SIGWX');
  writeFileSync(join(d, 'docs', 'normes', 'centres.md'), '# centres');
  if (yaml !== undefined) writeFileSync(join(d, 'cadence.yaml'), yaml);
  return d;
}
const REFS = `references:
  - mots: [sigwx, jet, "centre de pression"]
    docs: [docs/normes/sigwx.md, docs/normes/absent.md]
  - mots: [dépression, anticyclone]
    docs: [docs/normes/centres.md]
`;

describe('aiguillage de cadence run', () => {
  it('sans section references ni pièce : mode léger (brief de Claude seul, sans hook)', () => {
    const a = aiguiller('Ajoute un bouton', depot('orchestrate: {}\n'), []);
    expect(a).toMatchObject({ mode: 'leger', pieces: [], bras: BRAS_LEGER });
    expect(a.bras.settings).toBeUndefined();
  });
  it('un mot de references dans la demande : mode complet, documents existants ajoutés aux pièces, raison dite', () => {
    const d = depot(REFS);
    const a = aiguiller('Dessine les SIGWX du niveau 250', d, []);
    expect(a).toMatchObject({ mode: 'complet', bras: BRAS_COMPLET, pieces: ['docs/normes/sigwx.md'] });
    expect(a.raison).toMatch(/sigwx → docs\/normes\/sigwx\.md/);
  });
  it('mots sans tenir compte des accents ni de la casse, en mot entier', () => {
    const d = depot(REFS);
    expect(aiguiller('La DEPRESSION doit porter un D', d, []).pieces).toEqual(['docs/normes/centres.md']);
    expect(aiguiller('Change le jeton de session', d, []).mode).toBe('leger'); // « jet » n'est pas « jeton »
    expect(aiguiller('Affiche chaque centre de pression', d, []).pieces).toEqual(['docs/normes/sigwx.md']);
  });
  it('une pièce donnée : mode complet, la pièce en premier et sans doublon', () => {
    const d = depot(REFS);
    const a = aiguiller('Pour les SIGWX, voir la capture', d, ['capture.png', 'docs/normes/sigwx.md']);
    expect(a).toMatchObject({ mode: 'complet', pieces: ['capture.png', 'docs/normes/sigwx.md'] });
  });
  it('--complet force le mode complet sans référence', () => {
    expect(aiguiller('Ajoute un bouton', depot(), [], true)).toMatchObject({ mode: 'complet', pieces: [] });
  });
  it('references mal formée : refus clair plutôt qu un aiguillage faux', () => {
    expect(() => aiguiller('x', depot('references: oui\n'), [])).toThrow(/references/);
  });
});
