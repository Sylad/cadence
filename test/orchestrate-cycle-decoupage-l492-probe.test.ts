import { describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isNonQuestion, redExcerpt, needsPrecheck } from '../src/orchestrate/cycle.js';
import { shEscape } from '../src/orchestrate/cycle/sh.js';
import { minorLine, withoutLine } from '../src/orchestrate/cycle/shared.js';
import { handBackDroppedQuestions } from '../src/orchestrate/cycle/questions.js';
import type { Constat } from '../src/orchestrate/state.js';

const dir = join(__dirname, '..', 'src', 'orchestrate', 'cycle');
const loaders: Record<string, () => Promise<unknown>> = {
  'accept-step': () => import('../src/orchestrate/cycle/accept-step.js'),
  'baseline-run': () => import('../src/orchestrate/cycle/baseline-run.js'),
  'brief': () => import('../src/orchestrate/cycle/brief.js'),
  'budget': () => import('../src/orchestrate/cycle/budget.js'),
  'checks': () => import('../src/orchestrate/cycle/checks.js'),
  'ctx': () => import('../src/orchestrate/cycle/ctx.js'),
  'depot-partage': () => import('../src/orchestrate/cycle/depot-partage.js'),
  'integrate-lot': () => import('../src/orchestrate/cycle/integrate-lot.js'),
  'plan-writes': () => import('../src/orchestrate/cycle/plan-writes.js'),
  'precheck-step': () => import('../src/orchestrate/cycle/precheck-step.js'),
  'questions': () => import('../src/orchestrate/cycle/questions.js'),
  'review': () => import('../src/orchestrate/cycle/review.js'),
  'session': () => import('../src/orchestrate/cycle/session.js'),
  'sh': () => import('../src/orchestrate/cycle/sh.js'),
  'shared': () => import('../src/orchestrate/cycle/shared.js'),
  'spec-steps': () => import('../src/orchestrate/cycle/spec-steps.js'),
  'work': () => import('../src/orchestrate/cycle/work.js'),
};
// L567 : après vi.resetModules() chaque import retransforme tout le graphe du cycle ; le délai par défaut (5 s) tombait sur ce travail, pas sur un cycle d'import qui bloquerait, sous charge
const IMPORT_FRAIS_MS = 60_000;
const modules = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, ''));

describe('L492 — chaque module de cycle/ se charge seul en premier (cycles d\'import)', () => {
  for (const m of modules) {
    it(`import frais de cycle/${m}`, async () => {
      vi.resetModules();
      const mod = await loaders[m]!();
      expect(mod).toBeTruthy();
    }, IMPORT_FRAIS_MS);
  }
  it('import frais de la façade cycle.ts', async () => {
    vi.resetModules();
    const mod = await import('../src/orchestrate/cycle.js');
    expect(typeof mod.runLot).toBe('function');
    expect(typeof mod.needsPrecheck).toBe('function');
  }, IMPORT_FRAIS_MS);
});

describe('L492 — isNonQuestion aux bords', () => {
  it.each([
    ['', true], ['   ', true], ['\n', true], ['Aucune question.', true], ['  NO QUESTIONS!  ', true],
    ['je n’ai pas de question', true], ['N/A', true], ['aucune question ?', false], ['?', false],
    ['aucune question, mais pourquoi', false], ['rien…', true], ['pas de question -', true],
  ])('%j → %s', (q, attendu) => {
    expect(isNonQuestion(q)).toBe(attendu);
  });
  it('un type erroné (undefined) lève au lieu de se taire comme avant', () => {
    expect(() => isNonQuestion(undefined as unknown as string)).toThrow();
  });
});

describe('L492 — redExcerpt aux bords', () => {
  const k = (texte: string): Constat => ({ source: 'tests', gravite: 'bloquant', texte });
  it('texte vide', () => expect(redExcerpt(k(''))).toBe(''));
  it('une seule ligne avec « : » final', () => expect(redExcerpt(k('npx vitest run en échec (code 1) :'))).toBe('npx vitest run en échec (code 1)'));
  it('plus de 10 tests nommés → 10 + compteur', () => {
    const t = ['cmd :', ...Array.from({ length: 13 }, (_, i) => `- t${i}`)].join('\n');
    const r = redExcerpt(k(t));
    expect(r.split(' ; ')).toHaveLength(12);
    expect(r.endsWith('… (+3)')).toBe(true);
  });
  it('sans nom : les 10 dernières lignes, vides ignorées', () => {
    const t = ['cmd', ...Array.from({ length: 15 }, (_, i) => `l${i}\n`)].join('\n');
    const r = redExcerpt(k(t)).split(' ; ');
    expect(r[1]).toBe('l5');
    expect(r.at(-1)).toBe('l14');
  });
});

describe('L492 — needsPrecheck aux bords', () => {
  const plan = { lot: () => ({ title: 'x', goal: undefined }), lots: () => [] } as never;
  it('precheck désactivé → false même en local', () => {
    expect(needsPrecheck({ precheck: false, precheckLocal: true }, plan, '/inexistant', 'L1')).toBe(false);
  });
});

describe('L492 — shEscape / minorLine / withoutLine', () => {
  it('shEscape : vide, espaces multiples, guillemets, $ et backquote', () => {
    expect(shEscape('')).toBe('');
    expect(shEscape('a \n\t b')).toBe('a b');
    expect(shEscape('"$x`y`\\')).toBe('\\"\\$x\\`y\\`\\\\');
  });
  it('minorLine sans fichier, avec fichier, avec ligne 0', () => {
    expect(minorLine('code', { texte: 't' })).toBe('[mineur code] t');
    expect(minorLine('code', { fichier: 'a.ts', texte: 't' })).toBe('[mineur code] a.ts — t');
    expect(minorLine('code', { fichier: 'a.ts', ligne: 0, texte: 't' })).toBe('[mineur code] a.ts — t');
    expect(minorLine('code', { fichier: 'a.ts', ligne: 3, texte: 't' })).toBe('[mineur code] a.ts:3 — t');
  });
  it('withoutLine retire la ligne, deux fois = idempotent, texte étranger intact', () => {
    const l = minorLine('code', { fichier: 'a.ts', ligne: 3, texte: 't' });
    expect(withoutLine(l)).toBe('[mineur code] a.ts — t');
    expect(withoutLine(withoutLine(l))).toBe('[mineur code] a.ts — t');
    expect(withoutLine('autre chose')).toBe('autre chose');
    expect(withoutLine('')).toBe('');
  });
});

describe('L492 — handBackDroppedQuestions', () => {
  it('liste vide : ne fait rien', () => {
    expect(() => handBackDroppedQuestions([])).not.toThrow();
  });
});
