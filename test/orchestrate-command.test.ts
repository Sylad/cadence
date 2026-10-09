import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lotBudget, orchestrate, parseBudget, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { projectLogDir, type ClaudeFn, type LaunchOutcome } from '../src/orchestrate/launch.js';
import { installPrePush } from '../src/orchestrate/guard.js';
import { acquireSlot, cadenceHome, liveSlots, liveWaves, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { TEMPLATES_DIR } from '../src/orchestrate/briefs.js';
import { Plan } from '../src/plan.js';
import { claudeOut, commitFile, git, kindOf, precheckReport, reviewReport, workReport } from './orchestrate-harness.js';
import { gitRepo, removeDryRunBriefs, tempDir } from './helpers.js';

// L150 — le registre des vagues et les créneaux sont propres à CHAQUE test : sous charge, un test qui échoue (ou est
// interrompu par son délai) avant son unregisterWave() laissait sa vague vivante au suivant (« vagues en cours : 2 »).
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

describe('registre des vagues isolé par test (L150)', () => {
  it('un test laisse une vague vivante…', () => {
    registerWave(cadenceHome(), { pid: process.ppid, wave: 'laissee', started: '2026-10-09T12:00:00Z', cwd: '/x', repos: [], cap: 1 });
    expect(liveWaves(cadenceHome())).toHaveLength(1);
  });
  it('…le suivant ne la voit pas', () => {
    expect(liveWaves(cadenceHome())).toEqual([]);
  });
});

/** Attend qu'une condition devienne vraie (événement), échoue en la nommant au bout de `ms` : sous charge, jamais une durée fixe. */
async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé (${ms} ms) : ${what}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

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
    // Le contrôle préalable (L77) a ses propres tests : ici il est coupé pour que les étapes attendues restent les mêmes.
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  return { parent, dirs };
}

type Over = Partial<Record<'implement' | 'review' | 'fix' | 'ux' | 'review-small' | 'precheck', (cwd: string, brief: string) => LaunchOutcome | Promise<LaunchOutcome>>>;

function fakeDeps(over: Over = {}, tweak: Partial<OrchestrateDeps> = {}): { deps: OrchestrateDeps; calls: { cwd: string; kind: string; model: string }[] } {
  const calls: { cwd: string; kind: string; model: string }[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    calls.push({ cwd: o.cwd, kind, model: args[args.indexOf('--model') + 1] });
    const custom = over[kind];
    if (custom) return custom(o.cwd, args[1]);
    if (kind === 'precheck') return claudeOut(precheckReport());
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
  it('L120 — un id de lot peut contenir « / » : le premier « : » sépare le projet, « @ » final le modèle', () => {
    expect(parseOrchestrateArgs(['maritime-atlas:Q4/accueil-4-ux12', 'a:Q4/x-1@haiku', 'Q4/y-2']).lots).toEqual([
      { project: 'maritime-atlas', lot: 'Q4/accueil-4-ux12', model: undefined },
      { project: 'a', lot: 'Q4/x-1', model: 'haiku' },
      { project: undefined, lot: 'Q4/y-2', model: undefined },
    ]);
    expect(parseOrchestrateArgs(['--resume', '--answer', 'ma:Q4/a-1', 'oui']).answers).toEqual([{ project: 'ma', lot: 'Q4/a-1', text: 'oui' }]);
    expect(parseOrchestrateArgs(['--status', 'ma:Q4/a-1']).lots).toEqual([{ project: 'ma', lot: 'Q4/a-1', model: undefined }]);
    for (const id of ['maritime-atlas:R-M7/ux-1', 'maritime-atlas:NC2.4/scores-versionnes', 'maritime-atlas:E-DI0/tranches-spec-22-09']) {
      expect(parseOrchestrateArgs(['--status', id])).toMatchObject({ lots: [{ project: 'maritime-atlas', lot: id.split(':')[1] }], status: true });
      expect(parseOrchestrateArgs(['--resume', id])).toMatchObject({ lots: [{ lot: id.split(':')[1] }], resume: true });
    }
    expect(parseOrchestrateArgs(['--status', '2026-10-04-1412']).status).toBe('2026-10-04-1412');
    expect(() => parseOrchestrateArgs(['a:Q4/x@gpt'])).toThrow(/modèle inconnu/);
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

  it('--dry-run dit, par étape, les serveurs MCP chargés (L74)', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un', visible: true }] });
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'orchestrate:\n  ux:\n    url: http://localhost:4200\n');
    git(dirs.a, 'add', '--', 'cadence.yaml');
    git(dirs.a, 'commit', '-qm', 'chore: config');
    const r = await run(parent, ['a:L1', '--dry-run']);
    try {
      const out = r.out.join('\n');
      expect(out).toMatch(/  ux : claude [^\n]*--strict-mcp-config[^\n]*\n    brief : [^\n]*\n    mcp : playwright \(captures dans le dossier de la vague : <vague>\/a--L1\/playwright\)/);
      const implement = out.slice(out.indexOf('  implement :'), out.indexOf('  review :'));
      expect(implement).toContain('--strict-mcp-config --mcp-config <mcp>');
      expect(implement).toMatch(/    mcp : playwright \(captures dans le dossier de la vague : <vague>\/a--L1\/playwright\)/); // lot visible (L74)
      expect(out).toMatch(/  review : claude [^\n]*--strict-mcp-config[^\n]*\n    brief : [^\n]*\n    mcp : aucun/);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it("--dry-run : le brief implement d'un lot visible porte cadence news new <lot>, celui d'un lot sans écran non ; aucun {{…}} ne reste (L48/t3)", async () => {
    const { parent } = parentWith({ a: [{ title: 'un', visible: true }], b: [{ title: 'sans écran' }] });
    const r = await run(parent, ['a:L1', 'b:L1', '--dry-run']);
    try {
      const out = r.out.join('\n');
      const brief = (project: string) => {
        const line = out.split('\n').find((l) => l.includes('brief :') && l.includes(`${project}--L1--implement.md`))!;
        return readFileSync(line.replace(/^\s*brief : /, '').trim(), 'utf8');
      };
      const a = brief('a');
      const b = brief('b');
      expect(a).toContain('cadence news new L1');
      expect(b).not.toContain('news new');
      expect(a).not.toMatch(/\{\{/);
      expect(b).not.toMatch(/\{\{/);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it("--dry-run : l'étape implement d'un lot visible a le dossier Playwright de la vague en --add-dir ; lot sans écran : ni l'un ni l'autre (L48/t4)", async () => {
    const { parent } = parentWith({ a: [{ title: 'un', visible: true }], b: [{ title: 'sans écran' }] });
    const r = await run(parent, ['a:L1', 'b:L1', '--wave', 'w-t4', '--dry-run']);
    try {
      const out = r.out.join('\n');
      const dir = join(parent, '.cadence', 'runs', 'w-t4', 'a--L1', 'playwright');
      const briefOf = (project: string) => readFileSync(out.split('\n').find((l) => l.includes('brief :') && l.includes(`${project}--L1--implement.md`))!.replace(/^\s*brief : /, '').trim(), 'utf8');
      expect(briefOf('a')).not.toContain(dir); // le dry-run ne crée pas ce dossier : le brief ne le cite pas (L48/t5)
      expect(briefOf('b')).not.toContain('.cadence');
      const implement = (project: string) => out.split('\n').find((l) => l.startsWith('  implement : claude') && out.indexOf(l) > out.indexOf(`${project}:L1 —`))!;
      expect(implement('a')).toContain(`--add-dir ${dir}`);
      expect(implement('b')).not.toContain('--add-dir');
      expect(out.split('\n').filter((l) => /^  (ux|review|review-small) : claude/.test(l)).join('\n')).not.toContain(dir);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it("--dry-run : le brief implement d'un lot visible ne cite aucun chemin .cadence/runs mais garde la consigne Nouveautés (L48/t5)", async () => {
    const { parent } = parentWith({ a: [{ title: 'un', visible: true }] });
    const r = await run(parent, ['a:L1', '--wave', 'w-t5', '--dry-run']);
    try {
      const out = r.out.join('\n');
      const file = out.split('\n').find((l) => l.includes('brief :') && l.includes('a--L1--implement.md'))!.replace(/^\s*brief : /, '').trim();
      const brief = readFileSync(file, 'utf8');
      expect(brief).not.toContain('.cadence/runs');
      expect(brief).not.toContain('w-t5');
      expect(brief).toContain('cadence news new L1');
      expect(brief).toContain('OS temp directory');
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it('--dry-run : petit lot visible, review-small charge Playwright (et le dit) ; petit lot sans écran, aucun (L74/t6)', async () => {
    const { parent } = parentWith({ a: [{ title: 'petit', estimate: 0.5, visible: true }], b: [{ title: 'petit sans écran', estimate: 0.5 }] });
    const r = await run(parent, ['a:L1', 'b:L1', '--dry-run']);
    try {
      const out = r.out.join('\n');
      expect(out).toMatch(/  review-small : claude [^\n]*--strict-mcp-config[^\n]*\n    brief : [^\n]*\n    mcp : playwright \(captures dans le dossier de la vague : <vague>\/a--L1\/playwright\)/);
      expect(out).toMatch(/  review : claude [^\n]*\n    brief : [^\n]*\n    mcp : aucun/);
      expect(out).not.toMatch(/b--L1\/playwright/);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it('claude avant 2.1.284 : refus tant qu\'une passe demande un effort (L137), accepté si tout est « default »', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    const old = fakeDeps({}, { claudeInfo: () => ({ version: '2.1.283', jsonSchema: true }) }).deps;
    expect((await run(parent, ['a:L1', '--dry-run'], old)).err.join()).toContain("claude 2.1.283 n'a pas --effort");
    const all = ['precheck', 'implement', 'fix', 'review', 'ux'].map((k) => `${k}: default`).join(', ');
    writeFileSync(join(dirs.a, 'cadence.yaml'), `orchestrate:\n  effort: { ${all} }\n`);
    git(dirs.a, 'add', 'cadence.yaml');
    git(dirs.a, 'commit', '-q', '-m', 'cfg');
    const r = await run(parent, ['a:L1', '--dry-run'], old);
    try {
      expect(r.err.join()).not.toContain('--effort');
      expect(r.out.join('\n')).not.toContain('--effort');
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it('--dry-run affiche --effort <niveau> dans la ligne de chaque passe, selon orchestrate.effort (L137)', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'orchestrate:\n  effort: { precheck: low, implement: medium, fix: medium, review: high, ux: high }\n');
    git(dirs.a, 'add', 'cadence.yaml');
    git(dirs.a, 'commit', '-q', '-m', 'cfg');
    const r = await run(parent, ['a:L1', '--dry-run']);
    try {
      const out = r.out.join('\n');
      expect(out).toMatch(/  precheck : claude [^\n]*--effort low/);
      expect(out).toMatch(/  implement : claude [^\n]*--effort medium/);
      expect(out).toMatch(/  review[^ ]* : claude [^\n]*--effort high/);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
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
    // L150 — jamais un échec qui laisse la vague en vie : elle écrirait encore (wave.json.<pid>.tmp) après la
    // suppression du dossier du test (ENOENT non géré). On libère les créneaux et on attend la fin quoi qu'il arrive.
    try {
      // La vague démarre (dépôts git, verrous, état) AVANT d'atteindre l'attente : sous charge cela dépasse tout délai
      // fixe. On attend l'événement — son message d'attente — pas une durée.
      await until(() => /en attente d'un créneau de session/.test(r.out.join('\n')), "le message d'attente de créneau");
      expect(f.calls).toEqual([]); // plafond atteint : aucune session
      expect(r.out.join('\n')).toMatch(/en attente d'un créneau de session depuis \d+ s \(2\/2 en cours : x, y\)/);
      x();
      expect(await done).toBe(0);
      expect(f.calls.length).toBeGreaterThan(0);
      expect(r.out.join('\n')).toMatch(/créneau de session obtenu après \d+ s d'attente/);
      y();
      expect(liveSlots(home)).toEqual([]); // tous les créneaux de la vague sont rendus
    } finally {
      x(); // idempotents : rendre un créneau déjà rendu ne fait rien
      y();
      await done.catch(() => undefined);
    }
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

describe('--status : créneaux libres et vague choisie (L141)', () => {
  const run = async (parent: string, argv: string[]) => {
    const r = io(parent);
    return { code: await orchestrate(argv, r.io, fakeDeps().deps), ...r };
  };

  it('affiche les créneaux libres dans l\'en-tête des vagues vivantes', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-09-1253', started: '2026-10-09T12:53:00Z', cwd: '/ailleurs', repos: ['/x/a'], cap: 2 });
    const r = await run(parent, ['--status']);
    expect(r.out.join('\n')).toContain('vagues en cours : 1 · sessions en cours : 0 · créneaux libres : 1 sur 2');
    unregisterWave(cadenceHome(), process.ppid);
  });

  it('sans identifiant, montre le tableau de la vague la plus récemment lancée, pas la dernière par ordre alphabétique', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--wave', '2026-10-09-1253'], io(parent).io, f.deps)).toBe(0);
    const old = new RunStore(parent, 'ol-gains-1');
    const recent = new RunStore(parent, '2026-10-09-1253');
    old.writeWave({ ...recent.readWave()!, id: 'ol-gains-1', created: '2026-10-07T09:00:00.000Z' });
    recent.writeWave({ ...recent.readWave()!, created: '2026-10-09T12:53:00.000Z' });
    const r = await run(parent, ['--status']);
    expect(r.out.join('\n')).toContain('vague 2026-10-09-1253 :');
    expect(r.out.join('\n')).not.toContain('vague ol-gains-1 :');
  });

  it('RunStore.last avec unfinished (--resume sans identifiant) prend la dernière lancée non terminée, pas la dernière par ordre alphabétique', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    expect(await orchestrate(['a:L1', '--wave', '2026-10-09-1253'], io(parent).io, fakeDeps().deps)).toBe(0);
    const base = new RunStore(parent, '2026-10-09-1253').readWave()!;
    const wave = (id: string, created: string, status: 'interrupted' | 'done') => new RunStore(parent, id).writeWave({ ...base, id, created, status });
    wave('ol-gains-1', '2026-10-07T09:00:00.000Z', 'interrupted');
    wave('2026-10-09-1253', '2026-10-09T12:53:00.000Z', 'interrupted');
    expect(RunStore.last(parent, { unfinished: true })!.id).toBe('2026-10-09-1253');
    wave('2026-10-09-1253', '2026-10-09T12:53:00.000Z', 'done');
    expect(RunStore.last(parent, { unfinished: true })!.id).toBe('ol-gains-1');
  });
});

describe('--status --watch (L49)', () => {
  const CLEAR = '\x1b[H\x1b[2J';
  it('--watch et --interval : analyse, refus hors --status', async () => {
    expect(parseOrchestrateArgs(['--status', '--watch', '--interval', '5'])).toMatchObject({ status: true, watch: true, interval: 5 });
    expect(parseOrchestrateArgs(['--status', '2026-10-04-1412', '--watch']).status).toBe('2026-10-04-1412');
    expect(parseOrchestrateArgs(['--status']).watch).toBe(false);
    expect(() => parseOrchestrateArgs(['--interval', '0'])).toThrow(/--interval invalide/);
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const r = io(parent);
    await expect(orchestrate(['--watch'], r.io, fakeDeps().deps)).rejects.toThrow(/--watch s'utilise avec --status/);
    await expect(orchestrate(['--status', '--interval', '3'], r.io, fakeDeps().deps)).rejects.toThrow(/--interval s'utilise avec --status --watch/);
  });

  it('rafraîchit le tableau en effaçant l\'écran, puis s\'arrête seul quand plus aucune vague ne tourne', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--wave', '2026-10-08-1000'], io(parent).io, f.deps)).toBe(0);
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-08-1000', started: '2026-10-08T10:00:00Z', cwd: parent, repos: ['/x/a'], cap: 2 });
    const sleeps: number[] = [];
    f.deps.watchSleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) unregisterWave(cadenceHome(), process.ppid);
    };
    const r = io(parent);
    expect(await orchestrate(['--status', '--watch', '--interval', '3'], r.io, f.deps)).toBe(0);
    expect(sleeps).toEqual([3000, 3000]);
    expect(r.out.filter((l) => l === CLEAR)).toHaveLength(3); // deux rendus d'une vague vivante, un dernier sans
    const text = r.out.join('\n');
    expect(text.match(/vagues en cours : 1/g)).toHaveLength(2);
    expect(text).toContain('rafraîchi toutes les 3 s');
    expect(r.out[r.out.length - 1]).toMatch(/^vague 2026-10-08-1000 :/); // le dernier rendu reste affiché, sans invite
  });

  it('sans vague vivante : un seul rendu, sans attendre ; mêmes refus que --status', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    f.deps.watchSleep = async () => {
      throw new Error('ne doit pas attendre');
    };
    await expect(orchestrate(['--status', '--watch'], io(parent).io, f.deps)).rejects.toThrow(/aucune vague dans ce dossier/);
    expect(await orchestrate(['a:L1'], io(parent).io, f.deps)).toBe(0);
    const r = io(parent);
    expect(await orchestrate(['--status', '--watch'], r.io, f.deps)).toBe(0);
    expect(r.out.filter((l) => l === CLEAR)).toHaveLength(1);
  });
});

describe('--status <id> --watch pendant qu\'une autre vague tourne (L49)', () => {
  it('s\'arrête quand la vague observée ne tourne plus, même si une autre vague est vivante', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }] });
    const f = fakeDeps();
    expect(await orchestrate(['a:L1', '--wave', '2026-10-08-1000'], io(parent).io, f.deps)).toBe(0);
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-08-1100', started: '2026-10-08T11:00:00Z', cwd: '/ailleurs', repos: ['/x/b'], cap: 2 });
    f.deps.watchSleep = async () => {
      throw new Error('ne doit pas attendre');
    };
    try {
      const r = io(parent);
      expect(await orchestrate(['--status', '2026-10-08-1000', '--watch'], r.io, f.deps)).toBe(0);
      expect(r.out.filter((l) => l === '\x1b[H\x1b[2J')).toHaveLength(1);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
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

  it('L133 — dépôt sali par une revue : le lot suivant est suspendu mais la vague n\'est pas « suspended-budget » (code 1, reprenable)', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps({ review: (cwd) => { writeFileSync(join(cwd, 'capture.png'), 'png'); return claudeOut(reviewReport()); } });
    const r = io(parent);
    const code = await orchestrate(['a:L1', 'a:L2', '--max-sessions', '1'], r.io, f.deps);
    expect(code).toBe(1);
    const wave = new RunStore(parent, '2026-10-04-1412').readWave()!;
    expect(wave.status).toBe('interrupted');
    expect(wave.consumed).toBeLessThan(wave.budget);
    expect(r.out.join('\n')).not.toMatch(/suspended-budget/);
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

  it('L120 — plan en lecture seule, lot « Q4/accueil-4-ux12 » : --dry-run, vague, question, --answer, --status', async () => {
    const parent = tempDir();
    const dir = join(parent, 'ma');
    mkdirSync(join(dir, 'docs/plan'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'docs/plan/taches.yaml'), 'taches:\n- id: Q4/accueil-4-ux12\n  titre: sous-tâche\n  etat: en_cours\n  parent: SQ4\n  visible: true\n- id: SQ4\n  titre: parent\n  etat: en_cours\n');
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: docs/plan/taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, parent: parent, visible: visible }\n  statuses: { todo: prevu, doing: en_cours, done: deploye }\norchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', 'docs/plan/taches.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    const id = 'ma:Q4/accueil-4-ux12';
    const dry = io(parent);
    try {
      expect(await orchestrate([id + '@haiku', '--dry-run'], dry.io, fakeDeps().deps)).toBe(0);
      expect(dry.out.join('\n')).toContain('ma:Q4/accueil-4-ux12 —');
      expect(dry.out.join('\n')).toContain('ma--Q4__accueil-4-ux12--implement.md');
      expect(dry.out.join('\n')).toContain('haiku');
      expect(dry.out.join('\n')).toContain('<vague>/ma--Q4__accueil-4-ux12/playwright');
      expect(dry.out.join('\n')).not.toContain('<vague>/ma--Q4/accueil');
    } finally {
      removeDryRunBriefs(dry.out.join('\n'));
    }
    let n = 0;
    const f = fakeDeps({
      implement: (cwd) => (n++ === 0 ? claudeOut(workReport({ questions: ['Quelle option ?'] })) : claudeOut(workReport({ commits: [commitFile(cwd, 'x.txt', 'feat(Q4/accueil-4-ux12): x')] }))),
    });
    const first = io(parent);
    expect(await orchestrate([id], first.io, f.deps)).toBe(1);
    expect(first.out.join('\n')).toContain(`--resume --answer ${id} "…"`);
    const runs = join(parent, '.cadence/runs/2026-10-04-1412');
    expect(readdirSync(runs)).toContain('ma--Q4__accueil-4-ux12.json');
    expect(readdirSync(runs).filter((x) => x.includes('/'))).toEqual([]);
    expect(await orchestrate(['--resume', '--answer', id, 'A'], io(parent).io, f.deps)).toBe(0);
    expect(new RunStore(parent, '2026-10-04-1412').readLot('ma', 'Q4/accueil-4-ux12')!.answers).toEqual(['A']);
    const st = io(parent);
    expect(await orchestrate(['--status'], st.io, fakeDeps().deps)).toBe(0);
    expect(st.out.join('\n')).toContain(id);
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

describe('Node du projet (.nvmrc)', () => {
  /** Un faux ~/.nvm/versions/node avec les versions données. */
  function fakeNvm(versions: string[]): string {
    const dir = tempDir();
    for (const v of versions) {
      mkdirSync(join(dir, 'versions/node', v, 'bin'), { recursive: true });
      for (const n of ['node', 'npm', 'npx', 'raf', 'cadence']) writeFileSync(join(dir, 'versions/node', v, 'bin', n), '#!/bin/sh\n', { mode: 0o755 });
    }
    return dir;
  }
  const run = async (parent: string, argv: string[], deps: OrchestrateDeps, env: Record<string, string>) => {
    const r = io(parent, env);
    const code = await orchestrate(argv, r.io, deps);
    return { code, ...r };
  };

  it('.nvmrc : chaque session part avec le Node en tête du PATH, process.env intact', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    writeFileSync(join(dirs.a, '.nvmrc'), 'v22\n');
    const nvm = fakeNvm(['v20.20.2', 'v22.22.2', 'v22.22.3']);
    const seen: Record<string, string | undefined> = {};
    const before = process.env.PATH;
    const f = fakeDeps();
    const inner = f.deps.claude;
    f.deps.claude = async (args, o) => {
      seen[`${o.cwd.endsWith('/a') ? 'a' : 'b'}:${kindOf(args)}`] = o.env.PATH;
      return inner(args, o);
    };
    const r = await run(parent, ['a:L1', 'b:L1'], f.deps, { NVM_DIR: nvm });
    expect(r.code).toBe(0);
    const want = join(parent, '.cadence/runs/2026-10-04-1412/node-bin/v22.22.3');
    const aPaths = Object.entries(seen).filter(([k]) => k.startsWith('a:')).map(([, v]) => v);
    expect(aPaths.length).toBeGreaterThanOrEqual(2); // implement + revue, toutes préfixées
    for (const p of aPaths) expect(p!.split(':')[0]).toBe(want);
    // L80/t2 : seul node/npm/npx (présents dans le faux bin) sont atteignables ; raf et cadence du bin nvm ne masquent rien
    expect(readdirSync(want).sort()).toEqual(['node', 'npm', 'npx']);
    expect(existsSync(join(want, 'raf'))).toBe(false);
    expect(existsSync(join(nvm, 'versions/node/v22.22.3/bin/raf'))).toBe(true);
    expect(aPaths.every((p) => !p!.split(':').includes(join(nvm, 'versions/node/v22.22.3/bin')))).toBe(true);
    for (const [k, v] of Object.entries(seen)) if (k.startsWith('b:')) expect(v).toBeUndefined(); // pas de .nvmrc : inchangé
    expect(process.env.PATH).toBe(before);
  });

  it('version absente : refus code 2 avant d\'agir, avec la version et le dossier', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    writeFileSync(join(dirs.a, '.nvmrc'), '24\n');
    const nvm = fakeNvm(['v22.22.3']);
    const f = fakeDeps();
    const r = await run(parent, ['a:L1'], f.deps, { NVM_DIR: nvm });
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain(`a:L1 : .nvmrc 24 : aucun Node installé correspondant dans ${join(nvm, 'versions/node')}`);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(parent, '.cadence'))).toBe(false);
  });

  /** Une vague suspendue au budget (code 3), prête à reprendre ; rend la fabrique de store pour relire/modifier l'état. */
  async function suspended(nvmrc: string | null, nvm: string) {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    if (nvmrc !== null) writeFileSync(join(dirs.a, '.nvmrc'), nvmrc);
    const f = fakeDeps();
    expect((await run(parent, ['a:L1', '--budget', '1'], f.deps, { NVM_DIR: nvm })).code).toBe(3);
    return { parent, dirs, f, store: () => RunStore.last(parent)! };
  }

  it('L80/t1 — --resume : version désinstallée depuis le départ → refus code 2, rien ne repart', async () => {
    const nvm = fakeNvm(['v22.22.3']);
    const s = await suspended('22', nvm);
    rmSync(join(nvm, 'versions/node/v22.22.3'), { recursive: true });
    const calls = s.f.calls.length;
    const r = await run(s.parent, ['--resume', '--budget', '1M'], s.f.deps, { NVM_DIR: nvm });
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain(`a:L1 : .nvmrc 22 : aucun Node installé correspondant dans ${join(nvm, 'versions/node')}`);
    expect(s.f.calls.length).toBe(calls);
  });

  it('L80/t1 — --resume : .nvmrc modifié pendant la vague → nouvelle version résolue et enregistrée', async () => {
    const nvm = fakeNvm(['v22.22.3', 'v24.1.0']);
    const s = await suspended('22', nvm);
    expect(s.store().readLot('a', 'L1')!.node?.version).toBe('v22.22.3');
    writeFileSync(join(s.dirs.a, '.nvmrc'), '24');
    expect((await run(s.parent, ['--resume', '--budget', '1M'], s.f.deps, { NVM_DIR: nvm })).code).toBe(0);
    expect(s.store().readLot('a', 'L1')!.node).toMatchObject({ version: 'v24.1.0', wanted: '24' });
    expect(readdirSync(join(s.store().dir, 'node-bin')).sort()).toEqual(['v22.22.3', 'v24.1.0']); // lien recréé à la reprise
  });

  it('L80/t1 — --resume d\'un état sans node (vague d\'avant L80) et un .nvmrc → résolu et enregistré', async () => {
    const nvm = fakeNvm(['v22.22.3']);
    const s = await suspended(null, nvm);
    expect(s.store().readLot('a', 'L1')!.node).toBeUndefined();
    writeFileSync(join(s.dirs.a, '.nvmrc'), '22');
    expect((await run(s.parent, ['--resume', '--budget', '1M'], s.f.deps, { NVM_DIR: nvm })).code).toBe(0);
    expect(s.store().readLot('a', 'L1')!.node).toMatchObject({ version: 'v22.22.3' });
  });

  it('L80/t1 — --resume sans .nvmrc : inchangé', async () => {
    const nvm = fakeNvm(['v22.22.3']);
    const s = await suspended(null, nvm);
    expect((await run(s.parent, ['--resume', '--budget', '1M'], s.f.deps, { NVM_DIR: nvm })).code).toBe(0);
    expect(s.store().readLot('a', 'L1')!.node).toBeUndefined();
  });

  // L80/t4 — vrai disque (aucun NodeFs injecté) : couvre realNodeFs.executable.
  const emptyBin = (nvm: string, v: string) => {
    rmSync(join(nvm, 'versions/node', v, 'bin'), { recursive: true });
    mkdirSync(join(nvm, 'versions/node', v, 'bin'));
  };
  const notExec = (nvm: string, v: string) => chmodSync(join(nvm, 'versions/node', v, 'bin/node'), 0o644);
  const broken: [string, (nvm: string, v: string) => void][] = [['bin vide', emptyBin], ['bin/node en 0o644', notExec]];

  for (const [label, breakIt] of broken) {
    it(`L80/t4 — ${label} : version refusée au départ (code 2, aucune session)`, async () => {
      const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
      writeFileSync(join(dirs.a, '.nvmrc'), '22');
      const nvm = fakeNvm(['v20.20.2', 'v22.22.3']);
      breakIt(nvm, 'v22.22.3');
      const f = fakeDeps();
      const r = await run(parent, ['a:L1'], f.deps, { NVM_DIR: nvm });
      expect(r.code).toBe(2);
      expect(r.err.join('\n')).toContain('a:L1 : .nvmrc 22 : v22.22.3 trouvée(s)');
      expect(r.err.join('\n')).toContain('sans node exécutable');
      expect(f.calls).toEqual([]);
      expect(existsSync(join(parent, '.cadence'))).toBe(false);
    });

    it(`L80/t4 — ${label} : version refusée à --resume (code 2, aucune session)`, async () => {
      const nvm = fakeNvm(['v22.22.3']);
      const s = await suspended('22', nvm);
      breakIt(nvm, 'v22.22.3');
      const calls = s.f.calls.length;
      const r = await run(s.parent, ['--resume', '--budget', '1M'], s.f.deps, { NVM_DIR: nvm });
      expect(r.code).toBe(2);
      expect(r.err.join('\n')).toContain('sans node exécutable');
      expect(s.f.calls.length).toBe(calls);
    });
  }

  it('L80/t5 — --dry-run : une version plus haute sans node exécutable est écartée et le dit', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    writeFileSync(join(dirs.a, '.nvmrc'), '22');
    const nvm = fakeNvm(['v22.9.0', 'v22.22.3']);
    emptyBin(nvm, 'v22.22.3');
    const r = await run(parent, ['a:L1', '--dry-run'], fakeDeps().deps, { NVM_DIR: nvm });
    try {
      expect(r.code).toBe(0);
      expect(r.out.filter((l) => l.includes('node :'))).toEqual(['  node : v22.9.0 (.nvmrc 22 ; v22.22.3 écartée : pas de node exécutable)']);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });

  it('L80/t6 — un lien qui échoue au départ libère la vague : le même --wave se relance', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }] });
    writeFileSync(join(dirs.a, '.nvmrc'), '22');
    const nvm = fakeNvm(['v22.22.3']);
    const f = fakeDeps();
    f.deps.linkNode = () => {
      throw new Error('EACCES: symlink');
    };
    await expect(run(parent, ['a:L1', '--wave', 'w1'], f.deps, { NVM_DIR: nvm })).rejects.toThrow(/EACCES/);
    expect(existsSync(join(parent, '.cadence/runs/w1'))).toBe(false);
    expect(f.calls).toEqual([]);
    delete f.deps.linkNode;
    expect((await run(parent, ['a:L1', '--wave', 'w1'], f.deps, { NVM_DIR: nvm })).code).toBe(0);
  });

  it('--dry-run : une ligne node par lot avec .nvmrc, rien sans', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'un' }], b: [{ title: 'deux' }] });
    writeFileSync(join(dirs.a, '.nvmrc'), '22');
    const r = await run(parent, ['a:L1', 'b:L1', '--dry-run'], fakeDeps().deps, { NVM_DIR: fakeNvm(['v22.22.2', 'v22.22.3']) });
    try {
      expect(r.code).toBe(0);
      expect(r.out.filter((l) => l.includes('node :'))).toEqual(['  node : v22.22.3 (.nvmrc 22)']);
    } finally {
      removeDryRunBriefs(r.out.join('\n'));
    }
  });
});

describe('budget par lot (L78)', () => {
  it("dérivé de l'estimate : 400 k par jour, plancher 450 k (écriture + revue + correction + revue courte, L128)", () => {
    expect(lotBudget(0.1)).toBe(450_000);
    expect(lotBudget(0.5)).toBe(450_000);
    expect(lotBudget(1)).toBe(450_000);
    expect(lotBudget(1.25)).toBe(500_000);
    expect(lotBudget(2.5)).toBe(1_000_000);
  });

  it('le plancher couvre le pire cas mesuré (L62 : contrôle 14 k, écriture 282 k, revue 80 k) plus la réserve de 65 k pour une correction et sa revue', () => {
    expect(lotBudget(0.1)).toBeGreaterThanOrEqual(14_000 + 282_000 + 80_000 + 65_000);
  });

  it("mesures du 06-10 rejouées avec la règle : le contrôle se fait avant chaque session, plus aucun des 5 lots n'est arrêté par le plancher de 450 k (L128)", () => {
    // Un lot n'est arrêté que si une session devait partir alors que le cumul avait déjà atteint le plafond :
    // il suffit que le cumul avant sa dernière session soit au plafond (le cumul ne fait que croître).
    // [lot, estimate, cumul avant la dernière session, total final] d'après .cadence/runs/2026-10-06-1801
    const mesures: Array<[string, number, number, number, boolean]> = [
      ['finance L4', 0.5, 252_770, 459_507, false],
      ['finance L5', 0.5, 220_513, 337_304, false],
      ['finance L6', 1, 403_391, 455_197, false],
      ['ol L37', 1, 405_513, 468_399, false],
      ['ol L36', 0.5, 169_079, 205_155, false], // sa dernière review-small part à 169 k : le lot finit à 205 k et reste « ready »
    ];
    for (const [lot, estimate, avantDerniere, final, arrete] of mesures) {
      expect(avantDerniere >= lotBudget(estimate), `${lot} (final ${final})`).toBe(arrete);
    }
  });

  it("--dry-run dit le budget de chaque lot", async () => {
    const { parent } = parentWith({ a: [{ title: 'un', estimate: 1 }], b: [{ title: 'gros', estimate: 2 }] });
    const r = io(parent);
    await orchestrate(['a:L1', 'b:L1', '--dry-run'], r.io, fakeDeps().deps);
    const text = r.out.join('\n');
    try {
      expect(text).toContain('budget du lot : 450000 tokens comptés');
      expect(text).toContain('budget du lot : 800000 tokens comptés');
    } finally {
      removeDryRunBriefs(text);
    }
  });

  it('revue proportionnée (L108) : seuil sur l\'estimate, dry-run et état du lot le disent ; le seuil vient de cadence.yaml', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'léger', estimate: 0.25 }], b: [{ title: 'plus gros', estimate: 0.5 }] });
    const r = io(parent);
    await orchestrate(['a:L1', 'b:L1', '--dry-run'], r.io, fakeDeps().deps);
    const text = r.out.join('\n');
    try {
      expect(text).toMatch(/étapes : implement \(sonnet\) → review \(sonnet\) — petit lot — revue légère/);
      expect(text).toMatch(/étapes : implement \(sonnet\) → review \(opus\) — petit lot\n/);
    } finally {
      removeDryRunBriefs(text);
    }
    writeFileSync(join(dirs.b, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n  review: { threshold: 0.5, light: haiku }\n');
    git(dirs.b, 'add', 'cadence.yaml');
    git(dirs.b, 'commit', '-q', '-m', 'chore: cadence.yaml');
    const f = fakeDeps();
    await orchestrate(['a:L1', 'b:L1', '--budget', '1'], io(parent).io, f.deps);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.light).toBe(true);
    expect(store.readLot('b', 'L1')!.light).toBe(true);
  });

  it('revue proportionnée (L108) : seuil > 0,5, le dry-run d\'un lot léger non petit annonce le modèle léger', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'gros mais léger', estimate: 1 }] });
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n  review: { threshold: 2 }\n');
    git(dirs.a, 'add', 'cadence.yaml');
    git(dirs.a, 'commit', '-q', '-m', 'chore: cadence.yaml');
    const r = io(parent);
    await orchestrate(['a:L1', '--dry-run'], r.io, fakeDeps().deps);
    const text = r.out.join('\n');
    try {
      expect(text).toMatch(/étapes : implement \(sonnet\) → review \(sonnet\) — revue légère/);
    } finally {
      removeDryRunBriefs(text);
    }
  });

  it("le budget est écrit dans l'état du lot", async () => {
    const { parent } = parentWith({ a: [{ title: 'un', estimate: 2 }] });
    const f = fakeDeps();
    await orchestrate(['a:L1', '--budget', '1'], io(parent).io, f.deps);
    const store = RunStore.last(parent)!;
    expect(store.readLot('a', 'L1')!.budget).toBe(800_000);
  });
});

describe('--continue (L147)', () => {
  const doneBy = (calls: { cwd: string; kind: string }[]) => calls.filter((c) => c.kind === 'implement').map((c) => c.cwd.split('/').pop());

  it('sans lot donné, tire les lots prêts dans l\'ordre de priorité, projet après projet, puis s\'arrête faute de lot', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }, { title: 'b deux' }] });
    const f = fakeDeps();
    const o = io(parent);
    const code = await orchestrate(['--continue', '--priority', 'b,a', '--max-sessions', '1'], o.io, f.deps);
    expect(code).toBe(0);
    expect(doneBy(f.calls)).toEqual(['b', 'b', 'a']);
    expect(o.out.join('\n')).toMatch(/continue : tire b:L2\n/);
    expect(o.out.join('\n')).toMatch(/continue : arrêt — plus aucun lot prêt/);
    const store = RunStore.last(parent)!;
    expect(store.readWave()!.lots).toEqual(['b:L1', 'b:L2', 'a:L1']);
    expect(store.readWave()!.status).toBe('done');
  });

  it('la priorité vient du cadence.yaml du dossier parent ; les lots à décider et ceux dont l\'after n\'est pas levé ne sont pas tirés', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un à décider avec Sylvain' }, { title: 'b deux', after: ['L1'] }, { title: 'b trois' }] });
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: [b, a]\n');
    const f = fakeDeps();
    expect(await orchestrate(['--continue', '--max-sessions', '1'], io(parent).io, f.deps)).toBe(0);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['b:L3', 'a:L1']);
  });

  it('un lot donné ouvre la vague, la suite est tirée ; une question arrête le tirage et garde la vague reprenable', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const f = fakeDeps({ implement: (cwd) => claudeOut(workReport({ questions: ['Quelle base ?'] })) });
    const o = io(parent);
    const code = await orchestrate(['a:L1', '--continue'], o.io, f.deps);
    expect(code).toBe(1);
    expect(doneBy(f.calls)).toEqual(['a']);
    expect(o.out.join('\n')).toMatch(/continue : arrêt — 1 question/);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1']);
  });

  it('deux lots rendus de suite arrêtent le tirage', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }, { title: 'trois' }] });
    const f = fakeDeps({ implement: () => claudeOut(workReport({ commits: [] })) });
    const o = io(parent);
    await orchestrate(['--continue', '--max-sessions', '1'], o.io, f.deps);
    expect(o.out.join('\n')).toMatch(/continue : arrêt — deux lots rendus de suite/);
    expect(RunStore.last(parent)!.readWave()!.lots).toHaveLength(2);
  });

  it('le budget restant : un lot dont l\'estimation ne tient pas n\'est pas tiré, le suivant qui tient l\'est', async () => {
    const { parent } = parentWith({ a: [{ title: 'gros', estimate: 3 }, { title: 'petit', estimate: 0.5 }] });
    const f = fakeDeps();
    const o = io(parent);
    await orchestrate(['--continue', '--budget', '500k'], o.io, f.deps);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L2']);
  });

  it('--until : la fenêtre close (l\'horloge passe l\'heure) arrête le tirage ; --until sans --continue ou invalide est refusé', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    let hour = 14;
    const o = io(parent);
    o.io.now = () => new Date(`2026-10-04T${hour}:12:00`);
    const f = fakeDeps({ implement: (cwd) => { hour = 18; return claudeOut(workReport({ commits: [commitFile(cwd, `x${Math.random()}.txt`, 'feat(L1): x')] })); } });
    await orchestrate(['--continue', '--until', '17:00', '--max-sessions', '1'], o.io, f.deps);
    expect(o.out.join('\n')).toMatch(/continue : arrêt — fenêtre horaire close/);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1']);
    await expect(orchestrate(['a:L1', '--until', '17:00'], io(parent).io, f.deps)).rejects.toThrow(/--continue/);
    await expect(orchestrate(['--continue', '--until', '13:00'], io(parent).io, f.deps)).rejects.toThrow(/déjà passée/);
  });

  it('aucun lot prêt au départ : refus (2) ; --dry-run dit les lots qui seraient tirés', async () => {
    const empty = parentWith({ a: [{ title: 'à décider avec Sylvain' }] });
    const e = io(empty.parent);
    expect(await orchestrate(['--continue'], e.io, fakeDeps().deps)).toBe(2);
    expect(e.err.join('\n')).toMatch(/aucun lot prêt/);
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const o = io(parent);
    expect(await orchestrate(['a:L1', '--continue', '--until', '17:00', '--dry-run'], o.io, fakeDeps().deps)).toBe(0);
    removeDryRunBriefs(o.out.join('\n'));
    expect(o.out.join('\n')).toMatch(/--continue : priorité .*jusqu'à 17:00\n.*tirés ensuite, par tour .*: tour 1 : a:L2/);
  });

  it('--dry-run --continue simule les tours avec la règle de draw (un lot par dépôt par tour) et dit les lots sautés', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a1' }, { title: 'a2' }, { title: 'a3' }, { title: 'a4' }], b: [{ title: 'b1' }, { title: 'b2' }], c: [{ title: 'c1' }] });
    writeFileSync(join(dirs.c, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n# sale\n');
    const o = io(parent);
    expect(await orchestrate(['--continue', '--dry-run', '--priority', 'a,b,c', '--max-sessions', '2', '--budget', '4M'], o.io, fakeDeps().deps)).toBe(0);
    removeDryRunBriefs(o.out.join('\n'));
    const text = o.out.join('\n');
    // premier tirage : a:L1, b:L1 (lots donnés, affichés par la simulation) ; ensuite un seul lot de a par tour tant que b en a, puis a seul complète
    expect(text).toMatch(/tirés ensuite, par tour .*: tour 1 : a:L2, b:L2 · tour 2 : a:L3, a:L4/);
    expect(text.match(/lot sauté — c : arbre sale/g)).toHaveLength(1);
    expect(text).not.toMatch(/tour 1 : a:L2, a:L3/);
  });

  it('un refus qui vaut pour tout le dépôt (arbre sale) saute le dépôt pour ce tirage seulement : une ligne, et ses lots sont tirés dès qu\'il est propre', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }, { title: 'a trois' }], b: [{ title: 'b un' }, { title: 'b deux' }] });
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n# sale\n');
    let cleaned = false;
    const f = fakeDeps({
      implement: (cwd, brief) => {
        const lot = /on lot `([^`]+)`/.exec(brief)![1];
        if (cwd.endsWith('/b') && lot === 'L2' && !cleaned) {
          cleaned = true;
          git(dirs.a, 'checkout', '--', 'cadence.yaml');
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `x-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const o = io(parent);
    await orchestrate(['--continue', '--priority', 'a,b', '--max-sessions', '1'], o.io, f.deps);
    const text = o.out.join('\n');
    expect(text.match(/lot sauté — a : arbre sale/g)).toHaveLength(1);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['b:L1', 'b:L2', 'a:L1', 'a:L2', 'a:L3']);
  });

  it('--resume --answer … --continue : la vague reprise tire la suite du plan, sans rejouer les lots repris', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    let n = 0;
    const f = fakeDeps({
      implement: (cwd, brief) => (n++ === 0 ? claudeOut(workReport({ questions: ['Quelle base ?'] })) : claudeOut(workReport({ commits: [commitFile(cwd, `x-${n}.txt`, `feat(${/on lot \`([^\`]+)\`/.exec(brief)![1]}): x`)] }))),
    });
    expect(await orchestrate(['a:L1'], io(parent).io, f.deps)).toBe(1);
    const o = io(parent);
    expect(await orchestrate(['--resume', '--answer', 'a:L1', 'SQLite', '--continue', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(o.out.join('\n')).toMatch(/continue : tire a:L2\n/);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1', 'a:L2']);
    expect(f.calls.filter((c) => c.kind === 'implement')).toHaveLength(3); // L1, L1 repris, L2
    expect(RunStore.last(parent)!.readWave()!.status).toBe('done');
  });

  it("la limite d'usage arrête le tirage (vague suspendue, code 3)", async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const quota = fakeDeps({ implement: () => claudeOut({}, {}, { is_error: true, subtype: 'success', result: 'Claude AI usage limit reached|1759600000' }) });
    const o = io(parent);
    expect(await orchestrate(['--continue', '--max-sessions', '1'], o.io, quota.deps)).toBe(3);
    expect(o.out.join('\n')).toMatch(/continue : arrêt — limite d'usage atteinte/);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1']);

  });

  it('un lot qui ne tient pas dans le reste d\'UN tour n\'est pas écarté pour la vague : il est tiré au tour suivant, quand le budget restant le permet', async () => {
    const { parent } = parentWith({ a: [{ title: 'un', estimate: 0.5 }, { title: 'deux', estimate: 0.5 }, { title: 'trois', estimate: 1 }] });
    const f = fakeDeps();
    const o = io(parent);
    await orchestrate(['a:L1', '--continue', '--budget', '500k', '--max-sessions', '2'], o.io, f.deps);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1', 'a:L2', 'a:L3']);
    expect(o.out.join('\n')).toMatch(/continue : tire a:L2\n[\s\S]*continue : tire a:L3\n/);
  });

  it('au premier tour sans lot donné, un lot sauté dit sa cause : sur la sortie d\'erreur et dans le journal de la vague', async () => {
    const { parent, dirs } = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }] });
    writeFileSync(join(dirs.a, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n# sale\n');
    const f = fakeDeps();
    const o = io(parent);
    expect(await orchestrate(['--continue', '--priority', 'a,b', '--max-sessions', '1'], o.io, f.deps)).toBe(0);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['b:L1']);
    expect(o.err.join('\n')).toMatch(/lot sauté — a : arbre sale/);
    const journal = readFileSync(join(RunStore.last(parent)!.dir, 'journal.log'), 'utf8');
    expect(journal).toMatch(/continue : lot sauté — a : arbre sale/);
    expect(journal.indexOf('lot sauté')).toBeLessThan(journal.indexOf('continue : arrêt'));
  });

  it('une clé priority: invalide du cadence.yaml du dossier de lancement est refusée avant d\'agir, même avec des lots donnés', async () => {
    const { parent } = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: 3\n');
    const f = fakeDeps();
    await expect(orchestrate(['a:L1', '--continue'], io(parent).io, f.deps)).rejects.toThrow(/priority/);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(join(parent, '.cadence/runs')) ? readdirSync(join(parent, '.cadence/runs')) : []).toEqual([]);
  });

  it('un tour tire au plus UN lot par dépôt tant que d\'autres dépôts ont des lots prêts, puis complète avec le même dépôt s\'il n\'y a rien d\'autre', async () => {
    const { parent } = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }, { title: 'a trois' }, { title: 'a quatre' }], b: [{ title: 'b un' }, { title: 'b deux' }] });
    const f = fakeDeps();
    const o = io(parent);
    await orchestrate(['--continue', '--priority', 'a,b', '--max-sessions', '2'], o.io, f.deps);
    const text = o.out.join('\n');
    expect(text).toMatch(/continue : tire a:L2, b:L2\n/);
    expect(text).toMatch(/continue : tire a:L3, a:L4\n/);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1', 'b:L1', 'a:L2', 'b:L2', 'a:L3', 'a:L4']);
  });
});
