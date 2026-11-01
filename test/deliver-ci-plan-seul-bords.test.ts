import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, parseDeliverConfig, type DeliverDeps, type GhRun } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { appendDelivery, sharedStateDir as stateDir } from '../src/state.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

afterEach(() => cleanupTempDirs());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const START = Date.UTC(2026, 10, 1, 23, 59, 58);
const GITHUB = parseDeliverConfig('deliver:\n  ci: github\n  deploy:\n    - echo a\n    - echo b\n  verify:\n    - command: "true"\n    - command: "true"\n', 'cadence.yaml');
const COMMAND = parseDeliverConfig('deliver:\n  ci:\n    command: ./ci.sh\n  deploy:\n    - echo a\n  verify:\n    - command: "true"\n', 'cadence.yaml');
const NONE = parseDeliverConfig('deliver:\n  ci: none\n  deploy:\n    - echo a\n  verify:\n    - command: "true"\n', 'cadence.yaml');
const SCRIPT = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n  verify:\n    - command: "true"\n', 'cadence.yaml');

async function livre(): Promise<string> {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-09-28');
  plan.add('Cache', '2026-09-28');
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  appendDelivery(stateDir(dir), '2026-09-28', headSha(dir)!);
  return dir;
}

function planCommit(dir: string, title: string): void {
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.add(title, '2026-09-28');
  plan.save();
  git(dir, 'add', '.cadence/raf.yaml');
  commit(dir, `chore(plan): ${title}`);
  git(dir, 'push', '-q');
}

function fakeDeps(over: Partial<DeliverDeps> & { runs?: GhRun[]; exit?: (cmd: string) => number; deployMs?: number } = {}) {
  let clock = START;
  const execs: string[] = [];
  const ghCalls: string[] = [];
  const { runs, exit, deployMs = 0, ...rest } = over;
  const deps: DeliverDeps = {
    exec: (cmd) => {
      execs.push(cmd);
      if (cmd.startsWith('echo')) clock += deployMs;
      return exit ? exit(cmd) : 0;
    },
    gh: (sha) => {
      ghCalls.push(sha);
      return runs ?? [{ name: 'ci', status: 'completed', conclusion: 'success' }];
    },
    ghReady: () => null,
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...rest,
  };
  return { deps, execs, ghCalls };
}

function ctx(dir: string, config = GITHUB, over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    c: {
      root: dir,
      state: stateDir(dir),
      plan: 'plan' in over ? (over.plan as Plan | null) : Plan.load(join(dir, '.cadence/raf.yaml')),
      config,
      today: '2026-09-28',
      dryRun: false,
      args: [] as string[],
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      ...over,
    },
    out,
    err,
  };
}

const stepsFile = (dir: string) => join(stateDir(dir), 'deliveries-steps.log');
const steps = (dir: string) =>
  readFileSync(stepsFile(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('deliver — bords L516', () => {
  it('R1 — un commit vide (--allow-empty) dans l\'intervalle : la CI est attendue, pas de preuve plan seul', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    commit(dir, 'chore: vide');
    git(dir, 'push', '-q');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R2 — un merge --no-ff qui amène un commit source depuis une branche : la CI est attendue', async () => {
    const dir = await livre();
    git(dir, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'feat.txt'), 'x\n');
    git(dir, 'add', 'feat.txt');
    commit(dir, 'feat: x');
    git(dir, 'checkout', '-q', 'main');
    planCommit(dir, 'Un');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
    git(dir, 'push', '-q');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R2 — un fichier source supprimé dans l\'intervalle : la CI est attendue', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', 'a.txt');
    commit(dir, 'feat: a');
    git(dir, 'push', '-q');
    appendDelivery(stateDir(dir), '2026-09-28', headSha(dir)!);
    git(dir, 'rm', '-q', 'a.txt');
    commit(dir, 'chore: rm a');
    git(dir, 'push', '-q');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R3 — une ligne illisible dans deliveries.log (sha inconnu) : la CI est attendue sans exception', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    appendFileSync(join(stateDir(dir), 'deliveries.log'), '2026-09-28 pas-un-sha\n');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R3 — une ligne qui ressemble à une option git (--all) : la CI est attendue sans exception', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    appendFileSync(join(stateDir(dir), 'deliveries.log'), '2026-09-28 --all\n');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R3 — la livraison précédente est un nom de branche (main) : la CI n\'est pas sautée sur ce non-sha', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    appendFileSync(join(stateDir(dir), 'deliveries.log'), '2026-09-28 HEAD~1\n');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R3 — deliver deux fois de suite le même sha plan seul : la seconde attend la CI (précédente = sha)', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    const h = fakeDeps();
    const { c, out } = ctx(dir);
    await deliver(c, h.deps);
    expect(out.join('\n')).not.toContain('non attendue');
  });

  it('R5 — dry-run avec ci none sur un sha plan seul : la ligne CI reste « CI : none »', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const { c, out } = ctx(dir, NONE, { dryRun: true });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.join('\n')).toContain('  CI : none');
    expect(out.join('\n')).not.toContain('non attendue');
  });

  it('R5 — dry-run avec une CI commande sur un sha plan seul : annonce non attendue sans heure ni exécution', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const h = fakeDeps();
    const { c, out } = ctx(dir, COMMAND, { dryRun: true });
    expect(await deliver(c, h.deps)).toBe(0);
    expect(out.some((l) => /^ {2}CI : non attendue \(aucun fichier hors plan depuis [0-9a-f]{7}\)$/.test(l))).toBe(true);
    expect(h.execs).toEqual([]);
    expect(existsSync(stepsFile(dir))).toBe(false);
  });

  it('R5 — dry-run avec script de projet : aucune ligne « CI : » ni « non attendue »', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const { c, out } = ctx(dir, SCRIPT, { dryRun: true });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out.join('\n')).not.toMatch(/CI : /);
  });

  it('R6 — l\'heure passe minuit UTC : 23:59:58 puis 00:00:xx sur les lignes suivantes', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    const h = fakeDeps({ deployMs: 5_000 });
    const { c, out } = ctx(dir);
    expect(await deliver(c, h.deps)).toBe(0);
    const stamps = out.filter((l) => /^\d\d:\d\d:\d\d /.test(l)).map((l) => l.slice(0, 8));
    expect(stamps[0]).toBe('23:59:58');
    expect(stamps.at(-1)).toBe('00:00:08');
    expect(out.at(-1)).toMatch(/^00:00:08 ✓ livré et vérifié : [0-9a-f]{7} en 10 s$/);
  });

  it('R6 — chaque ligne « → » de la sortie réelle commence par HH:MM:SS (sauf la ligne d\'ouverture)', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const { c, out } = ctx(dir, SCRIPT);
    writeFileSync(join(dir, 'livrer.sh'), '#!/bin/sh\nexit 0\n');
    await deliver(c, fakeDeps().deps);
    for (const l of out.filter((x) => x.includes('→'))) expect(l).toMatch(/^\d\d:\d\d:\d\d → /);
  });

  it('R7 — une CI en échec écrit dans deliveries-failed.log une ligne sans heure ni préfixe horodaté', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    const h = fakeDeps({ runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] });
    const { c, err } = ctx(dir);
    expect(await deliver(c, h.deps)).toBe(1);
    expect(err.join('\n')).toContain('deliver : CI en échec : ci (failure)');
    const failed = readFileSync(join(stateDir(dir), 'deliveries-failed.log'), 'utf8');
    expect(failed).not.toMatch(/\b\d\d:\d\d:\d\d\b/);
    expect(failed.split('\n')[0]).toMatch(/^2026-09-28 [0-9a-f]{40} \[ci\] /);
  });

  it('R8 — duree_s arrondit 1499 ms à 1 et 1500 ms à 2', async () => {
    for (const [ms, expected] of [[1_499, 1], [1_500, 2], [499, 0]] as const) {
      const dir = await livre();
      writeFileSync(join(dir, `s${ms}.txt`), 's\n');
      git(dir, 'add', '.');
      commit(dir, 'feat: s');
      git(dir, 'push', '-q');
      await deliver(ctx(dir, NONE).c, fakeDeps({ deployMs: ms }).deps);
      expect(steps(dir)[0]).toMatchObject({ etape: 'deploiement 1/1', duree_s: expected });
    }
  });

  it('R8 — plan null : le journal est écrit, projet = nom du dossier, lots []', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    const { c, err } = ctx(dir, GITHUB, { plan: null });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(err).toEqual([]);
    const first = steps(dir)[0];
    expect(first.lots).toEqual([]);
    expect(typeof first.projet).toBe('string');
    expect((first.projet as string).length).toBeGreaterThan(0);
  });

  it('R8 — plusieurs déploiements et vérifications : numérotation i/n et ordre ci, deploiement 1/2, 2/2, verification 1/2, 2/2', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    expect(steps(dir).map((l) => l.etape)).toEqual(['ci', 'deploiement 1/2', 'deploiement 2/2', 'verification 1/2', 'verification 2/2']);
  });

  it('R8 — script de projet : les vérifications sont journalisées, aucune ligne ci ni deploiement', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    writeFileSync(join(dir, 'livrer.sh'), '#!/bin/sh\nexit 0\n');
    expect(await deliver(ctx(dir, SCRIPT).c, fakeDeps().deps)).toBe(0);
    const etapes = steps(dir).map((l) => l.etape);
    expect(etapes.some((e) => (e as string).startsWith('ci'))).toBe(false);
    expect(etapes.some((e) => (e as string).startsWith('deploiement'))).toBe(false);
  });

  it('R9 — CI commande en échec (code 1) : ligne ci echec, aucune ligne de déploiement', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    const h = fakeDeps({ exit: (cmd) => (cmd === './ci.sh' ? 1 : 0) });
    expect(await deliver(ctx(dir, COMMAND).c, h.deps)).toBe(1);
    expect(steps(dir).map((l) => [l.etape, l.resultat])).toEqual([['ci', 'echec']]);
  });

  it('R9 — CI commande en dépassement (124) : ligne ci echec', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    const h = fakeDeps({ exit: (cmd) => (cmd === './ci.sh' ? 124 : 0) });
    expect(await deliver(ctx(dir, COMMAND).c, h.deps)).toBe(1);
    expect(steps(dir)).toMatchObject([{ etape: 'ci', resultat: 'echec' }]);
  });

  it('R9 — gh en erreur persistante : ligne ci echec avant la sortie 1', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    const h = fakeDeps({
      gh: () => {
        throw new Error('quota');
      },
    });
    expect(await deliver(ctx(dir).c, h.deps)).toBe(1);
    expect(steps(dir)).toMatchObject([{ etape: 'ci', resultat: 'echec' }]);
  });

  it('R9 — la seconde vérification échoue : lignes ok puis echec, rien après', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    let n = 0;
    const cfg = parseDeliverConfig('deliver:\n  ci: none\n  deploy:\n    - echo a\n  verify:\n    - command: v1\n    - command: v2\n    - command: v3\n  verifyTimeout: 1\n', 'cadence.yaml');
    const h = fakeDeps({ exit: (cmd) => (cmd === 'v2' ? 1 : (n++, 0)) });
    expect(await deliver(ctx(dir, cfg).c, h.deps)).toBe(1);
    expect(steps(dir).map((l) => [l.etape, l.resultat])).toEqual([
      ['deploiement 1/1', 'ok'],
      ['verification 1/2', 'ok'],
      ['verification 2/3', 'echec'],
    ].map((x, i) => (i === 1 ? ['verification 1/3', 'ok'] : x)));
  });

  it('R10 — CI commande sur un sha plan seul : aucune ligne ci et ./ci.sh jamais lancé', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const h = fakeDeps();
    expect(await deliver(ctx(dir, COMMAND).c, h.deps)).toBe(0);
    expect(h.execs).not.toContain('./ci.sh');
    expect(steps(dir).some((l) => l.etape === 'ci')).toBe(false);
  });

  it('R11 — journal non inscriptible, plusieurs étapes : un seul avertissement, deliveries.log écrit', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    execFileSync('mkdir', [stepsFile(dir)]);
    const { c, err } = ctx(dir);
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(err.filter((l) => l.includes('journal des étapes'))).toHaveLength(1);
    expect(readFileSync(join(stateDir(dir), 'deliveries.log'), 'utf8').trim().split('\n').at(-1)).toBe(`2026-09-28 ${headSha(dir)}`);
  });

  it('R11 — journal non inscriptible sur une livraison en échec : le code reste 1 et deliveries-failed.log est écrit', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 's.txt'), 's\n');
    git(dir, 'add', 's.txt');
    commit(dir, 'feat: s');
    git(dir, 'push', '-q');
    execFileSync('mkdir', [stepsFile(dir)]);
    const h = fakeDeps({ exit: (cmd) => (cmd.startsWith('echo') ? 3 : 0) });
    expect(await deliver(ctx(dir).c, h.deps)).toBe(1);
    expect(existsSync(join(stateDir(dir), 'deliveries-failed.log'))).toBe(true);
  });
});
