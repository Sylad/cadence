import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { RunStore } from '../src/orchestrate/state.js';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { AGENTS_DIR } from '../src/skills.js';
import { removeDryRunBriefs, tempDir } from './helpers.js';

// le registre des vagues est propre à chaque test (comme dans orchestrate-command.test.ts)
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

/** Une simulation ne lance aucune session : le faux claude échoue s'il est appelé. */
const fakeDeps = (): { deps: OrchestrateDeps } => ({
  deps: { claude: async () => { throw new Error('aucune session en simulation'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR },
});

function io(cwd: string) {
  const out: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-23' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-23T09:00:00') };
  return { io: i, out };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

type L = { title: string; uses?: string[]; doing?: boolean; after?: string[] };

/** Dossier parent de projets git, chacun avec son plan (`uses:` posé par lot) ; `parentYaml` : cadence.yaml du parent. */
function parentWith(projects: Record<string, L[]>, parentYaml = 'resources: [banc, passerelle]\n') {
  const parent = tempDir();
  const dirs: Record<string, string> = {};
  for (const [name, lots] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(dir, ...a);
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), name, 'L', '2026-09-01');
    for (const l of lots) {
      const id = plan.add(l.title, '2026-10-01', { estimate: 1, uses: l.uses, after: l.after });
      if (l.doing) plan.setStatus(id, 'doing', '2026-10-01');
    }
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', 'docs/plan/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    dirs[name] = dir;
  }
  writeFileSync(join(parent, 'cadence.yaml'), parentYaml);
  return { parent, dirs };
}

/** Une vague vivante (pid du parent de vitest) qui ne tient aucun dépôt : elle ouvre la ligne des créneaux libres, sans rien prendre. */
const withIdleWave = <T>(cwd: string, body: () => Promise<T>): Promise<T> => {
  registerWave(cadenceHome(), { pid: process.ppid, wave: 'vague-vide', started: '2026-10-23T09:00:00Z', cwd, repos: [], cap: 2 });
  return body().finally(() => unregisterWave(cadenceHome(), process.ppid));
};

async function tour(dir: string, ...extra: string[]) {
  const out: string[] = [];
  const code = await run(['lead', 'tour', ...extra], { cwd: dir, env: { RAF_TODAY: '2026-10-23' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-10-23T09:00:00') });
  return { code, out: out.join('\n') };
}

const FREE = 'prêts, ressources libres : ';

describe('L252 — lead tour : les lots prêts dont les ressources sont libres', () => {
  it('R1 — un lot doing qui tient banc écarte les prêts qui l\'utilisent, dans tous les projets', async () => {
    const { parent } = parentWith({
      alpha: [{ title: 'Banc en cours', uses: ['banc'], doing: true }, { title: 'Autre banc', uses: ['banc'] }, { title: 'Sans ressource' }, { title: 'Passerelle', uses: ['passerelle'] }],
      beta: [{ title: 'Beta banc', uses: ['banc'] }, { title: 'Beta libre' }],
    });
    const line = (await withIdleWave(parent, () => tour(parent))).out.split('\n').find((l) => l.startsWith(FREE))!;
    expect(line).toBe(`${FREE}alpha:L3 Sans ressource · alpha:L4 Passerelle (passerelle) · beta:L2 Beta libre`);
  });

  it('R2 — sans lot doing, tous les prêts sont libres et la ressource est indiquée', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'A', uses: ['banc'] }], beta: [{ title: 'B', uses: ['banc'] }] });
    const line = (await withIdleWave(parent, () => tour(parent))).out.split('\n').find((l) => l.startsWith(FREE))!;
    expect(line).toBe(`${FREE}alpha:L1 A (banc) · beta:L1 B (banc)`);
  });

  it('R3 — une vague en cours qui tient banc l\'écarte aussi, ses propres lots ne sont pas listés', async () => {
    const { parent, dirs } = parentWith({ alpha: [{ title: 'Dans la vague', uses: ['banc'] }, { title: 'Libre' }], beta: [{ title: 'Beta banc', uses: ['banc'] }, { title: 'Beta passerelle', uses: ['passerelle'] }] });
    const store = RunStore.reserve(parent, '2026-10-23-0900')!;
    store.writeWave({ id: store.id, created: '2026-10-23T09:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: ['alpha:L1'] });
    store.writeLot({ project: 'alpha', repo: dirs.alpha, lot: 'L1', title: 'Dans la vague', visible: false, small: true, status: 'running' } as never);
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: '2026-10-23T09:00:00Z', cwd: parent, repos: [dirs.alpha], cap: 2 });
    try {
      const line = (await tour(parent)).out.split('\n').find((l) => l.startsWith(FREE))!;
      expect(line).toBe(`${FREE}alpha:L2 Libre · beta:L2 Beta passerelle (passerelle)`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R3 — une vague dont le lot est fini ne tient plus sa ressource', async () => {
    const { parent, dirs } = parentWith({ alpha: [{ title: 'Rendu', uses: ['banc'] }], beta: [{ title: 'Beta banc', uses: ['banc'] }] });
    const store = RunStore.reserve(parent, '2026-10-23-0900')!;
    store.writeWave({ id: store.id, created: '2026-10-23T09:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: ['alpha:L1'] });
    store.writeLot({ project: 'alpha', repo: dirs.alpha, lot: 'L1', title: 'Rendu', visible: false, small: true, status: 'handed-back' } as never);
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: '2026-10-23T09:00:00Z', cwd: parent, repos: [], cap: 2 });
    try {
      expect((await tour(parent)).out).toContain(`${FREE}alpha:L1 Rendu (banc) · beta:L1 Beta banc (banc)`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R3 — un état de vague illisible ne casse pas le tour : la ligne reste donnée', async () => {
    const { parent, dirs } = parentWith({ alpha: [{ title: 'Libre' }] });
    const store = RunStore.reserve(parent, '2026-10-23-0900')!;
    store.writeWave({ id: store.id, created: '2026-10-23T09:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: [] });
    writeFileSync(join(store.dir, 'alpha--L9.json'), '{ pas du json');
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: '2026-10-23T09:00:00Z', cwd: parent, repos: [dirs.alpha], cap: 2 });
    try {
      expect((await tour(parent)).out).toContain(`${FREE}alpha:L1 Libre`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R3 — un lot sans uses: d\'une vague vivante n\'est pas proposé comme libre', async () => {
    const { parent, dirs } = parentWith({ alpha: [{ title: 'Dans la vague' }, { title: 'Libre' }] });
    const store = RunStore.reserve(parent, '2026-10-23-0900')!;
    store.writeWave({ id: store.id, created: '2026-10-23T09:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: ['alpha:L1'] });
    store.writeLot({ project: 'alpha', repo: dirs.alpha, lot: 'L1', title: 'Dans la vague', visible: false, small: true, status: 'queued' } as never);
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: '2026-10-23T09:00:00Z', cwd: parent, repos: [dirs.alpha], cap: 2 });
    try {
      const line = (await tour(parent)).out.split('\n').find((l) => l.startsWith(FREE))!;
      expect(line).toBe(`${FREE}alpha:L2 Libre`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R8 — la ligne est bornée à 3 lots par projet, avec « +K » ; le --json garde tous les lots', async () => {
    const { parent } = parentWith({
      alpha: ['A', 'B', 'C', 'D', 'E'].map((title) => ({ title })),
      beta: [{ title: 'Seul' }],
    });
    const line = (await withIdleWave(parent, () => tour(parent))).out.split('\n').find((l) => l.startsWith(FREE))!;
    expect(line).toBe(`${FREE}alpha:L1 A · alpha:L2 B · alpha:L3 C · alpha +2 · beta:L1 Seul`);
    const rows = JSON.parse((await tour(parent, '--json')).out);
    expect(rows.find((r: { project: string }) => r.project === 'alpha').free).toHaveLength(5);
  });

  it('R4 — aucun lot prêt libre : pas de ligne ; un lot « à décider » n\'est pas listé', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Banc en cours', uses: ['banc'], doing: true }, { title: 'Autre', uses: ['banc'] }, { title: 'Choix (à décider avec Sylvain)' }] });
    expect((await withIdleWave(parent, () => tour(parent))).out).not.toContain(FREE);
  });

  it('R5 — --json : chaque projet porte ses lots prêts libres (free), absent quand il n\'en a pas', async () => {
    const { parent } = parentWith({
      alpha: [{ title: 'Banc en cours', uses: ['banc'], doing: true }, { title: 'Autre banc', uses: ['banc'] }, { title: 'Libre' }],
      beta: [{ title: 'Beta banc', uses: ['banc'] }],
    });
    const rows = JSON.parse((await tour(parent, '--json')).out);
    expect(rows.find((r: { project: string }) => r.project === 'alpha').free).toEqual([{ id: 'L3', title: 'Libre' }]);
    expect(rows.find((r: { project: string }) => r.project === 'beta')).not.toHaveProperty('free');
  });

  it('R5 — --json : un lot libre qui porte uses: le dit', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'A', uses: ['banc', 'passerelle'] }] });
    const rows = JSON.parse((await tour(parent, '--json')).out);
    expect(rows[0].free).toEqual([{ id: 'L1', title: 'A', uses: ['banc', 'passerelle'] }]);
  });

  it('R6 — sans vague en cours : pas de ligne (comme « créneaux libres »), le --json donne quand même les lots libres', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Un' }] });
    expect((await tour(parent)).out).not.toContain(FREE);
    expect(JSON.parse((await tour(parent, '--json')).out)[0].free).toEqual([{ id: 'L1', title: 'Un' }]);
  });

  it('R6 — un plan sans uses: : la liste des prêts est celle de « prochain », rien de caché', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Un' }, { title: 'Deux' }, { title: 'Suite', after: ['L1'] }] });
    const line = (await withIdleWave(parent, () => tour(parent))).out.split('\n').find((l) => l.startsWith(FREE))!;
    expect(line).toBe(`${FREE}alpha:L1 Un · alpha:L2 Deux`);
  });
});

describe('L252 — orchestrate --continue : la même liste', () => {
  it('R7 — --dry-run --continue affiche la ligne, sans les lots que la simulation tire', async () => {
    const { parent } = parentWith({
      alpha: [{ title: 'Banc en cours', uses: ['banc'], doing: true }, { title: 'Autre banc', uses: ['banc'] }, { title: 'Libre', uses: ['passerelle'] }],
      beta: [{ title: 'Beta banc', uses: ['banc'] }, { title: 'Beta libre' }],
    });
    const r = io(parent);
    await orchestrate(['--continue', '--dry-run', '--budget', '1M'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    const line = r.out.find((l) => l.startsWith(FREE));
    expect(line).toBeDefined();
    expect(line).toContain('alpha:L3 Libre (passerelle)');
    expect(line).toContain('beta:L2 Beta libre');
    expect(line).not.toContain('banc)');
  });

  it('R7 — sans --continue la ligne n\'est pas écrite', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Libre' }] });
    const r = io(parent);
    await orchestrate(['alpha:L1', '--dry-run'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    expect(r.out.join('\n')).not.toContain(FREE);
  });
});
