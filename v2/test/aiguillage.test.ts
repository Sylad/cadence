import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { aiguiller, BRAS_COMPLET, BRAS_LEGER, chemin, MODELES, modeleRun } from '../src/run/aiguillage.js';
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
  it('références et pièces hors du dépôt (chemin absolu ou ~) : gardées telles quelles, comme une base de connaissance', () => {
    const kb = dossierTemp('kb-'); writeFileSync(join(kb, 'lot.md'), 'dossier du lot');
    const d = depot(`references:\n  - mots: [canopy]\n    docs: [${join(kb, 'lot.md')}]\n`);
    expect(aiguiller('Le style canopy', d, [])).toMatchObject({ mode: 'complet', pieces: [join(kb, 'lot.md')] });
    expect(chemin(d, '~/x.md')).toBe(join(homedir(), 'x.md'));
    expect(chemin(d, '/abs/y.md')).toBe('/abs/y.md');
    expect(chemin(d, 'docs/z.md')).toBe(join(d, 'docs/z.md'));
  });
  it('--complet force le mode complet sans référence', () => {
    expect(aiguiller('Ajoute un bouton', depot(), [], true)).toMatchObject({ mode: 'complet', pieces: [] });
  });
  it('references mal formée : refus clair plutôt qu un aiguillage faux', () => {
    expect(() => aiguiller('x', depot('references: oui\n'), [])).toThrow(/references/);
  });
});

describe('modèle de cadence run (L699)', () => {
  it('défaut opus, celui des deux bras mesurés ; une variable vide compte pour absente', () => {
    expect([modeleRun(), modeleRun(undefined, ''), BRAS_COMPLET.modele, BRAS_LEGER.modele]).toEqual(['opus', 'opus', 'opus', 'opus']);
  });
  it('la variable d\'environnement est lue, l\'option l\'emporte', () => {
    expect(modeleRun(undefined, 'fable')).toBe('fable');
    expect(modeleRun('opus', 'fable')).toBe('opus');
    expect(modeleRun('fable', 'gpt')).toBe('fable'); // la variable n'est pas lue quand l'option est donnée
  });
  it('opus et fable passent ; toute autre valeur lève en nommant sa source (sonnet et haiku compris : cause C2)', () => {
    expect(MODELES.map((m) => modeleRun(m))).toEqual(['opus', 'fable']);
    for (const m of ['gpt', 'sonnet', 'haiku', 'Opus', '']) expect(() => modeleRun(m, 'opus')).toThrow(new RegExp(`modèle inconnu : « ${m} » ; attendu : opus, fable$`));
    expect(() => modeleRun(undefined, 'gpt')).toThrow(/« gpt » \(CADENCE_RUN_MODELE\)/);
  });
});
