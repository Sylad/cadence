import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddFeed, resumeNext, resumeRefusal, type AddEnv } from '../src/orchestrate/ajout.js';
import { type LotCtx, DROPPED } from '../src/orchestrate/cycle.js';
import { lotSpent, lotOver } from '../src/orchestrate/cycle/budget.js';
import { FIN_DE_CYCLE_WHATS, firstReview, toFix } from '../src/orchestrate/cycle/review.js';
import { firstWrite } from '../src/orchestrate/cycle/spec-steps.js';
import { MAX_PASSES } from '../src/orchestrate/cycle/ctx.js';
import { addableHandBack, lotGesture } from '../src/orchestrate/geste.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore, type LotState } from '../src/orchestrate/state.js';
import { lotBranch, lotTreeDir, prepareTree } from '../src/orchestrate/worktree.js';
import { sharedStateDir } from '../src/state.js';
import { claudeOut, commitFile, git, reviewReport } from './orchestrate-harness.js';
import { fake, lotOf, run, setup, store, until, WAVE } from './orchestrate-worktree-harness.js';
import { tempDir } from './helpers.js';

// L563 — --add d'un lot rendu en fin de cycle, corrigé par le lead dans son worktree conservé.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lot = (over: Partial<LotState> = {}): LotState =>
  ({ project: 'a', lot: 'L1', repo: '/x/a', status: 'handed-back', next: 'fix', outcome: 'revue non conforme après 2 passe(s) de correction', steps: [], pass: 2, answers: [], questions: [], warnings: [], constats: [], proposals: [], budget: 100, ...over }) as unknown as LotState;
const step = (kind: string, counted: number) => ({ kind, status: 'done', tokens: { counted, cacheRead: 0 } }) as unknown as LotState['steps'][number];
const constat = (source: 'code' | 'tests' | 'ux') => ({ source, gravite: 'bloquant', fichier: 'f.ts', ligne: 1, texte: 'à corriger' }) as unknown as LotState['constats'][number];

/** Un ctx à la main : la vague écrit dans `written`, le plan n'a aucun écran (firstWrite = implement). */
function ctxOf(l: LotState, saved: LotState[] = []): LotCtx {
  return { wave: { id: 'W2', store: { writeLot: (x: LotState) => saved.push(structuredClone(x)) }, log: () => {} }, lot: l, config: { timeouts: { work: 45 * 60_000 } }, loadPlan: () => ({ lot: () => ({ visible: false }) }) } as unknown as LotCtx;
}

const live = { id: 'W', status: 'running', cwd: '/x/a' } as const;
const stopped = { id: 'W', status: 'suspended' } as const;

describe('L563 — R13 liste blanche des rendus ajoutables', () => {
  const OUTCOMES = ['revue non conforme', 'tests rouges', 'code sans test', 'documentation en retard', 'sonde de cas limites', 'UX non conforme'];

  it('R13 — la constante FIN_DE_CYCLE_WHATS : toFix au plafond écrit un outcome que addableHandBack accepte pour chacun des six what', () => {
    expect([...FIN_DE_CYCLE_WHATS]).toEqual(OUTCOMES);
    for (const what of FIN_DE_CYCLE_WHATS) {
      const c = ctxOf(lot({ status: 'implementing', next: 'fix', outcome: null, pass: MAX_PASSES }));
      c.lot.status = 'fixing';
      // `stop` du cycle rend le lot : on lit l'outcome que toFix a écrit
      toFix(c, [constat('code')], what);
      expect(c.lot.outcome, what).toBe(`${what} après ${MAX_PASSES} passe(s) de correction`);
      expect(addableHandBack({ status: 'handed-back', next: c.lot.next, outcome: c.lot.outcome }), what).toBe(true);
    }
  });

  it.each([
    'revue non conforme après 2 passe(s) de correction',
    'tests rouges après 2 passe(s) de correction',
    'code sans test après 2 passe(s) de correction',
    'documentation en retard après 2 passe(s) de correction',
    'sonde de cas limites après 2 passe(s) de correction',
    'UX non conforme après 2 passe(s) de correction',
    "revue non conforme après 2 passe(s) de correction ; escalade fable déjà jouée",
  ])('R13 — lot rendu « %s » : addableHandBack vrai, geste --add sur vague vivante', (outcome) => {
    expect(addableHandBack({ status: 'handed-back', next: 'fix', outcome })).toBe(true);
    expect(lotGesture(live, lot({ outcome }))).toBe('cadence orchestrate --add .:L1 --wave W');
  });

  it.each([
    'spec non conforme après 2 passes',
    'fiche non conforme après 1 revue',
    'maquette non conforme après 1 revue',
    'accept non conforme après 2 passes',
    "verrou des tests d'acceptation",
    'dépôt sale après spec',
    'fix sans commit',
    'dépôt sale après fix',
    'délai dépassé : fix',
    'revue non conforme sans constat actionnable',
    'HEAD déplacé',
    'dépendance non prête dans la vague : L0',
    'worktree impossible',
    'le plan a été modifié par la session',
    'budget du lot atteint',
    'revue non conforme', // sans « après »
    '',
  ])('R13 — lot rendu « %s » : jamais ajoutable, aucun geste --add', (outcome) => {
    expect(addableHandBack({ status: 'handed-back', next: 'fix', outcome })).toBe(false);
    expect(lotGesture(live, lot({ outcome }))).not.toContain('--add');
  });

  it('R13 — outcome vide ou absent, lot non rendu, lot rendu à l\'intégration : faux', () => {
    expect(addableHandBack({ status: 'handed-back', next: 'fix', outcome: null })).toBe(false);
    expect(addableHandBack({ status: 'handed-back', next: 'fix' })).toBe(false);
    expect(addableHandBack({ status: 'ready', next: null, outcome: 'revue non conforme après 2 passe(s) de correction' })).toBe(false);
    expect(addableHandBack({ status: 'handed-back', next: 'integrate', outcome: 'revue non conforme après 2 passe(s) de correction' })).toBe(false);
    expect(addableHandBack({ outcome: 'revue non conforme après 2 passe(s) de correction' })).toBe(false);
  });

  it('R13 — même LotState, deux lectures : outcome inconnu → ni --add ni geste ; fin de cycle non conforme → les deux', () => {
    const inconnu = lot({ outcome: 'un futur outcome' });
    expect(addableHandBack(inconnu)).toBe(false);
    expect(lotGesture(live, inconnu)).toBe('');
    const fin = lot({ outcome: 'tests rouges après 2 passe(s) de correction' });
    expect(addableHandBack(fin)).toBe(true);
    expect(lotGesture(live, fin)).toContain('--add');
  });
});

describe('L563 — R8 la colonne geste', () => {
  it('R8 — vague vivante, lot rendu à corriger : la colonne geste vaut exactement « cadence orchestrate --add <projet>:<lot> --wave <vague> », sans « à la fin de la vague »', () => {
    expect(lotGesture({ id: 'W', status: 'running' }, lot())).toBe('cadence orchestrate --add a:L1 --wave W');
    expect(lotGesture({ id: 'W', status: 'running', cwd: '/x/a' }, lot())).toBe('cadence orchestrate --add .:L1 --wave W');
    expect(lotGesture(live, lot())).not.toContain('à la fin de la vague');
  });
  it('R8 — vague terminée : geste inchangé (texte exact de L554, sans --add)', () => {
    expect(lotGesture(stopped, lot())).toBe('');
    expect(lotGesture(stopped, lot({ outcome: DROPPED }))).toBe('cadence orchestrate a:L1');
    expect(lotGesture(live, lot({ next: 'integrate', outcome: 'x' }))).toBe('cadence orchestrate --resume --wave W --integrate a:L1');
  });
});

describe("L563 — resumeNext : l'état du lot rendu et l'étape où il repart", () => {
  /** Le ctx neuf de e.build (steps vides, budget d'un lot neuf 100) et l'ancien ctx du lot rendu. */
  const pair = (old: Partial<LotState>) => {
    const saved: LotState[] = [];
    const fresh = ctxOf(lot({ status: 'queued', next: null, outcome: null, pass: 0, steps: [], constats: [], budget: 100 }), saved);
    return { fresh, old: ctxOf(lot(old)), saved };
  };

  it("R2 — constats de revue présents : après la prise, next vaut 'fix' (toFix appelée avec ces constats), quel que soit le next du lot rendu", () => {
    for (const next of [null, 'integrate', 'review', 'fix'] as const) {
      const { fresh, old, saved } = pair({ next, constats: [constat('code')], steps: [step('review', 10)] });
      expect(resumeNext(fresh, old)).toBe('correction');
      expect(fresh.lot.next, String(next)).toBe('fix');
      expect(fresh.lot.constats).toEqual([constat('code')]);
      expect(saved.at(-1)?.next).toBe('fix'); // toFix a écrit l'état
    }
  });
  it('R2 — revue passée sans constat : après la prise, next vaut la valeur de firstReview (revue du correctif du lead), pas fix', () => {
    const { fresh, old } = pair({ constats: [], steps: [step('implement', 10), step('review', 10)] });
    expect(resumeNext(fresh, old)).toBe('revue');
    expect(fresh.lot.next).toBe(firstReview(fresh));
    expect(fresh.lot.next).not.toBe('fix');
  });
  it('R2 — jamais revu : après la prise, next vaut la valeur de firstWrite', () => {
    const { fresh, old } = pair({ constats: [], steps: [step('implement', 10)] });
    expect(resumeNext(fresh, old)).toBe('écriture');
    expect(fresh.lot.next).toBe(firstWrite(fresh));
  });
  it("R2 — constats de tests rouges seuls : après la prise, next vaut la valeur de firstWrite (pas 'fix', pas de revue)", () => {
    const { fresh, old } = pair({ constats: [constat('tests')], steps: [step('implement', 10), step('fix', 10)], outcome: 'tests rouges après 2 passe(s) de correction' });
    expect(resumeNext(fresh, old)).toBe('écriture');
    expect(fresh.lot.next).toBe(firstWrite(fresh));
    expect(fresh.lot.resumedReviewed).toBe(false);
  });
  it('R2 — lot rendu à next null ou terminal : next écrasé par la prise, le lot joue l\'étape choisie dans le cycle', () => {
    for (const next of [null, 'integrate'] as const) {
      const { fresh, old } = pair({ next, constats: [], steps: [step('review', 10)] });
      resumeNext(fresh, old);
      expect(fresh.lot.next, String(next)).toBe(firstReview(fresh));
    }
  });
  it('R2 — provenance : le ctx neuf a steps vides ; après la prise, steps, constats, reviewCounts et tokens sont ceux de l\'ancien ctx (copie, pas référence partagée)', () => {
    const { fresh, old } = pair({ constats: [constat('code')], steps: [step('review', 10)], reviewCounts: [3, 1], code: { verdict: 'x' } as LotState['code'] });
    expect(fresh.lot.steps).toEqual([]);
    resumeNext(fresh, old);
    expect(fresh.lot.steps).toEqual(old.lot.steps);
    expect(fresh.lot.steps).not.toBe(old.lot.steps);
    expect(fresh.lot.reviewCounts).toEqual([3, 1]);
    expect(fresh.lot.reviewCounts).not.toBe(old.lot.reviewCounts);
    expect(fresh.lot.code).toEqual(old.lot.code);
    fresh.lot.steps.push(step('fix', 1));
    expect(old.lot.steps).toHaveLength(1); // l'ancien état n'est pas touché
  });
  it('R2 — un lot rendu après une revue repart à fix ou firstReview, jamais à firstWrite (la copie des steps précède la pose de next)', () => {
    for (const constats of [[constat('code')], []]) {
      const { fresh, old } = pair({ constats, steps: [step('review', 10)] });
      resumeNext(fresh, old);
      expect(fresh.lot.next).not.toBe(firstWrite(fresh));
    }
  });
  it('R6 — lot rendu à 90 % de son budget, ajouté : budget = dépensé + budget neuf, lotOver faux, steps inchangés', () => {
    const { fresh, old } = pair({ budget: 100, steps: [step('implement', 40), step('review', 50)], constats: [constat('code')] });
    expect(lotOver(old.lot)).toBe(false);
    resumeNext(fresh, old);
    expect(fresh.lot.budget).toBe(90 + 100);
    expect(lotSpent(fresh.lot)).toBe(90);
    expect(lotOver(fresh.lot)).toBe(false);
    expect(fresh.lot.steps).toEqual(old.lot.steps);
  });
  it("R2 — copie de old.lot : model, small, visible, light, express, repos, goal restent ceux de l'ancien lot, même quand le ctx neuf en porte d'autres", () => {
    const { fresh, old } = pair({ model: 'opus', small: true, visible: true, light: true, express: true, goal: 'ancien', repos: [{ rel: '../b', path: '/x/b' }], constats: [constat('code')] } as Partial<LotState>);
    // le ctx neuf du préflight : visible relu du plan principal (false), model par défaut (sonnet), sans light/express/repos
    Object.assign(fresh.lot, { model: 'sonnet', small: false, visible: false, goal: 'neuf' });
    delete fresh.lot.light;
    delete fresh.lot.express;
    delete fresh.lot.repos;
    resumeNext(fresh, old);
    expect(fresh.lot).toMatchObject({ model: 'opus', small: true, visible: true, light: true, express: true, goal: 'ancien', repos: [{ rel: '../b', path: '/x/b' }] });
    expect(fresh.lot.repos).not.toBe(old.lot.repos);
  });
  it("R2 — un champ absent de l'ancien lot n'est pas repris du ctx neuf (goal, light, express, repos)", () => {
    const { fresh, old } = pair({ model: 'sonnet', visible: false, constats: [constat('code')] } as Partial<LotState>);
    Object.assign(fresh.lot, { model: 'opus', visible: true, light: true, express: true, goal: 'neuf', repos: [{ rel: '../c', path: '/x/c' }] });
    resumeNext(fresh, old);
    expect(fresh.lot).toMatchObject({ model: 'sonnet', visible: false });
    expect(fresh.lot.goal).toBeUndefined();
    expect(fresh.lot.light).toBeUndefined();
    expect(fresh.lot.express).toBeUndefined();
    expect(fresh.lot.repos).toBeUndefined();
  });
  it('R6 — lot repris : pass à 0 (1 après la correction posée), escalation vide, statut queued, outcome vidé', () => {
    const { fresh, old } = pair({ pass: 2, constats: [], steps: [step('review', 1)], escalation: { model: 'fable', stage: 'done', issue: 'rendu' } as LotState['escalation'] });
    resumeNext(fresh, old);
    expect(fresh.lot.pass).toBe(0);
    expect(fresh.lot.escalation).toBeUndefined();
    expect(fresh.lot.status).toBe('queued');
    expect(fresh.lot.outcome).toBeNull();
  });
  it("R6 — lot rendu avec pass = plafond et constats de revue : après la prise next = 'fix' (toFix n'a pas rendu le lot, pass lu à 0)", () => {
    const { fresh, old } = pair({ pass: MAX_PASSES, constats: [constat('code')], steps: [step('review', 1)] });
    resumeNext(fresh, old);
    expect(fresh.lot.next).toBe('fix');
    expect(fresh.lot.status).toBe('queued');
    expect(fresh.lot.pass).toBe(1);
  });
  it('R11 — lot rendu après une revue avec constats : resumedFrom = id de la vague, constats gardés, resumedReviewed vrai', () => {
    const { fresh, old } = pair({ constats: [constat('code')], steps: [] });
    resumeNext(fresh, old);
    expect(fresh.lot.resumedFrom).toBe('W2');
    expect(fresh.lot.resumedReviewed).toBe(true);
    expect(fresh.lot.constats).toEqual([constat('code')]);
  });
  it("R11 — lot rendu sans aucune revue : resumedReviewed faux, next posé par la prise à firstWrite", () => {
    const { fresh, old } = pair({ constats: [], steps: [step('implement', 5)] });
    resumeNext(fresh, old);
    expect(fresh.lot.resumedReviewed).toBe(false);
    expect(fresh.lot.next).toBe(firstWrite(fresh));
  });
  it('R11 — reviewCounts, minorPass et programFixes du lot rendu identiques après la prise ; escalation vide', () => {
    const { fresh, old } = pair({ reviewCounts: [2, 1, 1], minorPass: true, programFixes: 2, constats: [constat('code')], steps: [step('review', 1)], escalation: { model: 'm', stage: 'fix' } as LotState['escalation'] });
    resumeNext(fresh, old);
    expect(fresh.lot.reviewCounts).toEqual([2, 1, 1]);
    expect(fresh.lot.minorPass).toBe(true);
    expect(fresh.lot.programFixes).toBe(2);
    expect(fresh.lot.escalation).toBeUndefined();
  });
});

describe('L563 — R4 / R12 / R5 / R9 : la prise par la vague', () => {
  /** Un dépôt, le worktree conservé de a:L1 sur la branche de la vague W2, et la vague qui le porte déjà (lot rendu). */
  function scene() {
    const parent = tempDir();
    const repo = join(parent, 'a');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '--', 'base.txt');
    git(repo, 'commit', '-q', '-m', 'chore: base');
    const st = new RunStore(parent, 'W2');
    mkdirSync(st.dir, { recursive: true });
    const dir = lotTreeDir(st.dir, 'a', 'L1', repo);
    const branch = lotBranch('W2', 'a', 'L1');
    expect(prepareTree({ repo, dir, branch, base: 'main', lot: 'a:L1' }).ok).toBe(true);
    const oldLot = lot({ repo, steps: [step('review', 10)], constats: [constat('code')] });
    const oldCtx = { ...ctxOf(oldLot), tree: { dir, branch, base: 'main', active: true } } as unknown as LotCtx;
    (oldCtx.wave as unknown as { store: RunStore }).store = st;
    const log: string[] = [];
    (oldCtx.wave as unknown as { log: (l: string) => void }).log = (l) => log.push(l);
    const ctxs = [oldCtx];
    const all = [oldLot];
    const lots = [oldLot];
    const wave = { id: 'W2', lots: ['a:L1'] };
    const builtWith: unknown[] = [];
    let builds = 0;
    const e = {
      store: st, wave, wctx: oldCtx.wave, io: { err: () => {}, out: () => {} }, deps: {}, launch: parent, ctxs, all, lots,
      held: [join(sharedStateDir(repo), REPO_LOCK)], freed: new Set<string>(), repos: [repo], freeRepo: () => {}, saveWave: () => {}, announce: () => {},
      stopCause: () => null, budgetLeft: () => 1_000_000, planState: () => null,
      checks: { resolveTargets: () => [{ project: 'a', lot: 'L1', repo }] },
      build: async (_t: unknown, known: unknown) => {
        builds++;
        builtWith.push(known);
        const fresh = ctxOf(lot({ repo, status: 'queued', next: null, outcome: null, pass: 0, steps: [], constats: [], budget: 100 }));
        (fresh as { tree?: unknown }).tree = { dir, branch, base: 'main', active: false };
        (fresh.wave as unknown as { store: RunStore }).store = st;
        return { ctx: fresh };
      },
    } as unknown as AddEnv;
    const feed = new AddFeed(e);
    return { repo, st, dir, ctxs, all, lots, wave, feed, log, builds: () => builds, builtWith, oldLot, oldCtx, parent };
  }

  it('R4 — arbre du worktree sale : refus avec les fichiers non commités et la commande à rejouer, rien commité ni jeté', () => {
    const s = scene();
    expect(resumeRefusal(s.st, s.oldLot, s.parent)).toBeNull();
    writeFileSync(join(s.dir, 'base.txt'), 'corrigé, pas commité\n');
    const why = resumeRefusal(s.st, s.oldLot, s.parent)!;
    expect(why).toContain('base.txt');
    expect(why).toContain('cadence orchestrate --add a:L1 --wave W2');
    expect(readFileSync(join(s.dir, 'base.txt'), 'utf8')).toBe('corrigé, pas commité\n'); // jamais jeté
    expect(git(s.dir, 'status', '--porcelain')).toContain('base.txt'); // jamais commité
  });
  it('R4 — worktree disparu ou branche disparue : la cause est nommée', () => {
    const s = scene();
    git(s.repo, 'worktree', 'remove', '--force', s.dir);
    expect(resumeRefusal(s.st, s.oldLot, s.parent)).toContain("n'existe plus");
    git(s.repo, 'branch', '-D', lotBranch('W2', 'a', 'L1'));
    expect(resumeRefusal(s.st, s.oldLot, s.parent)).toContain('branche');
  });

  it("R5 — lot rendu ajouté : une seule occurrence du lot dans ctxs, all et lots (le nouveau LotState), une clé dans wave.lots", async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    const taken = await s.feed.take(() => true);
    expect(taken).toHaveLength(1);
    expect(s.ctxs).toEqual([taken[0]]);
    expect(s.all).toEqual([taken[0]!.lot]);
    expect(s.lots).toEqual([taken[0]!.lot]);
    expect(s.all[0]).not.toBe(s.oldLot);
    expect(s.wave.lots).toEqual(['a:L1']);
    expect(taken[0]!.lot.steps).toEqual(s.oldLot.steps);
    expect(taken[0]!.lot.next).toBe('fix');
    expect(s.st.addQueue()).toEqual([]);
    expect(s.st.readLot('a', 'L1')?.status).toBe('queued');
  });
  it('R5 — le remplacement garde le rang : un autre lot de la vague reste à sa place', async () => {
    const s = scene();
    const other = ctxOf(lot({ lot: 'L0', repo: s.repo, status: 'ready', outcome: null, next: null }));
    s.ctxs.unshift(other);
    s.all.unshift(other.lot);
    s.lots.splice(0, 1, ...[other.lot, s.oldLot]);
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    const taken = await s.feed.take(() => true);
    expect(s.ctxs).toEqual([other, taken[0]]);
    expect(s.lots.map((l) => l.lot)).toEqual(['L0', 'L1']);
  });
  it('R9 — journal : « a:L1 : ajouté à la vague W2 » écrit une fois, puis « reprise du lot rendu à la correction, worktree <chemin absolu> »', async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    await s.feed.take(() => true);
    expect(s.log.filter((l) => l === 'a:L1 : ajouté à la vague W2')).toHaveLength(1);
    expect(s.log).toContain(`a:L1 : reprise du lot rendu à la correction, worktree ${s.dir}`);
  });
  it('R9 — journal, revue sans constat : « … reprise du lot rendu à la revue, worktree <chemin> » ; jamais revu : « … à l\'écriture, … »', async () => {
    for (const [oldState, tail] of [[{ constats: [], steps: [step('review', 1)] }, 'à la revue'], [{ constats: [], steps: [step('implement', 1)] }, "à l'écriture"]] as const) {
      const s = scene();
      Object.assign(s.oldLot, oldState);
      s.st.requestAdd({ project: 'a', lot: 'L1' });
      await s.feed.take(() => true);
      expect(s.log).toContain(`a:L1 : reprise du lot rendu ${tail}, worktree ${s.dir}`);
    }
  });
  it('R12 — lot rendu absent de known à la prise : pas de refus « lot déjà dans la vague »', async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    await s.feed.take(() => true);
    expect(s.builtWith[0]).toEqual([]);
  });
  it('R12 — un lot de la vague non rendu (en cours) reste dans known : le préflight le refuse comme avant', async () => {
    const s = scene();
    s.oldLot.status = 'implementing';
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    await s.feed.take(() => true);
    expect(s.builtWith[0]).toEqual([{ project: 'a', lot: 'L1' }]);
  });
  it('R12 — arbre rendu sale après le dépôt de la demande : demande écartée et dite, aucune session lancée, lot toujours handed-back', async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    writeFileSync(join(s.dir, 'base.txt'), 'pas commité\n');
    expect(await s.feed.take(() => true)).toEqual([]);
    expect(s.builds()).toBe(0);
    expect(s.log.join('\n')).toContain('orchestrate : a:L1 : ajout écarté à la prise : worktree du lot introuvable ou arbre sale : fichiers non commités');
    expect(s.log.join('\n')).toContain('base.txt');
    expect(s.ctxs).toEqual([s.oldCtx]);
    expect(s.oldLot.status).toBe('handed-back');
    expect(s.st.addQueue()).toEqual([]);
  });
  it('R12 — worktree supprimé après le dépôt : demande écartée, lot inchangé', async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    git(s.repo, 'worktree', 'remove', '--force', s.dir);
    expect(await s.feed.take(() => true)).toEqual([]);
    expect(s.log.join('\n')).toContain("ajout écarté à la prise : worktree du lot introuvable ou arbre sale : le worktree");
    expect(s.oldLot.status).toBe('handed-back');
  });
  it("R5 — dépôt tenu par un lot qui joue : le lot attend puis est pris ; R12 — l'arbre sali pendant l'attente écarte la demande à la prise", async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    expect(await s.feed.take(() => false)).toEqual([]);
    expect(s.st.addQueue()).toHaveLength(1); // gardée
    expect(s.ctxs).toEqual([s.oldCtx]); // pas encore remplacé
    expect(await s.feed.take(() => true)).toHaveLength(1);
    const t = scene();
    t.st.requestAdd({ project: 'a', lot: 'L1' });
    await t.feed.take(() => false);
    writeFileSync(join(t.dir, 'base.txt'), 'sali pendant l\'attente\n');
    expect(await t.feed.take(() => true)).toEqual([]);
    expect(t.log.join('\n')).toContain('ajout écarté à la prise');
    expect(t.oldLot.status).toBe('handed-back');
  });
  it("R7 — la vague finit avant la prise : demande écartée (drain), lot toujours handed-back", async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    await s.feed.take(() => false);
    s.feed.drain('la vague a fini de jouer');
    expect(s.st.addQueue()).toEqual([]);
    expect(s.log.join('\n')).toContain('ajout écarté (la vague a fini de jouer)');
    expect(s.oldLot.status).toBe('handed-back');
    expect(s.ctxs).toEqual([s.oldCtx]);
  });
  it("R6 — budget neuf supérieur au budget restant de la vague, à la prise : demande écartée, lot inchangé", async () => {
    const s = scene();
    (s.feed as unknown as { e: AddEnv }).e.budgetLeft = () => 99; // le budget d'un lot neuf est 100
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    expect(await s.feed.take(() => true)).toEqual([]);
    expect(s.log.join('\n')).toContain('le budget restant de la vague ne tient pas le budget du lot (100)');
    expect(s.oldLot.status).toBe('handed-back');
  });
  it("R5 — lot rendu ajouté : même worktree, mêmes commits, compté une fois dans le budget (dépensé + neuf, pas deux fois)", async () => {
    const s = scene();
    const head = git(s.dir, 'rev-parse', 'HEAD');
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    const [c] = await s.feed.take(() => true);
    expect(git(s.dir, 'rev-parse', 'HEAD')).toBe(head);
    expect((c!.tree as { dir: string }).dir).toBe(s.dir);
    expect(c!.lot.budget).toBe(lotSpent(s.oldLot) + 100);
    expect(s.all.reduce((n, l) => n + (l.budget ?? 0), 0)).toBe(c!.lot.budget);
  });
  it("R7 — le lot n'est plus rendu quand la vague le prend : demande écartée, lot inchangé", async () => {
    const s = scene();
    s.st.requestAdd({ project: 'a', lot: 'L1' });
    await s.feed.take(() => false);
    s.oldLot.status = 'implementing';
    expect(await s.feed.take(() => true)).toEqual([]);
    expect(s.log.join('\n')).toContain("le lot n'est plus rendu en fin de cycle");
    expect(s.ctxs).toEqual([s.oldCtx]);
  });
});

describe('L563 — --add sur une vague vivante (e2e)', () => {
  const blocking = () => claudeOut(reviewReport({ bloquants: 1, constats: [{ gravite: 'bloquant', fichier: 'L1-implement.txt', ligne: 1, texte: 'à corriger' }], verdict: 'non conforme : un bloquant' }));

  /** Une vague L1 + L2 : L1 est rendu « revue non conforme après 2 passe(s) » ; `onL2` agit pendant que L2 « tourne ». `fixed()` : la revue de L1 devient conforme. */
  async function liveWave(onL2: (parent: string, repo: string) => Promise<void>, patch?: (l: LotState) => LotState) {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
    let fixed = false;
    const f = fake({
      review: (_cwd, brief) => (lotOf(brief) === 'L1' && !fixed ? blocking() : claudeOut(reviewReport())),
      implement: async (cwd, brief) => {
        const l = lotOf(brief);
        if (l === 'L2') {
          await until(() => store(parent).readLot('a', 'L1')?.status === 'handed-back');
          if (patch) store(parent).writeLot(patch(store(parent).readLot('a', 'L1')!));
          await onL2(parent, repo);
          fixed = true;
        }
        return claudeOut({ commits: [commitFile(cwd, `${l}.txt`, `feat(${l}): travail`)], tests: { commande: 'x', resultat: 'ok', vert: true }, build: { commande: 'x', resultat: 'ok', vert: true }, nonVerifie: [], questions: [], resume: 'ok', choix: [] });
      },
    });
    const res = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, { slotPollMs: 20 });
    return { parent, repo, f, res };
  }
  const treeOf = (parent: string, repo: string) => lotTreeDir(store(parent).dir, 'a', 'L1', repo);
  const journal = (parent: string) => readFileSync(join(store(parent).dir, 'journal.log'), 'utf8');

  it('R1/R3/R4/R13 — --add d\'un lot rendu corrigé : déposé (code 0), repris à la correction, joué une fois, prêt ; ancien état gardé', async () => {
    let add: { code: number; out: string; err: string } | undefined;
    let before: LotState | undefined;
    const { parent, res } = await liveWave(async (p, repo) => {
      before = store(p).readLot('a', 'L1')!;
      expect(before.outcome).toBe('revue non conforme après 2 passe(s) de correction');
      commitFile(treeOf(p, repo), 'lead-fix.txt', 'fix(L1): correctif du lead');
      add = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
      await until(() => store(p).addQueue().length === 0);
    });
    expect(add, add?.err).toMatchObject({ code: 0 });
    expect(add!.out).toContain(`a:L1 : ajout déposé — la vague ${WAVE} le prend entre deux étapes et le joue dès qu'un créneau est libre`);
    expect(res.code).toBe(0);
    const l = store(parent).readLot('a', 'L1')!;
    expect(l.status).toBe('ready');
    expect(l.resumedFrom).toBe(WAVE);
    expect(l.steps.length).toBeGreaterThan(before!.steps.length); // l'historique est gardé et prolongé
    expect(store(parent).readWave()!.lots.filter((k) => k === 'a:L1')).toHaveLength(1);
    const j = journal(parent);
    expect(j.match(new RegExp(`a:L1 : ajouté à la vague ${WAVE}`, 'g'))).toHaveLength(1);
    expect(j).toContain('a:L1 : reprise du lot rendu à la correction, worktree');
  });

  it('R1 — lot en cours ou prêt de la vague : « lot déjà dans la vague », code 2, rien déposé', async () => {
    let err = '';
    let code = 0;
    await liveWave(async (p) => {
      const r = await run(p, ['--add', 'a:L2', '--wave', WAVE], fake());
      [code, err] = [r.code, r.err];
      expect(store(p).addQueue()).toEqual([]);
    });
    expect(code).toBe(2);
    expect(err).toMatch(/a:L2 : lot déjà dans la vague/);
  });

  it('R4 — arbre du worktree sale : code 2, fichiers non commités et commande à rejouer nommés, état du lot inchangé', async () => {
    let r: { code: number; err: string } | undefined;
    let after: LotState | undefined;
    const { parent } = await liveWave(async (p, repo) => {
      writeFileSync(join(treeOf(p, repo), 'L1.txt'), 'correctif pas commité\n');
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
      after = store(p).readLot('a', 'L1')!;
      expect(store(p).addQueue()).toEqual([]);
      git(treeOf(p, repo), 'checkout', '--', 'L1.txt'); // le lead remet l'arbre en état pour la suite de la vague
    });
    expect(r!.code, r!.err).toBe(2);
    expect(r!.err).toContain('a:L1 : worktree du lot introuvable ou arbre sale');
    expect(r!.err).toContain('L1.txt');
    expect(r!.err).toContain(`cadence orchestrate --add a:L1 --wave ${WAVE}`);
    expect(after).toMatchObject({ status: 'handed-back', outcome: 'revue non conforme après 2 passe(s) de correction' });
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
  });

  it('R4 — worktree disparu : code 2, lot toujours rendu', async () => {
    let r: { code: number; err: string } | undefined;
    const { parent } = await liveWave(async (p, repo) => {
      git(repo, 'worktree', 'remove', '--force', treeOf(p, repo));
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
    });
    expect(r!.code).toBe(2);
    expect(r!.err).toContain('worktree du lot introuvable ou arbre sale');
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
  });

  it('R3 — lot rendu à l\'intégration : refus « lot déjà dans la vague » inchangé', async () => {
    let r: { code: number; err: string } | undefined;
    await liveWave(async (p) => {
      const l = store(p).readLot('a', 'L1')!;
      l.next = 'integrate';
      store(p).writeLot(l);
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
    });
    expect(r!.code).toBe(2);
    expect(r!.err).toMatch(/a:L1 : lot déjà dans la vague/);
  });

  it('R3 — lot retiré par --drop : refus inchangé, nouvelle vague', async () => {
    let r: { code: number; err: string } | undefined;
    await liveWave(async (p) => {
      const l = store(p).readLot('a', 'L1')!;
      l.outcome = DROPPED;
      store(p).writeLot(l);
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
    });
    expect(r!.code).toBe(2);
    expect(r!.err).toContain('retiré de la vague : le lancer dans une nouvelle vague');
  });

  it("R13 — lot rendu par un incident, une étape d'écriture ou un outcome inconnu : refus « lot déjà dans la vague », code 2", async () => {
    for (const outcome of ['HEAD déplacé', 'fix sans commit', 'spec non conforme après 2 passes', 'un futur outcome']) {
      let r: { code: number; err: string } | undefined;
      await liveWave(async (p) => {
        const l = store(p).readLot('a', 'L1')!;
        l.outcome = outcome;
        store(p).writeLot(l);
        r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
        expect(store(p).addQueue()).toEqual([]);
      });
      expect(r!.code, outcome).toBe(2);
      expect(r!.err, outcome).toMatch(/a:L1 : lot déjà dans la vague/);
    }
  });

  it("R1 — lot déjà en file d'ajout : refus inchangé « déjà en file d'ajout dans la vague », code 2", async () => {
    let r: { code: number; err: string } | undefined;
    await liveWave(async (p, repo) => {
      commitFile(treeOf(p, repo), 'lead-fix.txt', 'fix(L1): correctif du lead');
      store(p).requestAdd({ project: 'a', lot: 'L1' }); // L2 tient le dépôt : la demande attend
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
      expect(store(p).addQueue()).toHaveLength(1); // rien de plus déposé
    });
    expect(r!.code).toBe(2);
    expect(r!.err).toMatch(new RegExp(`a:L1 : lot déjà en file d'ajout dans la vague ${WAVE}`));
  });

  it("R3 — lot rendu sur budget : refus « lot déjà dans la vague » inchangé, code 2, rien déposé", async () => {
    let r: { code: number; err: string } | undefined;
    await liveWave(async (p) => {
      const l = store(p).readLot('a', 'L1')!;
      l.outcome = "budget du lot atteint (900/900) : étape « fix » non jouée, à décider par le lead";
      store(p).writeLot(l);
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
      expect(store(p).addQueue()).toEqual([]);
    });
    expect(r!.code).toBe(2);
    expect(r!.err).toMatch(/a:L1 : lot déjà dans la vague/);
  });

  it("R6 — budget neuf supérieur au budget restant de la vague : refus inchangé, code 2, rien déposé", async () => {
    let r: { code: number; err: string } | undefined;
    await liveWave(async (p, repo) => {
      commitFile(treeOf(p, repo), 'lead-fix.txt', 'fix(L1): correctif du lead');
      const w = store(p).readWave()!;
      store(p).writeWave({ ...w, budget: w.consumed + 1 });
      r = await run(p, ['--add', 'a:L1', '--wave', WAVE], fake());
      expect(store(p).addQueue()).toEqual([]);
      store(p).writeWave(w);
    });
    expect(r!.code).toBe(2);
    expect(r!.err).toMatch(/a:L1 : le budget restant de la vague \(\d+ tokens\) ne tient pas le budget du lot/);
  });

  it('R10 — --replay sur vague vivante : refus inchangé', async () => {
    let err = '';
    await liveWave(async (p) => {
      registerWave(cadenceHome(), { pid: process.ppid, wave: WAVE, started: 'x', cwd: p, repos: [] });
      try {
        err = (await run(p, ['--resume', '--wave', WAVE, '--replay', 'a:L1'], fake())).err;
      } finally {
        unregisterWave(cadenceHome(), process.ppid);
      }
    });
    expect(err).toMatch(/la vague \S+ tourne encore/);
  });

  it('R7 — vague finie : --add refusé avant d\'agir, lot toujours handed-back', async () => {
    const { parent, repo } = setup([{ title: 'un' }]);
    const f = fake({ review: () => blocking() });
    await run(parent, ['a:L1'], f, { slotPollMs: 20 });
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    const s = store(parent);
    commitFile(lotTreeDir(s.dir, 'a', 'L1', repo), 'lead-fix.txt', 'fix(L1): correctif du lead');
    const r = await run(parent, ['--add', 'a:L1', '--wave', WAVE], fake());
    expect(r.code).toBe(2); // aucune vague vivante : l'ajout est refusé avant d'agir
    expect(s.addQueue()).toEqual([]);
    expect(s.readLot('a', 'L1')!.status).toBe('handed-back');
  });
});
