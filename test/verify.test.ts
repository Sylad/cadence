import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { parseDeliverConfig, TIMED_OUT, type DeliverDeps } from '../src/deliver.js';
import { sharedStateDir, appendDelivery } from '../src/state.js';
import { realCheckDeps, replayChecks, resultLine, summaryLine, verifyCommand } from '../src/verify.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

function fakeDeps(over: Partial<DeliverDeps> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const fetched: { url: string; timeoutMs?: number }[] = [];
  const execs: { cmd: string; env: Record<string, string>; timeoutMs: number }[] = [];
  const deps: DeliverDeps = {
    exec: (cmd, env, timeoutMs) => {
      execs.push({ cmd, env, timeoutMs });
      return 0;
    },
    gh: () => {
      throw new Error('gh ne doit jamais être appelé par verify');
    },
    ghReady: () => null,
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
    const r = await replayChecks(TWO.verify, deps, 'abcdef1234', {}, { retryMs: 0, budgetMs: 60_000 });
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
    const r = await replayChecks(TWO.verify, deps, 'abc', {}, { retryMs: 0, budgetMs: 60_000 });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([]);
    expect(r[0]!.reason).toBeNull();
    expect(r[1]!.reason).toContain('absent de la réponse');
    expect(summaryLine(r)).toBe('verify : 1 effet rouge sur 2 vérifications');
  });

  it('--retry : réessaie jusqu\'au délai demandé puis rend le dernier constat', async () => {
    let n = 0;
    const { deps } = fakeDeps({ fetch: async () => ({ status: ++n < 3 ? 503 : 200, text: '' }) });
    const r = await replayChecks([{ url: 'https://x/y' }], deps, 'abc', {}, { retryMs: 60_000, budgetMs: 60_000 });
    expect(r[0]!.reason).toBeNull();
    expect(n).toBe(3);
    const never = fakeDeps({ fetch: async () => ({ status: 503, text: '' }) });
    const r2 = await replayChecks([{ url: 'https://x/y' }], never.deps, 'abc', {}, { retryMs: 25_000, budgetMs: 60_000 });
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
      { retryMs: 0, budgetMs: 5_000 },
    );
    expect(fetched[0]!.url).toBe('https://x/v/abcdef1');
    expect(r[1]!.reason).toBe('délai dépassé');
    expect(execs).toEqual([]);
  });

  it('borne chaque vérification par le budget (réseau absent : pas d\'attente de 20 s)', async () => {
    const { deps, fetched } = fakeDeps();
    await replayChecks([{ url: 'https://x' }], deps, 'abc', {}, { retryMs: 0, budgetMs: 8_000 });
    expect(fetched[0]!.timeoutMs).toBeLessThanOrEqual(8_000);
  });
});

describe('budget par vérification', () => {
  const cmds = (...c: string[]) => c.map((command) => ({ command }));
  /** Durée simulée de chaque commande : « sleep N » dure N s, tuée à l'échéance (TIMED_OUT). */
  const sleeper = () => {
    let clock = 0;
    return fakeDeps({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      exec: (cmd, _env, timeoutMs) => {
        const need = Number(cmd.split(' ')[1]) * 1000;
        clock += Math.min(need, timeoutMs);
        return need > timeoutMs ? TIMED_OUT : 0;
      },
    }).deps;
  };

  it("une vérification lente ne rougit pas les suivantes saines (sleep 1.5 après sleep 30)", async () => {
    const r = await replayChecks(cmds('sleep 30', 'sleep 1.5', 'sleep 0'), sleeper(), 'abc', {}, { retryMs: 0, budgetMs: 10_000 });
    expect(r[0]!.reason).toBe('délai dépassé'); // la lente est rouge : elle l'est vraiment
    expect(r[1]!.reason).toBeNull();
    expect(r[2]!.reason).toBeNull();
    expect(r.some((x) => x.unverified)).toBe(false);
  });

  it('budget global épuisé : les restantes sont « non vérifiées », jamais rouges', async () => {
    let clock = 0;
    const { deps } = fakeDeps({
      now: () => clock,
      exec: (cmd) => {
        if (cmd === 'hang') clock += 20_000; // ignore son délai
        return 0;
      },
    });
    const r = await replayChecks(cmds('hang', 'a', 'b'), deps, 'abc', {}, { retryMs: 0, budgetMs: 10_000 });
    expect(r.map((x) => x.unverified === true)).toEqual([false, true, true]);
    expect(r[1]!.reason).toMatch(/budget/);
    expect(resultLine(r[1]!)).toMatch(/^\? a — non vérifiée/);
    expect(summaryLine(r)).toBe('verify : 2 non vérifiées sur 3 vérifications (budget épuisé), 0 effet rouge');
  });

  it('--retry : une vérification qui réessaie ne prive pas les suivantes de leur essai', async () => {
    const ran: string[] = [];
    const { deps } = fakeDeps({ exec: (cmd) => (ran.push(cmd), cmd === 'red' ? 1 : 0) });
    const r = await replayChecks(cmds('red', 'ok'), deps, 'abc', {}, { retryMs: 30_000, budgetMs: 10_000 + 30_000 * 2 });
    expect(r[0]!.reason).toBe('code 1');
    expect(r[1]!.reason).toBeNull();
    expect(ran.filter((c) => c === 'ok')).toHaveLength(1);
  });

  it('--retry : budget global épuisé pendant les réessais → restantes non vérifiées', async () => {
    const { deps } = fakeDeps({ exec: () => 1 });
    const r = await replayChecks(cmds('red', 'x', 'y'), deps, 'abc', {}, { retryMs: 30_000, budgetMs: 20_000 });
    expect(r[0]!.reason).toBe('code 1');
    expect(r[1]!.unverified).toBe(true);
    expect(r[2]!.unverified).toBe(true);
  });

  it('exit 3 quand seul le budget a manqué (ni vert, ni rouge)', async () => {
    let clock = 0;
    const { deps } = fakeDeps({ now: () => clock, exec: (cmd) => { if (cmd === 'hang') clock += 999_000; return 0; } });
    const out: string[] = [];
    const cfg = config('    - command: hang\n    - command: b\n');
    expect(await verifyCommand({ config: cfg, sha: 'abc', retry: 0, out: (l) => out.push(l) }, deps)).toBe(3);
    expect(out[1]).toMatch(/^\? b/);
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
    expect(slow.execs[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
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
