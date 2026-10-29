import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { orchestrate } from '../src/orchestrate/command.js';
import { claudeOut, commitFile, git, workReport } from './orchestrate-harness.js';
import { fake, run, until } from './orchestrate-worktree-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L426 : le hook « porte seule » que la vague laisse derrière elle est posé par `freeRepo` (dépôt libéré dès que ses lots sont finis)
// et par `release` (fin ou échec de la vague) : ces tests passent par `cadence orchestrate`, pas par keepGateGuard en direct (R14, R15).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
  cleanupTempDirs();
});

const GATE_MARK = '# cadence — hook pre-push de la porte (L426)';
const hookFile = (repo: string) => join(repo, '.git/hooks/pre-push');
const lockFile = (repo: string) => join(repo, '.git/cadence/orchestrate.lock');

/** Un projet par nom sous un dossier parent, avec un lot et la config `orchestrate` donnée (precheck coupé). */
function parentWith(projects: Record<string, string>) {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, yaml] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    plan.add('un', '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: false\n${yaml}`);
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

describe('la vague laisse le hook de la porte derrière elle (L426)', () => {
  it('R16 — un dépôt libéré pendant la vague (ses lots finis, les autres projets encore en cours) garde un hook de la porte seule, sans la marque de la vague', async () => {
    const { parent, dirs } = parentWith({ a: '  test: "true"\n', b: '' });
    let seen: { hook: string | null; lock: boolean } | null = null;
    const f = fake({
      implement: async (cwd, brief) => {
        if (cwd === dirs.b) {
          // b attend que a soit libéré (son verrou tombé) pendant que la vague continue ici, puis regarde le hook laissé sur a
          await until(() => !existsSync(lockFile(dirs.a)));
          seen = { hook: existsSync(hookFile(dirs.a)) ? readFileSync(hookFile(dirs.a), 'utf8') : null, lock: existsSync(lockFile(dirs.a)) };
        }
        const lot = /lot `([^`]+)`/.exec(brief)?.[1] ?? 'L1';
        return claudeOut(workReport({ commits: [commitFile(cwd, 'x.txt', `feat(${lot}): x`)] }));
      },
    });
    expect((await run(parent, ['a:L1', 'b:L1', '--max-sessions', '2'], f)).code).toBe(0);
    expect(seen).not.toBeNull();
    expect(seen!.lock).toBe(false);
    expect(seen!.hook).toContain(GATE_MARK);
    expect(seen!.hook).not.toContain('# wave:');
    // à la fin de la vague, le hook de a est encore là (release ne le retire pas), b (sans porte) n'en a aucun
    expect(readFileSync(hookFile(dirs.a), 'utf8')).toContain(GATE_MARK);
    expect(existsSync(hookFile(dirs.b))).toBe(false);
    expect(existsSync(lockFile(dirs.a))).toBe(false);
  });

  it('R17 — à la fin de la vague (dépôt rendu par release), un projet à porte garde le hook de la porte ; un projet sans porte n\'en garde aucun', async () => {
    const { parent, dirs } = parentWith({ a: '  build: "true"\n', b: '' });
    const f = fake();
    expect((await run(parent, ['a:L1', 'b:L1'], f)).code).toBe(0);
    const hook = readFileSync(hookFile(dirs.a), 'utf8');
    expect(hook).toContain(GATE_MARK);
    expect(hook).not.toContain('# wave:');
    expect(hook).not.toContain('CADENCE_ORCHESTRATED');
    expect(existsSync(hookFile(dirs.b))).toBe(false);
    for (const d of [dirs.a, dirs.b]) expect(existsSync(lockFile(d))).toBe(false);
  });

  it('R17 — un démarrage qui échoue après la pose des hooks (registre illisible) rend le dépôt par release : le hook de la porte reste, celui de la vague non', async () => {
    const { parent, dirs } = parentWith({ a: '  test: "true"\n' });
    const home = tempDir();
    writeFileSync(join(home, 'fichier'), 'x'); // CADENCE_HOME sous un fichier : le registre ne peut pas être écrit
    process.env.CADENCE_HOME = join(home, 'fichier', 'home');
    const f = fake();
    await expect(orchestrate(['a:L1'], { cwd: parent, env: { RAF_TODAY: '2026-10-04' }, out: () => {}, err: () => {}, now: () => new Date('2026-10-04T14:12:00') }, { claude: f.claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: join(import.meta.dirname, '..', 'agents') })).rejects.toThrow();
    expect(f.calls).toEqual([]);
    const hook = readFileSync(hookFile(dirs.a), 'utf8');
    expect(hook).toContain(GATE_MARK);
    expect(hook).not.toContain('# wave:');
    expect(existsSync(lockFile(dirs.a))).toBe(false);
  });
});
