import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { citedResources, readResources } from '../src/resources.js';
import { gitRepo, tempDir } from './helpers.js';

// L671 — bords : la ressource citée par le titre (citedResources, raf add) face aux écritures réelles d'un titre de lot.

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const DOCS = 'resources:\n  docs-orchestrate:\n    paths: [docs/orchestrate.md, docs/orchestrate-cycle.md, docs/orchestrate-gate.md]\n  cycle-ts:\n    paths: [src/orchestrate/cycle.ts, src/orchestrate/cycle/]\n';

function declaredBy(yaml: string) {
  const parent = tempDir();
  const root = join(parent, 'projet', '.cadence');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(parent, 'cadence.yaml'), yaml);
  return readResources(root);
}

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-07' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-07T09:30:00') });
  return { code: code as number, out: out.join('\n'), err: err.join('\n') };
}

function project(yaml: string) {
  const parent = tempDir();
  const dir = gitRepo(parent);
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  writeFileSync(join(parent, 'cadence.yaml'), yaml);
  return dir;
}

describe('L671 bords — citedResources', () => {
  const r = declaredBy(DOCS);
  it('R1 bord — titre vide : aucune ressource', () => {
    expect(citedResources('', r)).toEqual([]);
  });
  it('R1 bord — chemin entouré de ponctuation de titre (backticks, parenthèses, guillemets, « ./ »)', () => {
    expect(citedResources('page `docs/orchestrate.md` à jour', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('(docs/orchestrate-gate.md)', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('« docs/orchestrate-cycle.md »', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('"docs/orchestrate.md"', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('voir ./docs/orchestrate.md', r)).toEqual(['docs-orchestrate']);
  });
  it('R1 bord — jokers : docs/orchestrate-*.md et docs/*.md couvrent, docs/orchestrate.* aussi, docs/zzz*.md non', () => {
    expect(citedResources('docs/orchestrate-*.md', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('docs/*.md', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('docs/orchestrate.*', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('docs/zzz*.md', r)).toEqual([]);
  });
  it('R1 bord — le « * » ne franchit pas un « / » et le « . » du joker est littéral', () => {
    expect(citedResources('docs/orchestrate*md', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('docs/orchestrateXmd', r)).toEqual([]);
    expect(citedResources('docs/orchestrate-cycle*', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('docs/*/orchestrate.md', r)).toEqual([]);
  });
  it('R1 bord — un dossier cité qui ne fait que contenir le chemin d\'une ressource ne la cite pas', () => {
    expect(citedResources('tout docs/ à relire', r)).toEqual([]);
    expect(citedResources('src/orchestrate/ en entier', r)).toEqual([]);
  });
  it('R1 bord — un mot « et/ou » ou une date « 07/11 » ne cite rien', () => {
    expect(citedResources('lire et/ou corriger le 07/11', r)).toEqual([]);
  });
  it('R1 bord — un très long titre sans chemin se lit vite', () => {
    const t0 = Date.now();
    expect(citedResources('a/'.repeat(50000) + ' ' + '*'.repeat(50000), r)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('R1 bord — ressource à chemins dont un chemin est un dossier, citée par le dossier exact', () => {
    expect(citedResources('src/orchestrate/cycle/', r)).toEqual(['cycle-ts']);
    expect(citedResources('src/orchestrate/cycle', r)).toEqual(['cycle-ts']);
  });
  it('R1 bord — table declarée vide ou ressource à chemins vides : aucune', () => {
    expect(citedResources('docs/orchestrate.md', declaredBy('resources:\n  docs-orchestrate: {}\n'))).toEqual([]);
    expect(citedResources('docs/orchestrate.md', declaredBy('resources:\n  docs-orchestrate:\n    paths: []\n'))).toEqual([]);
  });
});

describe('L671 bords — raf add', () => {
  it('R2 bord — --uses vide refusé même quand le titre cite une ressource', () => {
    const dir = project(DOCS);
    const res = raf(dir, 'add', 'page docs/orchestrate.md', '--uses', ' , ');
    expect(res.code).not.toBe(0);
    expect(raf(dir, 'show', 'L1').code).not.toBe(0);
  });
  it('R2 bord — --uses donné deux fois le même nom et cité par le titre : un seul', () => {
    const dir = project(DOCS);
    raf(dir, 'add', 'page docs/orchestrate.md', '--uses', 'docs-orchestrate,docs-orchestrate');
    const shown = raf(dir, 'show', 'L1').out;
    expect(shown).toContain('uses : docs-orchestrate');
    expect(shown).not.toContain('docs-orchestrate, docs-orchestrate');
  });
  it('R2 bord — cadence.yaml parent mal formé (liste mêlée) : le lot est ajouté, sans uses:', () => {
    const dir = project('resources:\n  - docs-orchestrate\n  - banc: {}\n');
    expect(raf(dir, 'add', 'page docs/orchestrate.md').code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).not.toContain('uses');
  });
  it('R2 bord — cadence.yaml parent illisible (YAML cassé) : le lot est ajouté, sans uses:', () => {
    const dir = project('resources: [unclosed\n  : :\n');
    expect(raf(dir, 'add', 'page docs/orchestrate.md').code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).not.toContain('uses');
  });
  it('R2 bord — aucun cadence.yaml parent : le lot est ajouté, sans uses:', () => {
    const parent = tempDir();
    const dir = gitRepo(parent);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    expect(raf(dir, 'add', 'page docs/orchestrate.md').code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).not.toContain('uses');
  });
  it('R2 bord — un lot ajouté deux fois avec le même titre reçoit la ressource les deux fois', () => {
    const dir = project(DOCS);
    raf(dir, 'add', 'page docs/orchestrate.md');
    raf(dir, 'add', 'page docs/orchestrate.md');
    expect(raf(dir, 'show', 'L1').out).toContain('uses : docs-orchestrate');
    expect(raf(dir, 'show', 'L2').out).toContain('uses : docs-orchestrate');
  });
});
