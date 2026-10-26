import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { staleNoteLines, staleNotes } from '../src/stale-notes.js';
import { tourRow, tourLine } from '../src/lead.js';
import type { Lot } from '../src/plan.js';
import { stateDir, writeNext } from '../src/state.js';
import { SKILLS_DIR } from '../src/skills.js';
import { commit, gitRepo } from './helpers.js';

const lot = (id: string, status: Lot['status'], finished?: string): Lot => ({ id, title: id, status, estimate: 1, quickwin: false, visible: false, after: [], notes: [], tasks: [], finished } as unknown as Lot);

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** L1 faite le 24-10, L2 abandonnée le 25-10, L3 à faire. */
async function project() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  for (const t of ['Un', 'Deux', 'Trois']) await cad(dir, 'add', t);
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-10-20T09:00:00');
  const plan = join(dir, '.cadence/raf.yaml');
  const text = readFileSync(plan, 'utf8')
    .replace(/(- id: L1\n(?:.*\n)*?)(    status: )todo/, '$1$2done\n    finished: 2026-10-24')
    .replace(/(- id: L2\n(?:.*\n)*?)(    status: )todo/, '$1$2dropped\n    finished: 2026-10-25');
  writeFileSync(plan, text);
  git(dir, 'commit', '-qam', 'chore: plan');
  return dir;
}

describe('notes de clôture périmées (L347)', () => {
  it('R1 — une note qui cite un lot done est signalée « note périmée : L217 done le 24-10 »', () => {
    const r = staleNotes(['L217 à faire'], [lot('L217', 'done', '2026-10-24')]);
    expect(r).toEqual([{ line: 'L217 à faire', stale: ['L217 done le 24-10'] }]);
  });

  it('R2 — un lot dropped est périmé aussi, et plusieurs lots se listent dans l’ordre de la note', () => {
    const r = staleNotes(['livrer L9 puis L4'], [lot('L4', 'dropped', '2026-10-25'), lot('L9', 'done', '2026-10-24')]);
    expect(r[0].stale).toEqual(['L9 done le 24-10', 'L4 dropped le 25-10']);
  });

  it('R3 — un lot todo ou doing n’est pas signalé, ni un identifiant plus long qui le contient', () => {
    const lots = [lot('L21', 'todo'), lot('L22', 'doing'), lot('L2', 'done', '2026-10-24')];
    expect(staleNotes(['L21 et L22 à finir', 'voir L217 et XL2'], lots).map((n) => n.stale)).toEqual([[], []]);
    expect(staleNotes(['reprendre L2.'], lots)[0].stale).toEqual(['L2 done le 24-10']);
  });

  it('R4 — un lot fini sans date se dit sans date, un identifiant à point (B28.8) se lit entier', () => {
    const lots = [lot('B28.8', 'done'), lot('B28', 'done', '2026-10-01')];
    expect(staleNotes(['B28.8 à livrer'], lots)[0].stale).toEqual(['B28.8 done']);
  });

  it('R5 — session start met le signalement à côté de la note, les notes saines sont relayées telles quelles', async () => {
    const dir = await project();
    writeNext(stateDir(dir), '2026-10-24', ['L1 à faire', 'finir L3']);
    const { out } = await cad(dir, 'session', 'start');
    expect(out).toContain('  - L1 à faire ⚠ note périmée : L1 done le 24-10\n  - finir L3\n');
  });

  it('R6 — lead tour signale la note périmée à côté des notes, le JSON porte les lots périmés', async () => {
    const dir = await project();
    writeNext(stateDir(dir), '2026-10-24', ['L1 à faire / L2 à reprendre']);
    const row = tourRow(dir, '2026-10-26');
    expect(row.staleNotes).toEqual(['L1 done le 24-10', 'L2 dropped le 25-10']);
    expect(tourLine(row)).toContain('notes : L1 à faire / L2 à reprendre ⚠ note périmée : L1 done le 24-10, L2 dropped le 25-10 ·');
    writeNext(stateDir(dir), '2026-10-24', ['finir L3']);
    expect(tourRow(dir, '2026-10-26').staleNotes).toBeUndefined();
  });

  it('R7 — session close liste les notes périmées à réécrire, sans changer le verdict', async () => {
    const dir = await project();
    writeNext(stateDir(dir), '2026-10-24', ['L1 à faire']);
    const stale = await cad(dir, 'session', 'close');
    expect(stale.out).toContain('Notes de la dernière clôture à réécrire');
    expect(stale.out).toContain('L1 à faire ⚠ note périmée : L1 done le 24-10');
    writeNext(stateDir(dir), '2026-10-24', ['finir L3']);
    const healthy = await cad(dir, 'session', 'close');
    expect(healthy.out).not.toContain('à réécrire');
    expect(stale.code).toBe(healthy.code);
  });

  it('R8 — staleNoteLines annote chaque ligne périmée et laisse les autres', () => {
    expect(staleNoteLines(['L1 à faire', 'rien'], [lot('L1', 'done', '2026-10-24')])).toEqual(['L1 à faire ⚠ note périmée : L1 done le 24-10', 'rien']);
  });

  it('R9 — la doc et les skills disent le signalement et la réécriture', () => {
    for (const page of ['session.md', 'lead.md']) expect(readFileSync(join(import.meta.dirname, '..', 'docs', page), 'utf8')).toContain('note périmée');
    const close = readFileSync(join(SKILLS_DIR, 'session-close', 'SKILL.md'), 'utf8');
    expect(close).toContain('note périmée');
    expect(close).toContain('à réécrire');
    expect(readFileSync(join(SKILLS_DIR, 'session-start', 'SKILL.md'), 'utf8')).toContain('note périmée');
    expect(readFileSync(join(SKILLS_DIR, 'lead', 'SKILL.md'), 'utf8')).toContain('note périmée');
  });
});
