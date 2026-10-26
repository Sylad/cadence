import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runLot } from '../src/orchestrate/cycle.js';
import { replayFile, shellArg, testWorkers, testWorkersFrom, testWorkersText, TEST_WORKERS_ENV } from '../src/orchestrate/workers.js';
import { renderBrief } from '../src/orchestrate/briefs.js';
import { claudeOut, commitFile, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { fake, meeting, run, setup, store, writes } from './orchestrate-worktree-harness.js';
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

describe('L350 R4 — un test rouge de la porte est rejoué seul avant d\'être compté', () => {
  const LOG = () => join(tempDir(), 'rejeux.log');
  /** Rouge dans la suite entière, `f` rejoué avec un fichier : `ALONE` décide (« vert » ou « rouge »). */
  const gate = (log: string, alone: 'vert' | 'rouge') =>
    `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; ${alone === 'vert' ? 'exit 0' : 'echo " FAIL  test/a.test.ts > charge"; exit 1'}; fi; echo " FAIL  test/a.test.ts > charge"; echo " FAIL  test/b.test.ts > autre"; exit 1; }; f`;

  it('R4 — rouge dans la suite, vert rejoué seul : pas de passe de correction, le lot va en revue, noté « instable sous charge »', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const c = h.lot('L1', {}, { test: gate(log, 'vert') });
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge', 'test/b.test.ts > autre']);
    expect(c.lot.warnings.some((w) => /instable\(s\) sous charge.*test\/a\.test\.ts > charge/.test(w))).toBe(true);
  });
  it('R4 — rejeu SEUL : la commande de la porte reçoit les fichiers des tests rouges, une seule fois quand le premier rejeu est vert', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    await runLot(h.lot('L1', {}, { test: gate(log, 'vert') }));
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['test/a.test.ts test/b.test.ts']);
  });
  it('R4 — rouge aussi au premier rejeu, vert au second : toujours instable (deux rejeux au plus)', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; [ "$(wc -l < ${log})" -ge 2 ] && exit 0; echo " FAIL  test/a.test.ts > charge"; exit 1; fi; echo " FAIL  test/a.test.ts > charge"; exit 1; }; f`;
    const c = h.lot('L1', {}, { test });
    await runLot(c);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge']);
  });
  it('R4 — rouge à la suite et aux deux rejeux : compté, la passe de correction a lieu et ne liste que lui', async () => {
    const log = LOG();
    let replaysBeforeFix = -1;
    const fixing: Handler = (call) => {
      replaysBeforeFix = readFileSync(log, 'utf8').trim().split('\n').length;
      return fix('b.txt')(call);
    };
    const h = harness({ script: { implement: [impl()], fix: [fixing], review: [ok] } });
    const c = h.lot('L1', {}, { test: `${gate(log, 'rouge')}` });
    await runLot(c);
    expect(replaysBeforeFix).toBe(2); // deux rejeux, pas trois
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
    expect(h.calls[1].brief).toContain('test/a.test.ts > charge');
    expect(c.lot.instables).toEqual(['test/b.test.ts > autre']); // b ne rougit pas aux rejeux (la sortie n'y nomme que a) : instable, a reste compté
  });
  it('R4 — deux rouges, un seul reste rouge au rejeu : la correction ne liste que celui-là, l\'autre est noté instable', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    // b.test.ts rouge partout ; a.test.ts rouge seulement dans la suite entière
    const test = `f() { [ -f a.txt ] || exit 0; if [ -n "$1" ]; then echo "$@" >> ${log}; echo " FAIL  test/b.test.ts > autre"; exit 1; fi; echo " FAIL  test/a.test.ts > charge"; echo " FAIL  test/b.test.ts > autre"; exit 1; }; f`;
    const c = h.lot('L1', {}, { test });
    await runLot(c);
    const brief = h.calls[1].brief;
    expect(brief).toContain('test/b.test.ts > autre');
    expect(brief).not.toContain('- test/a.test.ts > charge');
    expect(c.lot.instables).toEqual(['test/a.test.ts > charge']);
  });
  it('R4 — un rouge déjà présent à la ligne de base n\'est pas rejoué (déjà exclu du compte)', async () => {
    const log = LOG();
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    const test = `f() { if [ -n "$1" ]; then echo "$@" >> ${log}; exit 0; fi; echo " FAIL  test/a.test.ts > ancien"; exit 1; }; f`;
    const c = h.lot('L1', {}, { test });
    await runLot(c);
    expect(existsSync(log)).toBe(false);
    expect(c.lot.status).toBe('ready');
  });
  it('R4 — un échec sans nom de fichier (rien à rejouer seul) est compté comme avant', async () => {
    const h = harness({ script: { implement: [impl()], fix: [fix('b.txt')], review: [ok] } });
    const c = h.lot('L1', {}, { test: `[ ! -f a.txt ] || [ -f b.txt ] || { echo ' FAIL  cas sans fichier'; exit 1; }` });
    await runLot(c);
    expect(kinds(h).slice(0, 2)).toEqual(['implement', 'fix']);
  });
  it('R4 — l\'instabilité est une ligne du journal de la vague et le contrôle du relecteur la dit verte', async () => {
    const log = LOG();
    const lines: string[] = [];
    const h = harness({ script: { implement: [impl()], review: [ok] } });
    h.wave.log = (l) => lines.push(l);
    const c = h.lot('L1', {}, { test: gate(log, 'vert') });
    await runLot(c);
    expect(lines.some((l) => /instable\(s\) sous charge/.test(l))).toBe(true);
    const review = h.calls.find((x) => x.kind === 'review')!;
    expect(review.brief).toMatch(/green.*rouge\(s\) sous charge|green.*red under load/i);
  });
  it('R4 — les cibles de rejeu : fichier de vitest (« fichier > suite > test ») et de pytest (« fichier::test »), rien pour un nom sans fichier', () => {
    expect(replayFile('test/a.test.ts > suite > cas')).toBe('test/a.test.ts');
    expect(replayFile('tests/test_a.py::test_x[1-2]')).toBe('tests/test_a.py');
    expect(replayFile('cas sans fichier')).toBeNull();
    expect(replayFile('a > b')).toBeNull();
  });
  it('R4 — un chemin à espaces ou caractères de shell est quoté pour le rejeu', () => {
    expect(shellArg('test/a.test.ts')).toBe('test/a.test.ts');
    expect(shellArg("test/a b's.test.ts")).toBe("'test/a b'\\''s.test.ts'");
  });
});

describe('L350 R5 — la porte de la vague et de l\'intégration', () => {
  it('R5 — au sommet intégré, un rouge de charge rejoué seul n\'est plus un rouge : pas de relance de toute la suite', async () => {
    const mark = join(tempDir(), 'suite-entiere');
    process.env.CHARGE_MARK = mark;
    const check = `f() { if [ -n "$1" ]; then exit 0; fi; if [ -f L1.txt ] && [ -f L2.txt ]; then echo x >> "$CHARGE_MARK"; echo " FAIL  test/a.test.ts > charge"; exit 1; fi; exit 0; }; f "$@"\n`;
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', { 'check.sh': check });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    delete process.env.CHARGE_MARK;
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/relancés une fois/);
    expect(readFileSync(mark, 'utf8').trim().split('\n')).toHaveLength(1); // le rouge de charge a eu lieu une seule fois : la suite entière n'a pas été relancée
    expect(['L1', 'L2'].map((id) => store(parent).readLot('a', id)!.status)).toEqual(['ready', 'ready']);
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
