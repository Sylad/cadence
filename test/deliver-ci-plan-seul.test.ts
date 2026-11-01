import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gitModule from '../src/git.js';
import { deliver, parseDeliverConfig, type DeliverDeps, type GhRun } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { appendDelivery, lastDelivery, sharedStateDir as stateDir } from '../src/state.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

// readCommits passe par un espion qui rend la vraie lecture, sauf quand un test lui impose une réponse (R3 intervalle vide).
vi.mock('../src/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/git.js')>();
  return { ...original, readCommits: vi.fn(original.readCommits) };
});
const readCommits = vi.mocked(gitModule.readCommits);

afterEach(() => {
  readCommits.mockClear();
  cleanupTempDirs();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const START = Date.UTC(2026, 10, 1, 14, 30, 5);

const GITHUB = parseDeliverConfig('deliver:\n  ci: github\n  deploy:\n    - echo "$CADENCE_SHORT"\n  verify:\n    - url: https://app.example/\n', 'cadence.yaml');
const COMMAND = parseDeliverConfig('deliver:\n  ci:\n    command: ./ci.sh\n  deploy:\n    - echo deploy\n  verify:\n    - command: "true"\n', 'cadence.yaml');
const NONE = parseDeliverConfig('deliver:\n  ci: none\n  deploy:\n    - echo deploy\n  verify:\n    - command: "true"\n', 'cadence.yaml');
const SCRIPT = parseDeliverConfig('deliver:\n  script: ./livrer.sh\n  verify:\n    - command: "true"\n', 'cadence.yaml');

/** Dépôt poussé, plan « demo » avec un lot L1, un cadence.yaml, et une première livraison déjà journalisée. */
async function livre(): Promise<string> {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'demo', 'L', '2026-09-28');
  plan.add('Cache', '2026-09-28');
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: none\n');
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  appendDelivery(stateDir(dir), '2026-09-28', headSha(dir)!);
  return dir;
}

/** Un commit qui ne touche que le plan. */
function planCommit(dir: string, title: string): void {
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  plan.add(title, '2026-09-28');
  plan.save();
  git(dir, 'add', '.cadence/raf.yaml');
  commit(dir, `chore(plan): ${title}`);
  git(dir, 'push', '-q');
}

function sourceCommit(dir: string, subject = 'feat: source'): void {
  writeFileSync(join(dir, 'src.txt'), `${subject}\n`);
  git(dir, 'add', 'src.txt');
  commit(dir, subject);
  git(dir, 'push', '-q');
}

interface Harness {
  deps: DeliverDeps;
  execs: string[];
  ghCalls: string[];
  clock: () => number;
}

function fakeDeps(over: Partial<DeliverDeps> & { runs?: GhRun[]; deployMs?: number; exit?: (cmd: string) => number } = {}): Harness {
  let clock = START;
  const execs: string[] = [];
  const ghCalls: string[] = [];
  const { runs, deployMs = 0, exit, ...rest } = over;
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
  return { deps, execs, ghCalls, clock: () => clock };
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
  readFileSync(stepsFile(dir), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('deliver — CI d\'un sha plan seul (L516)', () => {
  it('R1 — intervalle de commits plan seul : gh n\'est pas interrogé, la CI-commande n\'est pas lancée, le déploiement et les vérifications le sont, code 0', async () => {
    for (const config of [GITHUB, COMMAND]) {
      const dir = await livre();
      const prev = lastDelivery(stateDir(dir))!;
      planCommit(dir, 'Un');
      planCommit(dir, 'Deux');
      const h = fakeDeps();
      const { c, out } = ctx(dir, config);
      expect(await deliver(c, h.deps)).toBe(0);
      expect(h.ghCalls).toEqual([]);
      expect(h.execs).not.toContain('./ci.sh');
      expect(h.execs.some((e) => e.startsWith('echo'))).toBe(true);
      const text = out.join('\n');
      expect(text).toContain(`→ CI : non attendue (aucun fichier hors plan depuis ${prev.slice(0, 7)})`);
      expect(text).toContain('→ déploiement 1/1');
      expect(text).toContain('→ vérification 1/1');
      expect(lastDelivery(stateDir(dir))).toBe(headSha(dir));
    }
  });

  it('R2 — un commit source parmi des commits plan : la CI est attendue', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    sourceCommit(dir);
    planCommit(dir, 'Deux');
    const h = fakeDeps();
    const { c, out } = ctx(dir);
    expect(await deliver(c, h.deps)).toBe(0);
    expect(h.ghCalls).toEqual([headSha(dir)]);
    expect(out.join('\n')).toContain('→ CI : attente des runs GitHub');
    expect(out.join('\n')).not.toContain('non attendue');
  });

  it('R2 — un commit de cadence.yaml hors clé du plan : la CI est attendue', async () => {
    const dir = await livre();
    writeFileSync(join(dir, 'cadence.yaml'), 'deliver:\n  ci: github\n');
    git(dir, 'add', 'cadence.yaml');
    commit(dir, 'chore: config');
    git(dir, 'push', '-q');
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R3 — plan absent (null) : la CI est attendue, sans exception', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const h = fakeDeps();
    const { c, out } = ctx(dir, GITHUB, { plan: null });
    expect(await deliver(c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
    expect(out.join('\n')).not.toContain('non attendue');
  });

  it('R3 — intervalle vide (lecture sans erreur qui rend []) : la CI est attendue', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const real = (await vi.importActual<typeof import('../src/git.js')>('../src/git.js')).readCommits;
    readCommits.mockReturnValue([]);
    try {
      const h = fakeDeps();
      const { c, out } = ctx(dir);
      expect(await deliver(c, h.deps)).toBe(0);
      expect(h.ghCalls).toHaveLength(1);
      expect(out.join('\n')).not.toContain('non attendue');
    } finally {
      readCommits.mockImplementation(real);
    }
  });

  it('R3 — pas de deliveries.log : la CI est attendue', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const h0 = fakeDeps();
    const { c: c0 } = ctx(dir);
    rmLog(c0.state);
    expect(await deliver(c0, h0.deps)).toBe(0);
    expect(h0.ghCalls).toHaveLength(1);
  });

  it('R3 — livraison précédente hors de l\'historique du sha : la CI est attendue', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const orphan = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-m', 'ailleurs'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(stateDir(dir), 'deliveries.log'), `2026-09-28 ${orphan}\n`);
    const h = fakeDeps();
    const { c, out } = ctx(dir);
    expect(await deliver(c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
    expect(out.join('\n')).not.toContain('non attendue');
  });

  it('R3 — précédente égale au sha : la CI est attendue', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    appendDelivery(stateDir(dir), '2026-09-28', headSha(dir)!);
    const h = fakeDeps();
    expect(await deliver(ctx(dir).c, h.deps)).toBe(0);
    expect(h.ghCalls).toHaveLength(1);
  });

  it('R4 — ci none : sortie identique à l\'actuelle', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const h = fakeDeps();
    const { c, out } = ctx(dir, NONE);
    expect(await deliver(c, h.deps)).toBe(0);
    expect(h.ghCalls).toEqual([]);
    expect(out.join('\n')).not.toContain('CI');
    expect(h.execs).toEqual(['echo deploy', 'true']);
  });

  it('R4 — script de projet : sortie identique, aucun calcul d\'intervalle', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    const before = readCommits.mock.calls.length;
    let during = -1;
    const h = fakeDeps({
      exec: () => {
        during = readCommits.mock.calls.length;
        return 0;
      },
    });
    const { c, out } = ctx(dir, SCRIPT);
    expect(await deliver(c, h.deps)).toBe(0);
    expect(during).toBe(before);
    expect(out.join('\n')).toContain('→ script du projet : ./livrer.sh');
    expect(out.join('\n')).not.toContain('CI');
  });

  it('R5 — dry-run sur un sha plan seul : annonce la CI non attendue sans appeler gh', async () => {
    const dir = await livre();
    const prev = lastDelivery(stateDir(dir))!;
    planCommit(dir, 'Un');
    const h = fakeDeps();
    const { c, out } = ctx(dir, GITHUB, { dryRun: true });
    expect(await deliver(c, h.deps)).toBe(0);
    expect(out).toContain(`  CI : non attendue (aucun fichier hors plan depuis ${prev.slice(0, 7)})`);
    expect(h.ghCalls).toEqual([]);
    expect(h.execs).toEqual([]);
  });

  it('R5 — dry-run sur un sha avec source : ligne CI inchangée', async () => {
    const dir = await livre();
    sourceCommit(dir);
    const { c, out } = ctx(dir, GITHUB, { dryRun: true });
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(out).toContain('  CI : github (délai 1800 s)');
    expect(out.join('\n')).not.toContain('non attendue');
  });
});

function rmLog(state: string): void {
  execFileSync('rm', ['-f', join(state, 'deliveries.log')]);
}

describe('deliver — horodatage et journal des étapes (L516)', () => {
  it('R6 — now injecté : chaque ligne d\'étape porte l\'heure UTC attendue', async () => {
    const dir = await livre();
    sourceCommit(dir);
    const h = fakeDeps({ deployMs: 7_000 });
    const { c, out } = ctx(dir);
    expect(await deliver(c, h.deps)).toBe(0);
    const steps = out.filter((l) => /^\d\d:\d\d:\d\d /.test(l));
    expect(steps.map((l) => l.slice(0, 8))).toEqual(['14:30:05', '14:30:05', '14:30:12', '14:30:12']);
    expect(steps[0]).toMatch(/→ CI : attente/);
    expect(steps[1]).toMatch(/→ déploiement 1\/1/);
    expect(steps[2]).toMatch(/→ vérification 1\/1/);
    expect(steps[3]).toMatch(/✓ livré et vérifié/);
  });

  it('R6 — ✓ livré donne la durée totale en secondes', async () => {
    const dir = await livre();
    sourceCommit(dir);
    const { c, out } = ctx(dir);
    expect(await deliver(c, fakeDeps({ deployMs: 7_000 }).deps)).toBe(0);
    expect(out.find((l) => l.includes('✓ livré'))).toMatch(/^14:30:12 ✓ livré et vérifié : [0-9a-f]{7} en 7 s$/);
  });

  it('R7 — deliveries.log garde exactement « jour sha »', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    const lines = readFileSync(join(stateDir(dir), 'deliveries.log'), 'utf8').trim().split('\n');
    expect(lines.at(-1)).toBe(`2026-09-28 ${headSha(dir)}`);
    expect(lines.every((l) => /^\d{4}-\d\d-\d\d [0-9a-f]{40}$/.test(l))).toBe(true);
  });

  it('R7 — deliveries-failed.log garde exactement sa ligne d\'avant, sans heure', async () => {
    const dir = await livre();
    sourceCommit(dir);
    const { c, err } = ctx(dir);
    expect(await deliver(c, fakeDeps({ exit: (cmd) => (cmd.startsWith('echo') ? 3 : 0) }).deps)).toBe(1);
    expect(readFileSync(join(stateDir(dir), 'deliveries-failed.log'), 'utf8')).toBe(
      `2026-09-28 ${headSha(dir)} [deploiement] déploiement en échec (code 3) : echo "$CADENCE_SHORT"\n`,
    );
    expect(err).toContain('deliver : déploiement en échec (code 3) : echo "$CADENCE_SHORT"');
  });

  const KEYS = ['lots', 'sha', 'projet', 'etape', 'debut', 'fin', 'duree_s', 'resultat'];

  it('R8 — livraison verte : une ligne JSON valide par étape jouée, dans l\'ordre, avec les huit clés', async () => {
    const dir = await livre();
    sourceCommit(dir, 'feat(L1): cache');
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    const lines = steps(dir);
    expect(lines.map((l) => l.etape)).toEqual(['ci', 'deploiement 1/1', 'verification 1/1']);
    for (const l of lines) {
      expect(Object.keys(l)).toEqual(KEYS);
      expect(l).toMatchObject({ lots: ['L1'], sha: headSha(dir), projet: 'demo', resultat: 'ok' });
    }
  });

  it('R8 — lots vaut [] quand aucun lot n\'est connu', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    expect(steps(dir).every((l) => Array.isArray(l.lots) && (l.lots as string[]).length === 0)).toBe(true);
  });

  it('R8 — duree_s égale fin − debut avec un now injecté', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir).c, fakeDeps({ deployMs: 7_400 }).deps)).toBe(0);
    const [ci, deploy] = steps(dir);
    expect(ci).toMatchObject({ debut: '2026-11-01T14:30:05.000Z', fin: '2026-11-01T14:30:05.000Z', duree_s: 0 });
    expect(deploy).toMatchObject({ debut: '2026-11-01T14:30:05.000Z', fin: '2026-11-01T14:30:12.400Z', duree_s: 7 });
  });

  it('R8 — dry-run : le fichier n\'est ni créé ni modifié', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir, GITHUB, { dryRun: true }).c, fakeDeps().deps)).toBe(0);
    expect(existsSync(stepsFile(dir))).toBe(false);
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    const before = readFileSync(stepsFile(dir), 'utf8');
    expect(await deliver(ctx(dir, GITHUB, { dryRun: true }).c, fakeDeps().deps)).toBe(0);
    expect(readFileSync(stepsFile(dir), 'utf8')).toBe(before);
  });

  it('R8 — un second deliver ajoute sans réécrire les lignes déjà présentes', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    const first = readFileSync(stepsFile(dir), 'utf8');
    sourceCommit(dir, 'feat: deux');
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    const all = readFileSync(stepsFile(dir), 'utf8');
    expect(all.startsWith(first)).toBe(true);
    expect(all.length).toBeGreaterThan(first.length);
    expect(steps(dir)).toHaveLength(6);
  });

  it('R9 — commande de déploiement en échec : ligne resultat echec, aucune ligne pour les vérifications', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir).c, fakeDeps({ exit: (cmd) => (cmd.startsWith('echo') ? 3 : 0) }).deps)).toBe(1);
    expect(steps(dir).map((l) => [l.etape, l.resultat])).toEqual([
      ['ci', 'ok'],
      ['deploiement 1/1', 'echec'],
    ]);
  });

  it('R9 — CI expirée : ligne ci resultat echec', async () => {
    const dir = await livre();
    sourceCommit(dir);
    const h = fakeDeps({ runs: [{ name: 'ci', status: 'in_progress', conclusion: '' }] });
    const { c, err } = ctx(dir);
    expect(await deliver(c, h.deps)).toBe(1);
    expect(err).toContain('deliver : CI non terminée après 1800 s');
    expect(steps(dir)).toMatchObject([{ etape: 'ci', resultat: 'echec', duree_s: 1800 }]);
  });

  it('R9 — vérification en échec : ligne verification resultat echec', async () => {
    const dir = await livre();
    sourceCommit(dir);
    const h = fakeDeps({ fetch: async () => ({ status: 502, text: '' }) });
    expect(await deliver(ctx(dir).c, h.deps)).toBe(1);
    expect(steps(dir).map((l) => [l.etape, l.resultat])).toEqual([
      ['ci', 'ok'],
      ['deploiement 1/1', 'ok'],
      ['verification 1/1', 'echec'],
    ]);
  });

  it('R10 — sha plan seul : aucune ligne ci dans deliveries-steps.log', async () => {
    const dir = await livre();
    planCommit(dir, 'Un');
    expect(await deliver(ctx(dir).c, fakeDeps().deps)).toBe(0);
    expect(steps(dir).map((l) => l.etape)).toEqual(['deploiement 1/1', 'verification 1/1']);
  });

  it('R10 — ci none : aucune ligne ci', async () => {
    const dir = await livre();
    sourceCommit(dir);
    expect(await deliver(ctx(dir, NONE).c, fakeDeps().deps)).toBe(0);
    expect(steps(dir).map((l) => l.etape)).toEqual(['deploiement 1/1', 'verification 1/1']);
  });

  it('R11 — journal des étapes non inscriptible : livraison verte, code 0, avertissement affiché', async () => {
    const dir = await livre();
    sourceCommit(dir);
    mkdirSync(stepsFile(dir)); // un dossier à la place du fichier : l'ajout échoue
    const { c, err } = ctx(dir);
    expect(await deliver(c, fakeDeps().deps)).toBe(0);
    expect(err.filter((l) => l.startsWith('deliver : journal des étapes non écrit : '))).toHaveLength(1);
    expect(lastDelivery(stateDir(dir))).toBe(headSha(dir));
  });
});
