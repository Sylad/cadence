import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { answerAltersRule, sourceRules } from '../src/orchestrate/spec.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { ecrit } from './spec-helpers.js';
import { tempDir } from './helpers.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';

// L302 — suite de la revue de L297 : la fiche n'est pas reformatée par le sourçage, et une réponse qui corrige la règle ne la marque pas « sourcée » telle quelle.
const FICHE = 'docs/specs/prochain-match/fiche.yaml';
const COUT = 'Si faux, une migration du stockage des rappels serait à écrire.';
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const screen = { visible: true, screen: 'page' as const };
const spec = (fiche?: (d: any) => void): Handler => (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, { fiche }) }));
const coutR3 = (d: any) => { d.regles[2].si_faux = COUT; };
const rien: Handler = () => claudeOut(specReport({ fiche: FICHE }));
const regle = (repo: string, id: string): any => (parse(readFileSync(join(repo, FICHE), 'utf8')) as any).regles.find((r: any) => r.id === id);

const fiche = [
  '# fiche à la main',
  'regles:',
  '  - id: R1',
  '    enonce: Une règle',
  '    cas: [C1,   C2]',
  '    statut: sourcee',
  '    source: CLAUDE.md',
  '  - id: R2   # à confirmer',
  '    enonce: "Une autre, avec: des deux-points"',
  '    cas: [C1]',
  '    statut: hypothese',
  '    si_faux: >-',
  '      Si faux, il faudrait',
  '      migrer.',
  '    tests: [ "a" ]',
  '  - id: R3',
  '    enonce: x',
  '    statut: hypothese',
  '    si_faux: y',
  '',
].join('\n');

describe('L302 — sourcer une règle ne touche que les lignes de la règle', () => {
  it('R1 — la fiche est identique à l\'octet près hors des lignes statut, source et si_faux de la règle sourcée', () => {
    const repo = tempDir();
    writeFileSync(join(repo, 'f.yaml'), fiche);
    expect(sourceRules(repo, 'f.yaml', ['R2'], 'réponse du lead, 2026-10-24, vague w')).toEqual(['R2']);
    const after = readFileSync(join(repo, 'f.yaml'), 'utf8');
    expect(after).toBe(
      fiche.replace('    statut: hypothese\n    si_faux: >-\n      Si faux, il faudrait\n      migrer.\n', '    statut: sourcee\n    source: réponse du lead, 2026-10-24, vague w\n'),
    );
    const r2 = (parse(after) as any).regles[1];
    expect(r2).toMatchObject({ statut: 'sourcee', source: 'réponse du lead, 2026-10-24, vague w', tests: ['a'] });
    expect(r2).not.toHaveProperty('si_faux');
  });

  it('R2 — une règle qui a déjà une source la voit remplacée, sans doublon de clé', () => {
    const repo = tempDir();
    writeFileSync(join(repo, 'f.yaml'), 'regles:\n  - id: R1\n    statut: hypothese\n    source: ancienne\n    si_faux: z # note\n    cas: [C1]\n');
    sourceRules(repo, 'f.yaml', ['R1'], 'réponse du lead, d, vague w');
    expect(readFileSync(join(repo, 'f.yaml'), 'utf8')).toBe('regles:\n  - id: R1\n    statut: sourcee\n    source: réponse du lead, d, vague w\n    cas: [C1]\n');
  });

  it('R3 — une règle en style de flux n\'est pas éditée : erreur claire, fiche inchangée', () => {
    const repo = tempDir();
    const flux = 'regles:\n  - {id: R1, statut: hypothese, si_faux: z}\n';
    writeFileSync(join(repo, 'f.yaml'), flux);
    expect(() => sourceRules(repo, 'f.yaml', ['R1'], 's')).toThrow(/style de flux/);
    expect(readFileSync(join(repo, 'f.yaml'), 'utf8')).toBe(flux);
  });
});

describe('L302 — une réponse qui corrige la règle ne la source pas telle quelle', () => {
  it.each([
    ['non, supprime R3', true],
    ['change en « rappel à 24 h »', true],
    ['plutôt 48 h', true],
    ['remove R3', true],
    ['confirmé, garder R3', false],
    ['oui', false],
  ])('R4 — « %s » altère la règle : %s', (text, altered) => {
    expect(answerAltersRule(text)).toBe(altered);
  });

  it('R5 — « non, supprime R3 » : la fiche reste hypothèse, la spec reprise reçoit la consigne d\'appliquer la réponse', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    c.lot.questions = [];
    c.lot.pendingAnswer = 'non, supprime R3';
    await runLot(c);
    expect(regle(h.repo, 'R3')).toMatchObject({ statut: 'hypothese' });
    expect(h.calls[1].brief).toContain('non, supprime R3');
    expect(h.calls[1].brief).toContain('Do not leave it as `hypothese`');
  });

  it('R6 — la session reprise ne traite pas la règle : elle est rendue au lead, pas passée sourcée', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    c.lot.questions = [];
    c.lot.pendingAnswer = 'non, change en X';
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.questions[0]).toMatch(/^R3 est posée comme hypothèse/);
  });
});
