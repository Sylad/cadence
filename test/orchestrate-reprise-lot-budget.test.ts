import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import type { ClaudeFn, LaunchOutcome } from '../src/orchestrate/launch.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, briefOf, reviewReport, specReport, workReport, precheckReport } from './orchestrate-harness.js';
import { ecritBack } from './spec-helpers.js';
import { tempDir } from './helpers.js';
import { toolDirOf } from '../src/orchestrate/snapshot.js';

// L223 — reprise ciblée d'un lot rendu sur budget : --resume <vague> --budget projet:lot=+N.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const WAVE = '2026-10-04-1412';
type Over = Partial<Record<'implement' | 'review' | 'fix' | 'review-small' | 'spec' | 'fiche', (cwd: string, brief: string, args: string[]) => LaunchOutcome>>;

function parentWith(projects: Record<string, { title: string; estimate?: number; spec?: boolean }[]>) {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, lots] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    for (const l of lots) plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 0.5, spec: l.spec });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

function fakeDeps(over: Over = {}) {
  const calls: { cwd: string; kind: string; args: string[]; brief: string }[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    calls.push({ cwd: o.cwd, kind, args, brief: briefOf(args) });
    const custom = over[kind as keyof Over];
    if (custom) return custom(o.cwd, briefOf(args), args);
    if (kind === 'precheck') return claudeOut(precheckReport());
    if (kind === 'implement' || kind === 'fix') {
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `${kind}-${Math.random()}.txt`, `${kind === 'fix' ? 'fix' : 'feat'}(${lot}): travail`)] }));
    }
    return claudeOut(reviewReport());
  };
  const deps: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR };
  return { deps, calls };
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out, err };
}

/** Revue non conforme qui coûte 400 k : le lot (budget 540 k) ne peut plus payer la passe fix → « correction non jouée (budget) ». */
const costlyMajor = () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'a.txt', ligne: 3, texte: 'bug nommé' }], verdict: 'non conforme' }), { cacheWrite: 400_000 });

/** Une vague réellement rendue sur budget par le programme (outcome produit par overBudget). */
async function handedBack(over: Over = {}, projects: Record<string, { title: string; estimate?: number }[]> = { a: [{ title: 'un' }] }) {
  const w = parentWith(projects);
  const code = await orchestrate(['a:L1'], io(w.parent).io, fakeDeps({ review: costlyMajor, ...over }).deps);
  const store = new RunStore(w.parent, WAVE);
  // la reprise a ses propres doublures : la revue y est conforme sauf mention contraire
  const f = fakeDeps();
  return { ...w, f, code, store, lot: () => store.readLot('a', 'L1')! };
}

const read = (parent: string) => new RunStore(parent, WAVE);

describe('R1 — lecture de --budget projet:lot=+N', () => {
  it('R1 — --budget maritime:B26.4=+200k est lu comme relèvement du lot, --budget 2M comme budget de vague', () => {
    expect(parseOrchestrateArgs(['--resume', '--budget', 'maritime:B26.4=+200k'])).toMatchObject({ lotBudgets: [{ project: 'maritime', lot: 'B26.4', raise: 200_000 }] });
    const wave = parseOrchestrateArgs(['--resume', '--budget', '2M']);
    expect(wave.budget).toBe(2_000_000);
    expect(wave.lotBudgets).toEqual([]);
  });
  it('R1 — deux options --budget projet:lot=+N pour deux lots sont toutes deux prises', () => {
    const a = parseOrchestrateArgs(['--resume', '--budget', 'a:L1=+200k', '--budget', 'a:L2=+0.3M', '--budget', '1M']);
    expect(a.lotBudgets.map((x) => [x.project, x.lot, x.raise])).toEqual([['a', 'L1', 200_000], ['a', 'L2', 300_000]]);
    expect(a.budget).toBe(1_000_000);
  });
  it('R1 — lot seul (B26.4=+200k) accepté quand un seul projet le porte', async () => {
    const r = await handedBack();
    expect(r.lot().status).toBe('handed-back');
    expect(parseOrchestrateArgs(['--resume', '--budget', 'L1=+300k']).lotBudgets).toMatchObject([{ lot: 'L1', raise: 300_000 }]);
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'L1=+300k'], again.io, r.f.deps)).toBe(0);
    expect(r.lot().status).toBe('ready');
  });
  it('R1 — --resume --budget 500k relève toujours la vague de 500 k au-dessus du consommé', async () => {
    const w = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', 'a:L2', '--budget', '2000'], io(w.parent).io, f.deps)).toBe(3);
    expect(await orchestrate(['--resume', '--budget', '500k'], io(w.parent).io, f.deps)).toBe(0);
    const wave = read(w.parent).readWave()!;
    expect(wave.budget).toBeGreaterThanOrEqual(500_000);
    expect(wave.budget - 500_000).toBeLessThanOrEqual(wave.consumed); // le consommé d'avant, plus ce que la reprise a dépensé ensuite
  });
});

describe('R2 — budget relevé', () => {
  it('R2 — lot à 849000 dépensés pour 750000, =+300k : budget 1149000', async () => {
    const r = await handedBack();
    const lot = r.lot();
    lot.budget = 750_000;
    lot.steps[lot.steps.length - 1]!.tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, counted: 849_000 - lot.steps.slice(0, -1).reduce((n, s) => n + (s.tokens?.counted ?? 0), 0) };
    r.store.writeLot(lot);
    const spent = lot.steps.reduce((n, s) => n + (s.tokens?.counted ?? 0), 0);
    expect(spent).toBe(849_000);
    const out = io(r.parent);
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], out.io, r.f.deps);
    expect(r.lot().budget).toBe(1_149_000);
    expect(out.out.join('\n')).toContain('a:L1 → suspended — budget relevé de 750000 à 1149000 (--resume --budget)');
    expect(r.lot().warnings.join('\n')).toContain('budget relevé de 750000 à 1149000');
  });
  it("R2 — le budget d'un lot non visé n'est pas modifié", async () => {
    const w = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps({ review: costlyMajor });
    await orchestrate(['a:L1', 'a:L2'], io(w.parent).io, f.deps);
    const store = read(w.parent);
    const other = store.readLot('a', 'L2')!;
    expect(other.status).toBe('handed-back');
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(w.parent).io, f.deps);
    expect(store.readLot('a', 'L2')).toEqual(other);
    expect(store.readLot('a', 'L1')!.budget).not.toBe(other.budget);
  });
});

describe('R3 / R4 / R5 — étape rejouée en session neuve', () => {
  it('R3 — lot rendu « correction non jouée (budget) » avec next fix : repris, fix joué', async () => {
    const r = await handedBack();
    expect(r.code).toBe(1);
    expect(r.lot().outcome).toMatch(/correction non jouée \(budget\)/);
    expect(r.lot().outcome).toContain('étape « fix » non jouée');
    const before = r.f.calls.length;
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], again.io, r.f.deps)).toBe(0);
    expect(r.f.calls.slice(before).map((c) => c.kind)).toEqual(['fix', 'review']);
    expect(r.lot().status).toBe('ready');
    expect(r.lot().outcome).not.toMatch(/budget/);
    expect(read(r.parent).readWave()!.status).toBe('done');
  });
  it('R3 — lot rendu « budget du lot atteint » avec next implement : repris, implémentation jouée', async () => {
    const w = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--budget', '1'], io(w.parent).io, f.deps)).toBe(3);
    const store = read(w.parent);
    const lot = store.readLot('a', 'L1')!;
    lot.status = 'handed-back';
    lot.next = 'implement';
    lot.budget = 1000;
    lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'interrupted', started: 'x', tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, counted: 1000 } });
    lot.outcome = 'budget du lot atteint (1000 / 1000 tokens comptés, dérivé de l\'estimate) : étape « implement » non jouée, à décider par le lead';
    store.writeLot(lot);
    const w0 = store.readWave()!;
    w0.status = 'done';
    store.writeWave(w0);
    const before = f.calls.length;
    expect(await orchestrate(['--resume', WAVE, '--budget', '1M', '--budget', 'a:L1=+200k'], io(w.parent).io, f.deps)).toBe(0);
    expect(f.calls.slice(before)[0]!.kind).toBe('implement');
  });
  it('R3 — lot avec next spec ou accept rendu sur budget : repris', async () => {
    for (const next of ['spec', 'accept'] as const) {
      const w = parentWith({ a: [{ title: 'un' }] });
      const f = fakeDeps();
      expect(await orchestrate(['a:L1', '--budget', '1'], io(w.parent).io, f.deps)).toBe(3);
      const store = read(w.parent);
      const lot = store.readLot('a', 'L1')!;
      lot.status = 'handed-back';
      lot.next = next;
      lot.budget = 1000;
      lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'ok', started: 'x', tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, counted: 1000 } });
      lot.outcome = `budget du lot atteint (1000 / 1000 tokens comptés, dérivé de l'estimate) : étape « ${next} » non jouée, à décider par le lead`;
      store.writeLot(lot);
      const out = io(w.parent);
      store.writeWave({ ...store.readWave()!, status: 'done' });
      await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+200k'], out.io, f.deps);
      expect(out.out.join('\n')).toMatch(/budget relevé de 1000 à \d+ \(--resume --budget\)/);
      expect(out.err.join()).not.toContain('pas rendu sur budget');
    }
  });
  it('R3 — lot handed-back avec next review : refusé (une revue n\'est pas rendue sur budget)', async () => {
    const r = await handedBack();
    const lot = r.lot();
    lot.next = null;
    lot.outcome = "budget du lot atteint (1000 / 1000 tokens comptés, dérivé de l'estimate) : étape « review » non jouée, à décider par le lead";
    r.store.writeLot(lot);
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], again.io, r.f.deps)).toBe(2);
    expect(again.err.join('\n')).toContain("orchestrate : --budget a:L1 : le lot n'est pas rendu sur budget avec une étape d'écriture à rejouer (handed-back");
  });
  it('R3 — l\'outcome du lot repris est vidé et son statut n\'est plus handed-back pendant la reprise', async () => {
    const r = await handedBack();
    const seen: string[] = [];
    const f = fakeDeps({ review: costlyMajor, fix: (cwd) => { const l = read(r.parent).readLot('a', 'L1')!; seen.push(`${l.status}|${l.outcome ?? ''}`); return claudeOut(workReport({ commits: [commitFile(cwd, 'z.txt', 'fix(L1): z')] })); } });
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, f.deps);
    expect(seen).toEqual(['fixing|']);
  });
  it('R3 — lot rendu non conforme après 2 passes (next null) : refusé', async () => {
    const r = await handedBack();
    const lot = r.lot();
    lot.next = null;
    lot.outcome = 'non conforme après 2 passes de correction';
    r.store.writeLot(lot);
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], again.io, r.f.deps)).toBe(2);
    expect(again.err.join('\n')).toContain("le lot n'est pas rendu sur budget avec une étape d'écriture à rejouer");
  });
  it('R4 — le fix repris a un sessionId absent des étapes précédentes et un lancement sans --resume', async () => {
    const r = await handedBack();
    const old = r.lot().steps.map((s) => s.sessionId);
    const before = r.f.calls.length;
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps);
    const fixCall = r.f.calls.slice(before).find((c) => c.kind === 'fix')!;
    expect(fixCall.args).not.toContain('--resume');
    const fixStep = r.lot().steps.find((s) => s.kind === 'fix')!;
    expect(fixStep.sessionId).toBeTruthy();
    expect(old).not.toContain(fixStep.sessionId);
    expect(old).not.toContain(fixCall.args[fixCall.args.indexOf('--session-id') + 1]);
  });
  it('R4 — les étapes déjà jouées et le compteur de passes sont conservés', async () => {
    const r = await handedBack();
    const first = r.lot().steps.map((s) => ({ n: s.n, kind: s.kind, sessionId: s.sessionId }));
    const pass = r.lot().pass;
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps);
    expect(r.lot().steps.slice(0, first.length).map((s) => ({ n: s.n, kind: s.kind, sessionId: s.sessionId }))).toEqual(first);
    expect(r.lot().pass).toBe(pass);
  });
  it('R4 — le brief du fix repris reprend les constats de la revue', async () => {
    const r = await handedBack();
    const before = r.f.calls.length;
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps);
    expect(r.f.calls.slice(before).find((c) => c.kind === 'fix')!.brief).toContain('bug nommé');
  });
  it('R5 — budget relevé juste au-dessus de la réserve : le fix est joué', async () => {
    const r = await handedBack();
    const before = r.f.calls.length;
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+155001'], io(r.parent).io, r.f.deps);
    expect(r.f.calls.slice(before).map((c) => c.kind)[0]).toBe('fix');
  });
  it('R5 — fix joué puis budget insuffisant pour la passe suivante : rendu avec « correction non jouée (budget) »', async () => {
    const r = await handedBack();
    const f = fakeDeps({ review: costlyMajor, 'review-small': costlyMajor });
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+160k'], again.io, f.deps)).toBe(1);
    expect(f.calls.map((c) => c.kind)).toEqual(['fix', 'review']);
    expect(r.lot().status).toBe('handed-back');
    expect(r.lot().outcome).toMatch(/^correction non jouée \(budget\) : /);
  });
});

describe('R6 / R7 / R11 — vague, verdict, reprise sans option', () => {
  it('R6 — vague done, lot visé reprenable : la reprise a lieu et la vague finit done', async () => {
    const r = await handedBack();
    expect(read(r.parent).readWave()!.status).toBe('done');
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps)).toBe(0);
    expect(read(r.parent).readWave()!.status).toBe('done');
  });
  it('R6 — vague done sans option de lot : toujours refusée « est terminée »', async () => {
    const r = await handedBack();
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE], again.io, r.f.deps)).toBe(2);
    expect(again.err.join()).toContain(`la vague ${WAVE} est terminée`);
  });
  it('R6 — vague épuisée : lot suspendu, code 3', async () => {
    const r = await handedBack();
    const wave = r.store.readWave()!;
    const again = io(r.parent);
    // vague épuisée : --budget 1 de vague posé en même temps que le relèvement du lot
    expect(await orchestrate(['--resume', WAVE, '--budget', '1', '--budget', 'a:L1=+300k'], again.io, r.f.deps)).toBe(3);
    expect(r.lot().status).toBe('suspended');
    expect(read(r.parent).readWave()!.status).toBe('suspended-budget');
    expect(wave.status).toBe('done');
  });
  it('R7 — lot repris puis revue conforme : verdict enregistré avec le sha relu', async () => {
    const r = await handedBack();
    expect(Plan.load(join(r.dirs.a, 'docs/plan/raf.yaml')).lot('L1').review).toBeUndefined();
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps);
    const plan = Plan.load(join(r.dirs.a, 'docs/plan/raf.yaml'));
    expect(plan.lot('L1').review?.verdict).toContain('orchestré');
    expect(plan.lot('L1').review?.commit).toBe(git(r.dirs.a, 'log', '--grep=^fix(L1)', '-1', '--format=%H'));
    expect(git(r.dirs.a, 'log', '--format=%s', '-3')).toContain('revue de code enregistrée');
  });
  it('R7 — lot repris, mineur déjà noté : le nombre de notes « Revue de la fiche » du lot dans le plan (plan.lot(lot).notes) est inchangé après la revue rejouée', async () => {
    // lot à fiche rendu sur budget avant la spec ; sa revue de fiche, rejouée à la reprise, rend un mineur déjà noté
    const w = parentWith({ a: [{ title: 'un', spec: true }] });
    // la vague d'origine ne sert qu'à créer l'état du lot ; il est ramené à « rendu avant la spec, budget du lot atteint »
    await orchestrate(['a:L1', '--budget', '1'], io(w.parent).io, fakeDeps().deps);
    const store = read(w.parent);
    const lot = store.readLot('a', 'L1')!;
    expect(lot.specLot).toBe(true);
    lot.status = 'handed-back';
    lot.next = 'spec';
    lot.budget = 1000;
    lot.spec = undefined;
    lot.steps = [];
    lot.steps.push({ n: 1, kind: 'precheck', model: 'sonnet', status: 'ok', started: 'x', tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, counted: 1000 } });
    lot.outcome = "budget du lot atteint (1000 / 1000 tokens comptés, dérivé de l'estimate) : étape « spec » non jouée, à décider par le lead";
    store.writeLot(lot);
    store.writeWave({ ...store.readWave()!, status: 'done' });
    const file = join(w.dirs.a, 'docs/plan/raf.yaml');
    const plan = Plan.load(file);
    plan.note('L1', 'Revue de la fiche — mineur : nom vague', '2026-10-04');
    plan.save();
    git(w.dirs.a, 'commit', '-q', '-m', 'plan: note', '--', 'docs/plan/raf.yaml');
    const revue = () => Plan.load(file).lot('L1').notes.filter((n) => n.text.startsWith('Revue de la fiche'));
    expect(revue()).toHaveLength(1);
    const g = fakeDeps({
      spec: (cwd) => claudeOut(specReport({ fiche: ecritBack(cwd) })),
      fiche: () => claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', texte: 'nom vague' }] })),
    });
    expect(await orchestrate(['--resume', WAVE, '--budget', '1M', '--budget', 'a:L1=+300k'], io(w.parent).io, g.deps)).toBe(0);
    expect(g.calls.map((c) => c.kind).slice(0, 2)).toEqual(['spec', 'fiche']);
    expect(revue().map((n) => n.text)).toEqual(['Revue de la fiche — mineur : nom vague']);
  });
  it('R7 — lot repris : le plan ne contient qu\'un seul verdict enregistré pour le lot après la reprise', async () => {
    const r = await handedBack();
    const file = join(r.dirs.a, 'docs/plan/raf.yaml');
    const before = git(r.dirs.a, 'log', '--format=%s', '--grep=revue de code enregistrée').split('\n').filter(Boolean).length;
    expect(before).toBe(0); // rendu sur budget : aucune revue conforme, donc aucun verdict avant la reprise
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps);
    expect(git(r.dirs.a, 'log', '--format=%s', '--grep=revue de code enregistrée').split('\n').filter(Boolean)).toHaveLength(1);
    expect(Plan.load(file).lot('L1').review?.verdict).toBeTruthy();
    expect(git(r.dirs.a, 'status', '--porcelain', '--', 'docs/plan/raf.yaml')).toBe('');
  });
  it('R7 — lot repris, revue non conforme : pas de verdict enregistré, le lot est rendu', async () => {
    const r = await handedBack();
    const f = fakeDeps({ review: costlyMajor, 'review-small': costlyMajor });
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+160k'], io(r.parent).io, f.deps);
    expect(Plan.load(join(r.dirs.a, 'docs/plan/raf.yaml')).lot('L1').review).toBeUndefined();
    expect(r.lot().status).toBe('handed-back');
  });
  it('R11 — reprise sans option : un lot handed-back reste handed-back', async () => {
    const w = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps({ review: costlyMajor });
    const first = await orchestrate(['a:L1', 'a:L2', '--max-sessions', '1', '--budget', '600k'], io(w.parent).io, f.deps);
    expect(first).toBe(3);
    const s = read(w.parent);
    expect(s.readLot('a', 'L1')!.status).toBe('handed-back');
    const calls = f.calls.length;
    await orchestrate(['--resume', '--budget', '3M'], io(w.parent).io, f.deps);
    expect(read(w.parent).readLot('a', 'L1')!.status).toBe('handed-back');
    expect(f.calls.slice(calls).every((c) => c.cwd === w.dirs.a)).toBe(true);
  });
  it('R11 — vague done sans option : refusée', async () => {
    const r = await handedBack();
    expect(read(r.parent).readWave()!.status).toBe('done');
    const again = io(r.parent);
    expect(await orchestrate(['--resume', WAVE], again.io, r.f.deps)).toBe(2);
    expect(again.err.join()).toContain(`la vague ${WAVE} est terminée`);
    expect(r.lot().status).toBe('handed-back');
  });
  it('R11 — --budget 500k relève le budget de vague de 500 k au-dessus du consommé', async () => {
    const w = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', 'a:L2', '--budget', '2000'], io(w.parent).io, f.deps)).toBe(3);
    const consumedBefore = read(w.parent).readWave()!.consumed;
    await orchestrate(['--resume', '--budget', '500k'], io(w.parent).io, f.deps);
    const after = read(w.parent).readWave()!;
    expect(after.budget).toBe(consumedBefore + 500_000);
  });
});

describe('R8 / R9 / R10 / R13 — refus avant écriture', () => {
  const resumeErr = async (r: Awaited<ReturnType<typeof handedBack>>, ...extra: string[]) => {
    const snapshotBefore = JSON.stringify([read(r.parent).readWave(), r.lot()]);
    const out = io(r.parent);
    const code = await orchestrate(['--resume', WAVE, ...extra], out.io, r.f.deps);
    return { code, err: out.err.join('\n'), unchanged: JSON.stringify([read(r.parent).readWave(), r.lot()]) === snapshotBefore };
  };
  it('R8 — projet:lot=+abc refusé avec le texte exact', () => {
    expect(() => parseOrchestrateArgs(['--resume', '--budget', 'a:L1=+abc'])).toThrow('--budget invalide : a:L1=+abc (projet:lot=+500k)');
  });
  it('R8 — projet:lot=+0 refusé', () => {
    expect(() => parseOrchestrateArgs(['--resume', '--budget', 'a:L1=+0'])).toThrow('--budget invalide : a:L1=+0 (projet:lot=+500k)');
  });
  it('R8 — option sans --resume refusée avec le texte exact', async () => {
    const w = parentWith({ a: [{ title: 'un' }] });
    await expect(orchestrate(['a:L1', '--budget', 'a:L1=+200k'], io(w.parent).io, fakeDeps().deps)).rejects.toThrow("--budget projet:lot=+N ne vaut qu'avec --resume");
  });
  it("R8 — aucune écriture de l'état de la vague après un refus", async () => {
    const r = await handedBack();
    const state = () => JSON.stringify([read(r.parent).readWave(), r.lot()]);
    const before = state();
    // refus d'usage levés à la lecture des arguments (forme invalide, option sans --resume), avant toute lecture de l'état de la vague
    await expect(orchestrate(['--resume', WAVE, '--budget', 'a:L1=+abc'], io(r.parent).io, r.f.deps)).rejects.toThrow('--budget invalide : a:L1=+abc (projet:lot=+500k)');
    await expect(orchestrate([WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps)).rejects.toThrow("--budget projet:lot=+N ne vaut qu'avec --resume");
    expect(state()).toBe(before);
  });
  it('R9 — lot inconnu : refus « lot inconnu dans la vague »', async () => {
    const r = await handedBack();
    const x = await resumeErr(r, '--budget', 'a:L9=+300k');
    expect(x.code).toBe(2);
    expect(x.err).toContain(`orchestrate : --budget a:L9 : lot inconnu dans la vague ${WAVE}`);
    expect(x.unchanged).toBe(true);
  });
  it('R9 — lot ambigu entre deux projets : refus « précisez projet:lot »', async () => {
    const r = await handedBack({}, { a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    const s = r.store;
    const b = { ...r.lot(), project: 'b', repo: r.dirs.b };
    s.writeLot(b);
    const w = s.readWave()!;
    w.lots = ['a:L1', 'b:L1'];
    s.writeWave(w);
    const x = await resumeErr(r, '--budget', 'L1=+300k');
    expect(x.code).toBe(2);
    expect(x.err).toContain('orchestrate : --budget L1 : plusieurs projets portent ce lot, précisez projet:lot');
  });
  it('R9 — lot ready : refus', async () => {
    const r = await handedBack();
    const lot = r.lot();
    lot.status = 'ready';
    r.store.writeLot(lot);
    const x = await resumeErr(r, '--budget', 'a:L1=+300k');
    expect(x.code).toBe(2);
    expect(x.err).toContain("le lot n'est pas rendu sur budget avec une étape d'écriture à rejouer (ready)");
  });
  it('R9 — lot handed-back pour spec non conforme : refus', async () => {
    const r = await handedBack();
    const lot = r.lot();
    lot.next = 'spec';
    lot.outcome = 'spec non conforme après 2 passes';
    r.store.writeLot(lot);
    const x = await resumeErr(r, '--budget', 'a:L1=+300k');
    expect(x.code).toBe(2);
    expect(x.err).toContain("le lot n'est pas rendu sur budget avec une étape d'écriture à rejouer (handed-back");
  });
  it('R10 — =+155k sur un lot à fix : refusé avec le texte exact', async () => {
    const r = await handedBack();
    const x = await resumeErr(r, '--budget', 'a:L1=+155k');
    expect(x.code).toBe(2);
    expect(x.err).toContain('orchestrate : --budget a:L1=+155k : un fix ne part qu\'au-dessus de 155000 tokens de réserve');
  });
  it('R10 — =+155k sur un lot à implement : accepté (la réserve ne vaut que pour un fix)', async () => {
    const r = await handedBack();
    const lot = r.lot();
    lot.next = 'implement';
    lot.outcome = 'budget du lot atteint (1000 / 1000 tokens comptés, dérivé de l\'estimate) : étape « implement » non jouée, à décider par le lead';
    r.store.writeLot(lot);
    const x = await resumeErr(r, '--budget', 'a:L1=+155k');
    expect(x.err).not.toContain('réserve');
  });
  it('R13 — --budget p:L=+200k --budget p:L=+300k : refusé « lot visé deux fois »', async () => {
    const r = await handedBack();
    const x = await resumeErr(r, '--budget', 'a:L1=+200k', '--budget', 'a:L1=+300k');
    expect(x.code).toBe(2);
    expect(x.err).toContain('orchestrate : --budget a:L1 : lot visé deux fois');
    expect(x.unchanged).toBe(true);
  });
  it('R13 — --budget p:L=+200k --budget L=+300k : refusé de même après résolution', async () => {
    const r = await handedBack();
    const x = await resumeErr(r, '--budget', 'a:L1=+200k', '--budget', 'L1=+300k');
    expect(x.err).toContain('--budget a:L1 : lot visé deux fois');
    expect(x.unchanged).toBe(true);
  });
  it('R13 — lot visé par --budget et --drop : refusé', async () => {
    const r = await handedBack();
    const x = await resumeErr(r, '--budget', 'a:L1=+300k', '--drop', 'a:L1');
    expect(x.code).toBe(2);
    expect(x.err).toContain('orchestrate : --budget a:L1 : lot aussi retiré par --drop');
    expect(x.unchanged).toBe(true);
  });
  it('R13 — lot visé par --budget et --answer : refusé', async () => {
    const r = await handedBack();
    const x = await resumeErr(r, '--budget', 'a:L1=+300k', '--answer', 'a:L1', 'oui');
    expect(x.code).toBe(2);
    expect(x.err).toContain('orchestrate : --budget a:L1 : lot aussi visé par --answer');
    expect(x.unchanged).toBe(true);
  });
  it("R13 — aucune écriture de l'état de la vague après ces refus", async () => {
    const r = await handedBack();
    const state = () => JSON.stringify([read(r.parent).readWave(), r.lot()]);
    const before = state();
    for (const extra of [['--budget', 'a:L1=+200k', '--budget', 'a:L1=+300k'], ['--budget', 'a:L1=+200k', '--budget', 'L1=+300k'], ['--budget', 'a:L1=+300k', '--drop', 'a:L1'], ['--budget', 'a:L1=+300k', '--answer', 'a:L1', 'oui']]) {
      const out = io(r.parent);
      expect(await orchestrate(['--resume', WAVE, ...extra], out.io, r.f.deps)).toBe(2);
      expect(out.err.join('\n')).toMatch(/--budget a:L1 : lot (visé deux fois|aussi retiré par --drop|aussi visé par --answer)/);
      expect(state()).toBe(before);
    }
  });
});

describe('R12 — gardes du lot repris', () => {
  const targeted = async () => handedBack();
  it('R12 — lot visé sur dépôt sale : refus « arbre sale », état de la vague inchangé', async () => {
    const r = await targeted();
    writeFileSync(join(r.dirs.a, 'cadence.yaml'), 'orchestrate:\n  precheck: true\n');
    const before = JSON.stringify([read(r.parent).readWave(), r.lot()]);
    const out = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], out.io, r.f.deps)).toBe(2);
    expect(out.err.join('\n')).toContain('orchestrate : a : arbre sale, 1 fichier(s) suivi(s) modifié(s) : cadence.yaml');
    expect(JSON.stringify([read(r.parent).readWave(), r.lot()])).toBe(before);
  });
  it('R12 — lot visé sur dépôt tenu par une autre orchestration : refus', async () => {
    const r = await targeted();
    const { takeLock, REPO_LOCK } = await import('../src/orchestrate/lock.js');
    const { sharedStateDir } = await import('../src/state.js');
    takeLock(join(sharedStateDir(r.dirs.a), REPO_LOCK), { pid: process.ppid, wave: 'autre', started: new Date().toISOString() });
    const out = io(r.parent);
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], out.io, r.f.deps)).toBe(2);
    expect(out.err.join('\n')).toContain(`a : une orchestration y est déjà en cours (autre, pid ${process.ppid})`);
  });
  it('R12 — lot visé avec .nvmrc introuvable : refus', async () => {
    const r = await targeted();
    writeFileSync(join(r.dirs.a, '.nvmrc'), '1.2.3\n');
    git(r.dirs.a, 'add', '--', '.nvmrc');
    git(r.dirs.a, 'commit', '-q', '-m', 'chore: nvmrc');
    const out = io(r.parent);
    out.io.env.NVM_DIR = tempDir();
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], out.io, r.f.deps)).toBe(2);
    expect(out.err.join('\n')).toContain('orchestrate : a:L1 : ');
    expect(r.lot().status).toBe('handed-back');
  });
  it('R12 — lot visé sain : node posé sur le lot, reprise jouée', async () => {
    const r = await targeted();
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, r.f.deps)).toBe(0);
    expect(r.lot().status).toBe('ready');
  });
});

describe('R14 — vague lancée avant L223 (instantané sans lotBudgets)', () => {
  const withSnapshot = (r: { store: RunStore }, command: string) => {
    const tool = toolDirOf(r.store.dir);
    mkdirSync(join(tool, 'bin'), { recursive: true });
    mkdirSync(join(tool, 'dist', 'orchestrate'), { recursive: true });
    writeFileSync(join(tool, 'bin', 'cadence.js'), '');
    writeFileSync(join(tool, 'dist', 'orchestrate', 'command.js'), command);
    return tool;
  };
  it("R14 — l'instantané ne connaît pas l'option : la reprise tourne sur le dist/ courant, avec un avertissement, sans relance", async () => {
    const r = await handedBack();
    withSnapshot(r, 'parseBudget(v)');
    const reexec: string[] = [];
    const again = io(r.parent);
    const deps = { ...r.f.deps, snapshot: { packageRoot: tempDir(), reexec: async (t: string) => (reexec.push(t), 9) } };
    expect(await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], again.io, deps)).toBe(0);
    expect(reexec).toEqual([]);
    expect(again.err.join()).toContain('ne connaît pas --budget projet:lot=+N');
    expect(r.lot().status).toBe('ready');
  });
  it("R14 — l'instantané connaît l'option, ou pas de lot visé : la reprise relance sur l'instantané", async () => {
    const r = await handedBack();
    const tool = withSnapshot(r, 'lotBudgets');
    const reexec: string[] = [];
    const deps = { ...r.f.deps, snapshot: { packageRoot: tempDir(), reexec: async (t: string) => (reexec.push(t), 0) } };
    await orchestrate(['--resume', WAVE, '--budget', 'a:L1=+300k'], io(r.parent).io, deps);
    withSnapshot(r, 'parseBudget(v)');
    await orchestrate(['--resume', WAVE, '--budget', '2M'], io(r.parent).io, deps);
    expect(reexec).toEqual([tool, tool]);
  });
});
