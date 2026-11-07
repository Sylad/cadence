import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { citedResources, readResources } from '../src/resources.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { resourceLock } from '../src/orchestrate/pool.js';
import type { LotCtx } from '../src/orchestrate/cycle.js';
import { newLot } from '../src/orchestrate/state.js';
import { AGENTS_DIR } from '../src/skills.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, removeDryRunBriefs, tempDir } from './helpers.js';

// L671 — un lot dont le titre cite un chemin d'une ressource déclarée reçoit cette ressource (raf add, file de la vague, plan à sec) : L551 le joue alors
// après le lot qui la tient, au lieu d'attendre son intégration (07-11 : 113,6 min d'attente pour deux lots tenus par L662 et L666).

const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const DOCS = 'resources:\n  docs-orchestrate:\n    paths: [docs/orchestrate.md, docs/orchestrate-cycle.md, docs/orchestrate-gate.md]\n  cycle-ts:\n    paths: [src/orchestrate/cycle.ts, src/orchestrate/cycle/]\n  banc: {}\n';

/** Les ressources d'un cadence.yaml parent, lues comme le programme les lit. */
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

describe('R1 — citedResources : les ressources dont un chemin est cité dans un texte', () => {
  const r = declaredBy(DOCS);
  it('R1 — un joker « docs/orchestrate*.md » cite les pages de la ressource qu\'il couvre', () => {
    expect(citedResources('docs-orchestrate au lancement : le diff cite docs/orchestrate*.md', r)).toEqual(['docs-orchestrate']);
  });
  it('R1 — une page citée, suivie de « :114 », d\'une virgule ou d\'un point', () => {
    expect(citedResources('L662 (docs/orchestrate-gate.md:114) rendu', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('voir docs/orchestrate-cycle.md, puis le reste', r)).toEqual(['docs-orchestrate']);
    expect(citedResources('corrige docs/orchestrate.md.', r)).toEqual(['docs-orchestrate']);
  });
  it('R1 — un fichier sous un chemin de dossier de la ressource', () => {
    expect(citedResources('refonte de src/orchestrate/cycle/brief.ts', r)).toEqual(['cycle-ts']);
  });
  it('R1 — deux ressources citées : les deux, dans l\'ordre de la table, une fois chacune', () => {
    expect(citedResources('src/orchestrate/cycle.ts et docs/orchestrate.md, docs/orchestrate.md', r)).toEqual(['docs-orchestrate', 'cycle-ts']);
  });
  it('R1 — rien de cité, une page voisine, un chemin sans « / », une ressource sans chemin : aucune', () => {
    expect(citedResources('un titre sans chemin', r)).toEqual([]);
    expect(citedResources('docs/orchestrates.md et docs/orchestrate-spec.md', r)).toEqual([]);
    expect(citedResources('orchestrate-gate.md:114', r)).toEqual([]);
    expect(citedResources('le banc', r)).toEqual([]);
  });
  it('R1 — resources: en liste de noms : aucune, comme avant', () => {
    expect(citedResources('docs/orchestrate.md', declaredBy('resources: [docs-orchestrate]\n'))).toEqual([]);
  });
});

describe('R2 — raf add : la ressource citée par le titre est posée en uses:', () => {
  function project(yaml: string) {
    const parent = tempDir();
    const dir = gitRepo(parent);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    writeFileSync(join(parent, 'cadence.yaml'), yaml);
    return dir;
  }
  it('R2 — le titre cite docs/orchestrate*.md : raf show du lot porte uses : docs-orchestrate', () => {
    const dir = project(DOCS);
    expect(raf(dir, 'add', 'page docs/orchestrate-gate.md à jour').code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).toContain('uses : docs-orchestrate');
  });
  it('R2 — avec --uses banc : banc d\'abord, la ressource citée ensuite, sans doublon', () => {
    const dir = project(DOCS);
    raf(dir, 'add', 'page docs/orchestrate.md', '--uses', 'banc,docs-orchestrate');
    expect(raf(dir, 'show', 'L1').out).toContain('uses : banc, docs-orchestrate');
    raf(dir, 'add', 'autre page docs/orchestrate.md', '--uses', 'banc');
    expect(raf(dir, 'show', 'L2').out).toContain('uses : banc, docs-orchestrate');
  });
  it('R2 — titre sans chemin cité, ou ressources en liste de noms : pas de uses:', () => {
    const dir = project(DOCS);
    raf(dir, 'add', 'un lot sans page');
    expect(raf(dir, 'show', 'L1').out).not.toContain('uses');
    const plain = project('resources: [docs-orchestrate]\n');
    raf(plain, 'add', 'page docs/orchestrate.md');
    expect(raf(plain, 'show', 'L1').out).not.toContain('uses');
  });
  it('R2 — sous-tâche (--parent) : le titre n\'ouvre aucun uses: (refusé pour une sous-tâche)', () => {
    const dir = project(DOCS);
    raf(dir, 'add', 'lot');
    expect(raf(dir, 'add', 'docs/orchestrate.md', '--parent', 'L1').code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).not.toContain('uses');
  });
});

/** Un LotCtx minimal pour `resourceLock` : le plan du dépôt, sans worktree. */
function ctxOf(repo: string, lot: string, status: LotCtx['lot']['status']): LotCtx {
  const state = newLot({ project: 'a', repo, lot, title: lot, visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
  state.status = status;
  return { lot: state, loadPlan: () => Plan.load(join(repo, '.cadence/raf.yaml')) } as LotCtx;
}

describe('R3 — la file de la vague : deux lots dont les titres citent la même page jouent l\'un après l\'autre', () => {
  function repoWith(titles: string[]) {
    const parent = tempDir();
    const repo = gitRepo(parent);
    writeFileSync(join(parent, 'cadence.yaml'), DOCS);
    const plan = Plan.create(join(repo, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
    for (const t of titles) plan.add(t, '2026-11-07', { estimate: 1 });
    plan.save();
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'chore: plan');
    return repo;
  }
  it('R3 — L1 joue (titre cite docs/orchestrate-gate.md), L2 le cite aussi : L2 attend ; L3 sans page : libre', () => {
    const repo = repoWith(['docs/orchestrate-gate.md', 'docs/orchestrate*.md', 'sans page']);
    const [l1, l2, l3] = [ctxOf(repo, 'L1', 'implementing'), ctxOf(repo, 'L2', 'queued'), ctxOf(repo, 'L3', 'queued')];
    const lock = resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l1, l2, l3]));
    expect(lock.wants([l2])).toBe(true);
    expect(lock.wants([l3])).toBe(false);
  });
  it('R3 — la file qui jouait a fini (hors live) : L2 part', () => {
    const repo = repoWith(['docs/orchestrate-gate.md', 'docs/orchestrate*.md']);
    const [l1, l2] = [ctxOf(repo, 'L1', 'ready'), ctxOf(repo, 'L2', 'queued')];
    expect(resourceLock(new Map([[Promise.resolve(), [l1]]]), new Set([l2])).wants([l2])).toBe(false);
  });
});

describe('R4 — plan à sec : la ressource citée par le titre est dite', () => {
  it('R4 — « ressources : docs-orchestrate (titre) » sous le lot, rien pour un lot sans page', async () => {
    const parent = tempDir();
    const dir = join(parent, 'a');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), 'a', 'L', '2026-09-01');
    plan.add('page docs/orchestrate.md', '2026-11-07', { estimate: 1 });
    plan.add('sans page', '2026-11-07', { estimate: 1 });
    plan.save();
    writeFileSync(join(dir, 'cadence.yaml'), 'orchestrate:\n  precheck: false\n');
    writeFileSync(join(parent, 'cadence.yaml'), DOCS);
    git(dir, 'add', '--', '.cadence/raf.yaml', 'cadence.yaml');
    git(dir, 'commit', '-q', '-m', 'chore: plan');
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: parent, env: { RAF_TODAY: '2026-11-07' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-07T08:00:00') };
    const code = await orchestrate(['a:L1', 'a:L2', '--dry-run'], io, { claude: async () => { throw new Error('plan à sec : aucune session'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR });
    const text = out.join('\n');
    try {
      expect(code).toBe(0);
      const l1 = text.slice(text.indexOf('a:L1'), text.indexOf('a:L2'));
      expect(l1).toContain('ressources : docs-orchestrate (cité par le titre');
      expect(text.slice(text.indexOf('a:L2'))).not.toContain('ressources :');
    } finally {
      removeDryRunBriefs(text);
    }
  });
});
