import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { parseDeliverConfig, TIMED_OUT, type CheckDeps } from '../src/deliver.js';
import { sharedStateDir, appendDelivery } from '../src/state.js';
import { realCheckDeps, replayChecks, resultLine, summaryLine, verifyCommand } from '../src/verify.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Dépendances d'une vérification : ni gh ni CI (le type CheckDeps n'en a pas). */
function fakeDeps(over: Partial<CheckDeps> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const fetched: { url: string; timeoutMs?: number }[] = [];
  const execs: { cmd: string; env: Record<string, string>; timeoutMs: number }[] = [];
  const deps: CheckDeps = {
    exec: (cmd, env, timeoutMs) => {
      execs.push({ cmd, env, timeoutMs });
      return 0;
    },
    fetch: async (url, timeoutMs) => {
      fetched.push({ url, timeoutMs });
      return { status: 200, text: 'ok "starters"' };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...over,
  };
  return { deps, sleeps, fetched, execs };
}

const config = (verify: string) => parseDeliverConfig(`deliver:\n  verify:\n${verify}`, 'cadence.yaml');
const TWO = config(`    - url: https://app.example/api/health
    - url: https://app.example/api/lineup
      contains: '"starters"'
`);

describe('replayChecks (une seule passe)', () => {
  it('une ligne par vérification, tout vert', async () => {
    const { deps, sleeps } = fakeDeps();
    const r = await replayChecks(TWO.verify, deps, 'abcdef1234', {}, { retryMs: 0, attemptMs: 60_000 });
    expect(r.map((x) => x.reason)).toEqual([null, null]);
    expect(r[1]!.label).toContain('contient « "starters" »');
    expect(sleeps).toEqual([]);
    expect(summaryLine(r)).toBe('verify : 2/2 vérifications vertes');
  });

  it("n'attend ni ne réessaie : un effet rouge reste rouge après un seul essai", async () => {
    let calls = 0;
    const { deps, sleeps } = fakeDeps({
      fetch: async () => {
        calls++;
        return { status: 200, text: 'vide' };
      },
    });
    const r = await replayChecks(TWO.verify, deps, 'abc', {}, { retryMs: 0, attemptMs: 60_000 });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([]);
    expect(r[0]!.reason).toBeNull();
    expect(r[1]!.reason).toContain('absent de la réponse');
    expect(summaryLine(r)).toBe('verify : 1 effet rouge sur 2 vérifications');
  });

  it('--retry : réessaie jusqu\'au délai demandé puis rend le dernier constat', async () => {
    let n = 0;
    const { deps } = fakeDeps({ fetch: async () => ({ status: ++n < 3 ? 503 : 200, text: '' }) });
    const r = await replayChecks([{ url: 'https://x/y' }], deps, 'abc', {}, { retryMs: 60_000, attemptMs: 60_000 });
    expect(r[0]!.reason).toBeNull();
    expect(n).toBe(3);
    const never = fakeDeps({ fetch: async () => ({ status: 503, text: '' }) });
    const r2 = await replayChecks([{ url: 'https://x/y' }], never.deps, 'abc', {}, { retryMs: 25_000, attemptMs: 60_000 });
    expect(r2[0]!.reason).toContain('statut 503');
    expect(never.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(25_000);
  });

  it('substitue ${SHORT}, passe les variables aux commandes, signale un délai dépassé', async () => {
    const { deps, fetched, execs } = fakeDeps({ exec: () => TIMED_OUT });
    const r = await replayChecks(
      [{ url: 'https://x/v/${SHORT}' }, { command: 'kubectl get pods' }],
      deps,
      'abcdef1234567',
      { CADENCE_SHORT: 'abcdef1' },
      { retryMs: 0, attemptMs: 5_000 },
    );
    expect(fetched[0]!.url).toBe('https://x/v/abcdef1');
    expect(r[1]!.reason).toBe('délai dépassé');
    expect(execs).toEqual([]);
  });

  it('borne chaque vérification par le budget (réseau absent : pas d\'attente de 20 s)', async () => {
    const { deps, fetched } = fakeDeps();
    await replayChecks([{ url: 'https://x' }], deps, 'abc', {}, { retryMs: 0, attemptMs: 8_000 });
    expect(fetched[0]!.timeoutMs).toBeLessThanOrEqual(8_000);
  });
});

describe('vérifications en parallèle, chacune avec le budget entier', () => {
  const cmds = (...c: string[]) => c.map((command) => ({ command }));
  /** exec qui ne rend la main qu'une fois toutes les commandes lancées (ou après 500 ms) : prouve qu'elles tournent ensemble. */
  const together = (n: number, codes: Record<string, number> = {}) => {
    const started: string[] = [];
    let atRelease = -1;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r)).then(() => {
      atRelease = started.length;
    });
    setTimeout(release, 500);
    const fake = fakeDeps({
      exec: async (cmd) => {
        started.push(cmd);
        if (started.length === n) release();
        await all;
        return codes[cmd] ?? 0;
      },
    });
    return { ...fake, startedAtRelease: () => atRelease };
  };

  it('toutes lancées avant que la première ne finisse ; résultats dans l\'ordre de cadence.yaml', async () => {
    const { deps, startedAtRelease } = together(3, { b: 1 });
    const r = await replayChecks(cmds('a', 'b', 'c'), deps, 'abc', {}, { retryMs: 0, attemptMs: 10_000 });
    expect(startedAtRelease()).toBe(3);
    expect(r.map((x) => [x.label, x.reason])).toEqual([['a', null], ['b', 'code 1'], ['c', null]]);
  });

  it('ordre stable même quand elles finissent à rebours', async () => {
    const { deps } = fakeDeps({ exec: async (cmd) => (await new Promise((r) => setTimeout(r, cmd === 'a' ? 60 : cmd === 'b' ? 30 : 0)), 0) });
    const r = await replayChecks(cmds('a', 'b', 'c'), deps, 'abc', {}, { retryMs: 0, attemptMs: 10_000 });
    expect(r.map((x) => x.label)).toEqual(['a', 'b', 'c']);
  });

  it('chaque essai reçoit le budget entier, pas une part (ol-companion : 7 vérifications, plus de 1,43 s)', async () => {
    const seven = config(Array.from({ length: 7 }, (_, i) => `    - command: check-${i}\n`).join(''));
    const { deps, execs } = fakeDeps();
    const { effectLines, MORNING_BUDGET_MS } = await import('../src/verify.js');
    await effectLines(seven, 'abc', deps);
    expect(execs.map((e) => e.timeoutMs)).toEqual(Array(7).fill(MORNING_BUDGET_MS));
    const urls = fakeDeps();
    await effectLines(TWO, 'abc', urls.deps);
    expect(urls.fetched.map((f) => f.timeoutMs)).toEqual([MORNING_BUDGET_MS, MORNING_BUDGET_MS]);
  });

  it("une vérification lente (tuée au délai) ne rougit pas les autres, et ne les retarde pas", async () => {
    const { deps } = fakeDeps({ exec: async (cmd, _env, timeoutMs) => (cmd === 'lente' ? TIMED_OUT : (expect(timeoutMs).toBe(10_000), 0)) });
    const r = await replayChecks(cmds('lente', 'verify-rollout.sh', 'ok'), deps, 'abc', {}, { retryMs: 0, attemptMs: 10_000 });
    expect(r.map((x) => x.reason)).toEqual(['délai dépassé', null, null]);
    expect(resultLine(r[0]!)).toBe('✗ lente — délai dépassé');
  });

  it('--retry : chaque vérification réessaie de son côté, sans priver les autres de leur essai', async () => {
    const ran: string[] = [];
    let clock = 0;
    const { deps } = fakeDeps({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      exec: (cmd) => (ran.push(cmd), cmd === 'red' ? 1 : 0),
    });
    const r = await replayChecks(cmds('red', 'ok'), deps, 'abc', {}, { retryMs: 30_000, attemptMs: 120_000 });
    expect(r.map((x) => x.reason)).toEqual(['code 1', null]);
    expect(ran.filter((c) => c === 'ok')).toHaveLength(1);
    expect(ran.filter((c) => c === 'red').length).toBeGreaterThan(1);
  });

  it('cadence verify : 120 s par essai, pas de code 3 ni de « non vérifiée »', async () => {
    const budgets: number[] = [];
    const { deps } = fakeDeps({ exec: (cmd, _e, timeoutMs) => (budgets.push(timeoutMs), cmd === 'red' ? 1 : 0) });
    const out: string[] = [];
    const cfg = config('    - command: ok\n    - command: red\n    - command: ok2\n');
    expect(await verifyCommand({ config: cfg, sha: 'abc', retry: 0, out: (l) => out.push(l) }, deps)).toBe(1);
    expect(budgets).toEqual([120_000, 120_000, 120_000]);
    expect(out).toEqual(['✓ ok', '✗ red — code 1', '✓ ok2', 'verify : 1 effet rouge sur 3 vérifications']);
    expect(out.join('\n')).not.toMatch(/non vérifiée|\?/);
  });

  it('pour de vrai : trois « sleep 2 » en session start prennent ~2 s, pas 6', async () => {
    const { effectLines } = await import('../src/verify.js');
    const t = Date.now();
    const lines = await effectLines(config('    - command: sleep 2\n    - command: sleep 2\n    - command: sleep 2\n'), 'abc', realCheckDeps(tempDir(), { quiet: true }));
    expect(lines).toEqual(['✓ verify : 3/3 vérifications vertes']);
    expect(Date.now() - t).toBeLessThan(4_500);
  });
});

describe('verifyCommand', () => {
  const ctx = (cfg = TWO, over = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return { c: { root: '/nowhere', sha: 'abcdef1234', config: cfg, retry: 0, out: (l: string) => out.push(l), err: (l: string) => err.push(l), ...over }, out, err };
  };

  it('0 : une ligne ✓ par vérification puis le résumé', async () => {
    const { c, out } = ctx();
    expect(await verifyCommand(c, fakeDeps().deps)).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^✓ GET https:\/\/app.example\/api\/health/);
    expect(out[2]).toBe('verify : 2/2 vérifications vertes');
  });

  it('1 : un effet rouge, avec sa cause', async () => {
    const { c, out } = ctx();
    const deps = fakeDeps({ fetch: async (u) => ({ status: 200, text: u.endsWith('lineup') ? '[]' : 'ok' }) }).deps;
    expect(await verifyCommand(c, deps)).toBe(1);
    expect(out[1]).toMatch(/^✗ .*lineup.* — « "starters" » absent de la réponse/);
    expect(out[2]).toContain('1 effet rouge sur 2');
  });

  it('2 : projet à script de livraison sans verify — dit proprement, sans erreur', async () => {
    const cfg = parseDeliverConfig('deliver:\n  script: ./scripts/livrer.sh\n', 'cadence.yaml');
    const { c, out, err } = ctx(cfg);
    expect(await verifyCommand(c, fakeDeps().deps)).toBe(2);
    expect(out.join('\n')).toContain('deliver.script');
    expect(out.join('\n')).toContain('aucune vérification');
    expect(err).toEqual([]);
  });
});

describe('cadence verify (CLI)', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  async function cad(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T08:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  async function serve(body: string): Promise<string> {
    server = createServer((req, res) => {
      res.statusCode = req.url === '/api/health' ? 200 : 200;
      res.end(req.url === '/api/lineup' ? body : 'ok');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  }
  const repo = (yaml: string) => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: config');
    return dir;
  };

  it('sans cadence.yaml : 2', async () => {
    const r = await cad(gitRepo(), 'verify');
    expect(r.code).toBe(2);
    expect(r.err).toContain('cadence.yaml');
  });

  it('cadence.yaml invalide : 2', async () => {
    const r = await cad(repo('deliver:\n  verify:\n    - { url: x, command: y }\n'), 'verify');
    expect(r.code).toBe(2);
    expect(r.err).toContain('verify[1]');
  });

  it('rejoue sans CI ni déploiement : vert 0, rouge 1 (cas ol-companion : /api/health vert, effectif vide)', async () => {
    const base = await serve('{"starters":[1]}');
    const yaml = (b: string) => `deliver:\n  ci: github\n  deploy:\n    - exit 9\n  verify:\n    - url: ${b}/api/health\n    - url: ${b}/api/lineup\n      contains: '"starters"'\n    - command: test -n "$CADENCE_SHORT"\n`;
    const dir = repo(yaml(base));
    const green = await cad(dir, 'verify');
    expect(green.code).toBe(0);
    expect(green.out).toContain('verify : 3/3 vérifications vertes');
    server!.close();
    const empty = await serve('[]');
    const red = await cad(repo(yaml(empty)), 'verify');
    expect(red.code).toBe(1);
    expect(red.out).toContain('✗');
    expect(red.out).toContain('verify : 1 effet rouge sur 3');
  });

  it('${SHORT} : la dernière livraison, à défaut la tête', async () => {
    const dir = repo('deliver:\n  verify:\n    - command: test "$CADENCE_SHORT" = "$WANT"\n');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    process.env.WANT = head.slice(0, 7);
    expect((await cad(dir, 'verify')).code).toBe(0);
    commit(dir, 'chore: autre');
    expect((await cad(dir, 'verify')).code).toBe(1);
    appendDelivery(sharedStateDir(dir), '2026-10-04', head);
    expect((await cad(dir, 'verify')).code).toBe(0);
    delete process.env.WANT;
  });

  it('--retry invalide : 2 ; script de projet sans verify : 2', async () => {
    const dir = repo('deliver:\n  verify:\n    - command: "true"\n');
    expect((await cad(dir, 'verify', '--retry', 'abc')).code).toBe(2);
    const r = await cad(repo('deliver:\n  script: ./livrer.sh\n'), 'verify');
    expect(r.code).toBe(2);
    expect(r.err).toBe('');
  });
});

describe('effets du matin (session start)', () => {
  it('vert : une ligne ; rouge : les effets rouges puis le résumé ; borné à 10 s', async () => {
    const { effectLines } = await import('../src/verify.js');
    const ok = fakeDeps();
    expect(await effectLines(TWO, 'abcdef1234', ok.deps)).toEqual(['✓ verify : 2/2 vérifications vertes']);
    const red = fakeDeps({ fetch: async (u) => ({ status: u.endsWith('lineup') ? 200 : 500, text: '' }) });
    const lines = await effectLines(TWO, 'abcdef1234', red.deps);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^✗ GET .*health.*statut 500/);
    expect(lines[1]).toMatch(/^✗ GET .*lineup.*absent|^✗ GET .*lineup/);
    expect(lines[2]).toContain('2 effets rouges sur 2');
    const slow = fakeDeps();
    await effectLines(config('    - command: sleep 60\n'), 'abc', slow.deps);
    expect(slow.execs[0]!.timeoutMs).toBe(10_000);
  });

  it('rien à dire sans verify (projet à script) ; ne lève jamais', async () => {
    const { effectLines } = await import('../src/verify.js');
    const cfg = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n', 'cadence.yaml');
    expect(await effectLines(cfg, 'abc', fakeDeps().deps)).toEqual([]);
    const boom = fakeDeps({ fetch: async () => { throw new Error('ENETUNREACH'); } });
    const lines = await effectLines(TWO, 'abc', boom.deps);
    expect(lines.some((l) => l.includes('ENETUNREACH'))).toBe(true);
  });
});

describe('cadence session start : effets', () => {
  async function cad(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T08:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  async function project(yaml: string | null) {
    const dir = gitRepo();
    await cad(dir, 'init', '--project', 'demo', '--no-hook');
    if (yaml !== null) writeFileSync(join(dir, 'cadence.yaml'), yaml);
    git(dir, 'add', '.');
    commit(dir, 'chore: plan');
    return dir;
  }

  it('signale un effet rouge dans le rapport sans changer le code de sortie', async () => {
    const dir = await project('deliver:\n  verify:\n    - command: "true"\n    - command: "exit 3"\n');
    const r = await cad(dir, 'session', 'start');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Effets en production');
    expect(r.out).toContain('✗ exit 3 — code 3');
    expect(r.out).toContain('verify : 1 effet rouge sur 2 vérifications');
  });

  it('tout vert : une ligne ; réseau absent : un constat, la session continue', async () => {
    const green = await cad(await project('deliver:\n  verify:\n    - command: "true"\n'), 'session', 'start');
    expect(green.out).toContain('✓ verify : 1/1 vérifications vertes');
    const down = await cad(await project('deliver:\n  verify:\n    - url: http://127.0.0.1:1/api/health\n'), 'session', 'start');
    expect(down.code).toBe(0);
    expect(down.out).toContain('erreur réseau');
    expect(down.out).toContain('En cours');
  });

  it('pas de section sans cadence.yaml, sans deliver, ou avec un script sans verify ; config invalide : une ligne', async () => {
    for (const y of [null, 'session:\n  start: echo x\n', 'deliver:\n  script: ./livrer.sh\n']) {
      const r = await cad(await project(y), 'session', 'start');
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('Effets en production');
    }
    const bad = await cad(await project('deliver:\n  verify:\n    - { url: x, command: y }\n'), 'session', 'start');
    expect(bad.code).toBe(0);
    expect(bad.out).toContain('Effets en production');
    expect(bad.out).toContain('verify[1]');
  });
});

describe('realCheckDeps.exec : vérifications en groupe détaché (verify, session start)', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (ok: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50));
    return ok();
  };
  const viteNode = () => join(process.cwd(), 'node_modules/.bin/vite-node');

  it('codes de sortie, variables, délai dépassé', async () => {
    const d = realCheckDeps(tempDir(), { quiet: true });
    expect(await d.exec('true', {}, 5_000)).toBe(0);
    expect(await d.exec('exit 7', {}, 5_000)).toBe(7);
    expect(await d.exec('test "$CADENCE_X" = oui', { CADENCE_X: 'oui' }, 5_000)).toBe(0);
    expect(await d.exec('sleep 5', {}, 300)).toBe(TIMED_OUT);
  });

  it('un délai dépassé tue TOUT le groupe : aucun enfant (sleep) ne survit', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'child.pid');
    expect(await realCheckDeps(dir, { quiet: true }).exec(`sleep 30 & echo $! > '${pidFile}'; wait`, {}, 1_000)).toBe(TIMED_OUT);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const survived = !(await until(() => !alive(pid), 2_000));
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
  });

  it('quiet coupe réellement la sortie des commandes (stdout du processus capturé)', () => {
    const tmp = tempDir();
    const script = join(tmp, 'probe.ts');
    writeFileSync(
      script,
      `import { realCheckDeps } from ${JSON.stringify(join(process.cwd(), 'src/verify.ts'))};\n` +
        `const quiet = process.argv[2] === 'quiet';\n` +
        `process.exitCode = await realCheckDeps(${JSON.stringify(tmp)}, { quiet }).exec('echo BRUIT-SOUS-PROCESSUS; echo BRUIT-ERR >&2', {}, 5000);\n`,
    );
    const probe = (mode: string) => execFileSync(viteNode(), [script, mode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(probe('loud')).toContain('BRUIT-SOUS-PROCESSUS'); // témoin : la sonde voit bien la sortie
    expect(probe('quiet')).not.toContain('BRUIT-SOUS-PROCESSUS');
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    '%s reçu par cadence : relayé au groupe de la vérification, qui meurt avec lui',
    async (sig) => {
      const tmp = tempDir();
      const pidFile = join(tmp, 'check.pid');
      const script = join(tmp, 'probe.ts');
      writeFileSync(
        script,
        `import { realCheckDeps } from ${JSON.stringify(join(process.cwd(), 'src/verify.ts'))};\n` +
          `process.exitCode = await realCheckDeps(${JSON.stringify(tmp)}, { quiet: true }).exec("echo $$ > '${pidFile}'; exec sleep 30", {}, 60_000);\n`,
      );
      const child = spawn(viteNode(), [script], { detached: true, stdio: 'ignore' });
      const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, s) => r(s)));
      let checkPid = 0;
      try {
        expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 15_000)).toBe(true);
        checkPid = Number(readFileSync(pidFile, 'utf8').trim());
        // la vérification est dans sa propre session : le signal du terminal ne l'atteint pas directement
        process.kill(-child.pid!, sig);
        expect(await exited).toBe(sig); // cadence sort comme sans relais : tué par le même signal
        const survived = !(await until(() => !alive(checkPid), 2_000));
        expect(survived).toBe(false);
      } finally {
        for (const pid of [-child.pid!, checkPid]) {
          try {
            if (pid) process.kill(pid, 'SIGKILL');
          } catch {
            // déjà mort
          }
        }
      }
    },
    30_000,
  );
});
