import { describe, expect, it } from 'vitest';
import { precheckBrief } from '../src/orchestrate/briefs.js';
import { keepPrecheckReading, PRECHECK_LU_MAX } from '../src/orchestrate/precheck.js';
import { claudeOut, commitFile, git, harness, type Handler } from './orchestrate-harness.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { renderBrief } from '../src/orchestrate/briefs.js';

const lot = () => ({ warnings: [] as string[], precheckLu: undefined as string | undefined });
const impl: Handler = (call) => claudeOut({ resume: 'r', commits: [commitFile(call.opts.cwd, `f-${Math.random().toString(36).slice(2)}.txt`, 'feat(L1): a')], tests: 'ok', build: 'ok', choix: [], nonVerifie: [], questions: [], nouveauxEchecs: [], echecsDeBase: [] } as never);

describe('probe L523 — R7 troncature', () => {
  it('R7 probe — une coupure ne laisse pas de demi-paire de substitution', () => {
    const l = lot();
    keepPrecheckReading(l, 'a'.repeat(PRECHECK_LU_MAX - 11) + '😀'.repeat(20));
    expect(l.precheckLu!.length).toBeLessThanOrEqual(4000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l.precheckLu!)).toBe(false);
  });
  it('R7 probe — 4001 espaces puis texte : rogné avant mesure, sans marqueur', () => {
    const l = lot();
    keepPrecheckReading(l, ' '.repeat(5000) + 'x');
    expect(l.precheckLu).toBe('x');
  });
  it('R6 probe — lu écrit deux fois : le second vide ne garde pas l\'ancien silencieusement', () => {
    const l = lot();
    keepPrecheckReading(l, 'premier');
    keepPrecheckReading(l, '');
    expect(l.precheckLu).toBeUndefined();
  });
});

describe('probe L523 — R8 brief', () => {
  it('R8 probe — un lu portant {{lot}} et $& arrive tel quel dans le brief rendu', () => {
    const lu = 'voir {{lot}} et $& et $1';
    const vars = { chemin: '/r', lot: 'L9', titre: 't', objectif: 'o', commits: precheckBrief('', undefined, lu), reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '', fiche: '', repos: '' };
    expect(renderBrief('implement', vars)).toContain(lu);
  });
  it('R8 probe — la lecture n\'est donnée qu\'à la première passe : pas à une seconde passe implement après une première terminée', async () => {
    const h = harness({ script: { implement: [impl, impl], review: [() => claudeOut({ bloquants: 0, majeurs: 0, mineurs: 0, constats: [], sousTaches: [], nonVerifie: [], verdict: 'conforme' } as never)] } });
    const c = h.lot('L1');
    c.lot.precheckLu = 'LECTURE-UNIQUE';
    c.lot.next = 'implement';
    c.lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'done', started: 'x', headBefore: git(h.repo, 'rev-parse', 'HEAD') } as never);
    await runLot(c);
    const first = h.calls.find((k) => k.kind === 'implement');
    expect(first?.brief ?? '').not.toContain('LECTURE-UNIQUE');
  });
});
