import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { parseDeliverConfig, TIMED_OUT, type DeliverDeps } from '../src/deliver.js';
import { sharedStateDir, appendDelivery } from '../src/state.js';
import { replayChecks, summaryLine, verifyCommand } from '../src/verify.js';
import { commit, gitRepo } from './helpers.js';

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
