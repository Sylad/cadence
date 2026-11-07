import { describe, expect, it } from 'vitest';
import { tourStaleBranchLines, type TourRow } from '../src/lead.js';
import type { KeptTree } from '../src/orchestrate/worktree.js';

// L676 : le tour du lead marque ⚠ toute branche de lot non intégrée depuis plus de 48 h, avec les gestes intégrer ou reprendre.
const NOW = Date.parse('2026-11-07T12:00:00Z');
const H = 3600_000;
const tree = (over: Partial<KeptTree>): KeptTree => ({ lot: 'maritime:B6', wave: '2026-11-01-0800', branch: 'cadence/2026-11-01-0800/maritime--B6', base: 'main', dir: '/x/B6', dirExists: true, created: NOW - 50 * H, unintegrated: 3, active: false, ...over });
const rows = (...worktrees: KeptTree[]): TourRow[] => [{ project: 'maritime', worktrees } as TourRow];

describe('lead tour — branche de lot non intégrée depuis plus de 48 h (L676)', () => {
  it('R2 — une branche à 3 commits non intégrés créée il y a 50 h : ⚠ avec le lot, l\'âge, les commits et les deux gestes', () => {
    const [line, ...rest] = tourStaleBranchLines(rows(tree({})), NOW);
    expect(rest).toEqual([]);
    expect(line).toMatch(/^⚠ maritime · maritime:B6 · /);
    expect(line).toContain('2 j');
    expect(line).toContain('3 commit(s) non intégré(s)');
    expect(line).toContain('cadence orchestrate --resume --wave 2026-11-01-0800 --integrate maritime:B6');
    expect(line).toContain('cadence orchestrate maritime:B6');
  });
  it('R2 — 48 h pile ou moins : pas de ⚠ (« plus de 48 h »)', () => {
    expect(tourStaleBranchLines(rows(tree({ created: NOW - 48 * H }), tree({ created: NOW - 2 * H })), NOW)).toEqual([]);
  });
  it('R2 — aucun commit non intégré : pas de ⚠, même ancienne', () => {
    expect(tourStaleBranchLines(rows(tree({ unintegrated: 0, created: NOW - 400 * H })), NOW)).toEqual([]);
  });
  it('R2 — date de création inconnue (0) : pas de ⚠ sur une mesure absente', () => {
    expect(tourStaleBranchLines(rows(tree({ created: 0 })), NOW)).toEqual([]);
  });
  it('R2 — un projet sans worktree conservé, ou une liste vide : rien', () => {
    expect(tourStaleBranchLines([{ project: 'a' } as TourRow, ...rows()], NOW)).toEqual([]);
  });
  it('R2 — une ligne par branche vieille, les récentes sont passées', () => {
    const lines = tourStaleBranchLines(rows(tree({}), tree({ lot: 'maritime:DI1', branch: 'cadence/w/maritime--DI1', wave: 'w', created: NOW - 100 * H }), tree({ lot: 'maritime:L1', created: NOW - H })), NOW);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('maritime:DI1');
  });
});
