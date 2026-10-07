import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate, type OrchestrateDeps } from '../src/orchestrate/command.js';
import { RESERVED_ENV, SNAPSHOT_ENV } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Un faux paquet : de quoi voir ce que l'instantané copie, et un gabarit de revue qu'on pourra modifier. */
function fakePackage(): string {
  const pkg = tempDir();
  mkdirSync(join(pkg, 'bin'));
  writeFileSync(join(pkg, 'bin/cadence.js'), '// bin\n');
  mkdirSync(join(pkg, 'dist'));
  writeFileSync(join(pkg, 'dist/cli.js'), '// v1\n');
  cpSync(join(ROOT, 'templates'), join(pkg, 'templates'), { recursive: true });
  cpSync(AGENTS_DIR, join(pkg, 'agents'), { recursive: true });
  mkdirSync(join(pkg, 'skills'));
  writeFileSync(join(pkg, 'package.json'), '{"name":"x"}\n');
  mkdirSync(join(pkg, 'node_modules'));
  return pkg;
}

function project() {
  const parent = tempDir();
  const dir = join(parent, 'a');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'a', 'L', '2026-09-01');
  plan.add('Un lot', '2026-10-01', { estimate: 1 });
  plan.add('Deux', '2026-10-01', { estimate: 1 });
  plan.save();
  git(dir, 'add', '--', 'docs/plan/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return { parent, dir };
}

function ioOf(cwd: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { cwd, env: { RAF_TODAY: '2026-10-04', ...env }, out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); }, now: () => new Date('2026-10-04T14:12:00') } };
}

function setup() {
  const pkg = fakePackage();
  const reviews: string[] = [];
  const implement = (cwd: string, args: string[]) => claudeOut(workReport({ commits: [commitFile(cwd, `f-${Math.random()}.txt`, `feat(${/on lot `([^`]+)`/.exec(args[1])![1]}): travail`)] }));
  const claude: OrchestrateDeps['claude'] = async (args, o) => {
    const kind = kindOf(args);
    if (kind === 'implement' || kind === 'fix') return implement(o.cwd, args);
    reviews.push(args[1]);
    return claudeOut(reviewReport());
  };
  const base = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  const reexecs: { toolDir: string; argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  /** Le processus relancé : sur la copie (ses gabarits), avec les variables posées par le processus d'origine. */
  let beforeChild: () => void = () => {};
  const deps: OrchestrateDeps = {
    ...base,
    snapshot: {
      packageRoot: pkg,
      reexec: async (toolDir, argv, env, sink) => {
        reexecs.push({ toolDir, argv, env });
        beforeChild();
        const child = ioOf(env.CWD_FOR_TEST!, { ...(env as Record<string, string>), [SNAPSHOT_ENV]: toolDir });
        Object.assign(child.io, { out: sink.out, err: sink.err });
        return orchestrate(argv, child.io, { ...base, templatesDir: join(toolDir, 'templates/orchestrate') });
      },
    },
  };
  return { pkg, deps, base, reviews, reexecs, setBeforeChild: (f: () => void) => (beforeChild = f) };
}

describe('L61 — instantané de la vague (<vague>/tool/)', () => {
  it('le lancement copie le paquet dans la vague et relance depuis la copie, avec la vague réservée', async () => {
    const { parent } = project();
    const s = setup();
    const r = ioOf(parent, { CWD_FOR_TEST: parent });
    expect(await orchestrate(['a:L1'], r.io, s.deps)).toBe(0);
    expect(s.reexecs).toHaveLength(1);
    const wave = join(parent, '.cadence/runs/2026-10-04-1412');
    expect(s.reexecs[0].toolDir).toBe(join(wave, 'tool'));
    expect(s.reexecs[0].argv).toEqual(['a:L1']);
    expect(s.reexecs[0].env[RESERVED_ENV]).toBe('2026-10-04-1412');
    for (const f of ['bin/cadence.js', 'dist/cli.js', 'templates/orchestrate/review.md', 'package.json']) expect(existsSync(join(wave, 'tool', f)), f).toBe(true);
    expect(existsSync(join(wave, 'tool/agents'))).toBe(true);
    expect(lstatSync(join(wave, 'tool/node_modules')).isSymbolicLink()).toBe(true);
    expect(new RunStore(parent, '2026-10-04-1412').readWave()!.status).toBe('done');
  });

  it('un gabarit et un dist/ modifiés après le lancement ne sont pas vus par la vague', async () => {
    const { parent } = project();
    const s = setup();
    s.setBeforeChild(() => {
      writeFileSync(join(s.pkg, 'templates/orchestrate/review.md'), 'GABARIT MODIFIE {{lot}}\n');
      writeFileSync(join(s.pkg, 'dist/cli.js'), '// v2\n');
    });
    expect(await orchestrate(['a:L1'], ioOf(parent, { CWD_FOR_TEST: parent }).io, s.deps)).toBe(0);
    expect(s.reviews[0]).toContain('Review lot `L1`');
    expect(s.reviews[0]).not.toContain('GABARIT MODIFIE');
    expect(readFileSync(join(parent, '.cadence/runs/2026-10-04-1412/tool/dist/cli.js'), 'utf8')).toBe('// v1\n');
  });

  it('le dry-run ne copie rien et ne relance rien', async () => {
    const { parent } = project();
    const s = setup();
    const r = ioOf(parent, { CWD_FOR_TEST: parent });
    expect(await orchestrate(['a:L1', '--dry-run'], r.io, s.deps)).toBe(0);
    removeDryRunBriefs(r.out.join('\n'));
    expect(s.reexecs).toHaveLength(0);
    expect(existsSync(join(parent, '.cadence'))).toBe(false);
  });

  it('un refus avant d\'agir ne copie rien', async () => {
    const { parent } = project();
    const s = setup();
    expect(await orchestrate(['a:L9'], ioOf(parent, { CWD_FOR_TEST: parent }).io, s.deps)).toBe(2);
    expect(s.reexecs).toHaveLength(0);
    expect(existsSync(join(parent, '.cadence'))).toBe(false);
  });

  it('le processus déjà relancé ne refait pas de copie', async () => {
    const { parent } = project();
    const s = setup();
    const r = ioOf(parent, { [SNAPSHOT_ENV]: '/x', [RESERVED_ENV]: 'w1' });
    expect(await orchestrate(['a:L1'], r.io, s.deps)).toBe(0);
    expect(s.reexecs).toHaveLength(0);
    expect(new RunStore(parent, 'w1').readWave()!.status).toBe('done');
    expect(existsSync(join(parent, '.cadence/runs/w1/tool'))).toBe(false);
  });

  it('--resume relance depuis l\'instantané de la vague reprise, jamais depuis le paquet courant', async () => {
    const { parent } = project();
    const s = setup();
    const env = { CWD_FOR_TEST: parent };
    expect(await orchestrate(['a:L1', 'a:L2', '--budget', '2000'], ioOf(parent, env).io, s.deps)).toBe(3);
    expect(s.reexecs).toHaveLength(1);
    s.setBeforeChild(() => writeFileSync(join(s.pkg, 'templates/orchestrate/review.md'), 'GABARIT MODIFIE {{lot}}\n'));
    expect(await orchestrate(['--resume', '--budget', '1M'], ioOf(parent, env).io, s.deps)).toBe(0);
    expect(s.reexecs).toHaveLength(2);
    expect(s.reexecs[1].toolDir).toBe(join(parent, '.cadence/runs/2026-10-04-1412/tool'));
    expect(s.reexecs[1].argv).toEqual(['--resume', '--budget', '1M']);
    expect(s.reviews.join('')).not.toContain('GABARIT MODIFIE');
  });

  it('--resume d\'une vague sans instantané : comportement actuel, avec un avertissement', async () => {
    const { parent } = project();
    const s = setup();
    expect(await orchestrate(['a:L1', 'a:L2', '--budget', '2000'], ioOf(parent, { CWD_FOR_TEST: parent }).io, s.deps)).toBe(3);
    rmSync(join(parent, '.cadence/runs/2026-10-04-1412/tool'), { recursive: true });
    const r = ioOf(parent, { CWD_FOR_TEST: parent });
    expect(await orchestrate(['--resume', '--budget', '1M'], r.io, s.deps)).toBe(0);
    expect(s.reexecs).toHaveLength(1);
    expect(r.err.join('\n')).toContain('sans instantané');
  });

  it('l\'instantané disparaît avec le dossier de la vague', async () => {
    const { parent } = project();
    const s = setup();
    await orchestrate(['a:L1'], ioOf(parent, { CWD_FOR_TEST: parent }).io, s.deps);
    rmSync(join(parent, '.cadence/runs/2026-10-04-1412'), { recursive: true });
    expect(existsSync(join(parent, '.cadence/runs/2026-10-04-1412/tool'))).toBe(false);
  });
});

