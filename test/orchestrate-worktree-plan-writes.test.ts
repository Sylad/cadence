import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlanOnly, lotWork, unreviewedWork } from '../src/audit.js';
import { sharedStateDir } from '../src/state.js';
import { INTEGRATION_LOCK } from '../src/orchestrate/integrate.js';
import { cadenceHome, freeSlots, liveWaves } from '../src/orchestrate/registry.js';
import { prepareTree, lotBranch, lotTreeDir, planSeenFrom } from '../src/orchestrate/worktree.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { branches, fake, inWorktree, lotOf, meeting, neighbour, planOf, run, setup, setupForeign, store, subjects, WAVE, writes } from './orchestrate-worktree-harness.js';
import { fakeApp } from './fake-app.js';
import { tempDir } from './helpers.js';

// L279 — le plan n'est jamais écrit dans un worktree de lot (R21) et chaque écriture est gardée (R26) ; R2, R15, R16.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PLAN = 'docs/plan/raf.yaml';

describe('R2 — seuls les lots qui peuvent jouer ensemble passent en worktree', () => {
  it('R2 — dépôt en HEAD détaché : lots à la suite et avertissement', async () => {
    const { parent, repo } = setup();
    git(repo, 'checkout', '-q', '--detach');
    const f = fake();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.out).toContain('orchestrate : a : worktrees demandés mais le dépôt est en HEAD détaché : lots joués à la suite');
    expect(f.calls.every((c) => c.cwd === repo)).toBe(true);
    expect(branches(repo)).toBe('');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
  it('R2 — deux lots partageant un voisin : même file, aucun worktree', async () => {
    const { parent, repo } = setup([{ title: 'un', repos: ['../voisin'] }, { title: 'deux', repos: ['../voisin'] }]);
    neighbour(parent);
    let active = 0;
    let peak = 0;
    const f = fake({
      implement: writes(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(30);
        active--;
      }),
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.out).toContain('worktrees demandés mais des lots du groupe ont des dépôts voisins (repos:) : lots joués à la suite');
    expect(peak).toBe(1);
    expect(f.calls.every((c) => c.cwd === repo)).toBe(true);
    expect(branches(repo)).toBe('');
  });
  it('R2 — un lot seul d\'un dépôt : joué dans le dépôt, pas de worktree', async () => {
    const { parent, repo } = setup([{ title: 'un' }]);
    const f = fake();
    const r = await run(parent, ['a:L1'], f);
    expect(r.code).toBe(0);
    expect(f.calls.every((c) => c.cwd === repo)).toBe(true);
    expect(r.out).not.toContain('worktrees demandés');
    expect(existsSync(join(store(parent).dir, 'worktrees'))).toBe(false);
  });
});

describe('R3 — les créneaux libres comptent les lots en parallèle', () => {
  it('R3 — la vague annonce au registre autant de files que de lots en worktree : les créneaux libres ne sont pas surestimés', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
    const seen: (number | undefined)[] = [];
    const f = fake({
      implement: writes(async () => {
        seen.push(liveWaves(cadenceHome())[0]?.lanes);
      }),
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(seen).toEqual([2, 2]);
    expect(freeSlots([{ pid: 1, wave: 'w', started: 's', cwd: '.', repos: ['a'], cap: 2, lanes: 2 }], 2)).toBe(0);
    expect(freeSlots([{ pid: 1, wave: 'w', started: 's', cwd: '.', repos: ['a'], cap: 2 }], 2)).toBe(1); // une vague sans worktree tient un dépôt, une session
  });
});

describe('R3 — mode par défaut inchangé : le registre ne reçoit pas de files', () => {
  it('R3 — vague sans worktrees avec un lot à dépôt voisin : aucune file écrite, créneaux = min(plafond, dépôts tenus) comme avant L279', async () => {
    const { parent } = setup([{ title: 'un', repos: ['../voisin'] }], '');
    neighbour(parent);
    const seen: { lanes: number | undefined; repos: number; free: number }[] = [];
    const f = fake({
      implement: writes(async () => {
        const w = liveWaves(cadenceHome())[0]!;
        seen.push({ lanes: w.lanes, repos: w.repos.length, free: freeSlots([w], 3) });
      }),
    });
    const r = await run(parent, ['a:L1', '--max-sessions', '3'], f);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ lanes: undefined, repos: 2, free: 1 }]); // 3 - min(3, 2 dépôts tenus), pas 3 - min(3, 1)
  });
});

describe('R15 — les gardes de dépôt valent pour chaque worktree', () => {
  it('R15 — un push depuis un worktree de lot arrête la vague (incident)', async () => {
    const { parent, repo } = setup();
    const bare = tempDir();
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        const out = claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
        if (lot === 'L1') git(cwd, 'push', '-q', 'origin', 'HEAD:refs/heads/pousse');
        return out;
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], f);
    expect(r.err).toMatch(/orchestrate : incident — push détecté pendant a:L1 \(implement\)/);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('failed');
    expect(store(parent).readWave()!.status).toBe('interrupted');
    expect(inWorktree(f.calls[0].cwd)).toBe(true);
  });
  it('R15 — un lot dont la session change de branche dans son worktree est rendu « HEAD déplacé »', async () => {
    const { parent } = setup();
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        if (lot === 'L1') {
          git(cwd, 'checkout', '-q', '--detach');
          return claudeOut(workReport({ commits: [commitFile(cwd, 'perdu.txt', `feat(${lot}): perdu`)] }));
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).toMatch(/^incident : HEAD déplacé pendant a:L1 \(implement\)/);
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    expect(r.code).toBe(1);
  });
});

describe('R16 — une seule application lancée à la fois dans le dépôt', () => {
  async function uxWave(lots: Parameters<typeof setup>[0], ux: (parent: () => string) => (cwd: string, brief: string) => Promise<ReturnType<typeof claudeOut>>) {
    const app = await fakeApp(0);
    const { parent, repo } = setup(lots, `worktrees: true\nux: { command: '${app.command}', url: '${app.url}', timeout: 1 }`);
    const f = fake({ ux: ux(() => parent) });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '3'], f);
    return { parent, repo, f, r };
  }
  it('R16 — deux lots à écran : une seule application lancée à la fois dans le dépôt', async () => {
    let active = 0;
    let peak = 0;
    const { f, parent } = await uxWave(
      [{ title: 'un', estimate: 1, visible: true }, { title: 'deux', estimate: 1, visible: true }],
      () => async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(1800); // plus long que le délai d'attente de l'URL (1 s) : sans file en mémoire, le second lot abandonnerait son UX
        active--;
        return claudeOut(reviewReport());
      },
    );
    expect(f.calls.filter((c) => c.kind === 'ux')).toHaveLength(2); // la seconde revue UX a bien eu lieu, après la première
    expect(peak).toBe(1);
    for (const id of ['L1', 'L2']) expect(store(parent).readLot('a', id)!.uxNote ?? '').not.toContain('url tenue');
  });
  it('R16 — le verrou d\'application est par dépôt, pris seulement par les étapes qui lancent l\'application : une étape sans application d\'un autre lot n\'attend pas ce verrou', async () => {
    let l2Status: string | undefined;
    const { f } = await uxWave(
      [{ title: 'un', estimate: 1, visible: true }, { title: 'deux' }],
      (parent) => async () => {
        await sleep(800); // L1 tient l'application ; L2, sans écran, ne la demande jamais
        l2Status = store(parent()).readLot('a', 'L2')?.status;
        return claudeOut(reviewReport());
      },
    );
    expect(f.calls.filter((c) => c.kind === 'ux')).toHaveLength(1);
    expect(l2Status).toBe('ready'); // L2 a joué toute sa chaîne et s'est intégré pendant que l'application de L1 tournait
  });
});

describe('R21 — le plan n\'est jamais écrit dans un worktree de lot', () => {
  it('R21 — deux lots du même dépôt, chacun avec des sous-tâches couvertes : les deux passent à ready, le plan du checkout principal porte les statuts et les sous-tâches closes des deux lots', async () => {
    const { parent, repo } = setup([{ title: 'un', tasks: ['première'] }, { title: 'deux', tasks: ['seconde'] }]);
    const f = fake({
      implement: async (cwd, brief) => {
        await meeting(2)();
        const lot = lotOf(brief);
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}/t1): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    const plan = planOf(repo);
    for (const id of ['L1', 'L2']) {
      expect(plan.lot(id).status).toBe('doing');
      expect(plan.lot(id).review!.verdict).toContain('orchestré');
      expect(plan.lot(id).tasks.map((t) => t.status)).toEqual(['done']);
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(subjects(repo).filter((s) => s.startsWith('plan: L')).length).toBeGreaterThanOrEqual(4); // deux démarrages, deux verdicts
  });
  it('R21 — git log de la branche de chaque lot : aucun commit ne touche le fichier de plan ni plan.files', async () => {
    const { parent, repo } = setup();
    const seen: string[] = [];
    const f = fake({
      implement: writes(meeting(2)),
      review: async (cwd) => {
        const base = git(cwd, 'merge-base', 'HEAD', 'main');
        seen.push(git(cwd, 'log', '--name-only', '--format=', `${base}..HEAD`));
        return claudeOut(reviewReport());
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(seen).toHaveLength(2);
    for (const files of seen) {
      expect(files).not.toContain(PLAN);
      expect(files).not.toBe('');
    }
    // et dans l'historique de la branche du dépôt, seuls les commits de plan touchent le plan
    expect(git(repo, 'log', '--format=%s', '--', PLAN).split('\n').every((s) => /^(plan|chore): /.test(s))).toBe(true);
  });
  it('R21 — le raf start du lot précède la création de son worktree, qui contient le commit de démarrage', async () => {
    const { parent } = setup();
    const seen: Record<string, string> = {};
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        seen[lot] = git(cwd, 'log', '--format=%s').split('\n').join('|');
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(seen.L1).toContain(`plan: L1 démarré (orchestrate ${WAVE})`);
    expect(seen.L2).toContain(`plan: L2 démarré (orchestrate ${WAVE})`);
  });
  it('R21 — plan hors du dépôt (plan: ../x.yaml) : lu et écrit en place, aucun commit de plan, aucun conflit', async () => {
    const { parent, repo } = setup();
    const outside = join(parent, 'plan-externe.yaml');
    writeFileSync(outside, readFileSync(join(repo, PLAN), 'utf8'));
    git(repo, 'rm', '-q', '--', PLAN);
    const yaml = readFileSync(join(repo, 'cadence.yaml'), 'utf8');
    writeFileSync(join(repo, 'cadence.yaml'), `plan:\n  path: ../plan-externe.yaml\n${yaml}`);
    git(repo, 'add', '--', 'cadence.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: plan hors du dépôt');
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const plan = Plan.load(outside);
    for (const id of ['L1', 'L2']) {
      expect(plan.lot(id).status).toBe('doing');
      expect(plan.lot(id).review).toBeDefined();
    }
    expect(subjects(repo).some((s) => s.startsWith('plan: '))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
  it('R21 — plan en lecture seule suivi par le dépôt : orchestrate.start et orchestrate.verdict sont lancés avec le checkout principal comme dossier courant, le worktree n\'est pas touché', async () => {
    const { parent, repo } = setupForeign();
    process.env.TOOL_LOG = join(tempDir(), 'tool.log');
    const worktreesDirty: string[] = [];
    const f = fake({
      implement: writes(meeting(2)),
      review: async (cwd) => {
        worktreesDirty.push(git(cwd, 'status', '--porcelain'));
        return claudeOut(reviewReport());
      },
    });
    const r = await run(parent, ['a:T1', 'a:T2', '--max-sessions', '2'], f);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const log = readFileSync(process.env.TOOL_LOG, 'utf8').trim().split('\n');
    expect(log.filter((l) => l.startsWith('start '))).toHaveLength(2);
    expect(log.filter((l) => l.startsWith('verdict '))).toHaveLength(2);
    expect(log.every((l) => l.split(' ')[2] === repo)).toBe(true);
    expect(worktreesDirty).toEqual(['', '']);
    expect(readFileSync(join(repo, 'docs/plan/taches.yaml'), 'utf8')).toMatch(/etat: en_cours/);
    expect(subjects(repo).filter((s) => s.startsWith('plan: T')).length).toBe(4);
  });
  it('R23 — plan en lecture seule : la trace figure dans le texte passé à orchestrate.verdict', async () => {
    const { parent } = setupForeign();
    process.env.TOOL_LOG = join(tempDir(), 'tool.log');
    await run(parent, ['a:T1', 'a:T2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    const verdicts = readFileSync(process.env.TOOL_LOG, 'utf8').split('\n').filter((l) => l.startsWith('verdict '));
    expect(verdicts.some((l) => /verdict reporté : [0-9a-f]{7} → [0-9a-f]{7} \(patch-id identique\)/.test(l))).toBe(true);
  });
  it('R21 — commits d\'acceptation (scellé, vert: true) : restent sur la branche du lot, pas dans le checkout principal', async () => {
    const { acceptWave } = await import('./orchestrate-worktree-accept.js');
    const r = await acceptWave();
    expect([r.status, r.next]).toEqual(['handed-back', 'integrate']); // rendu à l'intégration : rien n'a rejoint le dépôt du lead
    expect(r.branchLog).toContain('acceptation scellée');
    expect(r.branchLog).toContain('acceptation verte');
    expect(r.mainLog).not.toContain('acceptation scellée');
    expect(r.mainLog).not.toContain('acceptation verte');
  });
  it('R21 — une session commite une modification du plan dans son worktree : lot rendu, constat nommant le fichier et le commit, branche conservée', async () => {
    const { parent, repo } = setup();
    let sha = '';
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        if (lot === 'L1') {
          appendFileSync(join(cwd, PLAN), '# note de la session\n');
          git(cwd, 'add', '--', PLAN);
          git(cwd, 'commit', '-q', '-m', 'feat(L1): touche le plan');
          sha = git(cwd, 'rev-parse', '--short', 'HEAD');
          return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: 'feat(L1): touche le plan' }] }));
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).toBe(`la session a modifié le plan dans son worktree (${PLAN}, commit ${sha}) : le plan n'est écrit que par le programme ; worktree conservé : ${join(store(parent).dir, 'worktrees', 'a--L1')}`);
    expect(existsSync(join(store(parent).dir, 'worktrees', 'a--L1'))).toBe(true);
    expect(branches(repo)).toContain('a--L1');
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    expect(r.code).toBe(1);
  });
  it('R21 — une session modifie le plan sans le commiter : lot rendu de même', async () => {
    const { parent } = setup();
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        const out = claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
        if (lot === 'L1') appendFileSync(join(cwd, PLAN), '# non commité\n');
        return out;
      },
    });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const l1 = store(parent).readLot('a', 'L1')!;
    expect(l1.status).toBe('handed-back');
    expect(l1.outcome).toMatch(new RegExp(`^la session a modifié le plan dans son worktree \\(${PLAN.replace('.', '\\.')}, non commité\\)`));
  });
  it('R21 — un commit de plan venu de la branche du dépôt par le rebase : isPlanOnly le reconnaît depuis le worktree, lotWork et unreviewedWork ne le comptent pas', () => {
    const { repo } = setup([{ title: 'un' }]);
    const waveDir = tempDir();
    const t = { repo, dir: lotTreeDir(waveDir, 'a', 'L1'), branch: lotBranch('w', 'a', 'L1'), base: 'main', lot: 'a:L1' };
    expect(prepareTree(t).ok).toBe(true);
    commitFile(t.dir, 'x.txt', 'feat(L1): travail');
    // le programme écrit au plan du dépôt du lead (« plan: L1 … » cite le lot), puis le lot est rebasé dessus
    const p = Plan.load(join(repo, PLAN));
    p.note('L1', 'une note', '2026-10-04');
    p.save();
    git(repo, 'add', '--', PLAN);
    git(repo, 'commit', '-q', '-m', 'plan: L1 une note');
    git(t.dir, 'rebase', 'main');
    const view = planSeenFrom(Plan.load(join(repo, PLAN)), repo, t.dir);
    const planCommit = git(t.dir, 'log', '--format=%H', '-1', '--grep=^plan: L1', 'HEAD');
    expect(isPlanOnly(planCommit, view, t.dir)).toBe(true);
    expect(lotWork(view, t.dir, 'L1').map((c) => c.subject)).toEqual(['feat(L1): travail']);
    expect(unreviewedWork(view, t.dir, 'L1')).toBe(1); // le seul commit de travail, pas le commit de plan
  });
});

describe('R26 — chaque écriture de plan du programme est gardée', () => {
  /** Le premier lot, une fois en route, change le dépôt du lead ; le second (plafond 1) veut alors écrire le plan à son départ. */
  async function leadChanges(how: (repo: string) => void) {
    const { parent, repo } = setup();
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        const out = claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
        if (lot === 'L1') how(repo);
        return out;
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], f);
    return { parent, repo, f, r };
  }
  it('R26 — fichier suivi hors plan modifié dans le checkout principal : écriture de plan refusée, lot rendu, rien commité', async () => {
    const { parent, repo, f } = await leadChanges((repo) => appendFileSync(join(repo, 'base.txt'), 'édité par le lead\n'));
    const l2 = store(parent).readLot('a', 'L2')!;
    expect(l2.status).toBe('handed-back');
    expect(l2.outcome).toBe('écriture du plan refusée : arbre du dépôt modifié (base.txt)');
    expect(subjects(repo).some((s) => s.startsWith('plan: L2'))).toBe(false);
    expect(f.calls.some((c) => c.lot === 'L2')).toBe(false);
    expect(branches(repo)).toContain('a--L1'); // L1, rendu pour la même cause, garde le sien
    expect(branches(repo)).not.toContain('a--L2');
  });
  it('R26 — le lead est sur une autre branche : écriture de plan refusée, lot rendu, aucun commit', async () => {
    const { parent, repo } = await leadChanges((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    expect(store(parent).readLot('a', 'L2')!.outcome).toBe('écriture du plan refusée : dépôt sur autre et non main');
    expect(subjects(repo).some((s) => s.startsWith('plan: L2'))).toBe(false);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('autre');
  });
  it('R26 — verrou tenu au-delà de la borne pendant une écriture de plan : lot rendu avec le porteur, étape atteinte gardée', async () => {
    const { parent, repo } = setup();
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const f = fake({
        implement: async (cwd, brief) => {
          const lot = lotOf(brief);
          if (lot === 'L1') writeFileSync(join(sharedStateDir(repo), INTEGRATION_LOCK), JSON.stringify({ pid: sleeper.pid, wave: 'autre-vague', started: '2026-10-24T00:00:00Z' }));
          return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
        },
      });
      await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], f, { integrate: { waitMs: 150, pollMs: 20 } });
      const l2 = store(parent).readLot('a', 'L2')!;
      expect(l2.status).toBe('handed-back');
      expect(l2.outcome).toBe(`écriture du plan refusée : verrou tenu par autre-vague (pid ${sleeper.pid})`);
      expect(l2.next).toBeNull(); // rien n'avait été joué : l'étape atteinte est le départ
      expect(subjects(repo).some((s) => s.startsWith('plan: L2'))).toBe(false);
    } finally {
      sleeper.kill();
    }
  });
  it('R26 — trois lots écrivent le plan en même temps : trois commits de plan, aucun perdu, dans l\'ordre de la file', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }, { title: 'trois' }]);
    const r = await run(parent, ['a:L1', 'a:L2', 'a:L3', '--max-sessions', '3'], fake({ implement: writes(meeting(3)) }));
    expect(r.code).toBe(0);
    const log = subjects(repo).reverse();
    const starts = log.filter((s) => /^plan: L\d démarré/.test(s)).map((s) => s.slice(0, 8));
    expect(starts).toEqual(['plan: L1', 'plan: L2', 'plan: L3']);
    expect(log.filter((s) => /^plan: L\d revue de code enregistrée/.test(s))).toHaveLength(3);
    for (const id of ['L1', 'L2', 'L3']) expect(planOf(repo).lot(id).review).toBeDefined();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
