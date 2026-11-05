import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import type { LotCtx } from '../src/orchestrate/cycle/ctx.js';
import { probeIo } from '../src/orchestrate/cycle/work.js';
import { integratedChecks, programChecks } from '../src/orchestrate/cycle/checks.js';
import { readOrchestrateConfig } from '../src/config.js';
import { relatedCommand } from '../src/orchestrate/gate-parts.js';
import { renderTable } from '../src/orchestrate/table.js';
import { recordedGate } from '../src/gate-record.js';
import { newLot, RunStore, type LotState, type WaveState } from '../src/orchestrate/state.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store, writes } from './orchestrate-worktree-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L590 (fiche docs/specs/portes-intermediaires-ciblees) : la porte d'une écriture joue les tests liés au diff, la suite complète une fois à l'intégration.

afterEach(cleanupTempDirs);

// Le registre des vagues (CADENCE_HOME) que l'orchestrateur écrit : un dossier à part par test, comme test/orchestrate-worktree-integration.test.ts.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const impl = (file = 'a.txt', msg = 'feat(L1): a'): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, msg)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
const raw = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []);
/** Les lignes écrites par les portes ; « FULL » vient de la suite jouée dans le lot, « BASE » de la ligne de base (la suite rejouée au sha de départ, L213, dans un worktree jetable). */
const lines = (f: string) => raw(f).map((x) => (x.startsWith('FULL') ? (x.includes('cadence-baseline') ? 'BASE' : 'FULL') : x));
const wave = { id: 'w1', created: '2026-11-01T10:00:00Z', cwd: '/x', budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: [] } as unknown as WaveState;
const bare = (over: Partial<LotState> = {}) => ({ project: 'p', lot: 'L1', repo: '/x', status: 'ready', pass: 0, steps: [], constats: [], proposals: [], warnings: [], questions: [], ...over }) as unknown as LotState;

/** Porte complète et porte liée qui s'écrivent dans `log` : « FULL » pour la suite, « REL <fichiers> » pour les tests liés. */
const gates = (log: string, over: { full?: string; related?: string } = {}) => ({
  test: `echo "FULL $PWD" >> ${log}; ${over.full ?? 'true'}`,
  testRelated: `echo "REL {files}" >> ${log}; ${over.related ?? 'true'}`,
});
/** Un lot à worktree actif (une intégration suivra) : seul celui-là joue des portes ciblées ; le worktree est le dépôt du harnais, la fin du cycle n'est pas celle d'une vraie intégration. */
const tl = (h: ReturnType<typeof harness>, config: Parameters<ReturnType<typeof harness>['lot']>[2]) => Object.assign(h.lot('L1', {}, config), { tree: { dir: h.repo, branch: 'cadence/x', base: 'main', active: true } });
/** Une écriture du lot (un commit citant L1) puis la porte du programme, sans le cycle : le constat rouge et les CheckRun sont rendus. */
async function gateAfter(h: ReturnType<typeof harness>, c: LotCtx, file = 'a.txt', msg = 'feat(L1): a') {
  commitFile(h.repo, file, msg);
  const red: Awaited<ReturnType<typeof integratedChecks>>['red'] = [];
  const runs: Awaited<ReturnType<typeof integratedChecks>>['runs'] = [];
  await programChecks(c, red, runs);
  return { red, runs };
}
const logFile = () => join(tempDir(), 'portes.log');

describe('L590 R1 — après une écriture, seuls les tests liés au diff sont joués', () => {
  it('R1 — implement puis fix : chaque porte joue la commande liée sur les fichiers du diff et jamais orchestrate.test', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, gates(log, { related: '[ -f b.txt ] || { echo "FAIL  test/a.test.ts > lié"; exit 1; }' }));
    expect((await gateAfter(h, c)).red).toHaveLength(1);
    expect((await gateAfter(h, c, 'b.txt', 'fix(L1): b')).red).toEqual([]);
    expect(lines(log).filter((x) => x !== 'BASE')).toEqual(['REL a.txt', 'REL a.txt b.txt']);
    expect(c.lot.suiteRuns ?? 0).toBe(0);
  });
});

describe('L590 R2 — orchestrate.testRelated', () => {
  const read = (yaml: string) => {
    const f = join(tempDir(), 'cadence.yaml');
    writeFileSync(f, yaml);
    return readOrchestrateConfig(f);
  };
  it('R2 — testRelated avec {files} : la commande jouée porte les fichiers du diff', async () => {
    expect(read('orchestrate:\n  test: "npm test"\n  testRelated: "npm test -- {files}"\n').testRelated).toBe('npm test -- {files}');
    const log = logFile();
    const h = harness();
    await gateAfter(h, tl(h, gates(log)), 'un fichier.txt');
    expect(lines(log)).toEqual(["REL 'un fichier.txt'"]);
  });
  it('R2 — testRelated sans {files} : cadence.yaml refusé avec le motif exact', () => {
    expect(() => read('orchestrate:\n  test: "npm test"\n  testRelated: "npm test"\n')).toThrow(/orchestrate\.testRelated : la commande doit contenir \{files\} \(remplacé par les fichiers modifiés du lot\)/);
  });
  it('R2 — testRelated avec orchestrate.test en parties : refusé ; avec une composée : accepté', () => {
    expect(() => read('orchestrate:\n  test:\n    - { dir: a, run: npm test }\n  testRelated: "npm test -- {files}"\n')).toThrow(/testRelated : refusé quand orchestrate\.test est une liste de parties/);
    expect(read('orchestrate:\n  test: "npm run build && npm test"\n  testRelated: "npm test -- {files}"\n').testRelated).toBe('npm test -- {files}');
  });
});

describe('L590 R3 / R4 / R12 — repli sur la suite complète', () => {
  it('R3 — diff sans test lié : la suite complète est jouée et l\'entrée porte le motif « aucun test lié »', async () => {
    const log = logFile();
    const h = harness();
    const said: string[] = [];
    h.wave.log = (line: string) => said.push(line);
    const c = tl(h, gates(log, { related: 'echo " No test files found, exiting with code 0"' }));
    const { runs } = await gateAfter(h, c);
    expect(lines(log)).toEqual(['REL a.txt', 'FULL']);
    expect(c.lot.suiteRuns).toBe(1);
    expect(c.lot.portes).toHaveLength(1);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'complete', code: 0, motif: 'aucun test lié' });
    expect(runs.find((r) => r.label === 'tests')).toMatchObject({ command: c.config.test });
    expect(said.some((x) => x.includes('porte ciblée sans test lié : suite complète jouée'))).toBe(true); // contrat A1
  });
  it('R12 — sortie « No test files found, exiting with code 0 » : repli sur la suite complète', async () => {
    const log = logFile();
    const h = harness();
    await gateAfter(h, tl(h, gates(log, { related: 'echo "No test files found, exiting with code 0"' })));
    expect(lines(log)).toEqual(['REL a.txt', 'FULL']);
  });
  it('R12 — vraie sortie rouge : pas de repli', async () => {
    const log = logFile();
    const h = harness();
    const { red } = await gateAfter(h, tl(h, gates(log, { related: 'echo "FAIL  test/a.test.ts > lié"; exit 1' })));
    expect(red).toHaveLength(1);
    expect(lines(log)).not.toContain('FULL');
  });
  it('R12 — mots « no test files found » cités dans le titre d\'un test : pas de repli', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, gates(log, { related: 'echo " ✓ test/a.test.ts > no test files found, exiting with code 0 est reconnu"' }));
    await gateAfter(h, c);
    expect(lines(log)).toEqual(['REL a.txt']);
    expect(c.lot.portes![0]!.portee).toBe('ciblee');
  });
  it('R12 — « aucun test » avec un code de sortie non nul : pas de repli, la porte est rouge', async () => {
    const log = logFile();
    const h = harness();
    const { red } = await gateAfter(h, tl(h, gates(log, { related: 'echo "No test files found, exiting with code 1"; exit 1' })));
    expect(red).toHaveLength(1);
    expect(lines(log)).not.toContain('FULL');
  });
  it('R4 — test non vitest sans testRelated : suite complète jouée', async () => {
    const log = logFile();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = tl(h, { test: `echo "FULL $PWD" >> ${log}` });
    await runLot(c);
    expect(lines(log)).toEqual(['FULL']);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'complete' });
  });
  it('R4 — startedSha absent : suite complète jouée', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, gates(log));
    commitFile(h.repo, 'a.txt', 'chore: sans lot');
    await programChecks(c, [], []);
    expect(lines(log)).toEqual(['FULL']);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'complete', fichiers: [] });
  });
  it('R4 — build && vitest run sans testRelated : suite complète jouée, jamais ciblée', () => {
    expect(relatedCommand('build && vitest run', undefined)).toBeNull();
  });
});

describe('L590 R13 — la commande liée dérive de vitest run', () => {
  it('R13 — npx vitest run : la commande jouée est npx vitest related --run avec les fichiers', () => {
    expect(relatedCommand('npx vitest run', undefined)).toBe('npx vitest related --run {files}');
    expect(relatedCommand('vitest run', undefined)).toBe('vitest related --run {files}');
  });
  it('R13 — vitest run --reporter=dot : options conservées', () => {
    expect(relatedCommand('npx vitest run --reporter=dot --maxWorkers=$CADENCE_TEST_WORKERS', undefined)).toBe('npx vitest related --run --reporter=dot --maxWorkers=$CADENCE_TEST_WORKERS {files}');
  });
  it('R13 — build && vitest run : aucune dérivation, suite complète', () => {
    for (const t of ['npm run build && npx vitest run', '(cd a && vitest run)', 'vitest run || true', 'vitest run; x', 'vitest run | tee x']) expect(relatedCommand(t, undefined), t).toBeNull();
  });
  it('R13 — vitest run test/unit : un filtre positionnel n\'est pas une option, aucune dérivation, suite complète', () => {
    // Dérivé, `test/unit` deviendrait un fichier « lié » de plus et la porte jouerait des tests que `vitest run test/unit` écarte (revue du 05-11).
    for (const t of ['npx vitest run test/unit', 'vitest run a.test.ts', 'vitest run --reporter=dot test/unit', 'vitest run --reporter dot']) expect(relatedCommand(t, undefined), t).toBeNull();
  });
  it('R13 — npm test : aucune dérivation, suite complète', () => {
    for (const t of ['npm test', 'pnpm -r test', 'vitest', 'vitest watch', 'npx vitest runner']) expect(relatedCommand(t, undefined), t).toBeNull();
  });
  it('R13 — testRelated déclaré l\'emporte sur la dérivation ; une porte en parties ne dérive rien', () => {
    expect(relatedCommand('npx vitest run', 'x {files}')).toBe('x {files}');
    expect(relatedCommand([{ dir: 'a', run: 'vitest run' }], undefined)).toBeNull();
    expect(relatedCommand('npm run build && npm test', 'npm test -- {files}')).toBe('npm test -- {files}');
  });
  describe('un vitest sur le PATH', () => {
    const saved = process.env.PATH;
    beforeEach(() => {
      const bin = tempDir();
      const log = join(tempDir(), 'vitest.log');
      process.env.VITEST_LOG = log;
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'vitest'), '#!/bin/sh\necho "$@" >> "$VITEST_LOG"\n');
      chmodSync(join(bin, 'vitest'), 0o755);
      process.env.PATH = `${bin}:${saved}`;
    });
    afterEach(() => {
      process.env.PATH = saved;
    });
    it('R13 — vitest run --reporter=dot : la porte d\'une écriture joue vitest related --run avec options et fichiers', async () => {
      const h = harness();
      const c = tl(h, { test: 'vitest run --reporter=dot' });
      await gateAfter(h, c);
      expect(lines(process.env.VITEST_LOG!)).toEqual(['related --run --reporter=dot a.txt']);
      expect(c.lot.portes![0]).toMatchObject({ portee: 'ciblee', fichiers: ['a.txt'] });
    });
  });
});

describe('L590 R6 — un rouge ciblé suit le chemin d\'un rouge complet', () => {
  it('R6 — test lié rouge : le lot repart en correction avec le nom du test', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, gates(log, { related: '[ -f b.txt ] || { echo " FAIL  test/a.test.ts > le lié"; exit 1; }' }));
    const { red } = await gateAfter(h, c);
    expect(red).toHaveLength(1);
    expect(red[0]!.texte).toContain('test/a.test.ts > le lié');
    expect((await gateAfter(h, c, 'b.txt', 'fix(L1): b')).red).toEqual([]);
    expect(c.lot.portes!.map((p) => p.code)).toEqual([1, 0]);
  });
  it('R6 — test lié rouge rejoué seul et vert : instable, pas de correction, la porte enregistrée est absoute', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, { ...gates(log, { related: 'echo " FAIL  test/a.test.ts > le lié"; exit 1' }), testReplay: 'echo " ✓ {files} > le lié"' });
    const { red, runs } = await gateAfter(h, c);
    expect(red).toEqual([]);
    expect(runs.find((r) => r.label === 'tests')).toMatchObject({ code: 0, portee: 'ciblee', instables: ['test/a.test.ts > le lié'] });
    expect(c.lot.portes![0]).toMatchObject({ portee: 'ciblee', code: 0 });
  });
  it('R6 — test lié rouge déjà rouge au sha de départ : pas de correction', async () => {
    const log = logFile();
    const h = harness();
    const red = 'echo " FAIL  test/a.test.ts > déjà rouge"; exit 1';
    const c = tl(h, { test: `echo "FULL $PWD" >> ${log}; ${red}`, testRelated: `echo "REL {files}" >> ${log}; ${red}` });
    const { red: constats, runs } = await gateAfter(h, c);
    expect(constats).toEqual([]);
    expect(runs.find((r) => r.label === 'tests')).toMatchObject({ dejaRouges: 1, portee: 'ciblee' });
  });
});

describe('L590 R8 / R9 — portes et suiteRuns', () => {
  it('R8 — porte ciblée : portes reçoit portee, fichiers, code et duree, suiteRuns inchangé', async () => {
    const h = harness();
    const c = tl(h, gates(logFile()));
    await gateAfter(h, c);
    expect(c.lot.suiteRuns ?? 0).toBe(0);
    expect(c.lot.portes).toHaveLength(1);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'ciblee', fichiers: ['a.txt'], code: 0 });
    expect(c.lot.portes![0]!.duree).toBeGreaterThanOrEqual(0);
    expect(c.lot.portes![0]!.motif).toBeUndefined();
  });
  it('R8 — état ancien sans portes : lu comme liste vide, sans plantage', () => {
    const l = bare({ suiteRuns: 2 });
    expect(l.portes).toBeUndefined();
    expect(() => renderTable(wave, [l], { lotCommits: () => [] })).not.toThrow();
  });
  it('R8 — suite complète : suiteRuns +1 et une entrée complete', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: 'true' });
    await runLot(c);
    expect(c.lot.suiteRuns).toBe(1);
    expect(c.lot.portes).toHaveLength(1);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'complete', fichiers: [], code: 0 });
  });
  it('R9 — sans orchestrate.test : suiteRuns absent et colonne « — »', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { build: 'true' });
    await runLot(c);
    expect(c.lot.suiteRuns).toBeUndefined();
    expect(c.lot.portes ?? []).toEqual([]);
    expect(renderTable(wave, [c.lot])[1]).toMatch(/ +—$/);
  });
});

describe('L590 R10 — le tableau et le détail', () => {
  const portes = [
    { portee: 'ciblee' as const, fichiers: ['a.ts', 'b.ts'], code: 0, duree: 3.4 },
    { portee: 'ciblee' as const, fichiers: ['a.ts'], code: 1, duree: 2 },
    { portee: 'complete' as const, fichiers: [], code: 0, duree: 301.2, motif: 'aucun test lié' },
  ];
  it('R10 — un lot à une suite complète et deux portes ciblées : la colonne suites lit 1 et le détail liste trois portes avec durée', () => {
    const l = bare({ suiteRuns: 1, portes });
    const out = renderTable(wave, [l], { lotCommits: () => [] });
    expect(out[1]).toMatch(/ +1$/);
    const detail = out.filter((x) => x.includes('— porte '));
    expect(detail).toHaveLength(3);
    expect(detail[0]).toContain('ciblée');
    expect(detail[0]).toContain('2 fichier(s)');
    expect(detail[0]).toContain('3,4 s');
    expect(detail[1]).toContain('code 1');
    expect(detail[2]).toContain('complète');
    expect(detail[2]).toContain('301,2 s');
    expect(detail[2]).toContain('aucun test lié');
  });
  it('R10 — sans portes : colonne et détail comme L518', () => {
    const out = renderTable(wave, [bare({ suiteRuns: 2 })], { lotCommits: () => [] });
    expect(out[1]).toMatch(/ +2$/);
    expect(out.some((x) => x.includes('— porte '))).toBe(false);
  });
  it('R10 — l\'en-tête et la largeur de la table sont ceux d\'avant', () => {
    const avec = renderTable(wave, [bare({ suiteRuns: 1, portes })], { lotCommits: () => [] });
    const sans = renderTable(wave, [bare({ suiteRuns: 1 })], { lotCommits: () => [] });
    expect(avec[0]).toMatch(/durée +suites$/);
    expect(avec[0]).toBe(sans[0]);
    expect(avec[1]).toBe(sans[1]);
  });
  it('R10 — compact : les lignes de porte ne sont pas imprimées, le renvoi vers --detail demeure', () => {
    const out = renderTable(wave, [bare({ suiteRuns: 1, portes })], { lotCommits: () => [], compact: true });
    expect(out.some((x) => x.includes('— porte '))).toBe(false);
    expect(out.some((x) => x.includes('--status --detail'))).toBe(true);
  });
});

describe('L590 R11 — verify --gate ne reprend jamais une porte ciblée', () => {
  it('R11 — CheckRun ciblé : command différente de orchestrate.test et portee \'ciblee\'', async () => {
    const h = harness();
    const c = tl(h, gates(logFile()));
    const { runs } = await gateAfter(h, c);
    const r = runs.find((x) => x.label === 'tests')!;
    expect(r.portee).toBe('ciblee');
    expect(r.command).not.toBe(c.config.test);
    expect(r.command).toContain('{files}');
  });
  it('R11 — porte ciblée verte : verify --gate rejoue la suite', () => {
    const repo = tempDir();
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    git(repo, 'add', '--', 'f.txt');
    git(repo, 'commit', '-q', '-m', 'init');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const launch = tempDir();
    const record = (runs: NonNullable<LotState['checks']>['runs']) => {
      const s = RunStore.reserve(launch, '2026-10-28-0830')!;
      s.writeWave({ created: '2026-10-28T08:30:00.000Z', lots: ['p:L9'] } as never);
      s.writeLot({ ...newLot({ project: 'p', repo, lot: 'L9', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status: 'ready', checks: { head: sha, tree: git(repo, 'rev-parse', `${sha}^{tree}`), runs } });
    };
    // une porte ciblée dont la commande serait par hasard celle de la porte : jamais reprise
    record([{ label: 'tests', command: 'npm test', code: 0, portee: 'ciblee' }]);
    expect(recordedGate([launch], repo, sha, [{ name: 'test', cmd: 'npm test' }])).toHaveProperty('reason');
    record([{ label: 'tests', command: 'npm test', code: 0 }]);
    expect(recordedGate([launch], repo, sha, [{ name: 'test', cmd: 'npm test' }])).toHaveProperty('found');
  });
});

describe('L590 R17 — un lot sans worktree n\'a pas d\'intégration', () => {
  it('R17 — lot sans worktree : aucune intégration ne joue la suite, la porte joue la suite complète à la place du ciblé', async () => {
    const log = logFile();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, gates(log, { full: '[ -f a.txt ] && { echo " FAIL  test/a.test.ts > rouge"; exit 1; }; true' }));
    const { red } = await gateAfter(h, c);
    expect(red).toHaveLength(1);
    expect(lines(log).filter((x) => x !== 'BASE')).toEqual(['FULL']);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'complete', fichiers: [] });
  });
});

describe('L590 R16 — une annonce de tests rouges par la session : la suite complète, exception à R1', () => {
  it("R16 — tests annoncés rouges (L213, L522) : la porte joue la suite complète, l'annonce non démentie n'est pas crue sans test rouge", async () => {
    const log = logFile();
    const h = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')], tests: { commande: 'npm test', resultat: '1 failed', vert: false } }))], review: [ok] } });
    const c = tl(h, gates(log));
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']); // porte complète verte : pas de correction
    expect(lines(log)).toEqual(['FULL']);
    expect(c.lot.portes![0]).toMatchObject({ portee: 'complete' });
    expect(c.lot.warnings.some((w) => w.includes("l'annonce n'est pas crue"))).toBe(true);
  });
  it("R16 — tests annoncés rouges, suite complète rouge sur ce test : le lot repart en correction", async () => {
    const h = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')], tests: { commande: 'npm test', resultat: '1 failed', vert: false } }))], fix: [impl('b.txt', 'fix(L1): b')], review: [ok] } });
    const c = tl(h, gates(logFile(), { full: '[ -f a.txt ] && [ ! -f b.txt ] && { echo " FAIL  test/a.test.ts > rouge"; exit 1; }; true' }));
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
  });
});

describe('L590 R5 — le lot express en repli sur la suite complète', () => {
  it("R5 — express, repli « aucun test lié » : la suite complète de la porte est reprise à l'intégration, une seule suite", async () => {
    const log = logFile();
    const { parent } = setup([{ title: 'un', estimate: 0.1 }, { title: 'deux', estimate: 0.1 }], 'worktrees: true\ntest: sh check.sh\ntestRelated: sh related.sh {files}\n', { 'check.sh': `echo FULL >> ${log}\n`, 'related.sh': 'echo "No test files found, exiting with code 0"\n' });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake());
    expect(r.code).toBe(0);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.express).toBe(true);
    expect(l1.suiteRuns).toBe(1);
    expect(l1.portes!.map((p) => p.portee)).toEqual(['complete']);
  });
});

describe('L590 R14 — la sonde joue une porte ciblée', () => {
  it('R14 — sonde : porte ciblée', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, gates(log));
    await gateAfter(h, c);
    await probeIo(c).gate([], []);
    expect(lines(log)).toHaveLength(2);
    expect(lines(log)[1]).toMatch(/^REL .*a\.txt$/);
    expect(c.lot.portes!.map((p) => p.portee)).toEqual(['ciblee', 'ciblee']);
  });
  it('R14 — integratedChecks : la suite complète est jouée même si les portes précédentes étaient ciblées', async () => {
    const log = logFile();
    const h = harness();
    const c = tl(h, gates(log));
    await gateAfter(h, c);
    const { red, runs } = await integratedChecks(c, 'p:L1');
    expect(red).toEqual([]);
    expect(lines(log)).toEqual(['REL a.txt', 'FULL']);
    expect(runs.find((r) => r.label === 'tests')).toMatchObject({ command: c.config.test });
    expect(runs.find((r) => r.label === 'tests')!.portee).toBeUndefined();
    expect(c.lot.suiteRuns).toBe(1);
  });
  it('R14 — integratedChecks rouge : relancé en complet, jamais en ciblé', async () => {
    const log = logFile();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = tl(h, gates(log, { full: 'echo " FAIL  test/a.test.ts > rouge"; exit 1' }));
    const { red } = await integratedChecks(c, 'p:L1');
    expect(red.length).toBeGreaterThan(0);
    expect(lines(log)).toEqual(['FULL', 'FULL']);
  });
});

describe('L590 R15 — le brief de revue dit qu\'une porte est ciblée', () => {
  it('R15 — brief d\'un lot à porte ciblée : le texte dit « targeted »', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(tl(h, gates(logFile())));
    const brief = h.calls.find((x) => x.kind === 'review')!.brief;
    expect(brief).toMatch(/gate is targeted/);
    expect(brief).toMatch(/full suite will be played by the program at integration/);
    expect(brief).toContain('do not rerun the whole suite');
  });
  it('R15 — brief d\'une suite complète : texte inchangé', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(tl(h, { test: 'true' }));
    const brief = h.calls.find((x) => x.kind === 'review')!.brief;
    expect(brief).not.toMatch(/gate is targeted/);
    expect(brief).toContain('(tests): green');
  });
});

describe('L590 R5 / R7 — la suite complète à l\'intégration, une fois par sommet', () => {
  const yaml = 'worktrees: true\ntest: sh check.sh\ntestRelated: sh related.sh {files}\n';
  const files = (log: string, over: Record<string, string> = {}) => ({ 'check.sh': `echo FULL >> ${log}\n`, 'related.sh': `echo "REL $*" >> ${log}\n`, ...over });
  const portees = (parent: string, id: string) => store(parent).readLot('a', id)!.portes!.map((p) => p.portee);
  // Deux lots, une session à la fois : L1 s'intègre sans rebase (tip = commit relu), L2 est rebasé sur lui.

  it('R5 — sommet non rebasé après portes ciblées : une suite complète est jouée à l\'intégration', async () => {
    const log = logFile();
    const { parent } = setup(undefined, yaml, files(log));
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake());
    expect(r.code).toBe(0);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.code!.head).toBe(l1.checks!.head); // pas de rebase : le sommet est le commit relu
    expect(portees(parent, 'L1')).toEqual(['ciblee', 'complete']);
    expect(l1.suiteRuns).toBe(1);
  });
  it('R5 — suite complète verte déjà enregistrée pour l\'arbre : pas de seconde suite', async () => {
    const log = logFile();
    const { parent } = setup(undefined, yaml, files(log, { 'related.sh': 'echo "No test files found, exiting with code 0"\n' }));
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake());
    expect(r.code).toBe(0);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.portes!.map((p) => [p.portee, p.motif])).toEqual([['complete', 'aucun test lié']]);
    expect(l1.suiteRuns).toBe(1);
  });
  it('R5 — rebase rejoué : le nouveau sommet rejoue la suite complète', async () => {
    const log = logFile();
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], yaml, { ...files(log), 'f.txt': Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n') + '\n' });
    let moved = false;
    const f = fake({
      implement: async (cwd, brief) => {
        await meeting(2)();
        const lot = lotOf(brief);
        const n = lot === 'L1' ? 4 : 7; // deux lots sur le même fichier, lignes distinctes : le second intégré est rebasé (L364)
        writeFileSync(join(cwd, 'f.txt'), Array.from({ length: 12 }, (_, i) => (i === n ? `l${i} par ${lot}` : `l${i}`)).join('\n') + '\n');
        git(cwd, 'add', '--', 'f.txt');
        git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
        return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
      },
      'review-small': async () => {
        // le lead avance main pendant la revue du second lot : le rebase et les contrôles sont rejoués au nouveau sommet (L364)
        if (!moved) {
          moved = true;
          writeFileSync(join(repo, 'lead.txt'), 'x\n');
          git(repo, 'add', '--', 'lead.txt');
          git(repo, 'commit', '-q', '-m', 'plan: commit du lead');
        }
        return claudeOut(reviewReport());
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    const replayed = ['L1', 'L2'].map((id) => store(parent).readLot('a', id)!).find((l) => l.suiteRuns === 2)!;
    expect(replayed.portes!.map((p) => p.portee)).toEqual(['ciblee', 'complete', 'complete']); // une suite par sommet : celui d'avant le rebase, puis le rebasé
    expect(raw(log).filter((x) => x === 'FULL')).toHaveLength(3); // 2 lots, dont un rejoué
  });
  it('R5 — seule une porte ciblée verte enregistrée : suite complète jouée', async () => {
    const log = logFile();
    const { parent } = setup(undefined, yaml, files(log));
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake());
    const played = raw(log);
    expect(played.slice(0, 2)).toEqual([expect.stringMatching(/^REL /), 'FULL']);
    expect(played.filter((x) => x === 'FULL')).toHaveLength(2); // une par lot
  });
  it('R7 — suite complète rouge deux fois : intégration refusée avec les tests rouges', async () => {
    const log = logFile();
    const { parent, repo } = setup(undefined, yaml, files(log, { 'check.sh': `echo FULL >> ${log}\n[ -f L1-implement.txt ] && { echo " FAIL  test/x.test.ts > rouge"; exit 1; }\nexit 0\n` }));
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake());
    expect(r.code).toBe(1);
    const l = store(parent).readLot('a', 'L1')!;
    expect(l.status).toBe('handed-back');
    expect(l.outcome).toMatch(/intégration refusée : tests rouges au sommet intégré \(sh check\.sh en échec \(code 1\)/);
    expect(raw(log).filter((x) => x === 'FULL').length).toBeGreaterThanOrEqual(3); // L1 : suite puis relance (rouge deux fois, R7), sans compter la ligne de base ; L2 : sa suite d'intégration, verte
    expect(r.out).toMatch(/a:L1 tests rouges au sommet intégré, relancés une fois/)
    expect(git(repo, 'log', '--format=%s', 'main')).not.toMatch(/feat\(L1\)/);
  });
});
