import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { commit, gitRepo } from './helpers.js';

const LONG = `Un titre très long ${'mot '.repeat(70)}fin`;
const SHORT = 'Titre court';

async function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-30' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-30T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
}

/** Un dépôt avec L1 (titre long, démarré), L2 (titre court, démarré), une sous-tâche L1/t1, le plan commité. */
async function project(): Promise<string> {
  const dir = gitRepo();
  await raf(dir, 'init', '--no-hook');
  await raf(dir, 'add', LONG);
  await raf(dir, 'add', SHORT);
  await raf(dir, 'add', '--parent', 'L1', 'Sous-tâche');
  await raf(dir, 'start', 'L1');
  await raf(dir, 'start', 'L2');
  commit(dir, 'chore: plan');
  return dir;
}

const sixVerbs: [string, (dir: string, v: string[]) => Promise<Awaited<ReturnType<typeof raf>>>][] = [
  ['done', (d, v) => raf(d, 'done', 'L1', '--force', ...v)],
  ['ux', (d, v) => raf(d, 'ux', 'L1', 'verdict ok', ...v)],
  ['review', (d, v) => raf(d, 'review', 'L1', 'verdict ok', ...v)],
  ['note', (d, v) => raf(d, 'note', 'L1', 'une note', ...v)],
  ['move', (d, v) => raf(d, 'move', 'L1', '--after', 'L2', ...v)],
  ['public', (d, v) => raf(d, 'public', 'L1', 'titre public', ...v)],
];

describe('(L453) raf discret : le titre complet d\'un lot ne revient pas à chaque commande', () => {
  it.each(sixVerbs)('R1 — raf %s n\'imprime pas le titre complet du lot touché', async (_nom, play) => {
    const dir = await project();
    const r = await play(dir, []);
    expect(r.code).toBe(0);
    expect(r.all).not.toContain(LONG);
    expect(r.all).not.toContain('mot mot mot mot mot mot mot mot mot mot mot mot');
  });

  it.each(sixVerbs)('R2 — raf %s --verbose imprime une ligne « id état titre entier »', async (_nom, play) => {
    const dir = await project();
    const r = await play(dir, ['--verbose']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^L[12]  (doing|done)  ${LONG.slice(0, 20)}`, 'm'));
    expect(r.out).toContain(LONG);
  });

  it('R2 — --verbose sur une sous-tâche n\'invente rien : pas de ligne de lot, pas d\'erreur', async () => {
    const dir = await project();
    const r = await raf(dir, 'note', 'L1/t1', 'une note', '--verbose');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  it('R3 — le hook post-commit coupe le titre à 60 caractères, id et état gardés', async () => {
    const dir = await project();
    commit(dir, 'feat(L1): travail');
    const r = await raf(dir, 'hook', 'post-commit');
    const line = r.err.split('\n').find((l) => l.startsWith('raf: L1 '))!;
    expect(line).toBe(`raf: L1 (doing) ${LONG.slice(0, 59)}…`);
    expect(line.slice('raf: L1 (doing) '.length)).toHaveLength(60);
  });

  it('R3 — un titre de 60 caractères exactement est gardé entier, un de 61 est coupé', async () => {
    const dir = await project();
    await raf(dir, 'title', 'L1', 'a'.repeat(60));
    await raf(dir, 'title', 'L2', 'b'.repeat(61));
    commit(dir, 'feat(L1, L2): travail');
    const r = await raf(dir, 'hook', 'post-commit');
    expect(r.err).toContain(`raf: L1 (doing) ${'a'.repeat(60)}\n`);
    expect(r.err).toContain(`raf: L2 (doing) ${'b'.repeat(59)}…`);
  });

  it('R3 — un titre court reste tel quel', async () => {
    const dir = await project();
    commit(dir, 'feat(L2): travail');
    expect((await raf(dir, 'hook', 'post-commit')).err).toContain(`raf: L2 (doing) ${SHORT}`);
  });

  it('R4 — hook post-commit --verbose rend le titre entier', async () => {
    const dir = await project();
    commit(dir, 'feat(L1): travail');
    expect((await raf(dir, 'hook', 'post-commit', '--verbose')).err).toContain(`raf: L1 (doing) ${LONG}`);
  });

  it('R5 — le rappel « plan non commité » garde sa commande, avec ou sans --verbose', async () => {
    for (const v of [[], ['--verbose']]) {
      const dir = await project();
      const r = await raf(dir, 'done', 'L2', '--force', ...v);
      expect(r.out).toContain('L2 → done');
      expect(r.out).toContain('plan non commité');
      expect(r.out).toContain("git add -- .cadence/raf.yaml && git commit -m 'plan: L2 terminé' -- .cadence/raf.yaml");
    }
  });
});
