import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../src/check.js';
import { readCommits } from '../src/git.js';
import { linkCommits } from '../src/link.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo } from './helpers.js';

describe('check against a real repository', () => {
  it('reports every kind of drift', () => {
    const dir = gitRepo();
    const plan = Plan.create(join(dir, 'docs/plan/raf.yaml'), 'demo');
    plan.add('todo oublié', '2026-09-01');
    plan.add('en cours endormi', '2026-09-01');
    plan.add('fini trop vite', '2026-09-01');
    plan.addTask('L3', 'reste');
    plan.setStatus('L2', 'doing', '2026-09-01');
    plan.setStatus('L3', 'done', '2026-09-02', { force: true });
    commit(dir, 'feat(L1): premier pas', '2026-09-20T10:00:00');
    commit(dir, 'chore: rien de lié', '2026-09-21T10:00:00');
    commit(dir, 'fix(L9): lot fantôme', '2026-09-22T10:00:00');
    commit(dir, "Merge branch 'x'", '2026-09-22T11:00:00');
    commit(dir, 'fix: L2 corrigé', '2026-09-10T10:00:00');

    const lots = plan.lots();
    const linked = linkCommits(lots, readCommits(dir), plan.refs);
    const kinds = check(lots, linked, '2026-09-28').map((i) => i.kind).sort();
    expect(kinds).toEqual(['done-open-tasks', 'idle', 'orphan-commit', 'todo-with-commits', 'unknown-ref']);
  });

  it('flags cycles and missing dependencies', () => {
    const dir = gitRepo();
    const plan = Plan.create(join(dir, 'raf.yaml'), 'demo');
    plan.add('a', '2026-09-01');
    plan.add('b', '2026-09-01', { after: ['L1'] });
    plan.save();
    writeFileSync(plan.path, readFileSync(plan.path, 'utf8').replace('title: a', 'title: a\n    after: [L2, L7]'));
    const lots = Plan.load(plan.path).lots();
    const issues = check(lots, { byLot: new Map(), orphans: [], unknown: [] }, '2026-09-28');
    expect(issues.map((i) => i.kind).sort()).toEqual(['bad-dependency', 'cycle']);
  });
});

describe('ignore : commits automatiques', () => {
  it('les sujets qui correspondent à un motif « ignore » du plan ne sont pas des commits sans lot', async () => {
    const { run } = await import('../src/cli.js');
    const { gitRepo, commit } = await import('./helpers.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = gitRepo();
    const io = (out: string[]) => ({ cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date() });
    run(['init', '--no-hook'], io([]));
    const plan = join(dir, 'docs/plan/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('lots:', "ignore: ['^chore\\(batch\\):', '[invalide']\nlots:"));
    commit(dir, 'chore(batch): weekly content refresh', '2026-09-28T10:00:00');
    commit(dir, 'wip', '2026-09-28T11:00:00');
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(1);
    expect(out.join('\n')).not.toContain('weekly content refresh');
    expect(out.join('\n')).toContain('commit sans lot : ');
    expect(out.join('\n')).toContain('ignore : motif invalide « [invalide »');
  });
});

describe('planification', () => {
  it('un commit qui ne touche que le plan ne « démarre » pas le lot todo qu’il cite', async () => {
    const { run } = await import('../src/cli.js');
    const { gitRepo, commit } = await import('./helpers.js');
    const { execFileSync } = await import('node:child_process');
    const dir = gitRepo();
    const io = (out: string[]) => ({ cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date() });
    run(['init', '--no-hook'], io([]));
    run(['add', 'Audit'], io([]));
    execFileSync('git', ['add', 'docs/plan/raf.yaml'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'chore(L1): audit planifié'], { cwd: dir });
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(0);
    commit(dir, 'feat(L1): vrai travail', '2026-09-28T12:00:00');
    const out2: string[] = [];
    expect(await run(['check'], io(out2))).toBe(1);
    expect(out2.join('\n')).toContain('L1 a 1 commit(s) mais est encore todo');
  });
});

describe('commit d’entretien du plan : chore(plan)', () => {
  // Cas mesuré le 03-10 (ol-companion b7017e3 et cbc4ffc, warhammer40k f785f48) : le commit touche le plan
  // ET le plan publié que le projet en dérive (frontend/public/plan-data/plan.json) — il n'est donc pas
  // « réduit au plan », et raf check le comptait comme « commit sans lot ».
  async function project() {
    const { run } = await import('../src/cli.js');
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync } = await import('node:fs');
    const dir = gitRepo();
    const io = (out: string[], err: string[] = []) => ({ cwd: dir, env: { RAF_TODAY: '2026-10-03' }, out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date('2026-10-03T12:00:00') });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    /** Commit qui touche le plan et le plan publié, comme le fait « npm run plan » dans ces projets. */
    const publish = (subject: string, files = ['docs/plan/raf.yaml', 'frontend/public/plan-data/plan.json']) => {
      mkdirSync(join(dir, 'frontend/public/plan-data'), { recursive: true });
      for (const f of files) writeFileSync(join(dir, f), `${existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : ''}# ${subject}\n`);
      git('add', ...files);
      git('commit', '-qm', subject);
    };
    run(['init', '--no-hook'], io([]));
    git('add', 'docs/plan/raf.yaml');
    git('commit', '-qm', 'chore: adoption');
    return { dir, run, io, publish };
  }

  it('raf check : un commit « chore(plan): … » qui touche le plan et le plan publié n’est pas un « commit sans lot »', async () => {
    const { run, io, publish } = await project();
    publish('chore(plan): titres publics pour les 18 lots visibles ouverts — la page Plan montre ce qui se prépare (décision de Sylvain du 03-10)');
    publish('chore(plan): audit des liens morts et campagne UX densité planifiés');
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(0);
    expect(out.join('\n')).toBe('✓ plan et historique cohérents');
  });

  it('le sujet seul décide : les mêmes fichiers sous un autre sujet restent un commit sans lot ; « chore(plans) » ou « chore(plan) » en milieu de sujet aussi', async () => {
    const { run, io, publish } = await project();
    publish('chore: plan publié régénéré');
    publish('chore(plans): autre portée');
    publish('revert « chore(plan): titres publics »');
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(1);
    expect(out.filter((l) => l.includes('commit sans lot'))).toHaveLength(3);
  });

  it('session close ne le compte pas, et le hook post-commit ne le signale pas', async () => {
    const { run, io, publish } = await project();
    publish('chore(plan): page Jeux vidéo planifiée ; titres publics des lots prévus');
    const err: string[] = [];
    expect(await run(['hook', 'post-commit'], io([], err))).toBe(0);
    expect(err.join('\n')).not.toContain('commit sans lot');
    const out: string[] = [];
    await run(['session', 'close', '--since', '2026-10-01'], io(out));
    expect(out.join('\n')).not.toContain('sans lot');
    // Contrôle : sous un autre sujet, les deux le disent.
    publish('wip plan publié');
    const err2: string[] = [];
    await run(['hook', 'post-commit'], io([], err2));
    expect(err2.join('\n')).toContain('commit sans lot');
    const out2: string[] = [];
    await run(['session', 'close', '--since', '2026-10-01'], io(out2));
    expect(out2.join('\n')).toContain('1 commit(s) sans lot');
  });

  it('il reste un commit compté pour le lot qu’il cite quand il touche autre chose que le plan (porte de revue, lot « todo »)', async () => {
    const { run, io, publish } = await project();
    run(['add', 'Page Plan'], io([]));
    publish('chore(plan): L1 planifié, plan publié régénéré');
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(1);
    expect(out.join('\n')).toContain('L1 a 1 commit(s) mais est encore todo');
  });
});

describe('fichier dérivé du plan déclaré dans cadence.yaml (plan.files), plan au format de raf', () => {
  it('un commit qui ne touche que le plan et ce fichier est un commit de plan : ni « sans lot », ni travail sur le lot « todo » qu’il cite', async () => {
    const { run } = await import('../src/cli.js');
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync } = await import('node:fs');
    const dir = gitRepo();
    const io = (out: string[]) => ({ cwd: dir, env: { RAF_TODAY: '2026-10-03' }, out: (l: string) => out.push(l), err: () => {}, now: () => new Date('2026-10-03T12:00:00') });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run(['init', '--no-hook'], io([]));
    run(['add', 'Page Plan'], io([]));
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  files: [frontend/public/plan-data/plan.json]\n');
    mkdirSync(join(dir, 'frontend/public/plan-data'), { recursive: true });
    writeFileSync(join(dir, 'frontend/public/plan-data/plan.json'), '{}\n');
    git('add', 'docs/plan/raf.yaml', 'frontend/public/plan-data/plan.json');
    git('commit', '-qm', 'docs: L1 planifié, plan publié régénéré');
    writeFileSync(join(dir, 'frontend/public/plan-data/plan.json'), '{ "lots": [] }\n');
    git('add', 'frontend/public/plan-data/plan.json');
    git('commit', '-qm', 'docs: plan publié régénéré');
    const out: string[] = [];
    expect(await run(['check'], io(out))).toBe(0);
    // Le plan reste modifiable : plan.files seul ne le met pas en lecture seule.
    expect(await run(['start', 'L1'], io([]))).toBe(0);
  });
});

describe('readCommits', () => {
  it('reads a history larger than the default output buffer', () => {
    const dir = gitRepo();
    const body = 'x'.repeat(100_000);
    for (let i = 0; i < 12; i++) commit(dir, `feat(L1): pas ${i}\n\n${body}`);
    expect(readCommits(dir)).toHaveLength(12);
  });
});
