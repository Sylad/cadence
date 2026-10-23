import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  it('R7 — --dry-run --continue affiche la ligne, sans le lot que la simulation tire (même sans uses:) ni les lots qui prennent banc', async () => {
    const { parent } = parentWith({
      alpha: [{ title: 'Banc en cours', uses: ['banc'], doing: true }, { title: 'Tiré' }, { title: 'Autre banc', uses: ['banc'] }, { title: 'Libre', uses: ['passerelle'] }],
      beta: [{ title: 'Beta banc', uses: ['banc'] }, { title: 'Beta libre' }],
    });
    const r = io(parent);
    await orchestrate(['--continue', '--dry-run', '--budget', '1M', '--max-sessions', '1'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    expect(r.out).toContain('alpha:L2 — Tiré'); // le lot que la simulation tire
    expect(r.out.find((l) => l.startsWith(FREE))).toBe(`${FREE}alpha:L4 Libre (passerelle) · beta:L2 Beta libre`);
  });

  it('R7 — sans --continue la ligne n\'est pas écrite', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Libre' }] });
    const r = io(parent);
    await orchestrate(['alpha:L1', '--dry-run'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    expect(r.out.join('\n')).not.toContain(FREE);
  });

  it('R7 — lancé depuis un projet, un lot doing d\'un projet voisin qui tient banc écarte les prêts qui l\'utilisent', async () => {
    const { dirs } = parentWith({ alpha: [{ title: 'Alpha banc', uses: ['banc'] }], beta: [{ title: 'Beta banc en cours', uses: ['banc'], doing: true }] });
    const r = io(dirs.alpha!);
    await orchestrate(['--continue', '--dry-run', '--budget', '1M'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    expect(r.out.some((l) => l.startsWith(FREE))).toBe(false);
  });

  it('R7 — la vague qui part tire alpha:L1 : la ligne n\'annonce ni ce lot ni son concurrent sur banc', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Alpha banc', uses: ['banc'] }], beta: [{ title: 'Beta banc', uses: ['banc'] }, { title: 'Beta libre' }] });
    const r = io(parent);
    await orchestrate(['--continue', '--dry-run', '--budget', '1M', '--max-sessions', '1'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    expect(r.out.find((l) => l.startsWith(FREE))).toBe(`${FREE}beta:L2 Beta libre`);
  });
});

describe('L252 — un lot de vague se reconnaît à son dépôt, pas au nom du projet', () => {
  /** Une vague vivante dont le lot `lot` est dans `repo`, enregistré sous le nom de projet `project`, lancée depuis `cwd`. */
  const waveHolding = (cwd: string, project: string, repo: string, lot = 'L1') => {
    const store = RunStore.reserve(cwd, '2026-10-23-0900')!;
    store.writeWave({ id: store.id, created: '2026-10-23T09:00:00Z', cwd, budget: 1, consumed: 0, cacheRead: 0, status: 'running', pid: process.ppid, lots: [`${project}:${lot}`] });
    store.writeLot({ project, repo, lot, title: 'Dans la vague', visible: false, small: true, status: 'running' } as never);
    registerWave(cadenceHome(), { pid: process.ppid, wave: store.id, started: '2026-10-23T09:00:00Z', cwd, repos: [repo], cap: 2 });
  };

  it('R3 — projet imbriqué (depth: 2) : le lot d\'une vague --continue lancée depuis son dossier, enregistré sous le nom court, n\'est pas listé', async () => {
    const { parent, dirs } = parentWith({ 'grp/alpha': [{ title: 'Dans la vague' }, { title: 'Libre' }] }, 'resources: [banc]\ndepth: 2\n');
    waveHolding(join(parent, 'grp'), 'alpha', dirs['grp/alpha']!);
    try {
      const rows = JSON.parse((await tour(parent, '--json')).out) as { project: string; free?: { id: string }[] }[];
      expect(rows.map((r) => r.project)).toEqual(['grp/alpha']);
      expect(rows[0]!.free?.map((l) => l.id)).toEqual(['L2']);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R3 — la vague d\'un autre dossier, qui joue un projet de même nom dans un autre dépôt, ne retire pas le lot de même id', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Premier' }, { title: 'Second' }] });
    const other = parentWith({ alpha: [{ title: 'Autre dépôt' }] });
    waveHolding(other.parent, 'alpha', other.dirs.alpha!);
    try {
      const line = (await tour(parent)).out.split('\n').find((l) => l.startsWith(FREE))!;
      expect(line).toBe(`${FREE}alpha:L1 Premier · alpha:L2 Second`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R3 — la vague d\'un autre dossier qui joue ce dépôt retire son lot, quel que soit le nom sous lequel elle le cite', async () => {
    const { parent, dirs } = parentWith({ alpha: [{ title: 'Dans la vague' }, { title: 'Libre' }] });
    waveHolding(tempDir(), 'sous-un-autre-nom', dirs.alpha!);
    try {
      const line = (await tour(parent)).out.split('\n').find((l) => l.startsWith(FREE))!;
      expect(line).toBe(`${FREE}alpha:L2 Libre`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });

  it('R7 — --continue : la vague d\'un autre dossier qui joue un projet de même nom ailleurs ne retire pas le lot de même id', async () => {
    const { parent } = parentWith({ alpha: [{ title: 'Tiré' }, { title: 'Libre' }] });
    const other = parentWith({ alpha: [{ title: 'Autre dépôt' }] });
    waveHolding(other.parent, 'alpha', other.dirs.alpha!, 'L2');
    try {
      const r = io(parent);
      await orchestrate(['--continue', '--dry-run', '--budget', '1M', '--max-sessions', '1'], r.io, fakeDeps().deps);
      removeDryRunBriefs(r.out.join('\n'));
      expect(r.out.find((l) => l.startsWith(FREE))).toBe(`${FREE}alpha:L2 Libre`);
    } finally {
      unregisterWave(cadenceHome(), process.ppid);
    }
  });
});

describe('L252 — lead tour lancé depuis un projet', () => {
  it('R1 — un lot doing d\'un projet voisin qui tient banc écarte les prêts qui l\'utilisent', async () => {
    const { dirs } = parentWith({ alpha: [{ title: 'Alpha banc', uses: ['banc'] }, { title: 'Alpha libre' }], beta: [{ title: 'Beta banc en cours', uses: ['banc'], doing: true }] });
    const t = await tour(dirs.alpha!, '--json');
    const rows = JSON.parse(t.out) as { project: string; free?: { id: string }[] }[];
    expect(rows[0]!.free?.map((l) => l.id)).toEqual(['L2']);
  });
});

describe('L252 — une ressource se partage à tous les niveaux du dossier qui la déclare (dossier/groupe/projet)', () => {
  const HOLDER: L[] = [{ title: 'Banc en cours', uses: ['banc'], doing: true }];
  const OTHER: L[] = [{ title: 'Tiré' }, { title: 'X banc', uses: ['banc'] }, { title: 'Libre' }];

  /** `holder` tient banc (lot doing), `other` est l'autre projet ; l'un est `x` (P/x), l'autre `grp/alpha` (P/grp/alpha) ; `yaml` : cadence.yaml de P. */
  function layout(holder: 'x' | 'grp/alpha', yaml = 'resources: [banc]\ndepth: 2\n') {
    const other = holder === 'x' ? 'grp/alpha' : 'x';
    const { parent, dirs } = parentWith({ [holder]: HOLDER, [other]: OTHER }, yaml);
    return { otherName: basename(other), at: { P: parent, 'P/grp': join(parent, 'grp'), 'P/grp/alpha': dirs['grp/alpha']!, 'P/x': dirs.x! } };
  }

  // tout point de lancement voit le même lot doing, tenu à l'autre niveau : la ressource est prise, seuls « Tiré » et « Libre » sont libres
  const FROM = [
    ['P', 'grp/alpha', ['--depth', '1']],
    ['P', 'grp/alpha', []],
    ['P/grp', 'x', []],
    ['P/grp/alpha', 'x', []],
    ['P/x', 'grp/alpha', []],
  ] as const;

  it.each(FROM)('lead tour depuis %s (lot doing de %s) : banc est pris, X banc n\'est pas libre', async (from, holder, flags) => {
    const l = layout(holder);
    const rows = JSON.parse((await tour(l.at[from], '--json', ...flags)).out) as { project: string; free?: { id: string }[] }[];
    expect(rows.find((r) => basename(r.project) === l.otherName)!.free?.map((f) => f.id)).toEqual(['L1', 'L3']);
  });

  it.each([FROM[1], FROM[2], FROM[3], FROM[4]])('orchestrate --continue --dry-run depuis %s (lot doing de %s) : banc est pris, la ligne ne liste pas X banc', async (from, holder) => {
    const l = layout(holder);
    const r = io(l.at[from]);
    await orchestrate(['--continue', '--dry-run', '--budget', '1M', '--max-sessions', '1'], r.io, fakeDeps().deps);
    removeDryRunBriefs(r.out.join('\n'));
    expect(r.out.find((line) => line.startsWith(FREE))).toBe(`${FREE}${l.otherName}:L3 Libre`);
  });

  it('sans depth: dans le cadence.yaml déclarant, un projet d\'un niveau plus bas n\'est pas vu : la ressource que son lot doing tient reste libre ici', async () => {
    const l = layout('grp/alpha', 'resources: [banc]\n');
    const rows = JSON.parse((await tour(l.at['P/x'], '--json')).out) as { free?: { id: string }[] }[];
    expect(rows[0]!.free?.map((f) => f.id)).toEqual(['L1', 'L2', 'L3']);
  });

  it('sans depth: dans le cadence.yaml déclarant, les projets voisins du même dossier se partagent la ressource', async () => {
    const { parent } = parentWith({ alpha: HOLDER, beta: OTHER }, 'resources: [banc]\n');
    const rows = JSON.parse((await tour(join(parent, 'beta'), '--json')).out) as { free?: { id: string }[] }[];
    expect(rows[0]!.free?.map((f) => f.id)).toEqual(['L1', 'L3']);
  });

  it('une depth: invalide dans le cadence.yaml déclarant ne casse pas le calcul : les voisins du même dossier se partagent la ressource', async () => {
    const { parent } = parentWith({ alpha: HOLDER, beta: OTHER }, 'resources: [banc]\ndepth: 0\n');
    const rows = JSON.parse((await tour(join(parent, 'beta'), '--json')).out) as { free?: { id: string }[] }[];
    expect(rows[0]!.free?.map((f) => f.id)).toEqual(['L1', 'L3']);
  });

  it('sans cadence.yaml qui déclare resources:, les projets voisins du même dossier (un niveau) se partagent encore la ressource, pas ceux d\'un niveau plus bas', async () => {
    const sibling = parentWith({ alpha: HOLDER, beta: OTHER }, 'depth: 2\n');
    const rows = JSON.parse((await tour(join(sibling.parent, 'beta'), '--json')).out) as { free?: { id: string }[] }[];
    expect(rows[0]!.free?.map((f) => f.id)).toEqual(['L1', 'L3']);
    const nested = layout('grp/alpha', 'depth: 2\n');
    const rowsNested = JSON.parse((await tour(nested.at['P/x'], '--json')).out) as { free?: { id: string }[] }[];
    expect(rowsNested[0]!.free?.map((f) => f.id)).toEqual(['L1', 'L2', 'L3']);
  });
});
