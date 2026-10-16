import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOrchestrateConfig } from '../src/config.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { checkShape, REVIEW_SCHEMA, type ReviewReport } from '../src/orchestrate/schemas.js';
import { readAgents } from '../src/orchestrate/launch.js';
import { AGENTS_DIR } from '../src/skills.js';
import { claudeOut, commitFile, harness, reviewReport, specReport, workReport, type Handler } from './orchestrate-harness.js';
import { ecrit, ecritBack } from './spec-helpers.js';
import { tempDir } from './helpers.js';

// L230 (spec revue-maquette-exhaustive) : balayage complet dès la première revue de maquette, jusqu'à orchestrate.maquetteReviews revues (3 par défaut).
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const impl: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const ok: Handler = () => claudeOut(reviewReport());
const screen = { visible: true, screen: 'page' as const };
const lots = [{ title: 'Un écran', screen: 'page' as const }];
const spec: Handler = (call) => claudeOut(specReport({ fiche: ecrit(call.opts.cwd) }));
const hors: Handler = () => claudeOut(specReport({ fiche: 'autre/dossier/fiche.yaml' }));
const major = (texte = 'contraste 2:1 du texte d’erreur', extra: Record<string, unknown> = {}): Handler => () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte, ...extra }], verdict: 'non conforme : 1 majeur' }));
const minor = (extra: Record<string, unknown>): Handler => () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', texte: 'espacement', ...extra }], verdict: 'conforme : 1 mineur' }));
const cfg = (maquetteReviews?: number) => ({ maquette: true, ...(maquetteReviews ? { maquetteReviews } : {}) });
const yaml = (y: string) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), y);
  return readOrchestrateConfig(join(dir, 'cadence.yaml'));
};

describe('R1/R2 — orchestrate.maquetteReviews', () => {
  it('R1 — cadence.yaml sans maquetteReviews : le plafond lu est 3', () => {
    expect(readOrchestrateConfig('/nope').maquetteReviews).toBe(3);
    expect(yaml('orchestrate:\n  maquette: true\n').maquetteReviews).toBe(3);
  });
  it('R1 — maquetteReviews: 4 : le plafond lu est 4', () => {
    expect(yaml('orchestrate:\n  maquetteReviews: 4\n').maquetteReviews).toBe(4);
  });
  it('R2 — maquetteReviews: 0 : erreur nommant orchestrate.maquetteReviews', () => {
    expect(() => yaml('orchestrate:\n  maquetteReviews: 0\n')).toThrow('cadence.yaml : orchestrate.maquetteReviews : entier supérieur ou égal à 1 attendu');
    expect(() => yaml('orchestrate:\n  maquetteReviews: -1\n')).toThrow(/orchestrate\.maquetteReviews/);
  });
  it("R2 — maquetteReviews: 2.5 et maquetteReviews: 'trois' : erreur", () => {
    expect(() => yaml('orchestrate:\n  maquetteReviews: 2.5\n')).toThrow(/orchestrate\.maquetteReviews/);
    expect(() => yaml("orchestrate:\n  maquetteReviews: 'trois'\n")).toThrow(/orchestrate\.maquetteReviews/);
    expect(() => yaml('orchestrate:\n  maquetteReviews: true\n')).toThrow(/orchestrate\.maquetteReviews/);
  });
  it("R2 — maquetteReviews n'est plus rejetée comme clé inconnue", () => {
    expect(() => yaml('orchestrate:\n  maquetteReviews: 2\n')).not.toThrow();
  });
});

describe('R3/R4/R10 — le balayage complet dès la première revue', () => {
  it('R3 — le brief maquette.md rendu contient chacun des sept points du balayage', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, cfg()));
    const brief = h.calls.find((x) => x.kind === 'maquette')!.brief;
    for (const point of ['every state of the sheet at 1440 px and at 390 px', 'every rule of the sheet', 'contrast', 'real envelope of the app', 'gutters', 'empty or stretched panels', 'holes']) expect(brief, point).toContain(point);
  });
  it('R3 — agents/ux-reviewer.md (mode maquette) contient la liste à cocher et la consigne nonVerifie', () => {
    const prompt = readAgents(AGENTS_DIR)['ux-reviewer'].prompt;
    const mockup = prompt.slice(prompt.indexOf('## Mockup mode'), prompt.indexOf('## Conformity mode') > 0 ? prompt.indexOf('## Conformity mode') : undefined);
    for (const point of ['checklist', 'nonVerifie', 'every state', 'every rule', 'contrast', 'real envelope', 'gutters', 'empty or stretched panels', 'holes', 'ALL the blocking and major']) expect(mockup, point).toContain(point);
  });
  it('R4 — brief de la revue 1 : la consigne « tous les majeurs » est présente', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, cfg()));
    expect(h.calls.find((x) => x.kind === 'maquette')!.brief).toContain('ALL the blocking and major findings in this first report');
  });
  it('R10 — le brief demande la liste à cocher dans le rapport et nonVerifie pour le reste', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, cfg()));
    const brief = h.calls.find((x) => x.kind === 'maquette')!.brief;
    expect(brief).toMatch(/checklist in the text of your report/);
    expect(brief).toMatch(/what you cannot verify goes in `nonVerifie`/);
  });
  it('R4 — maquetteReviews 3, trois revues non conformes : lot rendu, message « après 3 revues »', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [major(), major(), major('trou central')] } });
    const c = h.lot('L1', screen, cfg(3));
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'spec', 'maquette']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('maquette non conforme après 3 revues : non conforme : 1 majeur');
    expect(c.lot.outcome).toContain('trou central');
  });
  it('R4 — maquetteReviews 3, revue 2 non conforme : la spec est renvoyée, pas de rendu', async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [major(), major(), ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', screen, cfg(3));
    await runLot(c);
    expect(kinds(h).slice(0, 5)).toEqual(['spec', 'maquette', 'spec', 'maquette', 'spec']);
    expect(c.lot.status).toBe('ready');
  });
  it('R4 — maquetteReviews 1 : première revue non conforme, lot rendu « maquette non conforme après 1 revue : » (singulier, sans « s »)', async () => {
    const h = harness({ lots, script: { spec: [spec], maquette: [major()] } });
    const c = h.lot('L1', screen, cfg(1));
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'maquette']);
    expect(c.lot.outcome).toContain('maquette non conforme après 1 revue : ');
    expect(c.lot.outcome).not.toContain('après 1 revues');
  });
});

describe('R5/R6 — plafond de sessions spec du lot', () => {
  it('R5 — lot à écran, maquetteReviews 3 : trois sessions spec permises, la quatrième refusée', async () => {
    const h = harness({ lots, script: { spec: [hors, hors, hors, hors] } });
    const c = h.lot('L1', screen, cfg(3));
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec', 'spec']);
    expect(c.lot.status).toBe('handed-back');
  });
  it('R5 — specStep, lot à écran, maquetteReviews 3, spec non conforme après la 2ᵉ passe : une 3ᵉ passe est encore permise', async () => {
    const h = harness({ lots, script: { spec: [hors, hors, spec], maquette: [ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, cfg(3)));
    expect(kinds(h)).toEqual(['spec', 'spec', 'spec', 'maquette', 'implement', 'review']);
  });
  it('R5 — specStep, lot à écran, spec non conforme après la 3ᵉ passe : lot rendu « spec non conforme après 3 passes »', async () => {
    const h = harness({ lots, script: { spec: [hors, hors, hors] } });
    const c = h.lot('L1', screen, cfg(3));
    await runLot(c);
    expect(c.lot.outcome).toContain('spec non conforme après 3 passes : ');
  });
  it('R5 — specStep, lot back sans écran, maquetteReviews 3 : plafond 2, lot rendu « spec non conforme après 2 passes » à la 2ᵉ passe non conforme', async () => {
    const h = harness({ lots: [{ title: 'Un comportement', spec: true }], script: { spec: [hors, hors, hors] } });
    const c = h.lot('L1', { specLot: true }, { fiche: true, ...cfg(3) });
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec']);
    expect(c.lot.outcome).toContain('spec non conforme après 2 passes : ');
  });
  it('R5 — lot à écran avec orchestrate.maquette false : plafond de sessions 2', async () => {
    const h = harness({ lots, script: { spec: [hors, hors, hors] } });
    const c = h.lot('L1', screen, { maquette: false, maquetteReviews: 3 });
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec']);
    expect(c.lot.outcome).toContain('spec non conforme après 2 passes : ');
  });
  it('R5 — plafond atteint avant la dernière revue : message « la spec a déjà joué 3 sessions »', async () => {
    const h = harness({ lots, script: { spec: [hors, spec, spec], maquette: [major(), major()] } });
    const c = h.lot('L1', screen, cfg(3));
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'spec', 'maquette', 'spec', 'maquette']);
    expect(c.lot.outcome).toContain('maquette non conforme et la spec a déjà joué 3 sessions : ');
  });
  it('R5 — réponse du lead : l.specRuns remis à zéro, trois sessions de nouveau permises', async () => {
    const h = harness({ lots, script: { spec: [() => claudeOut(specReport({ questions: ['Quel périmètre ?'] }))] } });
    const c = h.lot('L1', { ...screen, specRuns: 2 }, cfg(3));
    await runLot(c);
    expect(c.lot.status).toBe('question');
    expect(c.lot.specRuns).toBeUndefined();
  });

  const mixte: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd, { mixte: true }) }));
  const mixteLots = [{ title: 'Un écran et son API', screen: 'page' as const }];
  const majorFiche = (texte: string): Handler => () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte }], verdict: 'non conforme' }));
  it('R6 — fiche non conforme à la 2ᵉ revue avec maquetteReviews 3 : lot rendu « fiche non conforme après 2 revues »', async () => {
    const h = harness({ lots: [{ title: 'Un comportement', spec: true }], script: { spec: [(call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) })), (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) }))], fiche: [majorFiche('R5 : sans source'), majorFiche('R5 : toujours')] } });
    const c = h.lot('L1', { specLot: true }, { fiche: true, ...cfg(3) });
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche', 'spec', 'fiche']);
    expect(c.lot.outcome).toContain('fiche non conforme après 2 revues');
  });
  it('R6 — lot mixte, 2 sessions spec déjà jouées (maquette), maquetteReviews 3 : la revue de la fiche renvoie encore à la spec (3ᵉ session)', async () => {
    const h = harness({ lots: mixteLots, script: { spec: [mixte, mixte], fiche: [majorFiche('R5 : sans source'), ok], maquette: [ok], implement: [impl], review: [ok] } });
    const c = h.lot('L1', { ...screen, specRuns: 1 }, { fiche: true, ...cfg(3) });
    await runLot(c);
    expect(kinds(h).filter((k) => k === 'spec')).toHaveLength(2);
    expect(c.lot.specRuns).toBe(3);
    expect(c.lot.status).toBe('ready');
  });
  it('R6 — lot mixte, 3 sessions spec déjà jouées : la revue de la fiche rend le lot « la spec a déjà joué 3 sessions »', async () => {
    const h = harness({ lots: mixteLots, script: { spec: [mixte], fiche: [majorFiche('R5 : sans source')] } });
    const c = h.lot('L1', { ...screen, specRuns: 2 }, { fiche: true, ...cfg(3) });
    await runLot(c);
    expect(kinds(h)).toEqual(['spec', 'fiche']);
    expect(c.lot.outcome).toContain('fiche non conforme et la spec a déjà joué 3 sessions : ');
  });
  it('R6 — lot back sans écran, maquetteReviews 3 : la revue de la fiche rend le lot dès 2 sessions', async () => {
    const back: Handler = (call) => claudeOut(specReport({ fiche: ecritBack(call.opts.cwd) }));
    const h = harness({ lots: [{ title: 'Un comportement', spec: true }], script: { spec: [back], fiche: [majorFiche('R5 : sans source')] } });
    const c = h.lot('L1', { specLot: true, specRuns: 1 }, { fiche: true, ...cfg(3) });
    await runLot(c);
    expect(c.lot.outcome).toContain('fiche non conforme et la spec a déjà joué 2 sessions : ');
  });
});

describe('R7/R8 — défaut de revue au journal', () => {
  const run = async (second: Handler, first: Handler = major('contraste')) => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [first, second, ok], implement: [impl], review: [ok] } });
    const logs: string[] = [];
    h.wave.log = (line) => logs.push(line);
    const c = h.lot('L1', screen, cfg(3));
    await runLot(c);
    return { h, c, defauts: logs.filter((l) => l.includes('défaut de revue')) };
  };
  it('R7 — revue 2 : majeur marqué inchange : c.wave.log reçoit exactement une ligne « <projet>:<lot> · défaut de revue : maquette, revue 2, … » (et l.warnings est inchangé)', async () => {
    const { c, defauts } = await run(major('panneaux étirés', { inchange: true }));
    expect(defauts).toEqual(['demo:L1 · défaut de revue : maquette, revue 2, majeur sur un point inchangé absent de la revue 1 : panneaux étirés']);
    expect(c.lot.warnings.join('\n')).not.toContain('défaut de revue');
  });
  it('R7 — revue 1 avec inchange: true : c.wave.log ne reçoit aucune ligne « défaut de revue »', async () => {
    const { defauts } = await run(ok, major('contraste', { inchange: true }));
    expect(defauts).toEqual([]);
  });
  it('R7 — revue 2 : mineur marqué inchange, ou majeur non marqué (inchange absent, false, texte ou null) : aucune ligne', async () => {
    for (const second of [minor({ inchange: true }), major('x'), major('x', { inchange: false }), major('x', { inchange: 'true' }), major('x', { inchange: null }), major('x', { inchange: 1 })]) expect((await run(second)).defauts).toEqual([]);
  });
  it("R7 — l'état du lot après la ligne est identique à celui sans marque", async () => {
    const marked = await run(major('panneaux étirés', { inchange: true }));
    const plain = await run(major('panneaux étirés'));
    expect(kinds(marked.h)).toEqual(kinds(plain.h));
    expect(marked.c.lot.status).toBe(plain.c.lot.status);
    expect(marked.c.lot.maquette).toEqual(plain.c.lot.maquette);
    expect(marked.c.lot.warnings).toEqual(plain.c.lot.warnings);
  });
  it('R8 — inchange absent ou non booléen (texte, null) : lu comme faux, aucune ligne de journal, rapport accepté', async () => {
    for (const inchange of [undefined, 'oui', null]) {
      const { c, defauts } = await run(major('x', inchange === undefined ? {} : { inchange }));
      expect(defauts).toEqual([]);
      expect(c.lot.status).toBe('ready');
    }
  });
  it('R8 — rapport de revue sans inchange : accepté, constats identiques', () => {
    const rep = reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte: 'a' }] });
    expect(checkShape<ReviewReport>(rep, REVIEW_SCHEMA).constats).toEqual([{ gravite: 'majeur', texte: 'a' }]);
  });
  it('R8 — rapport avec inchange: true : accepté', () => {
    const rep = reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', texte: 'a', inchange: true }] });
    expect(checkShape<ReviewReport>(rep, REVIEW_SCHEMA).constats[0].inchange).toBe(true);
    expect((REVIEW_SCHEMA.properties.constats.items.properties as Record<string, { type: string }>).inchange.type).toBe('boolean');
  });
});

describe('R9 — brief des revues de rang 2 ou plus', () => {
  const briefs = async () => {
    const h = harness({ lots, script: { spec: [spec, spec, spec], maquette: [major(), major(), ok], implement: [impl], review: [ok] } });
    await runLot(h.lot('L1', screen, cfg(3)));
    return { mq: h.calls.filter((x) => x.kind === 'maquette').map((x) => x.brief), specs: h.calls.filter((x) => x.kind === 'spec').map((x) => x.brief) };
  };
  it('R9 — brief de la revue 2 avec maquetteReviews 3 : « revue 2 sur 3 », pas « second and last »', async () => {
    const { mq } = await briefs();
    expect(mq[1]).toContain('This is review 2 of 3');
    expect(mq[1]).not.toContain('second and last');
    expect(mq[1]).not.toContain('last review');
  });
  it('R9 — brief de la revue 3 : « dernière revue »', async () => {
    const { mq } = await briefs();
    expect(mq[2]).toContain('This is review 3 of 3, the last review');
  });
  it('R9 — brief de la revue 2 : la consigne de marquage inchange est présente', async () => {
    const { mq, specs } = await briefs();
    expect(mq[1]).toContain('`inchange: true`');
    expect(mq[0]).not.toContain('`inchange: true`');
    expect(specs[1]).not.toContain('one more pass only');
    expect(specs[1]).toContain('spec session 2 of 3');
  });
});
