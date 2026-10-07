import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate, realOrchestrateDeps, type OrchestrateDeps } from '../src/orchestrate/command.js';
import { spawnSync } from 'node:child_process';
import { RESERVED_ENV, SNAPSHOT_ENV, takeSnapshot } from '../src/orchestrate/snapshot.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Un faux paquet : de quoi voir ce que l'instantané copie, et un gabarit de revue qu'on pourra modifier. */
function fakePackage(): string {
  const pkg = tempDir();
  mkdirSync(join(pkg, 'bin'));
  for (const n of ['cadence', 'raf']) {
    writeFileSync(join(pkg, `bin/${n}.js`), `#!/usr/bin/env node\nconsole.log('${n}-copie', process.argv.slice(2).join(' '));\n`);
    chmodSync(join(pkg, `bin/${n}.js`), 0o755);
  }
  mkdirSync(join(pkg, 'dist'));
  writeFileSync(join(pkg, 'dist/cli.js'), '// v1\n');
  cpSync(join(ROOT, 'templates'), join(pkg, 'templates'), { recursive: true });
  cpSync(AGENTS_DIR, join(pkg, 'agents'), { recursive: true });
  mkdirSync(join(pkg, 'skills'));
  writeFileSync(join(pkg, 'package.json'), '{"name":"x"}\n');
  fakeYaml(join(pkg, 'node_modules'));
  return pkg;
}

/** De quoi faire résoudre `yaml` : un faux module dans `modules`. */
function fakeYaml(modules: string) {
  mkdirSync(join(modules, 'yaml'), { recursive: true });
  writeFileSync(join(modules, 'yaml/package.json'), '{"name":"yaml","main":"index.js"}\n');
  writeFileSync(join(modules, 'yaml/index.js'), 'module.exports = {};\n');
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
    expect(await orchestrate(['a:L1'], r.io, { ...s.base, templatesDir: join(s.pkg, 'templates/orchestrate') })).toBe(0);
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
});


describe('(L61/t1) variables de relance : lues par le fils, jamais transmises', () => {
  const saved = { snap: process.env[SNAPSHOT_ENV], res: process.env[RESERVED_ENV] };
  afterEach(() => {
    for (const [k, v] of [[SNAPSHOT_ENV, saved.snap], [RESERVED_ENV, saved.res]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('une session claude ne voit ni CADENCE_SNAPSHOT ni CADENCE_WAVE_RESERVED', async () => {
    const dir = tempDir();
    const dump = join(dir, 'env.txt');
    const bin = join(dir, 'claude.sh');
    writeFileSync(bin, '#!/bin/sh\nenv > "$DUMP"\n');
    chmodSync(bin, 0o755);
    const env = { PATH: process.env.PATH, DUMP: dump, CADENCE_CLAUDE_BIN: bin, [SNAPSHOT_ENV]: ROOT, [RESERVED_ENV]: 'w1' };
    await realOrchestrateDeps(env).claude([], { cwd: dir, env: { CADENCE_ORCHESTRATED: 'w1' }, timeoutMs: 10_000 });
    const seen = readFileSync(dump, 'utf8');
    expect(seen).toContain('CADENCE_ORCHESTRATED=w1');
    expect(seen).not.toContain(SNAPSHOT_ENV);
    expect(seen).not.toContain(RESERVED_ENV);
  });

  it('une commande sh du projet (orchestrate.start) ne les voit pas non plus', async () => {
    const h = harness({ script: {} });
    const dump = join(tempDir(), 'env.txt');
    process.env[SNAPSHOT_ENV] = '/x';
    process.env[RESERVED_ENV] = 'w1';
    const c = h.lot('L1', { readOnlyPlan: true }, { start: `env > ${dump}` });
    const plan = c.loadPlan;
    c.loadPlan = () => {
      const p = plan();
      Object.defineProperty(p, 'readonly', { get: () => true });
      return p;
    };
    await runLot(c);
    const seen = readFileSync(dump, 'utf8');
    expect(seen).toContain('PATH=');
    expect(seen).not.toContain(SNAPSHOT_ENV);
    expect(seen).not.toContain(RESERVED_ENV);
  });

  it('une variable héritée d\'une autre vague (CADENCE_SNAPSHOT qui n\'est pas CE paquet) ne fait pas passer pour un fils', () => {
    expect(realOrchestrateDeps({ [SNAPSHOT_ENV]: '/une/autre/vague/tool' }).snapshot).toBeDefined();
    expect(realOrchestrateDeps({ [SNAPSHOT_ENV]: ROOT }).snapshot).toBeUndefined();
  });
});

describe('(L61/t2) node_modules de l\'instantané : là où les dépendances se résolvent', () => {
  it('installation npx ou locale : yaml vit hors du paquet, dans un node_modules parent → c\'est celui-là qui est lié', () => {
    const outer = tempDir();
    fakeYaml(join(outer, 'node_modules'));
    const pkg = join(outer, 'node_modules/@sylad/cadence');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'bin/cadence.js'), '// bin\n');
    writeFileSync(join(pkg, 'package.json'), '{"name":"@sylad/cadence"}\n');
    const tool = takeSnapshot(join(tempDir(), 'wave'), pkg);
    expect(lstatSync(join(tool, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(tool, 'node_modules'))).toBe(realpathSync(join(outer, 'node_modules')));
    expect(existsSync(join(tool, 'node_modules/yaml/package.json'))).toBe(true);
  });

  it('yaml introuvable : refus AVANT toute copie, code 2, message clair', async () => {
    const { parent } = project();
    const s = setup();
    rmSync(join(s.pkg, 'node_modules'), { recursive: true });
    const r = ioOf(parent, { CWD_FOR_TEST: parent });
    expect(await orchestrate(['a:L1'], r.io, s.deps)).toBe(2);
    expect(r.err.join('\n')).toMatch(/dépendances.*introuvables|yaml/);
    expect(s.reexecs).toHaveLength(0);
    expect(existsSync(join(parent, '.cadence'))).toBe(false);
  });
});

describe('(L61/t4) raf et cadence de l\'instantané', () => {
  it('<vague>/tool/bin a des entrées exécutables raf et cadence qui lancent bin/*.js de la copie', () => {
    const wave = join(tempDir(), 'wave');
    const tool = takeSnapshot(wave, fakePackage());
    for (const n of ['raf', 'cadence']) {
      const r = spawnSync(join(tool, 'bin', n), ['commits', 'L1'], { encoding: 'utf8' });
      expect(r.stdout.trim(), n).toBe(`${n}-copie commits L1`);
    }
    // l'entrée appelle la copie, pas le paquet d'origine
    writeFileSync(join(tool, 'bin/raf.js'), "#!/usr/bin/env node\nconsole.log('modifiee');\n");
    expect(spawnSync(join(tool, 'bin/raf'), [], { encoding: 'utf8' }).stdout.trim()).toBe('modifiee');
  });

  it('les sessions ont <vague>/tool/bin en tête du PATH, avant le Node du projet', async () => {
    const { parent } = project();
    const s = setup();
    const envs: Record<string, string>[] = [];
    const wave = join(parent, '.cadence/runs/2026-10-04-1412');
    const tracked: OrchestrateDeps['claude'] = async (args, o) => {
      envs.push(o.env);
      return s.base.claude(args, o);
    };
    const base = { ...s.base, claude: tracked };
    const deps: OrchestrateDeps = {
      ...base,
      snapshot: {
        packageRoot: s.pkg,
        reexec: async (toolDir, argv, env, sink) => {
          const child = ioOf(env.CWD_FOR_TEST!, { ...(env as Record<string, string>) });
          Object.assign(child.io, { out: sink.out, err: sink.err });
          return orchestrate(argv, child.io, { ...base, templatesDir: join(toolDir, 'templates/orchestrate') });
        },
      },
    };
    expect(await orchestrate(['a:L1'], ioOf(parent, { CWD_FOR_TEST: parent }).io, deps)).toBe(0);
    expect(envs.length).toBeGreaterThan(0);
    for (const e of envs) expect(e.PATH.split(':')[0]).toBe(join(wave, 'tool/bin'));
  });
});
