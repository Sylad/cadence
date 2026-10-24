import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { answeredText } from '../src/orchestrate/spec.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { ecrit } from './spec-helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';

// L297 — une réponse donnée par --resume --answer à une question sur une règle « hypothèse » de la fiche la passe en « sourcée » (réponse du lead, date, vague) avant la revue de fiche suivante.
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const screen = { visible: true, screen: 'page' as const };
const FICHE = 'docs/specs/prochain-match/fiche.yaml';
const COUT = 'Si faux, une migration du stockage des rappels serait à écrire.';

const spec = (fiche?: (d: any) => void): Handler => (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd, { fiche }) }));
const coutR3 = (d: any) => { d.regles[2].si_faux = COUT; };
/** Une session spec qui n'écrit rien de plus : la fiche reste celle qui est commitée (la vague perdue de L279). */
const rien: Handler = () => claudeOut(specReport({ fiche: FICHE }));
const regle = (repo: string, id: string): any => (parse(readFileSync(join(repo, FICHE), 'utf8')) as any).regles.find((r: any) => r.id === id);
const answer = (c: ReturnType<ReturnType<typeof harness>['lot']>, text = 'confirmé, garder R3') => {
  c.lot.questions = []; // --answer vide les questions
  c.lot.pendingAnswer = text;
};

describe('L297 — la réponse du lead source la règle posée en question', () => {
  it('R1 — la règle hypothèse devient sourcée : source = réponse du lead, date, vague ; plus de si_faux', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    answer(c);
    await runLot(c);
    const r3 = regle(h.repo, 'R3');
    expect(r3.statut).toBe('sourcee');
    expect(r3.source).toBe(`réponse du lead, ${c.wave.today}, vague ${c.wave.id}`);
    expect(r3).not.toHaveProperty('si_faux');
  });

  it('R2b — le reste de la fiche n\'est pas reformaté : seules les lignes de la règle changent', async () => {
    const longue = 'mot '.repeat(60).trim();
    const h = harness({ lots, script: { spec: [spec((d) => { coutR3(d); d.regles[0].enonce = longue; }), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    const avant = readFileSync(join(h.repo, FICHE), 'utf8').split('\n');
    answer(c);
    await runLot(c);
    const apres = readFileSync(join(h.repo, FICHE), 'utf8').split('\n');
    expect(avant.filter((x) => !apres.includes(x))).toEqual([`    si_faux: ${COUT}`]);
    expect(apres.filter((x) => !avant.includes(x))).toEqual([expect.stringMatching(/^ {4}source: réponse du lead/)]);
  });

  it('R2 — la fiche sourcée est commitée avec le seul fichier de la fiche, avant la session spec reprise', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    answer(c);
    await runLot(c);
    const log = git(h.repo, 'log', '--format=%s', '--', FICHE).split('\n');
    expect(log[0]).toMatch(/^spec\(L1\): R3 sourcée par la réponse du lead/);
    const sha = git(h.repo, 'log', '-1', '--format=%H', '--', FICHE);
    expect(git(h.repo, 'show', '--name-only', '--format=', sha)).toBe(FICHE);
    expect(git(h.repo, 'status', '--porcelain', '--', FICHE)).toBe('');
  });

  it('R3 — session spec perdue ou muette : la fiche est conforme quand même, le lot passe à la revue sans reposer la question (cas L279/R27)', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    answer(c);
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.questions).toEqual([]);
    expect(c.lot.spec).toMatchObject({ fiche: FICHE });
  });

  it('R4 — seules les règles posées en question sont sourcées : une autre hypothèse reste une hypothèse', async () => {
    const h = harness({ lots, script: { spec: [spec((d) => { coutR3(d); d.regles[0].statut = 'hypothese'; d.regles[0].si_faux = 'Si faux, le libellé changerait.'; }), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    answer(c);
    await runLot(c);
    expect(regle(h.repo, 'R3').statut).toBe('sourcee');
    expect(regle(h.repo, 'R1')).toMatchObject({ statut: 'hypothese', si_faux: 'Si faux, le libellé changerait.' });
  });

  it('R5 — une question de la session (pas une hypothèse de la fiche) ne touche pas la fiche', async () => {
    const demande: Handler = (call) => { ecrit(call.opts.cwd, { fiche: coutR3 }); return claudeOut(specReport({ questions: ['Quelle route pour cet écran ?'] })); };
    const h = harness({ lots, script: { spec: [demande, spec()], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    expect(c.lot.status).toBe('question');
    answer(c, '/matchs');
    await runLot(c);
    expect(c.lot.spec).toMatchObject({ fiche: FICHE });
    expect(git(h.repo, 'log', '--format=%s').split('\n').some((s) => /sourcée par la réponse du lead/.test(s))).toBe(false);
  });

  it('R6 — le brief de la spec reprise dit que le programme a déjà sourcé la règle et ne demande plus de le faire', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    answer(c);
    await runLot(c);
    const brief = h.calls[1].brief;
    expect(brief).toContain('confirmé, garder R3');
    expect(brief).toMatch(/already .*sourcee/i);
    expect(brief).not.toContain('Do not leave it as `hypothese`');
  });

  it('R7 — commit de la fiche refusé (hook) : le lot est rendu en le disant, aucune session spec n\'est jouée sur une fiche non reportée', async () => {
    const h = harness({ lots, script: { spec: [spec(coutR3), rien], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen);
    await runLot(c);
    answer(c);
    writeFileSync(join(h.repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(h.repo, '.git/hooks/pre-commit'), 0o755);
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/réponse du lead non reportée dans la fiche docs\/specs\/prochain-match\/fiche\.yaml/);
    expect(h.calls.map((x) => x.kind)).toEqual(['spec']);
  });

  it('R8 — sans règle déjà sourcée par le programme, la consigne demande encore à l\'agent de le faire', () => {
    expect(answeredText(['R3 : …'], 'oui')).toContain('becomes `statut: sourcee`');
    expect(answeredText(['R3 : …'], 'oui', ['R3'])).not.toContain('becomes `statut: sourcee`');
  });
});
