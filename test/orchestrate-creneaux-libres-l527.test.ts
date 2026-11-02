import { describe, expect, it } from 'vitest';
import { lotBudget, orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

/** Des projets sous un même dossier parent ; `lotsOf` : leur nombre de lots ; `uses` : les ressources du lot L1 de chaque projet ; `extra` : le cadence.yaml du parent. */
function parentWith(names: string[], lotsOf: Record<string, number> = {}, uses: Record<string, string[]> = {}, extra = '', estimates: Record<string, number> = {}) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (let i = 0; i < (lotsOf[name] ?? 1); i++) plan.add('lot', '2026-10-01', { estimate: estimates[name] ?? 1, ...(i === 0 && uses[name] ? { uses: uses[name] } : {}) });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
  }
  writeFileSync(join(parent, 'cadence.yaml'), `priority: [${names.join(', ')}]\n${extra}`);
  return parent;
}

function io(cwd: string, now = '2026-10-04T14:12:00') {
  const out: string[] = [];
  const err: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(now) };
  return { io: i, out, err };
}

const wait = async (until: () => boolean) => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(until()).toBe(true);
};

/** Le lot `holder` tient la vague jusqu'à ce que `hold` rende la main ; les autres finissent vite. `maxAll` : le plus de sessions d'écriture à la fois ; `maxIn` : par projet. */
function scene(parent: string, holder: string, hold: (store: RunStore) => Promise<void>) {
  const played: string[] = [];
  const inRepo = new Map<string, number>();
  const maxIn = new Map<string, number>();
  let now = 0;
  let maxAll = 0;
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const project = o.cwd.split('/').pop()!;
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    played.push(`${project}:${lot}`);
    inRepo.set(project, (inRepo.get(project) ?? 0) + 1);
    maxIn.set(project, Math.max(maxIn.get(project) ?? 0, inRepo.get(project)!));
    maxAll = Math.max(maxAll, ++now);
    try {
      if (`${project}:${lot}` === holder) await hold(RunStore.last(parent)!);
      else await new Promise((r) => setTimeout(r, 30));
    } finally {
      inRepo.set(project, inRepo.get(project)! - 1);
      now--;
    }
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, played, maxIn, maxAll: () => maxAll };
}

const journal = (parent: string) => readFileSync(join(RunStore.last(parent)!.dir, 'journal.log'), 'utf8');

describe('L527 — --continue remplit seul les créneaux libres', () => {
  it("R1 — un créneau libéré par un lot fini est rempli par le lot prêt suivant sans attendre la fin de l'autre lot ; le plafond tient ; le démarrage est dit au journal", async () => {
    const parent = parentWith(['a', 'b', 'c']);
    let cWhileAHolds = '';
    const s = scene(parent, 'a:L1', async (store) => {
      await wait(() => store.readLot('c', 'L1')?.status === 'ready');
      cWhileAHolds = store.readLot('a', 'L1')!.status;
    });
    expect(await orchestrate(['--continue', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(cWhileAHolds).not.toBe('ready');
    expect(s.maxAll()).toBeLessThanOrEqual(2);
    expect(s.played.sort()).toEqual(['a:L1', 'b:L1', 'c:L1']);
    expect(journal(parent)).toMatch(/continue : tire c:L1 \(créneau libre\)/);
    expect(journal(parent)).toMatch(/c:L1 : ajouté à la vague/);
    expect(RunStore.last(parent)!.readWave()!.lots).toEqual(['a:L1', 'b:L1', 'c:L1']);
  });

  it('R2 — sans --continue, un lot donné à la main ne tire rien : le créneau libre reste vide', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    let cStatus = '';
    const s = scene(parent, 'a:L1', async (store) => {
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
      await new Promise((r) => setTimeout(r, 150));
      cStatus = store.readLot('c', 'L1')?.status ?? 'absent';
    });
    expect(await orchestrate(['a:L1', 'b:L1', '--max-sessions', '2'], io(parent).io, s.d)).toBe(0);
    expect(cStatus).toBe('absent');
    expect(s.played.sort()).toEqual(['a:L1', 'b:L1']);
  });

  it("R3 — un dépôt n'a jamais deux sessions : le créneau libre va au lot d'un autre dépôt, pas au lot suivant du dépôt qui joue", async () => {
    const parent = parentWith(['a', 'b'], { a: 2 });
    let b = '';
    const s = scene(parent, 'a:L1', async (store) => {
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
      b = 'ok';
      expect(store.readLot('a', 'L2')?.status ?? 'absent').toBe('absent');
    });
    expect(await orchestrate(['--continue', '--max-sessions', '3'], io(parent).io, s.d)).toBe(0);
    expect(b).toBe('ok');
    expect(s.maxIn.get('a')).toBe(1);
    expect(s.played.filter((p) => p.startsWith('a:'))).toEqual(['a:L1', 'a:L2']);
  });

  it("R4 — une ressource partagée tenue par un lot qui joue écarte le lot qui la veut : il n'est pas tiré dans le créneau libre, mais l'est au tour suivant", async () => {
    const parent = parentWith(['a', 'b', 'c'], {}, { a: ['banc'], c: ['banc'] }, 'resources: [banc]\n');
    let cDuringHold = 'absent';
    const s = scene(parent, 'a:L1', async (store) => {
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
      await new Promise((r) => setTimeout(r, 200));
      cDuringHold = store.readLot('c', 'L1')?.status ?? 'absent';
    });
    expect(await orchestrate(['--continue', '--max-sessions', '3'], io(parent).io, s.d)).toBe(0);
    expect(cDuringHold).toBe('absent');
    expect(s.played.sort()).toEqual(['a:L1', 'b:L1', 'c:L1']);
  });

  it("R5 — un arrêt demandé (--stop-after-current) : le créneau libre n'est pas rempli", async () => {
    const parent = parentWith(['a', 'b', 'c']);
    let cStatus = '';
    const s = scene(parent, 'a:L1', async (store) => {
      store.requestStopAfterCurrent();
      await wait(() => ['ready', 'suspended', 'handed-back'].includes(store.readLot('b', 'L1')?.status ?? ''));
      await new Promise((r) => setTimeout(r, 200));
      cStatus = store.readLot('c', 'L1')?.status ?? 'absent';
    });
    await orchestrate(['--continue', '--max-sessions', '2'], io(parent).io, s.d);
    expect(cStatus).toBe('absent');
    expect(s.played).not.toContain('c:L1');
  });

  it("R6 — le budget que les lots qui jouent n'ont pas encore dépensé reste réservé : un lot trop gros pour le reste n'est pas tiré dans le créneau libre", async () => {
    const parent = parentWith(['a', 'b', 'c'], {}, {}, '', { c: 2 });
    expect(lotBudget(2)).toBeGreaterThan(lotBudget(1) + 1);
    expect(lotBudget(2)).toBeLessThan(2 * lotBudget(1) + 1); // tient dans le budget de la vague, pas dans ce que les lots qui jouent laissent
    let cStatus = '';
    const s = scene(parent, 'a:L1', async (store) => {
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
      await new Promise((r) => setTimeout(r, 200));
      cStatus = store.readLot('c', 'L1')?.status ?? 'absent';
    });
    await orchestrate(['--continue', '--max-sessions', '2', '--budget', String(2 * lotBudget(1) + 1)], io(parent).io, s.d);
    expect(cStatus).toBe('absent');
  });
});
