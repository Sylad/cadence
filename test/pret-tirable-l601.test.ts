import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freeLine } from '../src/ready-free.js';

const read = (f: string): string => readFileSync(f, 'utf8');

/** Les fichiers de `dir` (récursif) dont le nom finit par une des extensions. */
function files(dir: string, ext: string[]): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.some((e) => n.endsWith(e)) ? [p] : [];
  });
}

describe('L601 — « prêt » est le mot de la vague, « tirable » celui du plan', () => {
  it('R1 — la ligne des lots du plan à jouer dit « tirables », jamais « prêts » ; sans lot libre, aucune ligne', () => {
    const line = freeLine([{ project: 'alpha', free: [{ id: 'L3', title: 'Un lot', uses: ['banc'] }] }], 40);
    expect(line).toBe('tirables, ressources libres : alpha:L3 Un lot (banc)');
    expect(line).not.toContain('prêts');
    expect(freeLine([], 40)).toBeNull();
    expect(freeLine([{ project: 'alpha', free: [] }], 40)).toBeNull();
  });

  it('R2 — plus aucun texte livré ne cite l\'ancienne ligne « prêts, ressources libres » (code, skills, docs hors études et CHANGELOG)', () => {
    const lus = [...files('src', ['.ts']), ...files('skills', ['.md']), ...files('agents', ['.md']), ...files('plugins', ['.ts', '.tsx', '.md']), ...['README.md', 'docs/raf.md', 'docs/lead.md', 'docs/orchestrate.md', 'docs/orchestrate-cycle.md', 'docs/orchestrate-gate.md', 'docs/orchestrate-spec.md', 'docs/orchestrate-worktrees.md', 'docs/concepts.md']];
    const restes = lus.filter((f) => read(f).includes('prêts, ressources libres'));
    expect(restes).toEqual([]);
  });

  it('R3 — le glossaire sépare « ready » (état de vague) de « tirable » (lot du plan sans dépendance ouverte) et précise « done »', () => {
    const md = read('docs/concepts.md');
    const g = md.slice(md.indexOf('## Glossary'));
    expect(g).toMatch(/- \*\*ready\*\*: .*wave/);
    expect(g).toMatch(/- \*\*tirable\*\*: .*plan/);
    expect(g).toMatch(/- \*\*done\*\*: .*plan.*wave/);
    expect(md.length).toBeLessThanOrEqual(15 * 1024);
  });

  it('R4 — la ligne du skill lead nomme « tirables, ressources libres »', () => {
    expect(read('skills/lead/SKILL.md')).toContain('`tirables, ressources libres :');
  });
});
