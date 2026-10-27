import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig } from '../src/config.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Dépôt dont `.gitignore` écarte node_modules et .venv, avec une dépendance présente dans l'arbre principal seulement. */
function project(yaml: string): { repo: string; sha: string } {
  const repo = gitRepo();
  writeFileSync(join(repo, 'cadence.yaml'), yaml);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.venv/\n');
  writeFileSync(join(repo, 'valeur.txt'), 'v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'x');
  mkdirSync(join(repo, '.venv'));
  return { repo, sha: git(repo, 'rev-parse', 'HEAD').trim() };
}

async function gate(repo: string, sha: string) {
  const lines: string[] = [];
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const leftovers = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

describe('orchestrate.worktreeDeps (L348)', () => {
  it('liste de chemins relatifs, lue dans cadence.yaml', () => {
    const { repo } = project('orchestrate:\n  worktreeDeps: [node_modules, .venv, front/node_modules]\n');
    expect(readOrchestrateConfig(join(repo, 'cadence.yaml')).worktreeDeps).toEqual(['node_modules', '.venv', 'front/node_modules']);
  });

  it.each([['absolu', '[/usr/lib]'], ['qui sort du dépôt', '[../autre]'], ['vide', "['']"], ['pas une liste', 'node_modules']])('refuse un chemin %s', (_, v) => {
    const { repo } = project(`orchestrate:\n  worktreeDeps: ${v}\n`);
    expect(() => readOrchestrateConfig(join(repo, 'cadence.yaml'))).toThrow(/worktreeDeps/);
  });
});

describe('verifyGate : la porte rejouée au sha dans un worktree jetable (L348)', () => {
  it('les dépendances non suivies sont liées depuis l\'arbre principal : vert', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test -f node_modules/dep/index.js && test -d .venv\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain('vert');
  });

  it('worktreeDeps déclarée : seules ces dépendances sont liées', async () => {
    const { repo, sha } = project('orchestrate:\n  worktreeDeps: [node_modules]\n  test: test -f node_modules/dep/index.js && test ! -e .venv\n');
    expect((await gate(repo, sha)).code).toBe(0);
  });

  it('une dépendance déclarée mais absente de l\'arbre principal est dite, sans arrêter la porte', async () => {
    const { repo, sha } = project('orchestrate:\n  worktreeDeps: [node_modules, vendor]\n  test: test -f node_modules/dep/index.js\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain('vendor');
  });

  it('rejoue au sha demandé, pas à la tête ni dans l\'arbre principal', async () => {
    const { repo, sha } = project('orchestrate:\n  test: grep -q v1 valeur.txt\n');
    writeFileSync(join(repo, 'valeur.txt'), 'v2\n');
    git(repo, 'commit', '-q', '-a', '-m', 'v2');
    expect((await gate(repo, sha)).code).toBe(0);
    expect((await gate(repo, git(repo, 'rev-parse', 'HEAD').trim())).code).toBe(1);
  });

  it('rouge : nomme les suites en échec et sort 1', async () => {
    const { repo, sha } = project(`orchestrate:\n  test: "printf ' FAIL  test/a.test.ts > une règle\\\\n FAIL  test/b.test.ts > une autre\\\\n'; exit 1"\n`);
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('rouge');
    expect(r.text).toContain('test/a.test.ts > une règle');
    expect(r.text).toContain('test/b.test.ts > une autre');
  });

  it('rouge sans test identifiable : dit le code de sortie et la fin de la sortie', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "echo boom; exit 3"\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('code 3');
    expect(r.text).toContain('boom');
  });

  it('L387 R1 — rouge sans test nommé : seules les 10 dernières lignes de la sortie sont imprimées, préfixées', async () => {
    const { repo, sha } = project(`orchestrate:\n  test: "seq 1 30; exit 1"\n`);
    const r = await gate(repo, sha);
    expect(r.text).toContain('  | 30');
    expect(r.text).toContain('  | 21');
    expect(r.text).not.toContain('  | 20\n');
    expect(r.text).not.toMatch(/\| 5\b/);
  });

  it('le build passe avant les tests, comme dans la porte de la vague, et les deux sont rejoués même si le premier est rouge', async () => {
    const { repo, sha } = project('orchestrate:\n  build: "touch dist-ok; exit 1"\n  test: test -f dist-ok\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('✗ build');
    expect(r.text).toContain('✓ tests');
  });

  it('retire le worktree, vert ou rouge', async () => {
    const green = project('orchestrate:\n  test: "true"\n');
    await gate(green.repo, green.sha);
    expect(leftovers(green.repo)).toBe(1);
    const red = project('orchestrate:\n  test: "false"\n');
    await gate(red.repo, red.sha);
    expect(leftovers(red.repo)).toBe(1);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('cadence-verify-')).length).toBe(0);
  });

  it('l\'arbre principal de dépendances reste intact après le retrait', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n');
    await gate(repo, sha);
    expect(existsSync(join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(repo, '.venv'))).toBe(true);
  });

  it('ni test ni build déclarés : rien à rejouer, code 2', async () => {
    const { repo, sha } = project('orchestrate:\n  worktrees: true\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(2);
    expect(r.text).toContain('orchestrate.test');
  });

  it('un sha inconnu : code 2, aucun worktree laissé', async () => {
    const { repo } = project('orchestrate:\n  test: "true"\n');
    const r = await gate(repo, 'deadbeef'.repeat(5));
    expect(r.code).toBe(2);
    expect(leftovers(repo)).toBe(1);
  });
});

describe('verifyGate : délai, noms des suites, signal (L348)', () => {
  it('au délai : tout le groupe est tué, code 124 et rouge, worktree retiré', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "sleep 30"\n');
    const lines: string[] = [];
    const t0 = Date.now();
    const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), out: (l) => lines.push(l), timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('code 124');
    expect(lines.join('\n')).toContain('délai dépassé');
    expect(leftovers(repo)).toBe(1);
  });

  it('les suites qui ne se chargent pas sont nommées une à une', async () => {
    const { repo, sha } = project(`orchestrate:\n  test: "printf ' FAIL  test/a.test.ts [ test/a.test.ts ]\\\\n FAIL  test/b.test.ts [ test/b.test.ts ]\\\\n Test Files  2 failed (2)\\\\n'; exit 1"\n`);
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('- test/a.test.ts');
    expect(r.text).toContain('- test/b.test.ts');
    expect(r.text).not.toContain('aucun test');
    expect(r.text).not.toContain('  | ');
  });

  it('une commande qui laisse un processus en arrière-plan : il est tué à la fin de la commande', async () => {
    const pidFile = join(tempDir(), 'bg.pid');
    const { repo, sha } = project(`orchestrate:\n  test: "sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}"\n`);
    const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), out: () => {} });
    expect(code).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('%s reçu par cadence : la commande de la porte meurt et le worktree est retiré', async (sig) => {
    const { repo, sha } = project('orchestrate:\n  test: "echo $$ > pid.txt; exec sleep 30"\n');
    const probe = join(tempDir(), 'probe.ts');
    writeFileSync(
      probe,
      `import { verifyGate } from ${JSON.stringify(join(process.cwd(), 'src/verify-gate.ts'))};\n` +
        `import { readOrchestrateConfig } from ${JSON.stringify(join(process.cwd(), 'src/config.ts'))};\n` +
        `process.exitCode = await verifyGate({ repo: ${JSON.stringify(repo)}, sha: ${JSON.stringify(sha)}, config: readOrchestrateConfig(${JSON.stringify(join(repo, 'cadence.yaml'))}), out: (l) => console.log(l) });\n`,
    );
    const child = spawn(join(process.cwd(), 'node_modules/.bin/vite-node'), [probe], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';
    child.stdout!.on('data', (d: Buffer) => (said += d.toString()));
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, s) => r(s)));
    const wait = async (ok: () => boolean, ms: number) => {
      const t0 = Date.now();
      while (!ok() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
      return ok();
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let cmdPid = 0;
    try {
      const pidFile = () => readdirSync(tmpdir()).map((n) => join(tmpdir(), n, 'pid.txt')).find((f) => f.includes('cadence-verify-') && existsSync(f));
      expect(await wait(() => !!pidFile() && readFileSync(pidFile()!, 'utf8').trim() !== '', 20_000)).toBe(true);
      cmdPid = Number(readFileSync(pidFile()!, 'utf8').trim());
      process.kill(child.pid!, sig);
      expect(await exited).toBe(sig);
      expect(await wait(() => !alive(cmdPid), 3_000)).toBe(true);
      expect(leftovers(repo)).toBe(1);
      expect(said).not.toContain('vert');
    } finally {
      for (const pid of [child.pid!, cmdPid]) {
        try {
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {
          // déjà mort
        }
      }
    }
  }, 40_000);
});

describe('cadence verify --gate (L348)', () => {
  const io = (cwd: string) => {
    const lines: string[] = [];
    return { lines, io: { cwd, env: {}, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date('2026-10-26T12:00:00') } };
  };

  it('--gate --sha rejoue la porte du projet courant', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test -f node_modules/dep/index.js\n');
    const c = io(repo);
    expect(await run(['verify', '--gate', '--sha', sha.slice(0, 7)], c.io)).toBe(0);
    expect(c.lines.join('\n')).toContain('vert');
  });

  it('--gate sans --sha est refusé (la tête mouvante d\'une vague n\'est pas un sha à re-vérifier)', async () => {
    const { repo } = project('orchestrate:\n  test: "true"\n');
    const c = io(repo);
    expect(await run(['verify', '--gate'], c.io)).toBe(2);
    expect(c.lines.join('\n')).toContain('--sha');
  });

  it('--project désigne un projet du dossier courant', async () => {
    const parent = gitRepo();
    const sub = join(parent, 'app');
    mkdirSync(sub);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: sub });
    writeFileSync(join(sub, 'cadence.yaml'), 'orchestrate:\n  test: "false"\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-q', '-m', 'init');
    const c = io(parent);
    expect(await run(['verify', '--gate', '--project', 'app', '--sha', 'HEAD'], c.io)).toBe(1); // la porte du projet app (test: false), pas celle du dossier courant
    expect(c.lines.join('\n')).toContain('rouge');
  });

  it('--project inconnu : code 2 qui nomme le dossier', async () => {
    const parent = gitRepo();
    const c = io(parent);
    expect(await run(['verify', '--gate', '--project', 'absent', '--sha', 'HEAD'], c.io)).toBe(2);
    expect(c.lines.join('\n')).toContain('absent');
  });

  it('--project qui n\'a pas son propre dépôt git (simple sous-dossier) : code 2 qui le dit', async () => {
    const parent = gitRepo();
    mkdirSync(join(parent, 'app'));
    const c = io(parent);
    expect(await run(['verify', '--gate', '--project', 'app', '--sha', 'HEAD'], c.io)).toBe(2);
    expect(c.lines.join('\n')).toContain('propre dépôt git');
  });

  it('--gate refuse --retry (il ne vaut que pour deliver.verify)', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n');
    const c = io(repo);
    expect(await run(['verify', '--gate', '--sha', sha, '--retry', '5'], c.io)).toBe(2);
  });
});

/** Porte `sh gate.sh` : la suite entière rouge sur deux tests, un rejeu (`sh gate.sh <fichiers>`) vert ou rouge selon `alone`. */
function replayProject(alone: 'vert' | 'rouge', extra = ''): { repo: string; sha: string } {
  const { repo } = project(`orchestrate:\n  test: sh gate.sh\n  testReplay: sh gate.sh {files}\n${extra}`);
  const lines = alone === 'vert'
    ? 'echo " ✓ $*"; exit 0'
    : 'echo " FAIL  test/a.test.ts > charge"; exit 1';
  writeFileSync(join(repo, 'gate.sh'), `if [ -n "$1" ]; then ${lines}; fi\necho " FAIL  test/a.test.ts > charge"\necho " FAIL  test/b.test.ts > autre"\nexit 1\n`);
  git(repo, 'add', 'gate.sh');
  git(repo, 'commit', '-q', '-m', 'gate');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD').trim() };
}

describe('verify --gate applique orchestrate.testReplay comme la porte des vagues (L387)', () => {
  it('R2 — rouge sous charge, vert rejoué seul : la porte est verte et nomme les tests instables', async () => {
    const { repo, sha } = replayProject('vert');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain('instable');
    expect(r.text).toContain('test/a.test.ts > charge');
    expect(r.text).toContain('test/b.test.ts > autre');
    expect(r.text).toContain('vert');
  });

  it('R2 — rouge aussi rejoué seul : la porte reste rouge et ne nomme que ce qui reste rouge', async () => {
    const { repo, sha } = replayProject('rouge');
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toContain('  - test/a.test.ts > charge');
    expect(r.text).not.toContain('instable');
  });

  it('R2 — sans orchestrate.testReplay rien n\'est rejoué : le rouge est compté tel quel', async () => {
    const { repo } = project('orchestrate:\n  test: sh gate.sh\n');
    writeFileSync(join(repo, 'gate.sh'), 'if [ -n "$1" ]; then exit 0; fi\necho " FAIL  test/a.test.ts > charge"\nexit 1\n');
    git(repo, 'add', 'gate.sh');
    git(repo, 'commit', '-q', '-m', 'gate');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD').trim());
    expect(r.code).toBe(1);
    expect(r.text).not.toContain('instable');
  });

  it('R2 — un échec que la sortie ne rattache à aucun test n\'est pas rejoué : rouge', async () => {
    const { repo } = project('orchestrate:\n  test: sh gate.sh\n  testReplay: sh gate.sh {files}\n');
    writeFileSync(join(repo, 'gate.sh'), 'if [ -n "$1" ]; then echo " ✓ $*"; exit 0; fi\necho " FAIL  test/a.test.ts > charge"\necho "Unhandled Errors"\nexit 1\n');
    git(repo, 'add', 'gate.sh');
    git(repo, 'commit', '-q', '-m', 'gate');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD').trim());
    expect(r.code).toBe(1);
    expect(r.text).not.toContain('instable');
  });

  it('R2 — le rejeu qui n\'a exécuté aucun test ne prouve rien : le test reste rouge', async () => {
    const { repo } = project('orchestrate:\n  test: sh gate.sh\n  testReplay: sh gate.sh {files}\n');
    writeFileSync(join(repo, 'gate.sh'), 'if [ -n "$1" ]; then echo "No test files found, exiting with code 0"; exit 0; fi\necho " FAIL  test/a.test.ts > charge"\nexit 1\n');
    git(repo, 'add', 'gate.sh');
    git(repo, 'commit', '-q', '-m', 'gate');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD').trim());
    expect(r.code).toBe(1);
    expect(r.text).toContain('  - test/a.test.ts > charge');
  });
});
