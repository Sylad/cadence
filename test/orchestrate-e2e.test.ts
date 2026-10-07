import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate, realOrchestrateDeps } from '../src/orchestrate/command.js';
import { spawnReexec } from '../src/orchestrate/snapshot.js';
import { cadenceHome, liveWaves } from '../src/orchestrate/registry.js';
import { projectLogDir } from '../src/orchestrate/launch.js';
import { RunStore } from '../src/orchestrate/state.js';
import { Plan } from '../src/plan.js';
import { fakeApp } from './fake-app.js';
import { gitRepo, removeDryRunBriefs, tempDir, testPackage } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/claude-result.sample.json', import.meta.url));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(scenario: Record<string, unknown[]>, opts: { cadenceYaml?: string; remote?: boolean; visible?: boolean; precheck?: boolean } = {}) {
  const parent = tempDir();
  const dir = join(parent, 'proj');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'proj', 'L', '2026-09-01');
  plan.add('Un lot', '2026-10-01', { visible: opts.visible });
  plan.save();
  // Le contrôle préalable (L77) a son propre test ; ailleurs il est coupé pour que les étapes attendues restent les mêmes.
  const yaml = opts.cadenceYaml ?? 'orchestrate:\n';
  writeFileSync(join(dir, 'cadence.yaml'), yaml.replace('orchestrate:\n', `orchestrate:\n  precheck: ${opts.precheck ?? false}\n`));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  let bare = '';
  if (opts.remote) {
    bare = join(tempDir(), 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  const scen = join(tempDir(), 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const log = join(tempDir(), 'calls.jsonl');
  writeFileSync(log, '');
  const env = { RAF_TODAY: '2026-10-04', CADENCE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_SCENARIO: scen, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SAMPLE: SAMPLE };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const e = { ...process.env, ...env };
    // L61/t5 : le fils est relancé depuis le paquet jetable construit depuis src/, jamais depuis le dist/ en service.
    const deps = { ...realOrchestrateDeps(e), snapshot: { packageRoot: testPackage(), reexec: spawnReexec } };
    const code = await orchestrate(argv, { cwd: parent, env: e, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') }, deps);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { parent, dir, bare, calls, cli, env };
}

const impl = { commits: [{ file: 'a.txt', message: 'feat({lot}): travail' }] };

describe('cadence orchestrate de bout en bout (faux claude)', () => {
  it('un lot : vrais processus, arguments, environnement et journaux', async () => {
    const s = setup({ implement: [impl], review: [{}] });
    const r = await s.cli('proj:L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('prêt à livrer');
    const [i, v] = s.calls();
    expect(i).toMatchObject({ kind: 'implement', lot: 'L1', model: 'sonnet', orchestrated: '2026-10-04-1412', resume: false, cwd: s.dir });
    expect(v).toMatchObject({ kind: 'review', model: 'opus', resume: false });
    expect(Plan.load(join(s.dir, 'docs/plan/raf.yaml')).lot('L1').review?.commit).toBe(git(s.dir, 'log', '--format=%H', '--grep=feat(L1)', '-1'));
    const base = join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1');
    expect(JSON.parse(readFileSync(join(base, '1-implement.json'), 'utf8')).tokens.counted).toBe(115);
    expect(git(s.dir, 'status', '--porcelain')).toBe('');
    expect(i.leaked).toEqual([]);
    // L61/t4 : raf et cadence des sessions sont ceux de la copie (<vague>/tool/bin en tête du PATH)
    const bin = join(s.parent, '.cadence/runs/2026-10-04-1412/tool/bin');
    expect(i.which).toEqual({ raf: join(bin, 'raf'), cadence: join(bin, 'cadence') });
    expect(v.which).toEqual(i.which);
    // L61 : la vague a tourné depuis son instantané (copie du paquet dans le dossier de la vague)
    expect(existsSync(join(base, '../tool/bin/cadence.js'))).toBe(true);
    expect(existsSync(join(base, '../tool/dist/orchestrate/snapshot.js'))).toBe(true);
  });

  it('(L61/t1) variables de relance héritées d\'une autre vague : ignorées, et aucune session ne les voit', async () => {
    const s = setup({ implement: [impl], review: [{}] });
    const out: string[] = [];
    const err: string[] = [];
    const env = { ...process.env, ...s.env, CADENCE_SNAPSHOT: '/une/autre/vague/tool', CADENCE_WAVE_RESERVED: '2000-01-01-0000' };
    const deps = { ...realOrchestrateDeps(env), snapshot: { packageRoot: testPackage(), reexec: spawnReexec } };
    const code = await orchestrate(['proj:L1'], { cwd: s.parent, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') }, deps);
    expect(err.join('\n')).toBe('');
    expect(code).toBe(0);
    expect(existsSync(join(s.parent, '.cadence/runs/2026-10-04-1412/wave.json'))).toBe(true);
    expect(existsSync(join(s.parent, '.cadence/runs/2000-01-01-0000'))).toBe(false);
    for (const c of s.calls()) expect(c.leaked, c.kind).toEqual([]);
  });

  it('sortie illisible : lot en échec, code 1 ; pas de nouvel essai', async () => {
    const s = setup({ implement: [{ garbage: true }] });
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(1);
    expect(r.out).toContain('échec');
    expect(s.calls()).toHaveLength(1);
  });

  it('revue finie en texte sans structured_output : une relance --resume de la même session, rapport récupéré, jetons comptés (L26)', async () => {
    const s = setup({ implement: [impl], review: [{ noStructured: true }] });
    const r = await s.cli('proj:L1');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('prêt à livrer');
    const calls = s.calls();
    expect(calls.map((c) => [c.kind, c.resume])).toEqual([['implement', false], ['review', false], ['review', true]]);
    const retry = calls[2];
    expect(retry.resumeId).toBe('fake-review-0');
    expect(retry.model).toBe('opus');
    expect(retry.schema).toBe(calls[1].schema);
    expect(retry.argv).toEqual(expect.arrayContaining(['--permission-mode', '--disallowedTools']));
    const state = JSON.parse(readFileSync(join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1.json'), 'utf8'));
    const review = state.steps.find((st: { kind: string }) => st.kind === 'review');
    expect(review.formatRetry).toBe(true);
    expect(review.tokens.counted).toBe(115 + 117);
    // (L27) la sortie de la première session reste lisible à côté du rapport récupéré
    const dir = join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1');
    const first = JSON.parse(readFileSync(join(dir, `${review.report.replace('.json', '')}.first.json`), 'utf8'));
    expect('structured_output' in first).toBe(false);
    expect(state.steps.find((st: { kind: string }) => st.kind === 'implement').formatRetry).toBeUndefined();
  });

  it('toujours sans structured_output après la relance : échec comme avant, une seule relance, jetons des deux appels (L26)', async () => {
    const s = setup({ implement: [impl], review: [{ noStructured: true, resumeNoStructured: true }] });
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(1);
    expect(r.out).toContain('structured_output');
    expect(s.calls().map((c) => [c.kind, c.resume])).toEqual([['implement', false], ['review', false], ['review', true]]);
    const state = JSON.parse(readFileSync(join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1.json'), 'utf8'));
    expect(state.steps.find((st: { kind: string }) => st.kind === 'review').tokens.counted).toBe(115 + 117);
    // (L27) la relance a échoué : la sortie de la première session est tout de même écrite à côté du rapport d'échec
    const dir = join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1');
    const first = JSON.parse(readFileSync(join(dir, '2-review.first.json'), 'utf8'));
    expect(first.session_id).toBe('fake-review-0');
    expect('structured_output' in first).toBe(false);
    expect(existsSync(join(dir, '2-review.json'))).toBe(true);
  });

  it('quota atteint pendant la relance de mise en forme : lot suspendu, sortie de la première session conservée (L27)', async () => {
    const s = setup({ implement: [impl], review: [{ noStructured: true, resumeUsageLimit: true }] });
    const r = await s.cli('proj:L1');
    expect(s.calls().map((c) => [c.kind, c.resume])).toEqual([['implement', false], ['review', false], ['review', true]]);
    expect(r.out).toContain('quota');
    const dir = join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1');
    const first = JSON.parse(readFileSync(join(dir, '2-review.first.json'), 'utf8'));
    expect(first.session_id).toBe('fake-review-0');
    expect('structured_output' in first).toBe(false);
    const state = JSON.parse(readFileSync(join(s.parent, '.cadence/runs/2026-10-04-1412/proj--L1.json'), 'utf8'));
    expect(state.status).toBe('suspended');
    expect(state.steps.find((st: { kind: string }) => st.kind === 'review').status).toBe('interrupted');
  });

  it('une implémentation sans structured_output est relancée aussi : tous les types d\'étape à schéma (L26)', async () => {
    const s = setup({ implement: [{ ...impl, noStructured: true }], review: [{}] });
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(0);
    expect(s.calls().map((c) => [c.kind, c.resume])).toEqual([['implement', false], ['implement', true], ['review', false]]);
  });

  it('limite d\'usage : code 3, vague suspendue-quota, aucun nouvel appel', async () => {
    const s = setup({ implement: [{ usageLimit: true }] });
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(3);
    expect(r.err).toContain('quota atteint');
    expect(r.err).toMatch(/limit reached — remise le \d{4}-\d{2}-\d{2} à \d{2}:\d{2}/); // L3/t15
    expect(r.err).not.toContain('|1759600000');
    expect(JSON.parse(readFileSync(join(s.parent, '.cadence/runs/2026-10-04-1412/wave.json'), 'utf8')).status).toBe('suspended-quota');
    expect(s.calls()).toHaveLength(1);
  });

  it('délai dépassé : la session est tuée, échec nommé', async () => {
    const s = setup({ implement: [{ sleepMs: 8000 }] }, { cadenceYaml: 'orchestrate:\n  timeouts: { implement: 0.01 }\n' });
    const t0 = Date.now();
    const r = await s.cli('proj:L1');
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.code).toBe(1);
    expect(r.out).toContain('délai dépassé');
  });

  it('le push d\'une session échoue (hook pre-push), le dépôt distant ne bouge pas', async () => {
    const s = setup({ implement: [{ ...impl, push: true }], review: [{}] }, { remote: true });
    const before = git(s.dir, 'ls-remote', '--heads');
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(0);
    expect(s.calls()[0].pushStatus).not.toBe(0);
    expect(git(s.dir, 'ls-remote', '--heads')).toBe(before);
    expect(existsSync(join(s.dir, '.git/hooks/pre-push'))).toBe(false); // retiré à la fin de la vague
  });

  it('--dry-run ne lance rien', async () => {
    const s = setup({});
    const r = await s.cli('proj:L1', '--dry-run');
    try {
      expect(r.code).toBe(0);
      expect(s.calls()).toEqual([]);
    } finally {
      removeDryRunBriefs(r.out);
    }
  });

  it('--dry-run d\'un lot déjà commité sans revue : implement reste dans les étapes, rien n\'est lancé (L53)', async () => {
    const s = setup({});
    writeFileSync(join(s.dir, 'a.txt'), 'x\n');
    git(s.dir, 'add', '--', 'a.txt');
    git(s.dir, 'commit', '-q', '-m', 'docs(L1): spec', '--', 'a.txt');
    const r = await s.cli('proj:L1', '--dry-run');
    try {
      expect(r.code).toBe(0);
      expect(r.out).toContain('étapes : implement (sonnet) → review (opus)');
      expect(r.out).not.toContain('implement sauté');
      expect(s.calls()).toEqual([]);
    } finally {
      removeDryRunBriefs(r.out);
    }
  });

  it('--dry-run : le contrôle préalable ouvre les étapes, sauf orchestrate.precheck: false (L77)', async () => {
    const on = setup({}, { precheck: true });
    const r = await on.cli('proj:L1', '--dry-run');
    try {
      expect(r.out).toContain('étapes : precheck (sonnet) → implement (sonnet) → review (opus)');
    } finally {
      removeDryRunBriefs(r.out);
    }
  });

  // L3/t12 : vrai processus, vrai signal.
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s : sessions tuées, étapes et vague interrompues, verrous et hook retirés', async (signal) => {
    const s = setup({ implement: [{ ...impl, sleepMs: 60_000 }] });
    const bin = join(testPackage(), 'bin/cadence.js');
    const logFile = s.calls;
    const claudeHome = tempDir();
    const env = { ...process.env, ...s.env, CLAUDE_CONFIG_DIR: claudeHome };
    const child = spawn(process.execPath, [bin, 'orchestrate', 'proj:L1'], { cwd: s.parent, env, stdio: 'ignore' });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const waitFor = async (what: string, ok: () => boolean) => {
      for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
      if (!ok()) {
        child.kill('SIGKILL');
        throw new Error(`délai : ${what}`);
      }
    };
    const store = () => RunStore.last(s.parent);
    const sessionPid = () => store()?.readLot('proj', 'L1')?.steps[0]?.pid;
    await waitFor('session lancée', () => logFile().length === 1 && !!sessionPid() && existsSync(join(s.dir, '.git/hooks/pre-push')) && liveWaves(cadenceHome()).length === 1);
    const pid = sessionPid()!;
    // L3/t20 : la session tuée a consommé des tokens, lisibles dans son journal (identifiant passé par --session-id)
    const sid = store()!.readLot('proj', 'L1')!.steps[0].sessionId!;
    expect(s.calls()[0].sessionId).toBe(sid);
    const logs = projectLogDir(claudeHome, realpathSync(s.dir));
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 7, output_tokens: 5 } } }));
    writeFileSync(join(logs, 'autre-conversation.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'z', usage: { input_tokens: 9_999_999, output_tokens: 1 } } }));
    // L61 : le processus de la vague est le fils relancé depuis l'instantané ; le processus lancé le surveille.
    const worker = liveWaves(cadenceHome()).map((w) => w.pid);
    expect(worker).toHaveLength(1);
    expect(worker[0]).not.toBe(child.pid);
    expect(existsSync(join(s.dir, '.git/cadence/orchestrate.lock'))).toBe(true);

    child.kill(signal);
    const end = await exited;
    expect(end.signal).toBe(signal); // cadence meurt du signal, comme sans nettoyage

    const st = store()!;
    const lot = st.readLot('proj', 'L1')!;
    expect(lot.steps.map((x) => x.status)).toEqual(['interrupted']);
    expect(lot.status).toBe('suspended');
    expect(st.readWave()!.status).toBe('interrupted');
    expect(st.readWave()!.consumed).toBe(115);
    expect(st.readWave()!.cacheRead).toBe(7);
    expect(lot.steps[0].tokens).toMatchObject({ counted: 115 });
    expect(liveWaves(cadenceHome())).toEqual([]);
    expect(existsSync(join(s.dir, '.git/cadence/orchestrate.lock'))).toBe(false);
    expect(existsSync(join(s.dir, '.git/hooks/pre-push'))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow(); // la session est morte
    expect(() => process.kill(worker[0], 0)).toThrow(); // et le processus de la vague aussi
  }, 20_000);

  // L60 : le signal reçu pendant la revue UX tue aussi l'application, détachée dans son propre groupe de processus.
  it('SIGTERM pendant la revue UX : l\'application lancée par le programme est tuée', async () => {
    const app = await fakeApp(0);
    const yaml = `orchestrate:\n  ux: { command: ${JSON.stringify(app.command)}, url: ${JSON.stringify(app.url)}, timeout: 20 }\n`;
    const s = setup({ implement: [impl], ux: [{ sleepMs: 60_000 }] }, { cadenceYaml: yaml, visible: true });
    const bin = join(testPackage(), 'bin/cadence.js');
    const child = spawn(process.execPath, [bin, 'orchestrate', 'proj:L1'], { cwd: s.parent, env: { ...process.env, ...s.env, CLAUDE_CONFIG_DIR: tempDir() }, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const waitFor = async (what: string, ok: () => boolean) => {
      for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
      if (!ok()) {
        child.kill('SIGKILL');
        throw new Error(`délai : ${what}`);
      }
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor('session UX lancée', () => s.calls().some((c) => c.kind === 'ux') && existsSync(join(app.dir, 'pid')));
    const pid = Number(readFileSync(join(app.dir, 'pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    child.kill('SIGTERM');
    await exited;
    expect(alive(pid)).toBe(false);
  }, 20_000);
});

/** Une copie du paquet jetable (construit depuis src/) qu'on peut modifier sans toucher au vrai : le « paquet courant » d'une vague. */
function livePackage(): string {
  const pkg = tempDir();
  for (const n of ['bin', 'dist', 'templates', 'agents', 'skills', 'package.json']) cpSync(join(testPackage(), n), join(pkg, n), { recursive: true });
  symlinkSync(join(testPackage(), 'node_modules'), join(pkg, 'node_modules'), 'dir');
  return pkg;
}

/** Une vraie vague : vrai fils node lancé depuis l'instantané d'un paquet jetable, faux claude. */
async function realWave(pkg: string, s: ReturnType<typeof setup>, afterSnapshot: () => void = () => {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { ...process.env, ...s.env };
  const deps = { ...realOrchestrateDeps(env), snapshot: { packageRoot: pkg, reexec: (...a: Parameters<typeof spawnReexec>) => (afterSnapshot(), spawnReexec(...a)) } };
  const code = await orchestrate(['proj:L1'], { cwd: s.parent, env, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') }, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('contrôle préalable (L77), de bout en bout', () => {
  it('livrable déjà présent : le vrai claude factice n\'est lancé qu\'une fois (precheck), lot rendu, code 1', async () => {
    const s = setup({ precheck: [{ structured: { dejaPresent: 'oui', preuves: ['a.ts:3'], resume: 'fait par L9' } }] }, { precheck: true });
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(1);
    expect(s.calls().map((c) => c.kind)).toEqual(['precheck']);
    expect(s.calls()[0].model).toBe('sonnet');
    expect(r.out).toContain('livrable déjà présent : fait par L9 (a.ts:3)');
  });
});

describe('(L61/t3) le vrai fils lit ses gabarits dans la copie', () => {
  it('un gabarit modifié dans le paquet courant après la copie n\'est pas vu : le brief de revue vient de la copie', async () => {
    const pkg = livePackage();
    const live = join(pkg, 'templates/orchestrate/review.md');
    const s = setup({ implement: [impl], review: [{}] });
    // Entre la copie et le démarrage du fils : le paquet courant change (le fils lit ses gabarits au départ).
    const r = await realWave(pkg, s, () => writeFileSync(live, 'GABARIT MODIFIE {{lot}}\n'));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(live, 'utf8')).toContain('GABARIT MODIFIE');
    const review = s.calls().find((c) => c.kind === 'review')!;
    expect(review.argv[1]).toContain('Review lot `L1`');
    expect(review.argv[1]).not.toContain('GABARIT MODIFIE');
  });
});
