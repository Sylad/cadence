import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver, parseDeliverConfig, type DeliverDeps } from '../src/deliver.js';
import { headSha } from '../src/git.js';
import { Plan } from '../src/plan.js';
import { appendDelivery, sharedStateDir } from '../src/state.js';
import { isNonConformingVerdict } from '../src/audit.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const CONFIG = parseDeliverConfig('deliver:\n  deploy:\n    - echo "$CADENCE_SHORT"\n  verify:\n    - command: "true"\n', 'cadence.yaml');

/** Dépôt poussé avec un plan de deux lots (L1 et L2) ; les commits de travail sont ajoutés par le test. */
function repo(): { dir: string; planFile: string } {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  const planFile = join(dir, '.cadence/raf.yaml');
  const plan = Plan.create(planFile, 'demo', 'L', '2026-09-28');
  plan.add('Premier', '2026-09-28');
  plan.add('Second', '2026-09-28');
  plan.save();
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  git(dir, 'remote', 'add', 'origin', origin);
  return { dir, planFile };
}

function work(dir: string, message: string, file: string) {
  writeFileSync(join(dir, file), message);
  git(dir, 'add', file);
  commit(dir, message);
}

function run(dir: string, planFile: string | null, over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const execs: string[] = [];
  const deps: DeliverDeps = {
    exec: (cmd) => (execs.push(cmd), 0),
    gh: () => [],
    ghReady: () => null,
    fetch: async () => ({ status: 200, text: 'ok' }),
    sleep: async () => {},
    now: () => 0,
  };
  const ctx = { root: dir, state: sharedStateDir(dir), plan: planFile ? Plan.load(planFile) : null, config: CONFIG, today: '2026-09-28', dryRun: false, sha: headSha(dir)!, args: [], out: (l: string) => out.push(l), err: (l: string) => err.push(l), ...over };
  return deliver(ctx, deps).then((code) => ({ code, out, err, execs }));
}

function push(dir: string) {
  git(dir, 'push', '-q', '-u', 'origin', 'main');
}

describe('deliver --sha hors vague : lots ni done ni prêts (L474)', () => {
  it('R1 — refuse un sha dont l\'histoire porte des commits d\'un lot en cours non relu, et nomme le lot et son état', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    work(dir, 'feat(L2): deux', 'b.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.setStatus('L2', 'done', '2026-09-28', { force: true });
    plan.save();
    const r = await run(dir, planFile);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/L1/);
    expect(r.err.join('\n')).toMatch(/non relu/);
    expect(r.err.join('\n')).not.toMatch(/L2/);
    expect(r.execs).toEqual([]);
  });

  it('R2 — un lot done passe ; un lot relu à son dernier commit (prêt) passe ; un commit postérieur à la revue refuse à nouveau', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    work(dir, 'feat(L2): deux', 'b.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'done', '2026-09-28', { force: true });
    plan.setStatus('L2', 'doing', '2026-09-28');
    plan.recordReview('L2', 'conforme', '2026-09-28', headSha(dir)!);
    plan.save();
    expect((await run(dir, planFile)).code).toBe(0);

    work(dir, 'fix(L2): après la revue', 'c.txt');
    push(dir);
    const r = await run(dir, planFile);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/L2.*relu avant 1 commit/);
  });

  it('R3 — --dry-run liste les lots de l\'intervalle avec leur état, et refuse comme la livraison quand l\'un bloque', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    work(dir, 'feat(L2): deux', 'b.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'done', '2026-09-28', { force: true });
    plan.setStatus('L2', 'doing', '2026-09-28');
    plan.save();
    const blocked = await run(dir, planFile, { dryRun: true });
    expect(blocked.code).toBe(2);
    expect(blocked.out.join('\n')).toMatch(/L1 « Premier » — terminé/);
    expect(blocked.out.join('\n')).toMatch(/L2 « Second » — en cours, non relu/);
    expect(blocked.execs).toEqual([]);

    const ok = Plan.load(planFile);
    ok.recordReview('L2', 'conforme', '2026-09-28', headSha(dir)!);
    ok.save();
    const free = await run(dir, planFile, { dryRun: true });
    expect(free.code).toBe(0);
    expect(free.out.join('\n')).toMatch(/L2 « Second » — prêt/);
    expect(free.out.join('\n')).toMatch(/simulation/);
  });

  it('R12 — un lot relu NON conforme à son dernier commit n\'est pas prêt : deliver --sha refuse, --dry-run le dit', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.recordReview('L1', 'non conforme : 1 bloquant', '2026-09-28', headSha(dir)!);
    plan.save();
    const r = await run(dir, planFile);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/L1.*relu non conforme/);
    expect(r.execs).toEqual([]);
    const d = await run(dir, planFile, { dryRun: true });
    expect(d.code).toBe(2);
    expect(d.out.join('\n')).toMatch(/L1 « Premier » — en cours, relu non conforme/);
    expect(d.out.join('\n')).not.toMatch(/prêt/);
  });

  it('R13 — isNonConformingVerdict : FR et EN, « conforme » dans « non conforme » ne compte pas', () => {
    for (const t of ['non conforme : 1 bloquant', 'Non conforme', 'non-conforme', 'not compliant', 'Non-compliant (2 majeurs)']) expect(isNonConformingVerdict(t), t).toBe(true);
    for (const t of ['conforme', 'conforme après 1 correction', 'Conforme — 0 bloquant', 'compliant', 'compliant after 1 fix']) expect(isNonConformingVerdict(t), t).toBe(false);
  });

  it('R4 — l\'intervalle part de la dernière livraison : un lot en cours dont les commits sont avant elle ne bloque plus', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    appendDelivery(sharedStateDir(dir), '2026-09-28', headSha(dir)!);
    work(dir, 'feat(L2): deux', 'b.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.setStatus('L2', 'done', '2026-09-28', { force: true });
    plan.save();
    const r = await run(dir, planFile);
    expect(r.code).toBe(0);
  });

  it('R4b — une livraison journalisée qui n\'est pas dans l\'histoire du sha laisse toute l\'histoire à contrôler', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    push(dir);
    appendDelivery(sharedStateDir(dir), '2026-09-28', '0123456789abcdef0123456789abcdef01234567');
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.save();
    expect((await run(dir, planFile)).code).toBe(2);
  });

  it('R5 — sans --sha (HEAD), la garde ne joue pas', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.save();
    git(dir, 'add', '.');
    commit(dir, 'plan: L1 démarré');
    push(dir);
    const r = await run(dir, planFile, { sha: undefined });
    expect(r.code).toBe(0);
  });

  it('R6 — pendant une vague, la garde de la vague (cli) décide : deliver ne rejoue pas celle-ci', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.save();
    expect((await run(dir, planFile, { duringWave: true })).code).toBe(0);
  });

  it('R7 — sans plan, ou pour un commit qui cite un lot que le plan ne connaît pas, rien ne bloque', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L99): inconnu', 'a.txt');
    push(dir);
    expect((await run(dir, planFile)).code).toBe(0);
    expect((await run(dir, null)).code).toBe(0);
  });

  it('R8 — un lot abandonné (dropped) ne bloque pas ; un lot à faire (todo) avec des commits bloque', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    work(dir, 'feat(L2): deux', 'b.txt');
    push(dir);
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'dropped', '2026-09-28');
    plan.save();
    const r = await run(dir, planFile);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/L2.*à faire/);
    expect(r.err.join('\n')).not.toMatch(/L1/);
  });

  it('R9 — un commit de plan seul sous le lot ne compte pas (aucun travail à relire)', async () => {
    const { dir, planFile } = repo();
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.save();
    git(dir, 'add', '.');
    commit(dir, 'plan: L1 démarré');
    push(dir);
    expect((await run(dir, planFile)).code).toBe(0);
  });

  it('R10 — la couverture de la revue se juge jusqu\'au sha livré : un fix(L1) au-dessus d\'un lot relu à X ne bloque pas `--sha X`', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    const x = headSha(dir)!;
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.recordReview('L1', 'conforme', '2026-09-28', x);
    plan.save();
    work(dir, 'fix(L1): après la revue', 'c.txt');
    push(dir);
    const r = await run(dir, planFile, { sha: x });
    expect(r.err.join('\n')).toBe('');
    expect(r.code).toBe(0);
    // Le sha de tête, lui, porte le commit non relu : refus.
    expect((await run(dir, planFile)).code).toBe(2);
  });

  it('R11 — un commit du lot non relu SOUS le sha bloque toujours, même si la revue est plus haut', async () => {
    const { dir, planFile } = repo();
    work(dir, 'feat(L1): un', 'a.txt');
    work(dir, 'feat(L1): deux', 'b.txt');
    const mid = headSha(dir)!;
    work(dir, 'feat(L1): trois', 'c.txt');
    const plan = Plan.load(planFile);
    plan.setStatus('L1', 'doing', '2026-09-28');
    plan.recordReview('L1', 'conforme', '2026-09-28', headSha(dir)!);
    plan.save();
    push(dir);
    // Revue au sommet : les commits sous mid sont couverts.
    expect((await run(dir, planFile, { sha: mid, dryRun: true })).code).toBe(0);
    // Revue au premier commit : le deuxième (sous mid) n'est pas couvert.
    const first = execFileSync('git', ['rev-parse', 'HEAD~2'], { cwd: dir }).toString().trim();
    const p2 = Plan.load(planFile);
    p2.recordReview('L1', 'conforme', '2026-09-28', first);
    p2.save();
    const r = await run(dir, planFile, { sha: mid });
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/L1.*relu avant 1 commit/);
  });
});
