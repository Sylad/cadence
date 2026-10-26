import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { testWorkers, testWorkersFrom, testWorkersText, TEST_WORKERS_ENV } from '../src/orchestrate/workers.js';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { fake, run, setup, store } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

const impl = (): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }));
const fix = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `fix(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);

describe('L350 R1 — la part de la machine de chaque session', () => {
  it('R1 — CADENCE_TEST_WORKERS = max(1, cœurs ÷ plafond de sessions) : 32 cœurs et plafond 4 donnent 8', () => {
    expect(testWorkers(32, 4)).toBe(8);
    expect(testWorkers(32, 2)).toBe(16);
    expect(testWorkers(10, 4)).toBe(2); // arrondi vers le bas
  });
  it('R1 — jamais moins de 1, même avec plus de sessions que de cœurs ou un plafond absurde', () => {
    expect(testWorkers(2, 4)).toBe(1);
    expect(testWorkers(0, 4)).toBe(1);
    expect(testWorkers(8, 0)).toBe(8);
    expect(testWorkers(Number.NaN, 4)).toBe(1);
  });
  it('R1 — une valeur CADENCE_TEST_WORKERS déjà posée par l\'humain l\'emporte quand c\'est un entier positif ; sinon le calcul', () => {
    expect(testWorkersFrom({ [TEST_WORKERS_ENV]: '3' }, 32, 4)).toBe(3);
    expect(testWorkersFrom({ [TEST_WORKERS_ENV]: '0' }, 32, 4)).toBe(8);
    expect(testWorkersFrom({ [TEST_WORKERS_ENV]: 'beaucoup' }, 32, 4)).toBe(8);
    expect(testWorkersFrom({}, 32, 4)).toBe(8);
  });
});

describe('L350 R2 — la part est passée aux sessions et à la porte', () => {
  it('R2 — chaque session reçoit CADENCE_TEST_WORKERS dans son environnement', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    h.wave.testWorkers = 6;
    await runLot(h.lot('L1', {}, { test: 'true' }));
    expect(h.calls.map((c) => c.opts.env?.[TEST_WORKERS_ENV])).toEqual(['6', '6']);
  });
  it('R2 — la commande de la porte (orchestrate.test) la voit', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    h.wave.testWorkers = 6;
    const out = join(tempDir(), 'workers.txt');
    await runLot(h.lot('L1', {}, { test: `echo "$${TEST_WORKERS_ENV}" > ${out}` }));
    expect(readFileSync(out, 'utf8').trim()).toBe('6');
  });
  it('R2 — la ligne de base, rejouée dans son worktree jetable, la voit aussi', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    h.wave.testWorkers = 6;
    const out = join(tempDir(), 'base.txt');
    const test = `case "$PWD" in *cadence-baseline*) echo "$${TEST_WORKERS_ENV}" > ${out}; echo ' FAIL  ancien > cas'; exit 1;; esac; echo ' FAIL  ancien > cas'; exit 1`;
    await runLot(h.lot('L1', {}, { test }));
    expect(readFileSync(out, 'utf8').trim()).toBe('6');
  });
  it('R2 — sans part connue (vague construite à la main), rien n\'est posé', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, { test: 'true' }));
    expect(h.calls.every((c) => c.opts.env?.[TEST_WORKERS_ENV] === undefined)).toBe(true);
  });
  it('R2 — la vague la calcule des cœurs de la machine et du plafond de sessions (--max-sessions)', async () => {
    const { parent } = setup([{ title: 'un' }], 'worktrees: true\ntest: "true"');
    const f = fake();
    const seen: (string | undefined)[] = [];
    const claude: typeof f.claude = async (args, o) => {
      seen.push(o.env?.[TEST_WORKERS_ENV]);
      return f.claude(args, o);
    };
    const r = await run(parent, ['a:L1', '--max-sessions', '4'], { ...f, claude }, { cores: () => 32 });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['8']));
    expect(store(parent).readWave()?.testWorkers).toBe(8);
  });
});

describe('L350 R3 — les gabarits disent aux lanceurs de tests de la respecter', () => {
  const vars = { chemin: '/r', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '' };
  it('R3 — implement, fix, passe des mineurs et passe du bibliothécaire portent la consigne, avec vitest, jest et pytest', () => {
    for (const kind of ['implement', 'fix', 'fix-minors', 'fix-docs'] as const) {
      const brief = renderBrief(kind, { ...vars, workers: testWorkersText(8) });
      expect(brief, kind).toContain(`${TEST_WORKERS_ENV}=8`);
      expect(brief, kind).toMatch(/vitest[^\n]*--maxWorkers/);
      expect(brief, kind).toMatch(/jest[^\n]*--maxWorkers/);
      expect(brief, kind).toMatch(/pytest[^\n]*-n/);
      expect(brief, kind).toMatch(/vitest run --minWorkers=1 --maxWorkers=/); // vitest 2 refuse --maxWorkers seul sous le minimum par défaut (cœurs)
    }
  });
  it('R3 — le brief réel d\'une session de la vague porte la part calculée', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    h.wave.testWorkers = 5;
    await runLot(h.lot('L1', {}, { test: 'true' }));
    expect(h.calls[0].brief).toContain(`${TEST_WORKERS_ENV}=5`);
  });
  it('R3 — sans part connue (brief délégué à la main), le gabarit ne laisse ni trou ni consigne', () => {
    const brief = renderBrief('implement', vars);
    expect(brief).not.toContain(TEST_WORKERS_ENV);
    expect(brief).not.toContain('{{');
  });
});

describe('L350 R4 — pas de rejeu seul : un rouge de la porte est compté tel quel (le rejeu part dans L354)', () => {
  const LOG = () => join(tempDir(), 'appels.log');
  /** Journalise chaque appel de la porte avec ses arguments ; rouge nommé dès que le lot a écrit. */
  const gate = (log: string) => `f() { echo "args:$#" >> ${log}; [ -f a.txt ] || exit 0; [ -f b.txt ] && exit 0; echo " FAIL  test/a.test.ts > charge"; exit 1; }; f "$@"`;

  it('R4 — un test rouge nommé dans la suite entière part en correction sans être rejoué : la porte n\'est jamais appelée avec un fichier', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: gate(log) });
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/a.test.ts > charge');
    expect(new Set(readFileSync(log, 'utf8').trim().split('\n'))).toEqual(new Set(['args:0']));
    expect((c.lot as { instables?: unknown }).instables).toBeUndefined();
    expect(c.lot.warnings.some((w) => /instable/.test(w))).toBe(false);
  });
  it('R4 — un rouge de la ligne de base n\'est pas rejoué seul au sha de départ : il est retenu « déjà rouge » tel quel', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { case "$PWD" in *cadence-baseline*) echo "base:$#" >> ${log};; esac; echo ' FAIL  test/a.test.ts > ancien'; exit 1; }; f "$@"`;
    const c = h.lot('L1', {}, { test });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.baseline?.failures).toEqual(['test/a.test.ts > ancien']);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['base:0']);
  });
  it('R4 — le contrôle passé au relecteur ne parle pas de tests « red under load »', async () => {
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, { test: 'true' }));
    const review = h.calls.find((x) => x.kind === 'review')!;
    expect(review.brief).toContain('(tests): green');
    expect(review.brief).not.toMatch(/red under load|replayed alone/);
  });
});

describe('L350 R7 — la suite de cadence respecte la part de machine', () => {
  const load = async (value: string | undefined) => {
    const saved = process.env[TEST_WORKERS_ENV];
    if (value === undefined) delete process.env[TEST_WORKERS_ENV];
    else process.env[TEST_WORKERS_ENV] = value;
    vi.resetModules();
    try {
      return ((await import('../vitest.config.js')).default as { test: { poolOptions: { forks?: { minForks?: number; maxForks?: number }; threads?: { minThreads?: number; maxThreads?: number } } } }).test.poolOptions;
    } finally {
      if (saved === undefined) delete process.env[TEST_WORKERS_ENV];
      else process.env[TEST_WORKERS_ENV] = saved;
    }
  };
  it('R7 — vitest.config.ts borne les workers à CADENCE_TEST_WORKERS (forks et threads)', async () => {
    const pool = await load('3');
    expect(pool.forks?.maxForks).toBe(3);
    expect(pool.threads?.maxThreads).toBe(3);
    // vitest refuse de démarrer quand le minimum de son pool dépasse le maximum (« minThreads and maxThreads must not conflict »)
    expect(pool.forks!.minForks!).toBeLessThanOrEqual(3);
    expect(pool.threads!.minThreads!).toBeLessThanOrEqual(3);
  });
  it('R7 — sans la variable, ou avec une valeur invalide, le défaut de vitest reste', async () => {
    expect((await load(undefined)).forks?.maxForks).toBeUndefined();
    expect((await load('0')).forks?.maxForks).toBeUndefined();
    expect((await load('abc')).threads?.maxThreads).toBeUndefined();
  });
});
