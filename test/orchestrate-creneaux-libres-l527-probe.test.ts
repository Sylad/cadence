import { describe, expect, it } from 'vitest';
import { lotBudget, orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { RunStore } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import type { ClaudeFn } from '../src/orchestrate/launch.js';
import { claudeOut, commitFile, kindOf, precheckReport, reviewReport, workReport } from './orchestrate-harness.js';
import { tempDir } from './helpers.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { execFileSync } from 'node:child_process';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function parentWith(names: string[], opts: { lotsOf?: Record<string, number>; precheck?: boolean; extra?: string } = {}) {
  const parent = tempDir();
  for (const name of names) {
    const dir = join(parent, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (let i = 0; i < (opts.lotsOf?.[name] ?? 1); i++) plan.add(opts.precheck ? 'reprend cadence:L68' : 'lot', '2026-10-01', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), `orchestrate:\n  precheck: ${opts.precheck ?? false}\n`);
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
  }
  writeFileSync(join(parent, 'cadence.yaml'), `priority: [${names.join(', ')}]\n${opts.extra ?? ''}`);
  return parent;
}

function io(cwd: string, extraEnv: Record<string, string> = {}, now = '2026-10-04T14:12:00') {
  const out: string[] = [];
  const i: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-10-04', ...extraEnv }, out: (l) => out.push(l), err: () => {}, now: () => new Date(now) };
  return { io: i, out };
}

const wait = async (until: () => boolean) => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(until()).toBe(true);
};

function scene(parent: string, holder: string | null, hold: (store: RunStore) => Promise<void>, precheckYes: string[] = [], quick = 30) {
  const played: string[] = [];
  const claude: ClaudeFn = async (args, o) => {
    const kind = kindOf(args);
    const project = o.cwd.split('/').pop()!.replace(/^.*--/, '');
    if (kind === 'precheck') {
      const lot = /Pre-check for lot `?([A-Za-z0-9]+)/.exec(args.join(' '));
      void lot;
      return claudeOut(precheckYes.some((p) => o.cwd.includes(p)) ? precheckReport({ dejaPresent: 'oui', preuves: ['x.ts:1'], resume: 'déjà là' }) : precheckReport());
    }
    if (kind !== 'implement' && kind !== 'fix') return claudeOut(reviewReport());
    const lot = /on lot `([^`]+)`/.exec(args[1])![1];
    const key = `${o.cwd.split('/').pop()}:${lot}`;
    played.push(key);
    if (holder && key.includes(holder)) await hold(RunStore.last(parent)!);
    else await new Promise((r) => setTimeout(r, quick));
    void project;
    return claudeOut(workReport({ commits: [commitFile(o.cwd, `f-${Math.random()}.txt`, `feat(${lot}): travail`)] }));
  };
  const d: OrchestrateDeps = { claude, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, slotPollMs: 20 };
  return { d, played };
}

const journal = (parent: string) => readFileSync(join(RunStore.last(parent)!.dir, 'journal.log'), 'utf8');
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('L527 probe — bords du remplissage des créneaux libres', () => {
  it('lot rendu dès le précheck : le créneau libre est rempli sans attendre le lot qui tient la vague', async () => {
    const parent = parentWith(['a', 'b', 'c'], { precheck: true });
    let cDuringHold = 'absent';
    const s = scene(parent, 'a', async (store) => {
      await wait(() => store.readLot('c', 'L1')?.status === 'ready');
      cDuringHold = store.readLot('a', 'L1')!.status;
    }, ['/b']);
    await orchestrate(['--continue', '--max-sessions', '2'], io(parent).io, s.d);
    expect(cDuringHold).not.toBe('ready');
    expect(RunStore.last(parent)!.readLot('b', 'L1')!.status).toBe('handed-back');
    expect(s.played.some((p) => p.endsWith(':L1') && p.includes('c'))).toBe(true);
    expect(count(journal(parent), /continue : tire c:L1/g)).toBe(1);
  });

  it('--max-sessions 1 : chaque lot est joué une seule fois, jamais deux sessions à la fois', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    const s = scene(parent, null, async () => {});
    expect(await orchestrate(['--continue', '--max-sessions', '1'], io(parent).io, s.d)).toBe(0);
    expect(s.played.map((p) => p.split(':')[1]).length).toBe(3);
    expect(new Set(s.played).size).toBe(3);
    expect(RunStore.last(parent)!.readWave()!.lots).toHaveLength(3);
  });

  it('un seul dépôt, trois lots : chacun joué une fois, dans l’ordre, aucun doublon dans la vague', async () => {
    const parent = parentWith(['a'], { lotsOf: { a: 3 } });
    const s = scene(parent, null, async () => {});
    expect(await orchestrate(['--continue', '--max-sessions', '4'], io(parent).io, s.d)).toBe(0);
    expect(s.played.map((p) => p.split(':')[1])).toEqual(['L1', 'L2', 'L3']);
    const lots = RunStore.last(parent)!.readWave()!.lots;
    expect(new Set(lots).size).toBe(lots.length);
  });

  it('budget juste suffisant pour deux lots : le troisième n’est pas tiré dans le créneau libre', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    let cStatus = 'x';
    const s = scene(parent, 'a', async (store) => {
      await wait(() => store.readLot('b', 'L1')?.status === 'ready');
      await new Promise((r) => setTimeout(r, 150));
      cStatus = store.readLot('c', 'L1')?.status ?? 'absent';
    });
    await orchestrate(['--continue', '--max-sessions', '2', '--budget', String(2 * lotBudget(1))], io(parent).io, s.d);
    expect(cStatus).toBe('absent');
  });

  it('un dépôt sali pendant la vague : refus dit une seule fois au journal, un autre dépôt passe', async () => {
    const parent = parentWith(['a', 'b', 'c', 'd']);
    const s = scene(parent, 'a', async (store) => {
      writeFileSync(join(parent, 'c', 'README.md'), 'sale');
      git(join(parent, 'c'), 'add', 'README.md');
      await wait(() => store.readLot('d', 'L1')?.status === 'ready');
      await new Promise((r) => setTimeout(r, 300));
    }, [], 200);
    await orchestrate(['--continue', '--max-sessions', '2'], io(parent).io, s.d);
    const lines = journal(parent).split('\n').filter((l) => l.includes('lot sauté'));
    expect(new Set(lines).size).toBe(lines.length);
    expect(s.played.some((p) => p.startsWith('c'))).toBe(false);
    expect(s.played.some((p) => p.startsWith('d'))).toBe(true);
  });

  it('--priority explicite : l’ordre du tirage suit la ligne de commande, pas le cadence.yaml parent', async () => {
    const parent = parentWith(['a', 'b', 'c']);
    const s = scene(parent, null, async () => {});
    await orchestrate(['--continue', '--max-sessions', '2', '--priority', 'c,b,a'], io(parent).io, s.d);
    // l'ordre du tirage est celui de la vague (wave.json) ; ni l'ordre d'appel de claude ni celui des lignes « → implementing » du journal ne le sont : c et b partent ensemble, leur préparation parallèle s'y double sous charge
    const tires = RunStore.last(parent)!.readWave()!.lots.map((k) => k.split(':')[0]);
    expect(tires).toEqual(['c', 'b', 'a']);
  });
});
