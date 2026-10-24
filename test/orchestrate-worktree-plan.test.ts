import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { unreviewedWork } from '../src/audit.js';
import { Plan } from '../src/plan.js';
import { gitRepo } from './helpers.js';

// L279 — verdict reporté au sha intégré (D5, R18, R23) : la trace `reporte` est informative, la porte de `raf done` ne change pas.
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const PLAN = '.cadence/raf.yaml';

function lotRepo() {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'), { recursive: true });
  const plan = Plan.create(join(dir, PLAN), 'demo', 'L', '2026-09-01');
  plan.add('Un lot', '2026-09-28', { estimate: 0.5 });
  plan.setStatus('L1', 'doing', '2026-09-28');
  plan.enableReview('2026-09-01');
  plan.save();
  git(dir, 'add', '--', PLAN);
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return dir;
}
const work = (dir: string, file: string, msg = 'feat(L1): travail') => {
  writeFileSync(join(dir, file), `${Math.random()}\n`);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
};
const planCommit = (dir: string, edit: (p: Plan) => void, msg = 'plan: L1 revue de code enregistrée') => {
  const p = Plan.load(join(dir, PLAN));
  edit(p);
  p.save();
  git(dir, 'add', '--', PLAN);
  git(dir, 'commit', '-q', '-m', msg);
};
const done = (dir: string) => {
  const err: string[] = [];
  const code = run(['done', 'L1'], { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-09-28T09:00:00') });
  return { code, err: err.join('\n') };
};
const reporte = (de: string, vers: string) => ({ de, vers, patchId: 'abc123' });

describe('D5 — champ optionnel `reporte` du verdict de revue', () => {
  it('D5 — recordReview écrit la trace { de, vers, patchId } et elle se relit', () => {
    const dir = lotRepo();
    const sha = work(dir, 'a');
    planCommit(dir, (p) => p.recordReview('L1', 'conforme', '2026-09-28', sha, undefined, reporte('1111111', sha)));
    expect(Plan.load(join(dir, PLAN)).lot('L1').review).toMatchObject({ verdict: 'conforme', commit: sha, reporte: { de: '1111111', vers: sha, patchId: 'abc123' } });
    expect(readFileSync(join(dir, PLAN), 'utf8')).toContain('reporte:');
  });
  it('D5 — un verdict sans trace se relit sans champ reporte (verdicts existants inchangés)', () => {
    const dir = lotRepo();
    const sha = work(dir, 'a');
    planCommit(dir, (p) => p.recordReview('L1', 'conforme', '2026-09-28', sha));
    const review = Plan.load(join(dir, PLAN)).lot('L1').review!;
    expect(review.reporte).toBeUndefined();
    expect(readFileSync(join(dir, PLAN), 'utf8')).not.toContain('reporte');
  });
});

describe('R18 — la porte de raf done reste inchangée', () => {
  it('R18 — verdict reporté, commit = dernier commit de travail intégré : unreviewedWork vaut 0 et raf done passe sans modification de la porte', () => {
    const dir = lotRepo();
    const a = work(dir, 'a');
    const vers = work(dir, 'b');
    planCommit(dir, (p) => p.recordReview('L1', 'conforme', '2026-09-28', vers, undefined, reporte(a, vers))); // commit de plan seul au sommet (R23)
    expect(unreviewedWork(Plan.load(join(dir, PLAN)), dir, 'L1')).toBe(0);
    const r = done(dir);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });
  it('R18 — verdict à la main au sha d\'avant le rebase (absent de l\'historique) : raf done refuse avec le message existant', () => {
    const dir = lotRepo();
    work(dir, 'a');
    work(dir, 'b');
    planCommit(dir, (p) => p.recordReview('L1', 'conforme', '2026-09-28', 'f'.repeat(40)));
    const r = done(dir);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/L1 : la revue de code précède 2 commit\(s\) du lot, elle est à refaire — raf review L1 "verdict" \(--force pour passer outre\)/);
  });
  it('R18 — un commit de travail ajouté après le report : refus comme aujourd\'hui', () => {
    const dir = lotRepo();
    const a = work(dir, 'a');
    planCommit(dir, (p) => p.recordReview('L1', 'conforme', '2026-09-28', a, undefined, reporte('2222222', a)));
    work(dir, 'b');
    const r = done(dir);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/la revue de code précède 1 commit\(s\) du lot/);
  });
  it('R18 — la trace `reporte` retirée du verdict : raf done passe encore (elle est informative)', () => {
    const dir = lotRepo();
    const a = work(dir, 'a');
    planCommit(dir, (p) => p.recordReview('L1', 'conforme', '2026-09-28', a, undefined, reporte('3333333', a)));
    const file = join(dir, PLAN);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/, reporte: \{[^}]*\}/, '').replace(/\n\s*reporte:[^\n]*(\n\s+[^\n]*)*/, ''));
    expect(readFileSync(file, 'utf8')).not.toContain('reporte');
    git(dir, 'add', '--', PLAN);
    git(dir, 'commit', '-q', '-m', 'plan: trace retirée');
    expect(done(dir).code).toBe(0);
  });
});
