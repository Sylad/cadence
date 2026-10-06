import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, parseBudget, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { projectLogDir, type ClaudeFn, type LaunchOutcome } from '../src/orchestrate/launch.js';
import { installPrePush } from '../src/orchestrate/guard.js';
import { acquireSlot, cadenceHome, liveSlots, liveWaves, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { TEMPLATES_DIR } from '../src/orchestrate/briefs.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { gitRepo, removeDryRunBriefs, tempDir } from './helpers.js';


/** Plusieurs projets sous un même dossier parent, chacun son dépôt git et son plan. */
function parentWith(projects: Record<string, { title: string; estimate?: number; visible?: boolean; status?: 'doing'; after?: string[] }[]>) {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, lots] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    for (const l of lots) {
      const id = plan.add(l.title, '2026-10-01', { estimate: l.estimate ?? 1, visible: l.visible, after: l.after });
      if (l.status === 'doing') plan.setStatus(id, 'doing', '2026-10-01');
    }
    plan.save();
    git(dir, 'add', '--', 'docs/plan/raf.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

type Over = Partial<Record<'implement' | 'review' | 'fix' | 'ux' | 'review-small', (cwd: string, brief: string) => LaunchOutcome | Promise<LaunchOutcome>>>;

function fakeDeps(over: Over = {}, tweak: Partial<OrchestrateDeps> = {}): { deps: OrchestrateDeps; calls: { cwd: string; kind: string; model: string }[] } {
  const calls: { cwd: string; kind: string; model: string }[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    calls.push({ cwd: o.cwd, kind, model: args[args.indexOf('--model') + 1] });
    const custom = over[kind];
    if (custom) return custom(o.cwd, args[1]);
    if (kind === 'implement' || kind === 'fix') {
      const lot = /on lot `([^`]+)`/.exec(args[1])![1];
      return claudeOut(workReport({ commits: [commitFile(o.cwd, `${kind}-${Math.random()}.txt`, `${kind === 'fix' ? 'fix' : 'feat'}(${lot}): travail`)] }));
    }
    return claudeOut(reviewReport());
  };
  return { deps: { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, ...tweak }, calls };
}

function io(cwd: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-04T14:12:00') };
  return { io: i, out, err };
}

describe('arguments', () => {
  it('lots, modèle, budget, options à valeur facultative', () => {
    expect(parseOrchestrateArgs(['ol:L22', 'cadence:L18@haiku', 'L3', '--budget', '1.5M', '--dry-run'])).toMatchObject({
      lots: [{ project: 'ol', lot: 'L22' }, { project: 'cadence', lot: 'L18', model: 'haiku' }, { lot: 'L3' }],
      budget: 1_500_000,
      dryRun: true,
    });
    expect(parseOrchestrateArgs(['--status']).status).toBe(true);
    expect(parseOrchestrateArgs(['--status', '2026-10-04-1412']).status).toBe('2026-10-04-1412');
    expect(parseOrchestrateArgs(['--resume', '--budget', '1M', '--answer', 'ol:L22', 'SQLite'])).toMatchObject({ resume: true, budget: 1_000_000, answers: [{ project: 'ol', lot: 'L22', text: 'SQLite' }] });
    expect(parseOrchestrateArgs(['--resume', 'L3']).lots).toEqual([{ project: undefined, lot: 'L3', model: undefined }]);
    expect(() => parseOrchestrateArgs(['a:L1@gpt'])).toThrow(/modèle inconnu/);
    expect(() => parseOrchestrateArgs(['--parallel'])).toThrow(/option inconnue/);
  });
  it('budget', () => {
    expect([parseBudget('1500000'), parseBudget('1.5M'), parseBudget('800k'), parseBudget('2M')]).toEqual([1_500_000, 1_500_000, 800_000, 2_000_000]);
    expect(() => parseBudget('beaucoup')).toThrow(/--budget invalide/);
  });
});

describe('refus avant d\'agir (code 2)', () => {
  const run = async (parent: string, argv: string[], deps = fakeDeps().deps, env: Record<string, string> = {}) => {
    const r = io(parent, env);
    const code = await orchestrate(argv, r.io, deps);
    return { code, ...r };
  };

  it('lot inconnu, terminé, dépendance non satisfaite, projet inconnu, lot donné deux fois', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux', after: ['L1'] }], b: [{ title: 'x' }] });
    const plan = Plan.load(join(parent, 'a/docs/plan/raf.yaml'));
    plan.setStatus('L1', 'dropped', '2026-10-04');
    plan.save();
    git(join(parent, 'a'), 'commit', '-qam', 'chore: plan');
    const r = await run(parent, ['a:L9', 'a:L1', 'zzz:L1', 'b:L1', 'b:L1']);
    expect(r.code).toBe(2);
    const err = r.err.join('\n');
    expect(err).toContain('a:L9 : lot inconnu');
    expect(err).toContain('a:L1 : le lot est dropped');
    expect(err).toContain('zzz:L1 : dossier');
    expect(err).toContain('b:L1 : lot donné deux fois');
    // rien n'a été écrit
    expect(existsSync(join(parent, '.cadence'))).toBe(false);
  });

  it('dépendance ouverte refusée, acceptée si elle est plus tôt dans la vague', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux', after: ['L1'] }] });
    expect((await run(parent, ['a:L2'])).err.join()).toContain('dépendance(s) ni terminée(s) ni plus tôt dans la vague : L1');
    expect((await run(parent, ['a:L2', 'a:L1'])).err.join()).toContain('a:L2 : dépendance(s)'); // L1 est après : refus
    const ok = await run(parent, ['a:L1', 'a:L2', '--dry-run']);
    try {
      expect(ok.code).toBe(0);
    } finally {
      removeDryRunBriefs(ok.out.join('\n'));
    }
  });

  it('arbre sale, claude absent, claude sans --json-schema, hook pre-push existant, session imbriquée', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    writeFileSync(join(dirs.a, 'docs/plan/raf.yaml'), `${readFileSync(join(dirs.a, 'docs/plan/raf.yaml'), 'utf8')}# sale\n`);
    expect((await run(parent, ['a:L1'])).err.join()).toMatch(/a : arbre sale, 1 fichier\(s\) suivi\(s\) modifié\(s\) : docs\/plan\/raf\.yaml/);
    git(dirs.a, 'checkout', '-q', '.');
    expect((await run(parent, ['a:L1'], fakeDeps({}, { claudeInfo: () => null }).deps)).err.join()).toContain('claude introuvable');
    expect((await run(parent, ['a:L1'], fakeDeps({}, { claudeInfo: () => ({ version: '1.0.0', jsonSchema: false }) }).deps)).err.join()).toContain("claude 1.0.0 n'a pas --json-schema");
    writeFileSync(join(dirs.a, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n');
    expect((await run(parent, ['a:L1'])).err.join()).toContain('hook pre-push existe déjà');
    expect((await run(parent, ['a:L1'], undefined, { CADENCE_ORCHESTRATED: 'w0' })).err.join()).toContain('depuis une session orchestrée');
  });

  it('plan en lecture seule et lot à faire sans orchestrate.start', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'plan:\n  path: docs/plan/raf.yaml\n  lots: lots\n  fields: { title: title }\n');
    git(dirs.a, 'add', '--', 'cadence.yaml');
    git(dirs.a, 'commit', '-qm', 'chore: config');
    const r = await run(parent, ['a:L1']);
    expect(r.code).toBe(2);
    expect(r.err.join()).toContain("plan en lecture seule : démarrer le lot avec l'outil du projet");
  });

  it('L71 — une vague vivante sur un autre dépôt du même dossier ne gêne pas ; sur le même dépôt, refus', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    mkdirSync(join(dirs.b, '.git/cadence'), { recursive: true });
    writeFileSync(join(dirs.b, '.git/cadence/orchestrate.lock'), JSON.stringify({ pid: process.ppid, wave: 'autre', started: 'x' }));
    expect((await run(parent, ['a:L1'])).code).toBe(0);
    const same = await run(parent, ['b:L1']);
    expect(same.code).toBe(2);
    expect(same.err.join()).toContain('b : une orchestration y est déjà en cours (autre');
    expect(same.err.join()).not.toContain('une vague est déjà en cours');
  });

  it('L71 — un verrou de dépôt de pid mort est retiré', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    mkdirSync(join(dirs.a, '.git/cadence'), { recursive: true });
    writeFileSync(join(dirs.a, '.git/cadence/orchestrate.lock'), JSON.stringify({ pid: 999999999, wave: 'morte', started: 'x' }));
    const r = await run(parent, ['a:L1']);
    expect(r.code).toBe(0);
    expect(r.err.join()).toContain('verrou de dépôt périmé retiré');
  });
});

describe('verrous, hooks et configuration (L3/t10, t13)', () => {
  it('L3/t10 — échec de verrou de dépôt en cours de pose : le hook d\'une autre vague vivante reste en place', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    const f = fakeDeps();
    const r = io(parent);
    // Entre les préconditions et la pose : une autre vague vivante prend le dépôt b (verrou + hook).
    let planted = false;
    r.io.now = () => {
      if (!planted) {
        planted = true;
        mkdirSync(join(dirs.b, '.git/cadence'), { recursive: true });
        writeFileSync(join(dirs.b, '.git/cadence/orchestrate.lock'), JSON.stringify({ pid: process.ppid, wave: 'autre', started: 'x' }));
        installPrePush(dirs.b, 'autre');
      }
      return new Date('2026-10-04T14:12:00');
    };
    expect(await orchestrate(['a:L1', 'b:L1'], r.io, f.deps)).toBe(2);
    expect(existsSync(join(dirs.b, '.git/hooks/pre-push'))).toBe(true);
    expect(readFileSync(join(dirs.b, '.git/hooks/pre-push'), 'utf8')).toContain('# wave: autre');
    expect(existsSync(join(dirs.a, '.git/hooks/pre-push'))).toBe(false); // le nôtre est retiré
    expect(f.calls).toEqual([]);
  });

  it('L3/t10 — --resume refuse un dépôt dont une autre orchestration vivante tient le verrou, sans rien poser', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--budget', '1'], io(parent).io, f.deps)).toBe(3);
    mkdirSync(join(dirs.a, '.git/cadence'), { recursive: true });
    writeFileSync(join(dirs.a, '.git/cadence/orchestrate.lock'), JSON.stringify({ pid: process.ppid, wave: 'autre', started: 'x' }));
    installPrePush(dirs.a, 'autre');
    const calls = f.calls.length;
    const again = io(parent);
    expect(await orchestrate(['--resume', '--budget', '1M'], again.io, f.deps)).toBe(2);
    expect(again.err.join('\n')).toContain('une orchestration y est déjà en cours (autre');
    expect(f.calls.length).toBe(calls);
    expect(readFileSync(join(dirs.a, '.git/hooks/pre-push'), 'utf8')).toContain('# wave: autre'); // le hook de l'autre vague reste
    expect(readFileSync(join(dirs.a, '.git/cadence/orchestrate.lock'), 'utf8')).toContain('autre'); // pas retiré
  });

  it('L3/t13 — cadence.yaml illisible à la reprise : ni hook ni verrou laissés', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--budget', '1'], io(parent).io, f.deps)).toBe(3);
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'orchestrate: [pas, un, objet]\n');
    git(dirs.a, 'add', '--', 'cadence.yaml');
    git(dirs.a, 'commit', '-qm', 'chore: config');
    await expect(orchestrate(['--resume', '--budget', '1M'], io(parent).io, f.deps)).rejects.toThrow(/orchestrate doit être un objet/);
    expect(existsSync(join(dirs.a, '.git/hooks/pre-push'))).toBe(false);
    expect(existsSync(join(dirs.a, '.git/cadence/orchestrate.lock'))).toBe(false);
  });
});

describe('plafond de sessions simultanées et --status (L71)', () => {
  const run = async (parent: string, argv: string[], deps = fakeDeps().deps, env: Record<string, string> = {}) => {
    const r = io(parent, env);
    return { code: await orchestrate(argv, r.io, deps), ...r };
  };

  it('--max-sessions et CADENCE_MAX_SESSIONS : entier ≥ 1', async () => {
    expect(parseOrchestrateArgs(['a:L1', '--max-sessions', '3']).maxSessions).toBe(3);
    expect(() => parseOrchestrateArgs(['--max-sessions', '0'])).toThrow(/--max-sessions invalide/);
    expect(() => parseOrchestrateArgs(['--max-sessions', 'x'])).toThrow(/entier/);
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    await expect(run(parent, ['--status'], fakeDeps().deps, { CADENCE_MAX_SESSIONS: 'abc' })).rejects.toThrow(/CADENCE_MAX_SESSIONS invalide/);
  });

  it('une vague attend un créneau libre avant chaque session, puis part', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const home = cadenceHome();
    const x = await acquireSlot(home, 2, { wave: 'x' });
    const y = await acquireSlot(home, 2, { wave: 'y' });
    const f = fakeDeps();
    f.deps.slotPollMs = 10;
    const r = io(parent);
    const done = orchestrate(['a:L1'], r.io, f.deps);
    await new Promise((res) => setTimeout(res, 150));
    expect(f.calls).toEqual([]); // plafond atteint : aucune session
    expect(r.out.join('\n')).toMatch(/en attente d'un créneau de session depuis \d+ s \(2\/2 en cours : x, y\)/);
    x();
    expect(await done).toBe(0);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(r.out.join('\n')).toMatch(/créneau de session obtenu après \d+ s d'attente/);
    y();
    expect(liveSlots(home)).toEqual([]); // tous les créneaux de la vague sont rendus
  });

  it('le plafond est celui du drapeau : --max-sessions 1 garde un créneau pour une seule session à la fois', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    let running = 0;
    let peak = 0;
    const track = (cwd: string, kind: 'implement') => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, 40));
      running--;
      return claudeOut(workReport({ commits: [commitFile(cwd, `${kind}-${Math.random()}.txt`, 'feat(L1): x')] }));
    };
    const f = fakeDeps({ implement: (cwd) => track(cwd, 'implement')() });
    f.deps.slotPollMs = 5;
    expect((await run(parent, ['a:L1', 'b:L1', '--max-sessions', '1'], f.deps)).code).toBe(0);
    expect(peak).toBe(1);
  });

  it('--status liste les vagues vivantes et les dépôts tenus, même sans vague dans ce dossier', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-06-1100', started: '2026-10-06T11:00:00Z', cwd: '/ailleurs', repos: ['/x/ol-companion', '/x/cadence'], cap: 3 });
    const r = await run(parent, ['--status']);
    expect(r.code).toBe(0);
    const out = r.out.join('\n');
    expect(out).toContain('vagues en cours : 1 · sessions en cours : 0');
    expect(out).toContain('2026-10-06-1100 (pid ' + process.ppid);
    expect(out).toContain('lancée depuis /ailleurs · plafond 3 · dépôts : /x/ol-companion, /x/cadence');
    unregisterWave(cadenceHome(), process.ppid);
  });
});

describe('--status <id> inconnu malgré une vague vivante ailleurs (L71)', () => {
  it('refuse « vague inconnue » au lieu de lister les vagues vivantes avec le code 0', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-06-1100', started: '2026-10-06T11:00:00Z', cwd: '/ailleurs', repos: ['/x/ol-companion'], cap: 2 });
    try {
      const r = io(parent);
      await expect(orchestrate(['--status', '2026-10-06-143'], r.io, fakeDeps().deps)).rejects.toThrow(/vague inconnue : 2026-10-06-143/);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });
});

describe("identifiant de vague réservé atomiquement (L71/t1)", () => {
  const run = async (parent: string, argv: string[], deps = fakeDeps().deps) => {
    const r = io(parent);
    return { code: await orchestrate(argv, r.io, deps), ...r };
  };

  it('deux vagues lancées ensemble du même dossier, à la même minute : deux identifiants, deux dossiers', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    const [x, y] = await Promise.all([run(parent, ['a:L1']), run(parent, ['b:L1'])]);
    expect([x.code, y.code]).toEqual([0, 0]);
    expect(readdirSync(join(parent, '.cadence/runs')).sort()).toEqual(['2026-10-04-1412', '2026-10-04-1412-2']);
    // L'ordre de réservation entre deux run() parallèles n'est pas promis : on vérifie l'ensemble.
    const lots = ['2026-10-04-1412', '2026-10-04-1412-2'].map((id) => new RunStore(parent, id).readWave()!.lots);
    expect(lots.sort()).toEqual([['a:L1'], ['b:L1']]);
  });

  it("--wave déjà existant : refus avant d'agir, la vague existante est intacte", async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    expect((await run(parent, ['a:L1', '--wave', 'ma-vague'])).code).toBe(0);
    const before = readFileSync(join(parent, '.cadence/runs/ma-vague/wave.json'), 'utf8');
    const f = fakeDeps();
    const again = await run(parent, ['b:L1', '--wave', 'ma-vague'], f.deps);
    expect(again.code).toBe(2);
    expect(again.err.join()).toContain('--wave ma-vague : cette vague existe déjà');
    expect(f.calls).toEqual([]);
    expect(readFileSync(join(parent, '.cadence/runs/ma-vague/wave.json'), 'utf8')).toBe(before);
  });

  it("--wave dont le démarrage échoue avant wave.json : aucun dossier orphelin, le même nom se relance", async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const home = tempDir();
    writeFileSync(join(home, 'fichier'), 'x'); // CADENCE_HOME sous un fichier : le registre ne peut pas être écrit
    const saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = join(home, 'fichier', 'home');
    try {
      await expect(run(parent, ['a:L1', '--wave', 'nuit'])).rejects.toThrow();
    } finally {
      process.env.CADENCE_HOME = saved;
    }
    expect(existsSync(join(parent, '.cadence/runs/nuit'))).toBe(false);
    expect((await run(parent, ['a:L1', '--wave', 'nuit'])).code).toBe(0);
  });

  it("--dry-run --wave déjà existant : même refus que le vrai lancement, rien n'est écrit", async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    expect((await run(parent, ['a:L1', '--wave', 'ma-vague'])).code).toBe(0);
    const f = fakeDeps();
    const again = await run(parent, ['a:L1', '--wave', 'ma-vague', '--dry-run'], f.deps);
    expect(again.code).toBe(2);
    expect(again.err.join()).toContain('--wave ma-vague : cette vague existe déjà');
    expect(again.out).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe('démarrage et reprise sous le registre (L71/t4, t5)', () => {
  it("L71/t4 — registerWave qui échoue : verrous et hooks retirés, rien n'est lancé", async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const home = tempDir();
    writeFileSync(join(home, 'fichier'), 'x'); // CADENCE_HOME sous un fichier : le registre ne peut pas être écrit
    const saved = process.env.CADENCE_HOME;
    process.env.CADENCE_HOME = join(home, 'fichier', 'home');
    const f = fakeDeps();
    try {
      await expect(orchestrate(['a:L1'], io(parent).io, f.deps)).rejects.toThrow();
    } finally {
      process.env.CADENCE_HOME = saved;
    }
    expect(existsSync(join(dirs.a, '.git/hooks/pre-push'))).toBe(false);
    expect(existsSync(join(dirs.a, '.git/cadence/orchestrate.lock'))).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('L71/t5 — --resume refusé quand la vague est vivante dans le registre, sans rien poser', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--budget', '1'], io(parent).io, f.deps)).toBe(3);
    const wave = new RunStore(parent, '2026-10-04-1412').readWave()!;
    registerWave(cadenceHome(), { pid: process.ppid, wave: wave.id, started: 'x', cwd: parent, repos: [dirs.a] });
    const calls = f.calls.length;
    const again = io(parent);
    try {
      expect(await orchestrate(['--resume', '--budget', '1M'], again.io, f.deps)).toBe(2);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
    expect(again.err.join('\n')).toContain(`la vague ${wave.id} tourne encore (pid ${process.ppid})`);
    expect(f.calls.length).toBe(calls);
    expect(existsSync(join(dirs.a, '.git/cadence/orchestrate.lock'))).toBe(false);
  });
});

describe('--dry-run', () => {
  it('rien n\'est lancé ni écrit ; étapes, modèles, commande résolue et briefs rendus', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'petit', estimate: 0.5 }], c: [{ title: 'écran', visible: true }] });
    const f = fakeDeps();
    const r = io(parent);
    const code = await orchestrate(['a:L1', 'b:L1@haiku', 'c:L1', '--dry-run'], r.io, f.deps);
    const text = r.out.join('\n');
    try {
      expect(code).toBe(0);
      expect(f.calls).toEqual([]);
      expect(existsSync(join(parent, '.cadence'))).toBe(false);
      expect(text).toContain('a:L1');
      expect(text).toContain('implement (sonnet) → review (opus)');
      expect(text).toContain('implement (haiku) → review (opus) — petit lot'); // sans écran, la passe unique est une revue de code
      expect(text).toContain('corrections : 2 passe(s) au plus, en session neuve');
      expect(text).toContain('revue conforme avec mineurs : une passe de correction des mineurs (session neuve), puis une revue courte');
      expect(text).toContain('UX à faire par le lead');
      expect(text).toContain('créneau 1');
      expect(text).toContain("en attente d'un créneau");
      expect(text).toContain('claude -p <brief> --output-format json --json-schema <json> --model sonnet');
      const brief = /^\s*brief : (.+?)\s*$/m.exec(text)![1]!; // ligne entière : un TMPDIR peut contenir des espaces
      expect(readFileSync(brief, 'utf8')).toContain('Work in `');
      expect(existsSync(join(parent, 'a/.git/hooks/pre-push'))).toBe(false);
    } finally {
      removeDryRunBriefs(text); // le produit laisse ces briefs à relire ; le test supprime les siens, même en échec
    }
  });
});

describe('une vague', () => {
  it('deux projets prêts : code 0, état rangé, hooks et verrous libérés, tableau', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    const f = fakeDeps();
    const r = io(parent);
    const code = await orchestrate(['a:L1', 'b:L1'], r.io, f.deps);
    expect(code).toBe(0);
    const out = r.out.join('\n');
    expect(out).toMatch(/lot +état +passes +revue +UX +commits +tokens +durée/);
    expect(out).toMatch(/a:L1 +prêt à livrer +0 +conforme +— +1 /);
    expect(out).toContain('vague 2026-10-04-1412 : ');
    expect(out).toContain('2 prêt(s)');
    const wave = new RunStore(parent, '2026-10-04-1412').readWave()!;
    expect(wave.status).toBe('done');
    expect(wave.consumed).toBe(6000);
    expect(wave.cacheRead).toBe(200_000);
    for (const d of Object.values(dirs)) {
      expect(existsSync(join(d, '.git/hooks/pre-push'))).toBe(false);
      expect(existsSync(join(d, '.git/cadence/orchestrate.lock'))).toBe(false);
      expect(Plan.load(join(d, 'docs/plan/raf.yaml')).lot('L1').review?.verdict).toContain('orchestré (vague 2026-10-04-1412');
      expect(Plan.load(join(d, 'docs/plan/raf.yaml')).lot('L1').status).toBe('doing');
    }
    expect(readFileSync(join(parent, '.cadence/runs/2026-10-04-1412/journal.log'), 'utf8')).toContain('a:L1 → ready');
  });

  it('pendant la vague, le hook pre-push est posé ; les verrous sont pris', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    let seen: { hook: boolean; repoLock: boolean; registered: boolean } | null = null;
    const f = fakeDeps({
      implement: (cwd) => {
        seen = { hook: existsSync(join(dirs.a, '.git/hooks/pre-push')), repoLock: existsSync(join(dirs.a, '.git/cadence/orchestrate.lock')), registered: liveWaves(cadenceHome()).some((w) => w.pid === process.pid && w.repos.includes(dirs.a)) };
        return claudeOut(workReport({ commits: [commitFile(cwd, 'x.txt', 'feat(L1): x')] }));
      },
    });
    await orchestrate(['a:L1'], io(parent).io, f.deps);
    expect(seen).toEqual({ hook: true, repoLock: true, registered: true });
    expect(liveWaves(cadenceHome())).toEqual([]); // retirée à la fin
    expect(existsSync(join(parent, '.cadence/orchestrate.lock'))).toBe(false); // plus de verrou par dossier
  });

  it('L3/t20 — --resume compte au budget l\'étape tuée par un signal, relue dans le journal de sa session', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const claudeHome = tempDir();
    const f = fakeDeps({}, { claudeHome });
    expect(await orchestrate(['a:L1', '--budget', '1'], io(parent).io, f.deps)).toBe(3);
    const store = new RunStore(parent, '2026-10-04-1412');
    const lot = store.readLot('a', 'L1')!;
    lot.steps.push({ n: lot.steps.length + 1, kind: 'implement', model: 'sonnet', status: 'running', pid: 2_999_999, sessionId: 'tuee-par-signal', started: '2026-10-04T14:13:00.000Z' });
    store.writeLot(lot);
    const dir = projectLogDir(claudeHome, realpathSync(dirs.a));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tuee-par-signal.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 7, output_tokens: 5 } } }));
    expect(await orchestrate(['--resume', '--budget', '1M'], io(parent).io, f.deps)).toBe(0);
    const after = new RunStore(parent, '2026-10-04-1412');
    const steps = after.readLot('a', 'L1')!.steps;
    expect(steps.find((x) => x.sessionId === 'tuee-par-signal')).toMatchObject({ status: 'interrupted', tokens: { counted: 115 } });
    expect(after.readWave()!.consumed).toBe(steps.reduce((n, x) => n + (x.tokens?.counted ?? 0), 0));
  });

  it('un lot rendu au lead : code 1 ; budget atteint : code 3 puis --resume --budget continue jusqu\'à 0', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps();
    const first = io(parent);
    const code = await orchestrate(['a:L1', 'a:L2', '--budget', '2000'], first.io, f.deps);
    expect(code).toBe(3);
    expect(first.out.join('\n')).toContain('suspendu');
    expect(new RunStore(parent, '2026-10-04-1412').readWave()!.status).toBe('suspended-budget');
    const again = io(parent);
    const code2 = await orchestrate(['--resume', '--budget', '1M'], again.io, f.deps);
    expect(code2).toBe(0);
    expect(new RunStore(parent, '2026-10-04-1412').readWave()!.status).toBe('done');
    expect(f.calls.map((c) => c.kind)).toEqual(['implement', 'review', 'implement', 'review']);
  });

  it('L39 — les gabarits sont lus une fois par exécution : un fichier modifié entre deux exécutions n\'est pris qu\'à la reprise', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const dir = tempDir();
    cpSync(TEMPLATES_DIR, dir, { recursive: true });
    const reviews: string[] = [];
    const f = fakeDeps({ review: (_cwd, brief) => { reviews.push(brief); return claudeOut(reviewReport()); } }, { templatesDir: dir });
    expect(await orchestrate(['a:L1', 'a:L2', '--budget', '2000'], io(parent).io, f.deps)).toBe(3);
    writeFileSync(join(dir, 'review.md'), 'GABARIT RELU {{lot}}\n');
    expect(await orchestrate(['--resume', '--budget', '1M'], io(parent).io, f.deps)).toBe(0);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toContain('Review lot `L1`');
    expect(reviews[1]).toBe('GABARIT RELU L2\n');
  });

  it('question puis --answer : le lot reprend, la vague aboutit', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    let n = 0;
    const f = fakeDeps({
      implement: (cwd) => (n++ === 0 ? claudeOut(workReport({ questions: ['Quelle base ?'] })) : claudeOut(workReport({ commits: [commitFile(cwd, 'x.txt', 'feat(L1): x')] }))),
    });
    const first = io(parent);
    expect(await orchestrate(['a:L1'], first.io, f.deps)).toBe(1);
    expect(first.out.join('\n')).toContain('question : a:L1 — « Quelle base ? » (cadence orchestrate --resume --answer a:L1 "…")');
    expect(new RunStore(parent, '2026-10-04-1412').readWave()!.status).toBe('interrupted');
    const second = io(parent);
    expect(await orchestrate(['--resume', '--answer', 'a:L1', 'SQLite'], second.io, f.deps)).toBe(0);
    expect(new RunStore(parent, '2026-10-04-1412').readLot('a', 'L1')!.answers).toEqual(['SQLite']);
  });

  it('L3/t9 — lot dépendant d\'un lot suspendu : reste reprenable, tourne après lui à la reprise', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux', after: ['L1'] }] });
    const f = fakeDeps();
    const first = io(parent);
    expect(await orchestrate(['a:L1', 'a:L2', '--budget', '1'], first.io, f.deps)).toBe(3);
    const store = new RunStore(parent, '2026-10-04-1412');
    expect(store.readLot('a', 'L1')!.status).toBe('suspended');
    expect(store.readLot('a', 'L2')!.status).not.toBe('handed-back');
    expect(store.readWave()!.status).toBe('suspended-budget');
    const again = io(parent);
    expect(await orchestrate(['--resume', '--budget', '1M'], again.io, f.deps)).toBe(0);
    expect(store.readLot('a', 'L1')!.status).toBe('ready');
    expect(store.readLot('a', 'L2')!.status).toBe('ready');
    expect(f.calls.map((c) => c.kind)).toEqual(['implement', 'review', 'implement', 'review']);
  });

  it('L3/t9 — lot dépendant d\'un lot en question : attend, puis tourne après --answer', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux', after: ['L1'] }] });
    let n = 0;
    const f = fakeDeps({
      implement: (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        return lot === 'L1' && n++ === 0 ? claudeOut(workReport({ questions: ['Quelle base ?'] })) : claudeOut(workReport({ commits: [commitFile(cwd, `${lot}-${Math.random()}.txt`, `feat(${lot}): x`)] }));
      },
    });
    expect(await orchestrate(['a:L1', 'a:L2'], io(parent).io, f.deps)).toBe(1);
    const store = new RunStore(parent, '2026-10-04-1412');
    expect(store.readLot('a', 'L1')!.status).toBe('question');
    expect(store.readLot('a', 'L2')!.status).not.toBe('handed-back');
    expect(store.readWave()!.status).toBe('interrupted');
    expect(await orchestrate(['--resume', '--answer', 'a:L1', 'SQLite'], io(parent).io, f.deps)).toBe(0);
    expect(store.readLot('a', 'L2')!.status).toBe('ready');
  });

  it('--resume refuse une réponse à un lot qui n\'attend rien, et une vague terminée', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    await orchestrate(['a:L1'], io(parent).io, f.deps);
    await expect(orchestrate(['--resume'], io(parent).io, f.deps)).rejects.toThrow(/aucune vague à reprendre/); // plus aucune vague non terminée
    const r2 = io(parent);
    expect(await orchestrate(['--resume', '2026-10-04-1412', '--answer', 'a:L1', 'x'], r2.io, f.deps)).toBe(2);
    expect(r2.err.join()).toContain('le lot n\'attend pas de réponse');
  });

  it('reprise après coupure : étape running dont la session est morte → interrompue puis relancée ; session vivante → refus', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const store = new RunStore(parent, 'w-coupee');
    store.writeWave({ id: 'w-coupee', created: 'x', cwd: parent, budget: 1_000_000, consumed: 10, cacheRead: 0, status: 'running', pid: 99_999_999, lots: ['a:L1'] });
    const { newLot } = await import('../src/orchestrate/state.js');
    const plan = Plan.load(join(dirs.a, 'docs/plan/raf.yaml'));
    plan.setStatus('L1', 'doing', '2026-10-04');
    plan.save();
    git(dirs.a, 'commit', '-qam', 'plan: L1 démarré');
    const lot = newLot({ project: 'a', repo: dirs.a, lot: 'L1', title: 'un', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    lot.status = 'implementing';
    lot.next = 'implement';
    lot.steps.push({ n: 1, kind: 'implement', model: 'sonnet', status: 'running', pid: process.pid, started: 'x', headBefore: git(dirs.a, 'rev-parse', 'HEAD') });
    store.writeLot(lot);
    const f = fakeDeps();
    const refused = io(parent);
    expect(await orchestrate(['--resume'], refused.io, f.deps)).toBe(2);
    expect(refused.err.join()).toContain(`a:L1 : session encore en vie, pid ${process.pid}`);
    lot.steps[0].pid = 99_999_998;
    store.writeLot(lot);
    const r = io(parent);
    expect(await orchestrate(['--resume'], r.io, f.deps)).toBe(0);
    const state = store.readLot('a', 'L1')!;
    expect(state.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(['implement:interrupted', 'implement:ok', 'review:ok']);
  });

  it('--status relit le tableau depuis l\'état', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    await orchestrate(['a:L1'], io(parent).io, fakeDeps().deps);
    const r = io(parent);
    expect(await orchestrate(['--status'], r.io, fakeDeps().deps)).toBe(0);
    expect(r.out.join('\n')).toContain('a:L1');
    expect(r.out.join('\n')).toContain('prêt à livrer');
    expect(readdirSync(join(parent, '.cadence/runs'))).toEqual(['2026-10-04-1412']);
    const none = io(tempDir());
    await expect(orchestrate(['--status'], none.io, fakeDeps().deps)).rejects.toThrow(/aucune vague/);
  });
});

describe('point d\'entrée', () => {
  it('bin/cadence.js route « orchestrate » vers le CLI et le liste dans son aide', () => {
    const bin = readFileSync(new URL('../bin/cadence.js', import.meta.url), 'utf8');
    expect(bin).toMatch(/\[[^\]]*'orchestrate'[^\]]*\]\.includes\(tool\)/);
    expect(bin).toContain('cadence orchestrate <projet>:<lot>');
  });
});
