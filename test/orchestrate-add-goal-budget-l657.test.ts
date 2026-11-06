import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addToLive, type LaunchChecks } from '../src/orchestrate/ajout.js';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { ESCALATION_RESERVE } from '../src/orchestrate/cycle/budget.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { preflight } from '../src/orchestrate/preflight.js';
import { relitObjectif } from '../src/orchestrate/reprise-objectif.js';
import { RunStore, type LotState, type StepState } from '../src/orchestrate/state.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { briefOf, claudeOut, commitFile, git, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';

// L657 (issue #44, spec goal-budget-add-resume) : --add reçoit --goal et --budget projet:lot=+N, --resume relit l'objectif changé du plan.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const WAVE = '2026-10-04-1412';

interface Proj { lots?: number; goals?: Record<string, string>; yaml?: string }
/** Des projets sous un même dossier parent ; `goals` : la clé goal: de chaque lot du plan. */
function parentWith(projects: Record<string, Proj>) {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, p] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (let i = 0; i < (p.lots ?? 1); i++) plan.add('lot', '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: false\n${p.yaml ?? ''}`);
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
    for (const [lot, goal] of Object.entries(p.goals ?? {})) setPlanGoal(dir, lot, goal);
  }
  return { parent, dirs };
}

/** Pose la clé goal: d'un lot du plan, commitée (une reprise refuse un arbre sale). */
function setPlanGoal(dir: string, lot: string, goal: string): void {
  const file = join(dir, '.cadence/raf.yaml');
  const text = readFileSync(file, 'utf8');
  const has = new RegExp(`- id: ${lot}\\n(?:    (?!id:)[^\\n]*\\n)*?    goal: `).test(text);
  const next = has ? text.replace(new RegExp(`(- id: ${lot}\\n(?:    (?!id:)[^\\n]*\\n)*?    goal: )[^\\n]*`), `$1${JSON.stringify(goal)}`) : text.replace(`- id: ${lot}\n`, `- id: ${lot}\n    goal: ${JSON.stringify(goal)}\n`);
  writeFileSync(file, next);
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', `plan: objectif de ${lot}`);
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out, err };
}

const wait = async (until: () => boolean) => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(until()).toBe(true);
};

/** Les sessions de `holder` (projet:lot) tiennent la vague jusqu'à ce que `hold` rende la main ; les autres finissent tout de suite. `briefs` : le brief de chaque session d'écriture, par lot. */
function scene(parent: string, holder: string | null, hold: (store: RunStore) => Promise<void> = async () => {}, heavy = false) {
  const briefs: Record<string, string[]> = {};
  const all: string[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    all.push(briefOf(args));
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const project = o.cwd.split('/').pop()!;
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    (briefs[`${project}:${lot}`] ??= []).push(briefOf(args));
    if (`${project}:${lot}` === holder) await hold(RunStore.last(parent)!);
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }), heavy ? { cacheWrite: 5000 } : {});
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, briefs, all };
}

/** Lance a:L1 (le lot qui tient la vague), joue `add` pendant qu'elle tient, rend ce que la commande a dit et l'état de la vague à la fin. */
async function addDuring(parent: string, add: string[], o: { unmark?: boolean; waitFor?: string } = {}) {
  let code = -1;
  let out: string[] = [];
  let err: string[] = [];
  let queued: unknown[] = [];
  let marked: unknown;
  const s = scene(parent, 'a:L1', async (store) => {
    marked = store.readWave()!.addsGoalBudget;
    if (o.unmark) {
      const w = store.readWave()!;
      delete w.addsGoalBudget;
      store.writeWave(w);
    }
    const r = io(parent);
    try {
      code = await orchestrate(['--add', ...add], r.io, s.d);
    } catch (e) {
      err = [(e as Error).message];
      code = -2;
    }
    out = r.out;
    err = [...err, ...r.err];
    queued = store.addQueue();
    if (o.waitFor) await wait(() => store.readLot(o.waitFor!.split(':')[0]!, o.waitFor!.split(':')[1]!)?.status === 'ready');
  });
  expect(await orchestrate(['a:L1', '--no-fill', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
  const store = RunStore.last(parent)!;
  return { code, out: out.join('\n'), err: err.join('\n'), queued, marked, store };
}

describe('R1 — --add sans --goal ni --budget', () => {
  it("R1 — --add seul : goal et budget du lot identiques à ceux d'avant", async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1'], { waitFor: 'b:L1' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/b:L1 : ajout déposé/);
    const b = r.store.readLot('b', 'L1')!;
    expect(b.goal).toBeUndefined();
    expect(b.budget).toBe(r.store.readLot('a', 'L1')!.budget); // même estimate, même budget dérivé que le lot lancé
  });
});

describe('R2 — --goal ne vaut que pour un seul lot ajouté', () => {
  it('R2 — deux --add et un --goal : refus, adds.log vide', async () => {
    const { parent } = parentWith({ a: {}, b: { lots: 2 } });
    const r = await addDuring(parent, ['b:L1', '--add', 'b:L2', '--goal', 'un objectif']);
    expect(r.code).toBe(-2);
    expect(r.err).toContain("--goal s'applique à un seul lot lancé : <projet>:<lot> --goal \"…\" (plusieurs lots : la clé goal: de chacun)");
    expect(r.queued).toEqual([]);
    expect(existsSync(join(r.store.dir, 'adds.log'))).toBe(false); // rien n'a été écrit
  });
  it("R2 — --add avec un seul lot et --goal : accepté, le lot porte l'objectif donné", async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--goal', 'faire seulement ceci'], { waitFor: 'b:L1' });
    expect(r.code).toBe(0);
    expect(r.store.readLot('b', 'L1')!.goal).toBe('faire seulement ceci');
  });
});

describe('R3 — un --goal vide ou qui avale l\'option suivante', () => {
  it('R3 — --add p:L --goal --wave w : refus « --goal attend un texte »', () => {
    expect(() => parseOrchestrateArgs(['--add', 'b:L1', '--goal', '--wave', 'w'])).toThrow('--goal attend un texte');
    expect(() => parseOrchestrateArgs(['--add', 'b:L1', '--goal', '  '])).toThrow('--goal attend un texte non vide');
  });
});

describe('R4 — --budget avec --add', () => {
  it("R4 — command.ts:125 adapté : --budget p:lot=+N accepté avec --add (la forme sans --resume n'est refusée que sans --add)", async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L1=+300k'], { waitFor: 'b:L1' });
    expect(r.code).toBe(0);
    await expect(orchestrate(['b:L1', '--budget', 'b:L1=+300k'], io(parent).io, scene(parent, null).d)).rejects.toThrow("--budget projet:lot=+N ne vaut qu'avec --resume");
  });
  it("R4 — --budget d'un lot absent des --add : refus", async () => {
    const { parent } = parentWith({ a: {}, b: { lots: 2 } });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L2=+300k']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--budget b:L2 : lot absent des --add de la commande');
    expect(r.queued).toEqual([]);
  });
  it('R4 — --budget 2M avec --add : refus inchangé', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--budget', '2M']);
    expect(r.code).toBe(-2);
    expect(r.err).toContain('--add ne se combine avec aucune autre action');
  });
  it('R4 — --budget p:L=+N répété sur le même lot : refus', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L1=+300k', '--budget', 'b:L1=+400k']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--budget b:L1 : lot visé deux fois');
    expect(r.queued).toEqual([]);
  });
});

describe('R5 — le budget du lot ajouté', () => {
  it('R5 — --budget p:L=+300k : état du lot budget = 300k (sans escalade déclarée)', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L1=+300k'], { waitFor: 'b:L1' });
    expect(r.store.readLot('b', 'L1')!.budget).toBe(300_000);
  });
  it('R5 — --budget p:L=+300k : état du lot budget = 300k + réserve d\'escalade quand la vague en réserve une', async () => {
    const { parent } = parentWith({ a: {}, b: { yaml: '  escalation:\n    model: opus\n' } });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L1=+300k'], { waitFor: 'b:L1' });
    const b = r.store.readLot('b', 'L1')!;
    expect(b.escalationReserve).toBe(ESCALATION_RESERVE);
    expect(b.budget).toBe(300_000 + ESCALATION_RESERVE);
  });
  it('R5 — budget supérieur au restant : refus nommant le lot', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L1=+3M']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/b:L1 : le budget restant de la vague \(\d+ tokens\) ne tient pas le budget du lot \(3000000\)/);
    expect(r.queued).toEqual([]);
  });
});

describe('R6 — lot rendu repris par --add', () => {
  const rendu = { project: 'a', lot: 'L1', repo: '/x/a', status: 'handed-back', next: 'fix', outcome: 'revue non conforme après 2 passe(s) de correction', steps: [], goal: 'objectif de la vague', budget: 100 } as unknown as LotState;
  const asked = async (argv: string[], lotsAjoutes = ['L1']) => {
    const requested: unknown[] = [];
    const store = { id: 'W', dir: tempDir(), lots: () => [rendu], addQueue: () => [], readWave: () => ({ budget: 1e6, consumed: 0, addsGoalBudget: true }), requestAdd: (t: unknown) => (requested.push(t), 1), markAddTaken: () => {}, journal: () => {} } as unknown as RunStore;
    const checks: LaunchChecks = { resolveTargets: () => lotsAjoutes.map((lot) => ({ project: 'a', projectDir: '/x/a', repo: '/x/a', lot, model: 'sonnet' })), preflight: async () => ({ refusals: [], lots: [] }) };
    const e = io('/x');
    const code = await addToLive(parseOrchestrateArgs(argv), { io: e.io, deps: {} as OrchestrateDeps, launch: '/x' }, store, checks);
    return { code, err: e.err.join('\n'), requested };
  };
  it('R6 — lot rendu repris avec --goal : refus et goal d\'état inchangé', async () => {
    const r = await asked(['--add', 'a:L1', '--goal', 'un autre']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('a:L1 : lot rendu repris : il garde son objectif et son budget, --goal et --budget lui sont refusés');
    expect(r.requested).toEqual([]);
    expect(rendu.goal).toBe('objectif de la vague');
  });
  it('R6 — lot rendu repris avec --budget : refusé de même', async () => {
    const r = await asked(['--add', 'a:L1', '--budget', 'a:L1=+300k']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('lot rendu repris : il garde son objectif et son budget');
    expect(r.requested).toEqual([]);
  });
  it('R6 — lot rendu repris sans --goal ni --budget qui le vise : le --budget d\'un autre lot ajouté ne le fait pas refuser', async () => {
    const r = await asked(['--add', 'a:L1', '--add', 'a:L2', '--budget', 'a:L2=+300k'], ['L1', 'L2']);
    expect(r.err).not.toContain('il garde son objectif et son budget');
  });
});

describe('R11 — la marque de la vague', () => {
  it('R11 — vague lancée par le code du lot : la marque est dans l\'état', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1'], { waitFor: 'b:L1' });
    expect(r.marked).toBe(true);
  });
  it('R11 — vague sans marque et --add --goal : refus, adds.log vide', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--goal', 'un objectif'], { unmark: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("cette vague a été lancée avant L657 : elle ignore --goal et --budget d'un ajout ; ajoutez le lot sans ces options, ou relancez la vague");
    expect(r.queued).toEqual([]);
  });
  it('R11 — vague sans instantané ni marque et --add --budget : refus', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1', '--budget', 'b:L1=+300k'], { unmark: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain('cette vague a été lancée avant L657');
    expect(r.queued).toEqual([]);
  });
  it('R11 — vague sans marque et --add seul : accepté', async () => {
    const { parent } = parentWith({ a: {}, b: {} });
    const r = await addDuring(parent, ['b:L1'], { unmark: true, waitFor: 'b:L1' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/b:L1 : ajout déposé/);
  });
});

// ——— Reprise ———

const step = (n: number): StepState => ({ n, kind: 'implement', model: 'sonnet', status: 'ok', started: '2026-10-04T10:00:00' });

/** Une vague arrêtée sur budget (a:L1, plus a:L2 jamais commencé quand `two`), puis les doublures de la reprise. */
async function stopped(o: { goals?: Record<string, string>; launchGoal?: string; two?: boolean } = {}) {
  const w = parentWith({ a: { lots: o.two ? 2 : 1, goals: o.goals } });
  const s = scene(w.parent, null, undefined, true); // la première session dépasse le budget de 2000 : la vague s'arrête, reprenable
  const code = await orchestrate(['a:L1', ...(o.two ? ['a:L2'] : []), ...(o.launchGoal ? ['--goal', o.launchGoal] : []), '--budget', '2000', '--max-sessions', '1'], io(w.parent).io, s.d);
  expect(code).toBe(3);
  const store = new RunStore(w.parent, WAVE);
  const resumed = async () => {
    const r = scene(w.parent, null);
    const out = io(w.parent);
    const rc = await orchestrate(['--resume', WAVE, '--budget', '2M'], out.io, r.d);
    return { rc, out: out.out.join('\n'), briefs: r.all, journal: readFileSync(join(store.dir, 'journal.log'), 'utf8') };
  };
  return { ...w, store, resumed };
}

describe('R7 — objectif du plan inchangé', () => {
  it("R7 — objectif du plan inchangé : goal d'état identique, aucune ligne « objectif changé »", async () => {
    const w = await stopped({ goals: { L1: 'objectif Y' } });
    expect(w.store.readLot('a', 'L1')!.goal).toBe('objectif Y');
    const r = await w.resumed();
    expect(r.rc).toBe(0);
    expect(w.store.readLot('a', 'L1')!.goal).toBe('objectif Y');
    expect(r.journal + r.out).not.toContain('objectif changé');
  });
  it('R7 — lancement --goal X avec plan goal: Y inchangé : X gardé à la reprise, aucune ligne', async () => {
    const w = await stopped({ goals: { L1: 'objectif Y' }, launchGoal: 'objectif X' });
    expect(w.store.readLot('a', 'L1')!.goal).toBe('objectif X');
    const r = await w.resumed();
    expect(r.rc).toBe(0);
    expect(w.store.readLot('a', 'L1')!.goal).toBe('objectif X');
    expect(r.journal + r.out).not.toContain('objectif changé');
  });
});

describe('R8 — un objectif changé du plan est relu à la reprise', () => {
  it('R8 — plan goal différent de l\'état : le brief de la reprise cite le nouvel objectif', async () => {
    const w = await stopped({ goals: { L1: 'ancien objectif' } });
    setPlanGoal(w.dirs.a!, 'L1', 'nouvel objectif du plan');
    const r = await w.resumed();
    expect(r.rc).toBe(0);
    expect(w.store.readLot('a', 'L1')!.goal).toBe('nouvel objectif du plan');
    expect(r.briefs.join('\n')).toContain('nouvel objectif du plan');
    expect(r.journal).toMatch(/a:L1 : objectif changé : « ancien objectif » → « nouvel objectif du plan »/);
  });
  it('R8 — lot sans étape et objectif qui rétrécit : maquette sautée à la reprise', async () => {
    const dir = mono({ screen: 'component' }, 1);
    const l = await launched(dir, 'Revoir la mise en page du composant');
    expect(l.screen).toBe('component');
    setPlanGoal(dir, 'L1', 'corriger quatre erreurs de calcul');
    expect(relitObjectif(l)).toMatch(/objectif changé/);
    expect(l.goal).toBe('corriger quatre erreurs de calcul');
    expect(l.screen).toBeUndefined();
  });
  it('R8 — lot déjà démarré : steps et screen inchangés', async () => {
    const dir = mono({ screen: 'component' }, 1);
    const l = await launched(dir, 'Revoir la mise en page du composant');
    l.steps = [step(1)];
    setPlanGoal(dir, 'L1', 'corriger quatre erreurs de calcul');
    expect(relitObjectif(l)).toMatch(/objectif changé/);
    expect(l.goal).toBe('corriger quatre erreurs de calcul');
    expect(l.screen).toBe('component');
    expect(l.steps).toHaveLength(1);
  });
});

/** Un projet a à un lot visible à écran, avec `commits` commits du lot déjà dans la base (de quoi rétrécir). */
function mono(lot: { screen: 'component' }, commits: number): string {
  const { dirs } = parentWith({ a: {} });
  const dir = dirs.a!;
  const file = join(dir, '.cadence/raf.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('    status: todo\n', `    status: todo\n    visible: true\n    screen: ${lot.screen}\n`));
  git(dir, 'add', '--', '.cadence/raf.yaml');
  git(dir, 'commit', '-q', '-m', 'plan: lot visible');
  for (let i = 0; i < commits; i++) commitFile(dir, `old${i}.txt`, 'feat(L1): déjà intégré');
  return dir;
}

/** L'état d'un lot tel que le lancement l'écrit (comme le contrôle préalable du lancement), avec `goal` en ligne de commande. */
async function launched(dir: string, goal?: string): Promise<LotState> {
  const e = io(dir);
  const deps: OrchestrateDeps = { claude: async () => { throw new Error('pas de session'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  const r = await preflight({ dryRun: true, ...(goal ? { goal } : {}) }, [{ project: 'a', projectDir: dir, repo: dir, lot: 'L1', model: 'sonnet' }], e.io, deps, tempDir());
  expect(r.refusals).toEqual([]);
  return r.lots[0]!;
}

describe('R9 — le dernier geste explicite gagne', () => {
  it('R9 — lancement --goal X, plan goal: Y inchangé : X gardé', async () => {
    const w = await stopped({ goals: { L1: 'objectif Y' }, launchGoal: 'objectif X' });
    const l = w.store.readLot('a', 'L1')!;
    expect([l.goal, l.planGoal]).toEqual(['objectif X', 'objectif Y']);
    expect(relitObjectif(l)).toBeNull();
    expect(l.goal).toBe('objectif X');
  });
  it('R9 — lancement --goal X, plan goal: Y puis changé en Z : Z l\'emporte et le journal cite X et Z', async () => {
    const w = await stopped({ goals: { L1: 'objectif Y' }, launchGoal: 'objectif X' });
    setPlanGoal(w.dirs.a!, 'L1', 'objectif Z');
    const r = await w.resumed();
    expect(r.rc).toBe(0);
    const l = w.store.readLot('a', 'L1')!;
    expect([l.goal, l.planGoal]).toEqual(['objectif Z', 'objectif Z']);
    expect(r.journal).toContain('objectif changé : « objectif X » → « objectif Z »');
  });
  it('R9 — --goal de lancement et plan sans goal: : goal gardé', async () => {
    const w = await stopped({ launchGoal: 'objectif X' });
    const l = w.store.readLot('a', 'L1')!;
    expect([l.goal, l.planGoal]).toEqual(['objectif X', '']);
    const r = await w.resumed();
    expect(w.store.readLot('a', 'L1')!.goal).toBe('objectif X');
    expect(r.journal + r.out).not.toContain('objectif changé');
  });
  it('R9 — --add --goal X, plan goal: Y inchangé : X gardé à la reprise', async () => {
    const { parent } = parentWith({ a: {}, b: { goals: { L1: 'objectif Y' } } });
    const r = await addDuring(parent, ['b:L1', '--goal', 'objectif X'], { waitFor: 'b:L1' });
    const b = r.store.readLot('b', 'L1')!;
    expect([b.goal, b.planGoal]).toEqual(['objectif X', 'objectif Y']);
    expect(relitObjectif(b)).toBeNull();
    expect(b.goal).toBe('objectif X');
  });
  it('R9 — après un plan changé repris, une seconde reprise sans nouveau changement : aucune ligne', async () => {
    const dir = mono({ screen: 'component' }, 0);
    const l = await launched(dir, 'objectif X');
    setPlanGoal(dir, 'L1', 'objectif Z');
    expect(relitObjectif(l)).toContain('objectif changé');
    expect(relitObjectif(l)).toBeNull();
    expect(l.goal).toBe('objectif Z');
  });
});

describe('R10 — plan sans le lot ou illisible', () => {
  it("R10 — lot absent du plan : --resume n'est pas refusé à l'entrée, goal d'état gardé et aucune ligne « objectif changé »", async () => {
    const w = await stopped({ goals: { L1: 'objectif Y' } });
    const file = join(w.dirs.a!, '.cadence/raf.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- id: L1\n', '- id: L9\n'));
    git(w.dirs.a!, 'add', '--', '.cadence/raf.yaml');
    git(w.dirs.a!, 'commit', '-q', '-m', 'plan: renommé');
    const r = await w.resumed();
    expect(r.rc).not.toBe(2);
    expect(w.store.readLot('a', 'L1')!.goal).toBe('objectif Y');
    expect(r.journal + r.out).not.toContain('objectif changé');
  });
  it("R10 — lot absent du plan : reprise sans refus, goal d'état gardé", async () => {
    const w = await stopped({ goals: { L1: 'objectif Y' } });
    const l = w.store.readLot('a', 'L1')!;
    writeFileSync(join(w.dirs.a!, '.cadence/raf.yaml'), readFileSync(join(w.dirs.a!, '.cadence/raf.yaml'), 'utf8').replace('- id: L1\n', '- id: L9\n'));
    git(w.dirs.a!, 'add', '--', '.cadence/raf.yaml');
    git(w.dirs.a!, 'commit', '-q', '-m', 'plan: renommé');
    expect(relitObjectif(l)).toBeNull();
    expect(l.goal).toBe('objectif Y');
    writeFileSync(join(w.dirs.a!, '.cadence/raf.yaml'), 'version: 1\nlots: [\n');
    expect(relitObjectif(l)).toBeNull();
    expect(l.goal).toBe('objectif Y');
  });
});

describe('R12 — état sans planGoal (vague d\'avant L657)', () => {
  it('R12 — état sans planGoal et plan différent : le plan l\'emporte, planGoal écrit', async () => {
    const dir = mono({ screen: 'component' }, 0);
    const l = await launched(dir, 'objectif X');
    delete l.planGoal;
    setPlanGoal(dir, 'L1', 'objectif Y');
    expect(relitObjectif(l)).toContain('objectif changé : « objectif X » → « objectif Y »');
    expect([l.goal, l.planGoal]).toEqual(['objectif Y', 'objectif Y']);
  });
  it('R12 — état sans planGoal et plan identique : aucune ligne', async () => {
    const dir = mono({ screen: 'component' }, 0);
    setPlanGoal(dir, 'L1', 'objectif Y');
    const l = await launched(dir);
    delete l.planGoal;
    expect(relitObjectif(l)).toBeNull();
    expect(l.goal).toBe('objectif Y');
  });
});
