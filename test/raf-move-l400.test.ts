import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { newLot, RunStore, type WaveState } from '../src/orchestrate/state.js';
import { sharedStateDir } from '../src/state.js';
import { repoWithPlan } from './archive-helpers.js';
import { gitRepo, tempDir } from './helpers.js';

// L400 — raf move <id> --before|--after <id> : réordonner un lot (ou une sous-tâche) dans le plan.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-28T10:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const planFile = (dir: string) => join(dir, '.cadence/raf.yaml');
const text = (dir: string) => readFileSync(planFile(dir), 'utf8');
const ids = (dir: string) => (parse(text(dir)) as { lots: { id: string }[] }).lots.map((l) => l.id);
const taskIds = (dir: string, lot: string) => (parse(text(dir)) as { lots: { id: string; tasks?: { id: string }[] }[] }).lots.find((l) => l.id === lot)!.tasks!.map((t) => t.id);

/** Un plan de quatre lots, L1 portant trois sous-tâches et un commentaire. */
function projet() {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  for (const t of ['un', 'deux', 'trois', 'quatre']) raf(dir, 'add', t);
  for (const t of ['a', 'b', 'c']) raf(dir, 'add', t, '--parent', 'L1');
  return dir;
}

describe('raf move (L400)', () => {
  it('R1 — --after place le lot juste après la cible, les autres gardent leur ordre', () => {
    const dir = projet();
    const r = raf(dir, 'move', 'L1', '--after', 'L3');
    expect(r.code).toBe(0);
    expect(ids(dir)).toEqual(['L2', 'L3', 'L1', 'L4']);
  });

  it('R1 — --before place le lot juste avant la cible', () => {
    const dir = projet();
    expect(raf(dir, 'move', 'L4', '--before', 'L2').code).toBe(0);
    expect(ids(dir)).toEqual(['L1', 'L4', 'L2', 'L3']);
  });

  it('R2 — le lot déplacé garde toutes ses clés, ses sous-tâches et son commentaire ; rien d\'autre ne change', () => {
    const dir = projet();
    raf(dir, 'start', 'L2');
    writeFileSync(planFile(dir), text(dir).replace('  - id: L3\n', '  # lot sensible\n  - id: L3\n'));
    const avant = parse(text(dir)) as { lots: { id: string }[] };
    expect(raf(dir, 'move', 'L3', '--before', 'L1').code).toBe(0);
    const apres = parse(text(dir)) as { lots: { id: string }[] };
    expect(apres.lots.map((l) => l.id)).toEqual(['L3', 'L1', 'L2', 'L4']);
    const parId = (p: { lots: { id: string }[] }) => Object.fromEntries(p.lots.map((l) => [l.id, l]));
    expect(parId(apres)).toEqual(parId(avant));
    expect(text(dir)).toContain('  # lot sensible\n  - id: L3');
  });

  it('R3 — un lot déjà à sa place : code 0, fichier inchangé octet pour octet', () => {
    const dir = projet();
    const avant = text(dir);
    expect(raf(dir, 'move', 'L2', '--after', 'L1').code).toBe(0);
    expect(raf(dir, 'move', 'L2', '--before', 'L3').code).toBe(0);
    expect(text(dir)).toBe(avant);
  });

  it('R4 — une sous-tâche se déplace parmi celles du même lot', () => {
    const dir = projet();
    expect(raf(dir, 'move', 'L1/t1', '--after', 'L1/t3').code).toBe(0);
    expect(taskIds(dir, 'L1')).toEqual(['t2', 't3', 't1']);
  });

  it('R4 — pas le même parent : refusé, plan inchangé (lot et sous-tâche, sous-tâches de deux lots)', () => {
    const dir = projet();
    raf(dir, 'add', 'x', '--parent', 'L2');
    const avant = text(dir);
    for (const argv of [['L2', '--after', 'L1/t1'], ['L1/t1', '--before', 'L3'], ['L1/t1', '--before', 'L2/t1']]) {
      const r = raf(dir, 'move', ...argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain('même parent');
    }
    expect(text(dir)).toBe(avant);
  });

  it('R5 — usage, ni l\'un ni l\'autre, les deux, lui-même, id inconnu : refusés, plan inchangé', () => {
    const dir = projet();
    const avant = text(dir);
    const cas: [string[], string][] = [
      [['L1'], 'usage : raf move'],
      [['L1', 'L2'], 'usage : raf move'],
      [['L1', '--before', 'L2', '--after', 'L3'], 'usage : raf move'],
      [['L1', '--before', 'L1'], 'lui-même'],
      [['L1', '--before', 'L99'], 'lot inconnu : L99'],
      [['L99', '--after', 'L1'], 'lot inconnu : L99'],
      [['L1/t9', '--after', 'L1/t1'], 'sous-tâche inconnue'],
    ];
    for (const [argv, msg] of cas) {
      const r = raf(dir, 'move', ...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toContain(msg);
    }
    expect(text(dir)).toBe(avant);
  });

  it('R6 — un lot archivé n\'est pas déplaçable : l\'ordre du fichier du plan ne bouge pas, refus nommé', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const avant = readFileSync(r.plan, 'utf8');
    const res = await r.raf('move', 'L5', '--before', 'L1');
    expect(res.code).toBe(2);
    expect(res.err).toContain('L1 est archivé');
    expect(readFileSync(r.plan, 'utf8')).toBe(avant);
    expect((await r.raf('move', 'L5', '--before', 'L4')).code).toBe(0);
    expect(readFileSync(r.plan, 'utf8')).not.toBe(avant);
  });

  it('R7 — plan en lecture seule : refusé avec l\'outil du projet, aucun fichier touché', () => {
    const dir = projet();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  lots: lots\n');
    const avant = text(dir);
    const r = raf(dir, 'move', 'L1', '--after', 'L3');
    expect(r.code).toBe(2);
    expect(r.err).toContain('plan en lecture seule');
    expect(r.err).toContain("l'outil du projet");
    expect(text(dir)).toBe(avant);
  });

  describe('R8 — pendant une vague du dépôt', () => {
    const WAVE = '2026-10-28-1000';
    function vague(repo: string) {
      const store = RunStore.reserve(repo, WAVE)!;
      store.writeWave({ id: store.id, status: 'running', created: 'x', lots: ['ici:L1'] } as WaveState);
      store.writeLot({ ...newLot({ project: 'ici', repo, lot: 'L1', title: 't', visible: false, small: false, model: 'sonnet' as never, readOnlyPlan: false }), status: 'question' });
      writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: WAVE, started: 'x' }));
      registerWave(cadenceHome(), { pid: process.pid, wave: WAVE, started: '2026-10-28T10:00:00Z', cwd: repo, repos: [repo] });
    }

    it('une vague vivante qui tient le dépôt : refus qui la nomme, plan inchangé ; le verrou tombé, le déplacement passe', () => {
      const dir = projet();
      vague(dir);
      const avant = text(dir);
      try {
        const r = raf(dir, 'move', 'L1', '--after', 'L3');
        expect(r.code).toBe(2);
        expect(r.err).toContain(`move : orchestration en cours (vague ${WAVE}, pid ${process.pid})`);
        expect(r.err).toContain('attendre');
        expect(text(dir)).toBe(avant);
      } finally {
        unregisterWave(cadenceHome(), process.pid);
        rmSync(join(sharedStateDir(dir), REPO_LOCK), { force: true });
      }
      expect(raf(dir, 'move', 'L1', '--after', 'L3').code).toBe(0);
    });
  });

  it('R9 — la commande est dans l\'aide, docs/raf.md et le CHANGELOG', () => {
    expect(raf(gitRepo(), '--help').out).toContain('raf move <id>');
    const raf_md = readFileSync(join(import.meta.dirname, '..', 'docs/raf.md'), 'utf8');
    expect(raf_md).toContain('`raf move <id> --before\\|--after <id>`');
    expect(raf_md).toMatch(/raf move[^\n]*read-only plan|read-only plan[^\n]*raf move/);
    expect(readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8')).toMatch(/## \[Unreleased\][\s\S]*?raf move[\s\S]*?\(L400\)/);
  });
});
