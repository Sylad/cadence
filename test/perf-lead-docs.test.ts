import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';

const root = join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const skill = read('skills/lead/SKILL.md');
const tourSection = skill.slice(skill.indexOf('## 1. Tour of the projects'), skill.indexOf('## 2. Delegation')).replace(/\s+/g, ' ');

describe('skill lead — l\'en-tête perf (L227)', () => {
  it('R10 — SKILL.md demande de lire l\'en-tête perf avant de proposer les trois lots', () => {
    expect(tourSection).toMatch(/perf header/i);
    expect(tourSection.search(/perf header/i)).toBeLessThan(tourSection.indexOf('propose **three**'));
    expect(tourSection).toMatch(/one line per `⚠`/);
  });

  it('R10 — SKILL.md réserve le lot d\'amélioration à une tendance sur deux fenêtres ou à un goulot net', () => {
    expect(tourSection).toMatch(/improvement lot/);
    expect(tourSection).toMatch(/trend confirmed on two windows/);
    expect(tourSection).toMatch(/`⚠ goulot`/);
  });

  it('R10 — SKILL.md fixe un lot d\'amélioration au plus, en plus des trois', () => {
    expect(tourSection).toMatch(/at most one improvement lot per tour, in addition to the three, never in their place/);
    expect(tourSection).toMatch(/the human decides/);
  });

  it('R11 — SKILL.md interdit le lot de micro-optimisation', () => {
    expect(tourSection).toMatch(/never open a lot for a micro-optimisation or for the variation of a single window/i);
  });

  it('R11 — SKILL.md ne demande aucune ligne de perf quand l\'en-tête est vide', () => {
    expect(tourSection).toMatch(/without a `⚠`.*say nothing about perf/is);
  });
});

describe('documentation — livraisons rouges et en-tête perf (L227)', () => {
  it('R12 — CHANGELOG.md contient une entrée citant L227', () => {
    // whole changelog: the entry stays found after a release renames [Unreleased] and later lots open new sections
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/\(L227[,)]/);
    expect(changelog.indexOf('(L227')).toBeLessThan(changelog.indexOf('(L225'));
  });

  it('R12 — le README cite les livraisons rouges et l\'en-tête perf du tour', () => {
    const readme = read('docs/overview.md');
    expect(readme).toMatch(/red deliveries/);
    expect(readme).toMatch(/perf header/);
    expect(read('docs/perf.md')).toMatch(/deliveries-failed\.log/);
    expect(read('docs/lead.md')).toMatch(/perf header/);
  });

  it('R12 — l\'aide de lead tour cite l\'en-tête perf', async () => {
    const out: string[] = [];
    await run(['--help'], { cwd: root, env: {}, out: (l) => out.push(l), err: () => {}, now: () => new Date() });
    expect(out.join('\n').split('\n').find((l) => l.includes('cadence lead tour'))).toContain('en-tête perf');
  });
});
