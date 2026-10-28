import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig, readVerifyConfig } from '../src/config.js';
import { copyDeps } from '../src/orchestrate/worktree.js';
import { verifyGate } from '../src/verify-gate.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Dépôt dont `.gitignore` écarte node_modules et .venv, avec une dépendance présente dans l'arbre principal seulement. */
function project(yaml: string, inPlace = false): { repo: string; sha: string } {
  const repo = gitRepo();
  // Les tests de la copie jetable (L348) forcent `verify.inPlace: false` : l'arbre est propre au sha, la porte jouerait sinon dans l'arbre principal (L389).
  writeFileSync(join(repo, 'cadence.yaml'), inPlace ? yaml : `${yaml}verify:\n  inPlace: false\n`);
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
  const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), verify: readVerifyConfig(join(repo, 'cadence.yaml')), out: (l) => lines.push(l) });
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
  it('les dépendances non suivies sont copiées depuis l\'arbre principal : vert', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test -f node_modules/dep/index.js && test -d .venv\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).toContain('vert');
  });

  it('worktreeDeps déclarée : seules ces dépendances sont copiées', async () => {
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
    const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), verify: readVerifyConfig(join(repo, 'cadence.yaml')), out: (l) => lines.push(l), timeoutMs: 300 });
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
    const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), verify: readVerifyConfig(join(repo, 'cadence.yaml')), out: () => {} });
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

  it.each([['SIGINT', false], ['SIGTERM', false], ['SIGINT', true]] as const)('%s reçu par cadence (en place : %s) : la commande de la porte meurt et le worktree est retiré', async (sig, inPlace) => {
    const { repo, sha } = project('orchestrate:\n  test: "echo $$ > pid.txt; exec sleep 30"\n', inPlace);
    const probe = join(tempDir(), 'probe.ts');
    writeFileSync(
      probe,
      `import { verifyGate } from ${JSON.stringify(join(process.cwd(), 'src/verify-gate.ts'))};\n` +
        `import { readOrchestrateConfig, readVerifyConfig } from ${JSON.stringify(join(process.cwd(), 'src/config.ts'))};\n` +
        `process.exitCode = await verifyGate({ repo: ${JSON.stringify(repo)}, sha: ${JSON.stringify(sha)}, config: readOrchestrateConfig(${JSON.stringify(join(repo, 'cadence.yaml'))}), verify: readVerifyConfig(${JSON.stringify(join(repo, 'cadence.yaml'))}), out: (l) => console.log(l) });\n`,
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
      const pidFile = () => (inPlace ? [join(repo, 'pid.txt')] : readdirSync(tmpdir()).map((n) => join(tmpdir(), n, 'pid.txt')).filter((f) => f.includes('cadence-verify-'))).find((f) => existsSync(f));
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

  // Revue de L387 : le rejeu écrit `--maxWorkers=$CADENCE_TEST_WORKERS` (cadence.yaml, docs/orchestrate.md) ; variable absente, vitest sort en erreur et rien n'est tenu pour vert.
  const workersProject = () => {
    const { repo } = project('orchestrate:\n  test: sh gate.sh\n  testReplay: sh gate.sh {files}\n');
    writeFileSync(
      join(repo, 'gate.sh'),
      'if [ -n "$1" ]; then\n  [ -n "$CADENCE_TEST_WORKERS" ] || { echo "--maxWorkers= vide"; exit 2; }\n  echo " ✓ $* (workers=$CADENCE_TEST_WORKERS)"; exit 0\nfi\n' +
        'echo "suite workers=$CADENCE_TEST_WORKERS"\necho " FAIL  test/a.test.ts > charge"\nexit 1\n',
    );
    git(repo, 'add', 'gate.sh');
    git(repo, 'commit', '-q', '-m', 'gate');
    return { repo, sha: git(repo, 'rev-parse', 'HEAD').trim() };
  };
  const gateIn = async (repo: string, sha: string, env: Record<string, string | undefined>, cores = 16) => {
    const lines: string[] = [];
    const code = await verifyGate({ repo, sha, config: readOrchestrateConfig(join(repo, 'cadence.yaml')), verify: readVerifyConfig(join(repo, 'cadence.yaml')), out: (l) => lines.push(l), env: { PATH: process.env.PATH, ...env }, cores });
    return { code, text: lines.join('\n') };
  };

  it('R2 — CADENCE_TEST_WORKERS absent de l\'environnement : la porte et le rejeu la reçoivent (cœurs ÷ plafond de sessions, comme une vague)', async () => {
    const { repo, sha } = workersProject();
    const r = await gateIn(repo, sha, {}, 16); // plafond par défaut 2 : 8
    expect(r.code).toBe(0);
    expect(r.text).toContain('instable');
  });

  it('R2 — la part suit CADENCE_MAX_SESSIONS quand le plafond est réglé', async () => {
    const probe = project('orchestrate:\n  test: "echo w=$CADENCE_TEST_WORKERS; exit 1"\n');
    const red = await gateIn(probe.repo, probe.sha, { CADENCE_MAX_SESSIONS: '4' }, 32);
    expect(red.text).toContain('| w=8');
  });

  it('R2 — une valeur CADENCE_TEST_WORKERS déjà posée par l\'humain n\'est pas écrasée', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "echo w=$CADENCE_TEST_WORKERS; exit 1"\n');
    const r = await gateIn(repo, sha, { CADENCE_TEST_WORKERS: '3' }, 32);
    expect(r.text).toContain('| w=3');
  });

  it('R2 — un rejeu qui ne confirme rien le dit : un rejeu a eu lieu, son code, et ce qu\'il n\'a pas prouvé', async () => {
    const { repo, sha } = replayProject('rouge');
    const r = await gate(repo, sha);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/rejeu seul.*2 rejeu/);
    expect(r.text).toMatch(/dernier code 1/);
    expect(r.text).toContain('0 test(s) confirmé(s) vert(s) sur 2');
  });
});

describe('verifyGate : où la porte tourne (L389)', () => {
  const here = (r: { text: string }) => r.text.split('\n')[0];

  it('L389 R1 — arbre principal propre et au sha : la porte y est jouée, sans worktree, et la sortie le dit', async () => {
    const { repo, sha } = project(`orchestrate:\n  test: test -f node_modules/dep/index.js && test ! -L node_modules/dep\n`, true);
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(here(r)).toMatch(/arbre principal/);
    expect(here(r)).toContain(repo);
    expect(r.text).not.toMatch(/copie jetable/);
  });

  it('L389 R2 — en place, la commande tourne dans la racine du dépôt', async () => {
    const out = join(tempDir(), 'cwd.txt');
    const { repo, sha } = project(`orchestrate:\n  test: pwd > ${out}\n`, true);
    await gate(repo, sha);
    expect(readFileSync(out, 'utf8').trim()).toBe(execFileSync('pwd', { cwd: repo, encoding: 'utf8' }).trim());
    expect(existsSync(join(repo, 'valeur.txt'))).toBe(true);
  });

  it('L389 R3 — arbre principal modifié : copie jetable, node_modules copié (pas un lien) et la sortie le dit', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test -f node_modules/dep/index.js && test ! -L node_modules/dep && test ! -L node_modules\n', true);
    writeFileSync(join(repo, 'valeur.txt'), 'modifié\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(here(r)).toMatch(/copie jetable/);
    expect(here(r)).toMatch(/modifications/);
    expect(here(r)).toContain('node_modules');
  });

  it('L389 R3 — un lien relatif de node_modules (espace de travail) reste relatif dans la copie : la commande lit le paquet du sha, pas celui de l\'arbre principal', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test "$(readlink node_modules/p)" = ../packages/p && grep -q v1 node_modules/p/index.js\n', true);
    mkdirSync(join(repo, 'packages', 'p'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'p', 'index.js'), 'v1\n');
    git(repo, 'add', 'packages');
    git(repo, 'commit', '-q', '-m', 'paquet');
    execFileSync('ln', ['-s', '../packages/p', join(repo, 'node_modules', 'p')]);
    const au = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'packages', 'p', 'index.js'), 'modifié\n');
    const r = await gate(repo, au);
    expect(sha).not.toBe(au);
    expect(here(r)).toMatch(/copie jetable/);
    expect(r.code).toBe(0);
  });

  it('L389 R3 — un lien de node_modules qui sort du dépôt (file:../voisin) reste résolvable dans la copie : il pointe le voisin vivant', async () => {
    const { repo, sha } = project('orchestrate:\n  test: grep -q voisin node_modules/x/i.js\n');
    const voisin = join(repo, '..', `voisin-${process.pid}`);
    mkdirSync(voisin, { recursive: true });
    writeFileSync(join(voisin, 'i.js'), 'voisin\n');
    execFileSync('ln', ['-s', `../../voisin-${process.pid}`, join(repo, 'node_modules', 'x')]);
    // La copie jetable est posée ailleurs que le dépôt : un lien relatif recopié tel quel ne retrouverait pas le voisin.
    const ailleurs = tempDir();
    const avant = process.env.TMPDIR;
    process.env.TMPDIR = ailleurs;
    try {
      const r = await gate(repo, sha);
      expect(here(r)).toMatch(/copie jetable/);
      expect(r.code).toBe(0);
    } finally {
      if (avant === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = avant;
      execFileSync('rm', ['-rf', voisin]);
    }
  });

  it('L389 R3 — arbre principal propre mais à un autre sha : copie jetable, au sha demandé', async () => {
    const { repo, sha } = project('orchestrate:\n  test: grep -q v1 valeur.txt\n', true);
    writeFileSync(join(repo, 'valeur.txt'), 'v2\n');
    git(repo, 'commit', '-q', '-a', '-m', 'v2');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(here(r)).toMatch(/copie jetable/);
    expect(here(r)).toMatch(/sha/);
  });

  it('L389 R3 — un fichier non suivi (hors ignorés) rend l\'arbre non propre', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n', true);
    writeFileSync(join(repo, 'nouveau.txt'), 'x');
    expect(here(await gate(repo, sha))).toMatch(/copie jetable/);
  });

  it('L389 R4 — verify.inPlace: false : copie jetable même si l\'arbre est propre au sha', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n');
    expect(here(await gate(repo, sha))).toMatch(/copie jetable/);
  });

  it('L389 R4 — verify.inPlace: true : arbre non propre → refus, code 2, rien n\'est joué', async () => {
    const mark = join(tempDir(), 'ran');
    const { repo, sha } = project(`orchestrate:\n  test: touch ${mark}\nverify:\n  inPlace: true\n`, true);
    writeFileSync(join(repo, 'valeur.txt'), 'modifié\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(2);
    expect(r.text).toContain('verify.inPlace');
    expect(existsSync(mark)).toBe(false);
  });

  it('L389 R4 — verify.inPlace: true : arbre propre au sha → joué en place', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\nverify:\n  inPlace: true\n', true);
    expect(here(await gate(repo, sha))).toMatch(/arbre principal/);
  });

  it('L389 R4 — verify.inPlace doit être un booléen', () => {
    const { repo } = project('verify:\n  inPlace: parfois\n', true);
    expect(() => readVerifyConfig(join(repo, 'cadence.yaml'))).toThrow(/verify\.inPlace/);
  });

  it('L392 R1 — sans worktreeDeps, seuls node_modules et .venv sont copiés : les autres dossiers ignorés (données, .env) restent des liens, rien n\'est dupliqué', async () => {
    const { repo } = project('orchestrate:\n  test: test ! -L .venv && test -f .venv/pyvenv.cfg && test -L donnees && test -L .env && test ! -L node_modules && test -f donnees/secret.txt\n', true);
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.venv/\ndonnees/\n.env\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore donnees');
    writeFileSync(join(repo, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    mkdirSync(join(repo, 'donnees'));
    writeFileSync(join(repo, 'donnees', 'secret.txt'), 'x');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    writeFileSync(join(repo, 'valeur.txt'), 'sale\n');
    const r = await gate(repo, git(repo, 'rev-parse', 'HEAD').trim());
    expect(here(r)).toMatch(/copie jetable/);
    expect(here(r)).toMatch(/dépendances copiées : \.venv, node_modules$/);
    expect(r.code).toBe(0);
  });

  it('L392 R2 — la copie ne bloque pas la boucle d\'événements (condition pour que Ctrl-C soit traité pendant la copie)', async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    const live = join(repo, 'node_modules');
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(live, `p${d}`), { recursive: true });
      for (let f = 0; f < 100; f++) writeFileSync(join(live, `p${d}`, `f${f}.js`), 'x');
    }
    const dir = tempDir();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      expect(await copyDeps(repo, dir, ['node_modules'])).toEqual(['node_modules']);
    } finally {
      clearInterval(timer);
    }
    expect(existsSync(join(dir, 'node_modules', 'p19', 'f99.js'))).toBe(true);
    expect(ticks).toBeGreaterThan(0);
  });

  it('L392 R3 — node_modules lui-même un lien : son contenu est copié (un vrai dossier), la sortie ne dit « copié » que si c\'est vrai', async () => {
    const { repo, sha } = project('orchestrate:\n  test: test ! -L node_modules && test -f node_modules/dep/index.js\n');
    const ailleurs = tempDir();
    mkdirSync(join(ailleurs, 'dep'));
    writeFileSync(join(ailleurs, 'dep', 'index.js'), 'x');
    execFileSync('rm', ['-rf', join(repo, 'node_modules')]);
    execFileSync('ln', ['-s', ailleurs, join(repo, 'node_modules')]);
    // `node_modules/` (avec barre) n'ignore pas un lien : le motif sans barre est celui d'un projet réel.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.venv/\n');
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(here(r)).toMatch(/dépendances copiées : .*node_modules/);
  });

  it('L392 R4 — un lien relatif sortant du dépôt depuis un node_modules de sous-dossier (front/node_modules/x -> ../../../voisin) pointe le voisin vivant dans la copie', async () => {
    const { repo, sha } = project('orchestrate:\n  test: grep -q voisin front/node_modules/x/i.js\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.venv/\n');
    mkdirSync(join(repo, 'front'));
    writeFileSync(join(repo, 'front', 'package.json'), '{}');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'front');
    const au = git(repo, 'rev-parse', 'HEAD').trim();
    const voisin = join(repo, '..', `voisin-front-${process.pid}`);
    mkdirSync(voisin, { recursive: true });
    writeFileSync(join(voisin, 'i.js'), 'voisin\n');
    mkdirSync(join(repo, 'front', 'node_modules'));
    execFileSync('ln', ['-s', `../../../voisin-front-${process.pid}`, join(repo, 'front', 'node_modules', 'x')]);
    const avant = process.env.TMPDIR;
    process.env.TMPDIR = tempDir();
    try {
      const r = await gate(repo, au);
      expect(sha).not.toBe(au);
      expect(here(r)).toMatch(/dépendances copiées : .*front\/node_modules/);
      expect(r.code).toBe(0);
    } finally {
      if (avant === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = avant;
      execFileSync('rm', ['-rf', voisin]);
    }
  });

  it('L392 R5 — la ligne « où la porte a tourné » est la première, avant l\'avis des dépendances déclarées absentes', async () => {
    const { repo, sha } = project('orchestrate:\n  worktreeDeps: [node_modules, vendor]\n  test: "true"\n');
    const r = await gate(repo, sha);
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/copie jetable/);
    expect(lines[0]).toMatch(/dépendances copiées : node_modules$/);
    expect(lines.findIndex((l) => l.includes('absentes'))).toBeGreaterThan(0);
  });

  it('L392 — worktreeDeps: [node_modules] alors que node_modules est un lien mort : rien n\'est copié, l\'avis « déclarées absentes » le dit', async () => {
    const { repo, sha } = project('orchestrate:\n  worktreeDeps: [node_modules]\n  test: "true"\n');
    execFileSync('rm', ['-rf', join(repo, 'node_modules')]);
    symlinkSync(join(repo, 'nulle-part'), join(repo, 'node_modules'));
    const r = await gate(repo, sha);
    expect(r.text.split('\n')[0]).toMatch(/dépendances copiées : aucune$/);
    expect(r.text).toMatch(/absentes de l'arbre principal, non copiées : node_modules/);
  });

  it('L389 R6 — l\'arbre principal bouge pendant la porte en place (HEAD avancé par une intégration) : le verdict est dit non probant, code 2', async () => {
    const { repo, sha } = project('orchestrate:\n  test: git commit -q --allow-empty -m integre\n', true);
    const r = await gate(repo, sha);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/non probant/);
  });

  it('L393 R1 — HEAD avancé pendant la porte : la sortie dit que le verdict n\'est pas celui du sha et nomme le nouveau HEAD', async () => {
    const { repo, sha } = project('orchestrate:\n  test: git commit -q --allow-empty -m plan\n', true);
    const r = await gate(repo, sha);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(r.code).toBe(2);
    expect(r.text).toContain(`verdict non probant`);
    expect(r.text).toContain(`HEAD est passé de ${sha.slice(0, 7)} à ${head.slice(0, 7)}`);
    expect(r.text).toMatch(/ne sont pas ceux de/);
    expect(r.text).not.toMatch(/: vert\s*$/m);
  });

  it('L393 R2 — git status devenu sale pendant la porte (fichier non suivi écrit par une commande), HEAD inchangé : non probant, code 2, le dit', async () => {
    const { repo, sha } = project('orchestrate:\n  test: echo x > ecrit-par-la-porte.txt\n', true);
    const r = await gate(repo, sha);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/verdict non probant/);
    expect(r.text).toMatch(/git status n'est plus vide/);
    expect(r.text).not.toMatch(/HEAD est passé/);
  });

  it('L393 R3 — un rouge dont l\'arbre a bougé est aussi non probant (code 2, pas 1) : on ne présente pas un rouge d\'un mélange de commits comme celui du sha', async () => {
    const { repo, sha } = project('orchestrate:\n  test: git commit -q --allow-empty -m plan; exit 1\n', true);
    const r = await gate(repo, sha);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/verdict non probant/);
    expect(r.text).not.toMatch(/: rouge \(/);
  });

  it('L389 R6 — l\'arbre principal ne bouge pas pendant la porte en place : le verdict reste probant', async () => {
    const { repo, sha } = project('orchestrate:\n  test: "true"\n', true);
    const r = await gate(repo, sha);
    expect(r.code).toBe(0);
    expect(r.text).not.toMatch(/non probant/);
  });

  it('L389 R5 — la copie ne touche pas aux dépendances de l\'arbre principal', async () => {
    const { repo, sha } = project('orchestrate:\n  test: rm -rf node_modules/dep\n');
    await gate(repo, sha);
    expect(existsSync(join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });
});

describe('aide de cadence verify --gate (L397)', () => {
  it('L397 — l\'aide dit que la porte enregistrée par la vague est reprise (même sha, arbre identique), rejouée sinon', async () => {
    const lines: string[] = [];
    const io = { cwd: tempDir(), env: {}, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date() };
    expect(await run(['help'], io)).toBe(0);
    const aide = lines.join('\n').split('\n').find((l) => /^\s*cadence verify --gate/.test(l));
    expect(aide, 'ligne d\'aide de verify --gate').toMatch(/reprend|repris/);
    expect(aide).toContain('arbre identique');
    expect(aide).toContain('verdict rejoué');
  });
});
