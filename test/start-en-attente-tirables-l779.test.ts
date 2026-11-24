import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { tourRow } from '../src/lead.js';
import { lotHold, readyFree } from '../src/ready-free.js';
import { holdRepo, PENDING_PLAN, readPending } from '../src/repo-held.js';
import { executerRun } from '../v2/src/run/run.js';
import type { Executeur } from '../v2/src/bench/bras.js';
import { tempDir, testPackage } from './helpers.js';

// Revue L779 r1 : `raf start` mis en attente laisse le lot todo dans le plan pendant son propre run. Le tour, raf next et le calcul des ressources
// libres doivent pourtant le voir en cours (start en attente, ou --lot d'un cadence run vivant) : sinon le lead relance le lot ou un lot du même banc.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-24' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-24T08:00:00Z') }) as number;
  } catch (e) {
    return { code: -1, out: out.join('\n'), err: `${err.join('\n')}${(e as Error).message}` };
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dossier parent qui déclare le banc, et un projet : L1 et L2 todo partagent le banc, L3 todo sans ressource. */
function project(): string {
  const parent = tempDir();
  const dir = join(parent, 'proj');
  mkdirSync(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(dir, ...a);
  const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'proj', 'L', '2026-11-01');
  plan.add('Autre lot du banc', '2026-11-01', { estimate: 1, uses: ['banc'] });
  plan.add('Lot suivant du lead', '2026-11-01', { estimate: 1, uses: ['banc'] });
  plan.add('Lot sans ressource', '2026-11-01', { estimate: 1 });
  plan.save();
  writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  test: "true"\n');
  git(dir, 'add', '-A');
  expect(git(dir, 'commit', '-qm', 'chore: plan').status).toBe(0);
  writeFileSync(join(parent, 'cadence.yaml'), 'resources: [banc]\n');
  return dir;
}

const home = () => process.env.CADENCE_HOME!;
const freeIds = (dir: string) => (readyFree([dir], home()).get(dir) ?? []).map((l) => l.id);
const fini = (msg: string, o: { cwd: string }) => {
  writeFileSync(join(o.cwd, 'fait.txt'), 'ok');
  git(o.cwd, 'add', 'fait.txt');
  git(o.cwd, 'commit', '-qm', msg);
  return { stdout: JSON.stringify({ session_id: 's1', total_cost_usd: 0, result: 'fini', subtype: 'success' }), code: 0 };
};

describe('L779 r1 : un lot dont le start attend, ou qui sert un cadence run vivant, est vu en cours', () => {
  it('rejoue « un run tient main, raf start L2 && cadence run --lot L2 » : pendant le run de L2, L2 n est plus tirable et le banc est tenu', () => {
    const dir = project();
    expect(freeIds(dir)).toEqual(['L1', 'L2', 'L3']);
    const unhold = holdRepo(dir, 'run', 'cadence run 20261124070000-1'); // le run A tient main
    const vu: Record<string, unknown> = {};
    try {
      expect(raf(dir, 'start', 'L2').out).toMatch(/^mis en attente : raf start L2/);
      vu.avantB = freeIds(dir); // le start en attente suffit, avant même le run B
      const exec: Executeur = (_args, o) => {
        vu.pendantB = freeIds(dir);
        vu.holdL1 = lotHold(dir, { id: 'L1', uses: ['banc'] }, home());
        vu.holdL2 = lotHold(dir, { id: 'L2', uses: ['banc'] }, home());
        vu.tour = tourRow(dir, '2026-11-24');
        vu.next = raf(dir, 'now');
        return fini('feat(L2): travail du run', o);
      };
      const e = executerRun({ repo: dir, demande: 'Crée fait.txt', lot: 'L2', exec, out: () => {}, raf: join(testPackage(), 'bin/raf.js') });
      expect(e.etat).toBe('integre');
    } finally {
      unhold();
    }
    expect(vu.avantB).toEqual(['L3']);
    expect(vu.pendantB).toEqual(['L3']);
    expect(vu.holdL1).toEqual({ resource: 'banc' });
    expect(vu.holdL2).toEqual({ running: true });
    const tour = vu.tour as ReturnType<typeof tourRow>;
    expect(tour.doing.map((d) => d.id)).toEqual(['L2']);
    expect(tour.next?.id).toBe('L1');
    const next = vu.next as { code: number; out: string };
    expect(next.code).toBe(0);
    expect(next.out).toMatch(/En cours\n {2}L2 {2}Lot suivant du lead .*raf start en attente/);
    expect(next.out.split('À suivre')[1]).not.toMatch(/L2/);
  });

  it('le --lot d un cadence run vivant suffit, sans start (lot laissé todo) ; le run fini, le lot redevient tirable', () => {
    const dir = project();
    const vu: Record<string, unknown> = {};
    const exec: Executeur = (_args, o) => {
      vu.libres = freeIds(dir);
      vu.next = raf(dir, 'now').out;
      return fini('feat(L1): travail', o);
    };
    executerRun({ repo: dir, demande: 'Crée fait.txt', lot: 'L1', exec, out: () => {}, raf: join(testPackage(), 'bin/raf.js') });
    expect(vu.libres).toEqual(['L3']);
    expect(vu.next).toMatch(/En cours\n {2}L1 {2}Autre lot du banc .*cadence run \d/);
    expect(freeIds(dir)).toEqual(['L1', 'L2', 'L3']);
  });
});

describe('L779 r1 : un start en attente devenu sans objet ne bloque plus l attente', () => {
  it('lot passé doing par un autre chemin : la ligne est retirée, un message le dit, les écritures suivantes passent', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'run', 'cadence run 20261124070000-1');
    try {
      expect(raf(dir, 'start', 'L1').code).toBe(0);
      expect(raf(dir, 'note', 'L2', 'après L1').code).toBe(0);
    } finally {
      unhold();
    }
    // orchestrate ou hook.autostart démarre L1 entre-temps (écriture directe du plan, comme le commit d'un programme).
    const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
    plan.setStatus('L1', 'doing', '2026-11-24');
    plan.save();
    const ok = raf(dir, 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/raf start L1 sans objet : L1 est déjà doing/);
    expect(ok.out).toMatch(/2 écriture\(s\) appliquée\(s\)/);
    expect(readPending(dir)).toEqual([]);
    expect(existsSync(join(dir, PENDING_PLAN))).toBe(false);
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toMatch(/après L1/);
  });

  it('lot clos entre-temps : start écarté avec un message, les écritures suivantes passent', () => {
    const dir = project();
    const unhold = holdRepo(dir, 'run', 'cadence run 20261124070000-1');
    try {
      expect(raf(dir, 'start', 'L1').code).toBe(0);
      expect(raf(dir, 'note', 'L2', 'après L1').code).toBe(0);
    } finally {
      unhold();
    }
    const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
    plan.setStatus('L1', 'dropped', '2026-11-24');
    plan.save();
    const ok = raf(dir, 'attente', 'appliquer');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/raf start L1 écarté : L1 est dropped/);
    expect(readPending(dir)).toEqual([]);
  });
});
