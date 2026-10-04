import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { gitRepo, tempDir } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/claude-result.sample.json', import.meta.url));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup(scenario: Record<string, unknown[]>, opts: { cadenceYaml?: string; remote?: boolean } = {}) {
  const parent = tempDir();
  const dir = join(parent, 'proj');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'proj', 'L', '2026-09-01');
  plan.add('Un lot', '2026-10-01');
  plan.save();
  if (opts.cadenceYaml) writeFileSync(join(dir, 'cadence.yaml'), opts.cadenceYaml);
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
    const code = await run(['orchestrate', ...argv], { cwd: parent, env: { ...process.env, ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { parent, dir, bare, calls, cli };
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
  });

  it('sortie illisible : lot en échec, code 1 ; pas de nouvel essai', async () => {
    const s = setup({ implement: [{ garbage: true }] });
    const r = await s.cli('proj:L1');
    expect(r.code).toBe(1);
    expect(r.out).toContain('échec');
    expect(s.calls()).toHaveLength(1);
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
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual([]);
  });
});
