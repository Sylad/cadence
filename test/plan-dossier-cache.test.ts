import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { planLoader } from '../src/config.js';
import { isProject } from '../src/lead.js';
import { orchestrate, realOrchestrateDeps } from '../src/orchestrate/command.js';
import { excludeState } from '../src/orchestrate/state.js';
import { snapshot } from '../src/orchestrate/guard.js';
import { Plan } from '../src/plan.js';
import { isPlanOnly } from '../src/audit.js';
import { changedFiles } from '../src/git.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { gitRepo, tempDir } from './helpers.js';
import { claudeOut, commitFile, harness, reviewReport, workReport } from './orchestrate-harness.js';

function raf(dir: string, args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { cwd: dir, env: { RAF_TODAY: '2026-10-22', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-22T09:00:00') });
  return { code: code as number, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const MOVE = 'git mv docs/plan/raf.yaml .cadence/raf.yaml';

/** Un dépôt avec un plan hérité docs/plan/raf.yaml portant le lot L1 « Hérité ». */
function legacyRepo() {
  const dir = gitRepo();
  const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-10-01');
  plan.add('Hérité', '2026-10-01');
  plan.save();
  return dir;
}

describe('plan par défaut dans .cadence/ (L246)', () => {
  it('R1 — raf init crée .cadence/raf.yaml et .cadence/notes/.gitkeep, pas docs/plan/raf.yaml', () => {
    const dir = gitRepo();
    const r = raf(dir, ['init', '--project', 'demo', '--no-hook']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`plan créé : ${join(dir, '.cadence/raf.yaml')}`);
    expect(existsSync(join(dir, '.cadence/raf.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.cadence/notes/.gitkeep'))).toBe(true);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(false);
    expect(raf(dir, ['add', 'Un lot']).out).toBe('L1');
  });

  it('R2 — raf init avec docs/plan/raf.yaml présent : refus « existe déjà », aucun .cadence/raf.yaml créé', () => {
    const dir = legacyRepo();
    const r = raf(dir, ['init', '--no-hook']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`${join(dir, 'docs/plan/raf.yaml')} existe déjà`);
    expect(existsSync(join(dir, '.cadence'))).toBe(false);
  });

  it('R3 — init avec plan: x/plan.yaml crée x/plan.yaml et pas .cadence/raf.yaml', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan: x/plan.yaml\n');
    const r = raf(dir, ['init', '--no-hook']);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'x/plan.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.cadence/raf.yaml'))).toBe(false);
    expect(existsSync(join(dir, '.cadence/notes'))).toBe(false);
  });

  it('R4 — les deux plans présents : le plan lu est .cadence/raf.yaml et la ligne d\'avertissement est émise', () => {
    const dir = legacyRepo();
    raf(dir, ['init', '--file', '.cadence/raf.yaml', '--no-hook']);
    raf(dir, ['add', 'Neuf', '--file', '.cadence/raf.yaml']);
    const before = readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
    const r = raf(dir, ['list']);
    expect(r.out).toContain('Neuf');
    expect(r.out).not.toContain('Hérité');
    expect(r.err).toContain('docs/plan/raf.yaml');
    expect(r.err).toContain('.cadence/raf.yaml');
    expect(r.err).toMatch(/ignoré/);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toBe(before);
  });

  it('R5 — plan hérité : raf now lit le plan, stderr propose le git mv, stdout identique à avant', () => {
    const dir = legacyRepo();
    const r = raf(dir, ['list']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Hérité');
    expect(r.out).not.toContain('git mv');
    expect(r.err.split('\n').filter((l) => l.includes(MOVE))).toHaveLength(1);
    // écrit comme avant
    expect(raf(dir, ['add', 'Autre']).code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8')).toContain('Autre');
    expect(existsSync(join(dir, '.cadence/raf.yaml'))).toBe(false);
  });

  it('R5 — la ligne de déplacement est exécutable telle quelle, sans .cadence/ préexistant', () => {
    const dir = legacyRepo();
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    const line = raf(dir, ['list']).err.split('\n').find((l) => l.includes(MOVE))!;
    const cmd = line.slice(line.indexOf('déplacer : ') + 'déplacer : '.length);
    execFileSync('bash', ['-c', cmd], { cwd: dir, stdio: 'pipe' });
    expect(existsSync(join(dir, '.cadence/raf.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(false);
  });

  it('R5 — après le git mv proposé, les commits du plan hérité et du déplacement restent des commits de plan seul', () => {
    const dir = legacyRepo();
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'plan: ajout');
    const avant = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    mkdirSync(join(dir, '.cadence'));
    git(dir, 'mv', 'docs/plan/raf.yaml', '.cadence/raf.yaml');
    git(dir, 'commit', '-m', 'plan: déplacé');
    const deplace = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
    expect(changedFiles(dir, deplace).sort()).toEqual(['.cadence/raf.yaml', 'docs/plan/raf.yaml']);
    expect(isPlanOnly(avant, plan, dir)).toBe(true);
    expect(isPlanOnly(deplace, plan, dir)).toBe(true);
  });

  it('R5 — hors dépôt git, la ligne propose mv', () => {
    const dir = tempDir();
    Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo', 'L', '2026-10-01');
    expect(raf(dir, ['list']).err).toContain('mv docs/plan/raf.yaml .cadence/raf.yaml');
    expect(raf(dir, ['list']).err).not.toContain('git mv');
  });

  it('R5 — session start --all sur un plan hérité : la ligne de déplacement part sur stderr, pas dans le tableau de stdout', async () => {
    const root = tempDir();
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'alpha', 'L', '2026-10-01');
    plan.add('Hérité', '2026-10-01');
    plan.save();
    const out: string[] = [];
    const err: string[] = [];
    await run(['session', 'start', '--all'], { cwd: root, env: { RAF_TODAY: '2026-10-22' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-22T09:00:00') });
    expect(out.join('\n')).toContain('## alpha');
    expect(out.join('\n')).not.toContain('ancien emplacement');
    expect(err.join('\n')).toContain(MOVE);
  });

  it('R5 — --file ou plan: vers docs/plan/raf.yaml : aucune ligne de déplacement', () => {
    const dir = legacyRepo();
    expect(raf(dir, ['list', '--file', 'docs/plan/raf.yaml']).err).toBe('');
    expect(raf(dir, ['list'], { RAF_FILE: join(dir, 'docs/plan/raf.yaml') }).err).toBe('');
    writeFileSync(join(dir, 'cadence.yaml'), 'plan: docs/plan/raf.yaml\n');
    expect(raf(dir, ['list']).err).toBe('');
  });

  it('R5 — planLoader (orchestrate, lead) suit le plan déplacé de docs/plan/ vers .cadence/ sans être recréé', () => {
    const dir = legacyRepo();
    const loadPlan = planLoader(dir);
    expect(loadPlan().lot('L1').title).toBe('Hérité');
    mkdirSync(join(dir, '.cadence'));
    renameSync(join(dir, 'docs/plan/raf.yaml'), join(dir, '.cadence/raf.yaml'));
    expect(loadPlan().path).toBe(join(dir, '.cadence/raf.yaml'));
    expect(loadPlan().lot('L1').title).toBe('Hérité');
  });

  it('R6 — plan: chemin.yaml : raf add écrit le plan', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan: suivi/plan.yaml\n');
    raf(dir, ['init', '--no-hook']);
    expect(raf(dir, ['add', 'Un lot']).code).toBe(0);
    expect(readFileSync(join(dir, 'suivi/plan.yaml'), 'utf8')).toContain('Un lot');
  });

  it('R6 — plan avec fields: : raf add refusé « plan en lecture seule »', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, 'suivi'));
    writeFileSync(join(dir, 'suivi/plan.yaml'), 'lots: []\n');
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: suivi/plan.yaml\n  fields:\n    title: [name]\n');
    const r = raf(dir, ['add', 'Un lot']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('plan en lecture seule');
  });

  it('R7 — lead : isProject vrai avec .cadence/raf.yaml seul', () => {
    const dir = tempDir();
    expect(isProject(dir)).toBe(false);
    mkdirSync(join(dir, '.cadence'));
    writeFileSync(join(dir, '.cadence/raf.yaml'), 'lots: []\n');
    expect(isProject(dir)).toBe(true);
  });

  it('R7 — lead : message « aucun projet » cite .cadence/raf.yaml', () => {
    const dir = tempDir();
    const r = raf(dir, ['lead', 'tour']);
    expect(r.out).toContain('aucun projet');
    expect(r.out).toContain('.cadence/raf.yaml');
  });

  const refusals = async (project: string) => {
    const err: string[] = [];
    const parent = join(project, '..');
    const code = await orchestrate([`${project.split('/').pop()}:L1`], { cwd: parent, env: { RAF_TODAY: '2026-10-22' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-10-22T09:00:00') }, realOrchestrateDeps({}));
    return { code, err: err.join('\n') };
  };

  it('R7 — orchestrate : un dossier au seul .cadence/raf.yaml n\'est pas refusé « n\'est pas un projet cadence »', async () => {
    const parent = tempDir();
    const dir = join(parent, 'p');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    Plan.create(join(dir, '.cadence/raf.yaml'), 'p', 'L', '2026-10-01');
    const r = await refusals(dir);
    expect(r.err).toContain('p:L1 : lot inconnu');
    expect(r.err).not.toContain('n\'est pas un projet cadence');
  });

  it('R7 — orchestrate : un dossier sans plan est refusé et le message cite .cadence/raf.yaml et docs/plan/raf.yaml', async () => {
    const parent = tempDir();
    const dir = join(parent, 'p');
    mkdirSync(dir);
    const r = await refusals(dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`p:L1 : ${dir} n'est pas un projet cadence (.cadence/raf.yaml, docs/plan/raf.yaml, ou cadence.yaml avec une clé plan:)`);
  });

  it('R8 — excludeState écrit /.cadence/runs/ et /.cadence/corrections.json, et non /.cadence/', () => {
    const repo = gitRepo();
    excludeState(repo);
    const lines = readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('\n');
    expect(lines).toContain('/.cadence/runs/');
    expect(lines).toContain('/.cadence/corrections.json');
    expect(lines).not.toContain('/.cadence/');
  });

  it('R8 — snapshot : .cadence/runs/x ignoré, .cadence/raf.yaml modifié compté dans tracked', async () => {
    const repo = gitRepo();
    Plan.create(join(repo, '.cadence/raf.yaml'), 'p', 'L', '2026-10-01');
    git(repo, 'add', '--', '.cadence/raf.yaml');
    git(repo, 'commit', '-q', '-m', 'plan');
    excludeState(repo);
    mkdirSync(join(repo, '.cadence/runs'), { recursive: true });
    writeFileSync(join(repo, '.cadence/runs/x'), 'état');
    expect((await snapshot(repo, { remote: false })).tracked).toEqual([]);
    expect((await snapshot(repo, { remote: false })).untracked).toEqual([]);
    writeFileSync(join(repo, '.cadence/raf.yaml'), `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}# modif\n`);
    const s = await snapshot(repo, { remote: false });
    expect(s.tracked).toHaveLength(1);
    expect(s.tracked[0]).toContain('.cadence/raf.yaml');
  });

  it('R8 — un plan sous .cadence/ est commitable par commitPlan sans git add -f', async () => {
    const h = harness({ planRel: '.cadence/raf.yaml', script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }))], review: [() => claudeOut(reviewReport())] } });
    excludeState(h.repo);
    await runLot(h.lot('L1'));
    // « plan: L1 démarré » et « revue enregistrée » sont des commits du cycle sur .cadence/raf.yaml, que le git du dépôt suit
    expect(execFileSync('git', ['log', '--format=%s', '--', '.cadence/raf.yaml'], { cwd: h.repo, encoding: 'utf8' }).split('\n')).toEqual(expect.arrayContaining(['plan: L1 démarré (orchestrate w1)']));
    expect(h.plan().lot('L1').status).toBe('doing');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: h.repo, encoding: 'utf8' })).toBe('');
  });

  it('R9 — ancienne ligne /.cadence/ remplacée, autres lignes intactes, deuxième appel sans effet', () => {
    const repo = gitRepo();
    const file = join(repo, '.git/info/exclude');
    writeFileSync(file, '# commentaire\n/build/\n/.cadence/\n*.tmp\n');
    excludeState(repo);
    const once = readFileSync(file, 'utf8');
    expect(once.split('\n')).not.toContain('/.cadence/');
    expect(once.split('\n')).toEqual(expect.arrayContaining(['# commentaire', '/build/', '*.tmp', '/.cadence/runs/', '/.cadence/corrections.json']));
    excludeState(repo);
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('R10 — le texte d\'aide de raf cite .cadence/raf.yaml comme plan par défaut', () => {
    const r = raf(tempDir(), ['--help']);
    expect(r.out + r.err).toContain('Le plan est .cadence/raf.yaml');
  });

  it('R11 — excludeState écrit aussi /.cadence/corrections.json', () => {
    const repo = gitRepo();
    excludeState(repo);
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.cadence/corrections.json');
  });

  it('R11 — snapshot : .cadence/corrections.json non compté en untracked ni en tracked', async () => {
    const repo = gitRepo();
    excludeState(repo);
    mkdirSync(join(repo, '.cadence'));
    writeFileSync(join(repo, '.cadence/corrections.json'), '{}');
    const s = await snapshot(repo, { remote: false });
    expect(s.tracked).toEqual([]);
    expect(s.untracked).toEqual([]);
  });

  it('R11 — garde d\'arbre propre : .cadence/corrections.json listé par git (sans exclude) n\'est compté ni en untracked ni en tracked', async () => {
    const repo = gitRepo();
    mkdirSync(join(repo, '.cadence'));
    writeFileSync(join(repo, '.cadence/corrections.json'), '{}');
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })).toContain('.cadence/corrections.json');
    const s = await snapshot(repo, { remote: false });
    expect(s.tracked).toEqual([]);
    expect(s.untracked).toEqual([]);
  });

  it('R11 — cadence corrections lit et écrit toujours .cadence/corrections.json', async () => {
    const parent = tempDir();
    mkdirSync(join(parent, '.cadence/runs'), { recursive: true });
    const cache = join(parent, '.cadence/corrections.json');
    const corrections = async (...argv: string[]) => {
      const err: string[] = [];
      const code = await run(['corrections', parent, ...argv], { cwd: parent, env: { RAF_TODAY: '2026-10-22', OLLAMA_HOST: 'http://127.0.0.1:1' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-10-22T09:00:00') });
      return { code, err: err.join('\n') };
    };
    expect((await corrections('--classify')).code).toBe(0);
    expect(JSON.parse(readFileSync(cache, 'utf8'))).toEqual({});
    writeFileSync(cache, '[]');
    const r = await corrections();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(cache);
  });
});
