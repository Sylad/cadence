import { describe, expect, it } from 'vitest';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { EXPRESS_MAX_ESTIMATE, isExpress } from '../src/orchestrate/express.js';
import { claudeOut, commitFile, git, harness, precheckReport, reviewReport, workReport, type Handler } from './orchestrate-harness.js';

const GATE = { code: ['*.ts'], tests: ['*.spec.ts'], except: [] as string[], threshold: 1 };
const impl = (file = 'a.ts'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

describe('L519 R1 — la voie express est celle des lots de 0,1 j au plus, sans spec ni écran', () => {
  it('R1 — 0,1 j et moins : express ; au-delà : ordinaire', () => {
    expect(EXPRESS_MAX_ESTIMATE).toBe(0.1);
    expect(isExpress({ estimate: 0.1 })).toBe(true);
    expect(isExpress({ estimate: 0.05 })).toBe(true);
    expect(isExpress({ estimate: 0.11 })).toBe(false);
    expect(isExpress({ estimate: 1 })).toBe(false);
  });

  it('R1 — un lot à écran ou à spec n\'est jamais express, quelle que soit son estimation', () => {
    expect(isExpress({ estimate: 0.1, screen: 'page' })).toBe(false);
    expect(isExpress({ estimate: 0.1, specLot: true })).toBe(false);
  });

  it('R1 — une estimation absente, nulle ou illisible n\'est pas express', () => {
    expect(isExpress({ estimate: undefined })).toBe(false);
    expect(isExpress({ estimate: 0 })).toBe(false);
    expect(isExpress({ estimate: Number.NaN })).toBe(false);
    expect(isExpress({ estimate: -0.05 })).toBe(false);
  });
});

describe('L519 R2 — une session, sans précheck, sans sonde, sans revue séparée', () => {
  it('R2 — un lot express saute le précheck que son titre appellerait', async () => {
    const h = harness({ lots: [{ title: 'un' }, { title: 'suite de revue L1', estimate: 0.1 }], script: { precheck: [() => claudeOut(precheckReport())], implement: [impl()], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'fix(L1): une correction');
    const c = h.lot('L2', { express: true }, { precheck: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement']);
  });

  it('R2 — le même lot, non express, garde son précheck et sa revue', async () => {
    const h = harness({ lots: [{ title: 'un' }, { title: 'suite de revue L1' }], script: { precheck: [() => claudeOut(precheckReport())], implement: [impl()], review: [ok] } });
    commitFile(h.repo, 'a.txt', 'fix(L1): une correction');
    const c = h.lot('L2', {}, { precheck: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['precheck', 'implement', 'review']);
  });

  it('R2 — un lot express n\'a ni sonde ni revue : implement seul, puis prêt à livrer', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl()] } });
    const c = h.lot('L1', { express: true }, { probe: true });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement']);
    expect(c.lot.status).toBe('ready');
    expect(JSON.stringify(c.lot)).not.toContain('"probe"');
  });

  it('R2 — le verdict écrit au plan dit que la revue est celle du lead, au sha du HEAD', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl()] } });
    const c = h.lot('L1', { express: true });
    await runLot(c);
    const review = h.plan().lot('L1').review;
    expect(review?.verdict).toMatch(/voie express.*le lead/);
    expect(review?.commit).toBe(git(h.repo, 'log', '-1', '--format=%H', '--grep=feat(L1)'));
  });

  it('R2 — un lot ordinaire garde sa sonde et sa revue', async () => {
    const h = harness({ lots: [{ title: 'un' }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { probe: false });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
  });
});

describe('L519 R3 — la porte du programme reste jouée une fois, sans « code sans test »', () => {
  it('R3 — un lot express dont le code n\'a pas de test (changement visuel) ne part pas en correction', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl('a.ts')] } });
    const c = h.lot('L1', { express: true }, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement']);
    expect(c.lot.status).toBe('ready');
  });

  it('R3 — un lot ordinaire, lui, y part (la porte existante est intacte)', async () => {
    const h = harness({ lots: [{ title: 'un' }], script: { implement: [impl('a.ts')], fix: [impl('a.spec.ts')], review: [ok] } });
    const c = h.lot('L1', {}, { testGate: GATE });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
  });

  it('R3 — des tests rouges à la porte d\'un lot express vont en correction : la porte n\'est pas levée', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl('a.ts')], fix: [impl('b.ts')] } });
    const c = h.lot('L1', { express: true }, { test: 'if [ -f a.ts ] && [ ! -f b.ts ]; then echo "FAIL  a.test.ts > suite > rouge"; exit 1; fi' });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix']);
    expect(c.lot.status).toBe('ready');
  });
});

describe('L519 R4 — le brief d\'un lot express', () => {
  const vars = { chemin: '/w', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };

  it('R4 — le brief de l\'implémentation express nomme la voie, le test visuel et le lead qui lit', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1 }], script: { implement: [impl()] } });
    const c = h.lot('L1', { express: true });
    await runLot(c);
    const brief = h.calls[0]!.brief;
    expect(brief).toMatch(/Express lane/);
    expect(brief).toMatch(/purely visual/);
    expect(brief).toMatch(/the lead reads the diff/);
  });

  it('R4 — le brief d\'un lot ordinaire n\'en parle pas', async () => {
    const h = harness({ lots: [{ title: 'un' }], script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1'));
    expect(h.calls[0]!.brief).not.toMatch(/Express lane/);
  });

  it('R4 — un lot express visible n\'écrit pas d\'entrée Nouveautés : la consigne est remplacée par celle de la capture seule', async () => {
    const h = harness({ lots: [{ title: 'un', estimate: 0.1, visible: true }], script: { implement: [impl()] } });
    const c = h.lot('L1', { express: true, visible: true });
    await runLot(c);
    const brief = h.calls[0]!.brief;
    expect(brief).not.toMatch(/write its News entry|Add a screenshot of the result: copy it/);
    expect(brief).toMatch(/No News entry/);
  });

  it('R4 — un lot visible ordinaire garde sa consigne Nouveautés', async () => {
    const h = harness({ lots: [{ title: 'un', visible: true }], script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', { visible: true });
    await runLot(c);
    expect(h.calls[0]!.brief).toMatch(/cadence news new L1/);
  });

  it('R4 — le gabarit se rend sans {{express}} fourni (autres appelants)', () => {
    expect(() => renderBrief('implement', vars)).not.toThrow();
  });
});
