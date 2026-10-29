import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedStateDir } from '../src/state.js';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { INTEGRATION_LOCK } from '../src/orchestrate/integrate.js';
import { cadenceHome, liveSlots, liveWaves } from '../src/orchestrate/registry.js';
import { claudeOut, commitFile, git, reviewReport, workReport } from './orchestrate-harness.js';
import { branches, conflictWave, fake, inWorktree, lotOf, meeting, planOf, run, setup, sharedFile, store, subjects, writes } from './orchestrate-worktree-harness.js';
import { parseOrchestrateArgs } from '../src/orchestrate/command.js';
import { tempDir } from './helpers.js';

// L279 — C2 : l'intégration d'un lot prêt à la branche du dépôt (R4 à R9, R17, R22 à R25), de bout en bout.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
const CHECK = 'if [ -f L1.txt ] && [ -f L2.txt ]; then echo "FAIL combo-des-deux-lots"; exit 1; fi\necho run >> "$CHECK_LOG"\n';

describe('R4 / R22 — un lot qui dépend d\'un autre attend son intégration', () => {
  it('R4 — B dépend de A : le worktree de B naît après l\'intégration de A et contient ses commits', async () => {
    const { parent, repo } = setup([{ title: 'a' }, { title: 'b', after: ['L1'] }]);
    const seen: Record<string, string> = {};
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        seen[lot] = `${branches(repo)}|${existsSync(join(cwd, 'L1.txt'))}`;
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    // quand L1 joue, L2 n'a ni branche ni worktree ; quand L2 joue, le commit de L1 est dans son worktree (R22 : L1 est ready seulement une fois intégré)
    expect(seen.L1).toContain('a--L1');
    expect(seen.L1).not.toContain('a--L2');
    expect(seen.L2.endsWith('|true')).toBe(true);
    expect(f.calls.filter((c) => c.lot === 'L2')[0]!.cwd).not.toBe(f.calls.filter((c) => c.lot === 'L1')[0]!.cwd);
  });
  it('R4 — A rendu sur conflit : B est rendu « dépendance non prête dans la vague : L1 »', async () => {
    const { parent, repo } = setup([{ title: 'a' }, { title: 'c' }, { title: 'b', after: ['L1'] }]);
    const f = fake({ implement: sharedFile(repo) });
    await run(parent, ['a:L1', 'a:L2', 'a:L3', '--max-sessions', '3'], f);
    expect(store(parent).readLot('a', 'L3')!.outcome).toBe('dépendance non prête dans la vague : L1');
    expect(branches(repo)).not.toContain('a--L3'); // B n'a jamais eu de worktree
  });
  it('R22 — intégration de A en conflit : A n\'est jamais ready, B est rendu « dépendance non prête dans la vague : L1 »', async () => {
    const { parent, repo } = setup([{ title: 'a' }, { title: 'c' }, { title: 'b', after: ['L1'] }]);
    const f = fake({ implement: sharedFile(repo) }); // L2 s'intègre avant L1, qui se heurte à lui
    const r = await run(parent, ['a:L1', 'a:L2', 'a:L3', '--max-sessions', '3'], f);
    expect(r.code).toBe(1);
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    const a = store(parent).readLot('a', 'L1')!;
    expect(a.status).toBe('handed-back');
    expect(a.next).toBe('integrate');
    const b = store(parent).readLot('a', 'L3')!;
    expect(b.status).toBe('handed-back');
    expect(b.outcome).toBe('dépendance non prête dans la vague : L1');
    expect(f.calls.some((c) => c.lot === 'L3')).toBe(false);
  });
  it('R22 — l\'état d\'un lot ne contient aucun champ nouveau après intégration', async () => {
    const plain = setup([{ title: 'un' }, { title: 'deux' }], '');
    await run(plain.parent, ['a:L1', 'a:L2'], fake());
    const tree = setup();
    await run(tree.parent, ['a:L1', 'a:L2'], fake());
    const keys = (parent: string) => Object.keys(store(parent).readLot('a', 'L2')!).sort();
    expect(keys(tree.parent)).toEqual(keys(plain.parent));
  });
});

describe('R5 — un worktree impossible ne rend que son lot', () => {
  it('R5 — branche cadence/<vague>/<lot> déjà présente et non reconnue : lot rendu avec la cause, l\'autre lot joue', async () => {
    const { parent, repo } = setup();
    git(repo, 'branch', 'cadence/2026-10-04-1412/a--L1');
    const f = fake();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(1);
    const a = store(parent).readLot('a', 'L1')!;
    expect(a.status).toBe('handed-back');
    expect(a.outcome).toMatch(/^worktree impossible : la branche cadence\/2026-10-04-1412\/a--L1 existe déjà/);
    expect(r.out).toMatch(/orchestrate : a:L1 : worktree impossible : la branche/);
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    expect(f.calls.some((c) => c.lot === 'L1')).toBe(false);
    expect(git(repo, 'branch', '--list', 'cadence/2026-10-04-1412/a--L1')).toContain('a--L1'); // la branche d'un autre n'est pas touchée
  });
});

describe('R6 — un conflit au rebase d\'intégration est rendu au lead', () => {
  const conflict = conflictWave;
  it('R6 — deux lots modifient la même ligne : le second est handed-back avec le fichier en conflit', async () => {
    const { parent, r } = await conflict();
    const a = store(parent).readLot('a', 'L1')!;
    expect(a.status).toBe('handed-back');
    expect(a.next).toBe('integrate');
    expect(a.outcome).toMatch(/^intégration impossible : conflit en rebasant cadence\/2026-10-04-1412\/a--L1 sur main \(fichiers : shared\.txt\) ; worktree conservé : .*worktrees\/a--L1$/);
    expect(r.out).toContain('a:L1 → handed-back — intégration impossible : conflit en rebasant');
  });
  it('R6 — la sortie cite la commande qui reprend le lot rendu à l\'intégration', async () => {
    const { r } = await conflict();
    expect(r.out).toContain('orchestrate : a:L1 : rendu à l\'intégration : reprise par cadence orchestrate --resume --wave 2026-10-04-1412 --integrate a:L1');
  });
  it('L309 — la commande de reprise imprimée désigne la vague (id qui ressemble à un lot : suite2) et n\'est pas lue comme un lot à lancer', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }]);
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2', '--wave', 'suite2'], fake({ implement: sharedFile(parent + '/a') }));
    const printed = /reprise par (cadence orchestrate [^\n]*)/.exec(r.out)![1];
    expect(parseOrchestrateArgs(printed.replace('cadence orchestrate ', '').split(' '))).toMatchObject({ resume: 'suite2', lots: [], integrate: [{ project: 'a', lot: 'L1' }] });
  });
  it('R6 — après le conflit, la branche du dépôt est au même sha qu\'avant et le worktree du lot est intact', async () => {
    const { parent, repo } = await conflict();
    expect(subjects(repo).some((s) => s.startsWith('feat(L1)'))).toBe(false);
    expect(subjects(repo)[0]).toBe('plan: L2 revue de code enregistrée (orchestrate 2026-10-04-1412)'); // rien n'a été posé après l'intégration de L2
    const dir = join(store(parent).dir, 'worktrees', 'a--L1');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'cadence/2026-10-04-1412/a--L1'));
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('feat(L1): travail');
  });
  it('R6 — aucun rebase en cours dans le worktree après l\'échec', async () => {
    const { parent } = await conflict();
    const gitDir = git(join(store(parent).dir, 'worktrees', 'a--L1'), 'rev-parse', '--git-dir');
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
  });
  it('R6 — aucune session n\'est lancée pour résoudre le conflit', async () => {
    const { f } = await conflict();
    expect(f.calls.filter((c) => c.lot === 'L1').map((c) => c.kind)).toEqual(['implement', 'review']);
  });
  it('R6 — le conflit ne porte jamais sur le plan : la branche d\'un lot ne contient aucun commit de plan (R21)', async () => {
    const { parent, repo } = await conflict();
    const base = git(repo, 'merge-base', 'main', 'cadence/2026-10-04-1412/a--L1');
    const own = git(repo, 'log', '--format=%s', `${base}..cadence/2026-10-04-1412/a--L1`).split('\n');
    expect(own).toEqual(['feat(L1): travail']);
    expect(store(parent).readLot('a', 'L1')!.outcome).not.toMatch(/raf\.yaml/);
  });
});

describe('R7 — tests et build rejoués au sommet rebasé', () => {
  const files = { 'check.sh': CHECK };
  it('R7 — rebase non vide puis test rouge au sommet : branche du dépôt inchangée, lot rendu', async () => {
    process.env.CHECK_LOG = join(tempDir(), 'checks.log');
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', files);
    const f = fake({ implement: writes(meeting(2)) });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(1);
    const lots = [store(parent).readLot('a', 'L1')!, store(parent).readLot('a', 'L2')!];
    const red = lots.filter((l) => l.status === 'handed-back');
    expect(red).toHaveLength(1); // le premier intégré passe, le second se casse sur lui
    expect(red[0].next).toBe('integrate');
    expect(red[0].outcome).toMatch(/^intégration refusée : tests rouges au sommet intégré \(sh check\.sh en échec \(code 1\)/);
    expect(red[0].outcome).toMatch(/branche du dépôt inchangée, worktree conservé : /);
    expect(subjects(repo).filter((s) => s.startsWith('feat('))).toHaveLength(1);
    expect(subjects(repo)[0]).toMatch(/^plan: L\d revue de code enregistrée/);
  });
  it('L328 R2 — rouge au sommet intégré une seule fois (charge) : relancé, vert la seconde fois, le lot est intégré et la relance est tracée', async () => {
    const mark = join(tempDir(), 'deja-rouge-une-fois');
    process.env.FLAKY_MARK = mark;
    const flaky = 'if [ -f L1.txt ] && [ -f L2.txt ] && [ ! -f "$FLAKY_MARK" ]; then touch "$FLAKY_MARK"; echo "FAIL rouge-de-charge"; exit 1; fi\n';
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', { 'check.sh': flaky });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.code).toBe(0);
    expect(existsSync(mark)).toBe(true); // le rouge a bien eu lieu
    for (const id of ['L1', 'L2']) expect(store(parent).readLot('a', id)!.status).toBe('ready');
    expect(r.out).toMatch(/a:L\d tests rouges au sommet intégré, relancés une fois/);
    const warned = ['L1', 'L2'].map((id) => store(parent).readLot('a', id)!).filter((l) => l.warnings.some((w) => /rouge au sommet intégré, vert à la relance/.test(w)));
    expect(warned).toHaveLength(1);
  });
  it('L328 R2 — rouge les deux fois : lot rendu, branche du dépôt inchangée, une seule relance', async () => {
    const log = join(tempDir(), 'runs.log');
    process.env.CHECK_LOG = log;
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', { 'check.sh': 'if [ -f L1.txt ] && [ -f L2.txt ]; then echo combo >> "$CHECK_LOG"; fi\n' + CHECK });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.code).toBe(1);
    const red = ['L1', 'L2'].map((id) => store(parent).readLot('a', id)!).filter((l) => l.status === 'handed-back');
    expect(red).toHaveLength(1);
    expect(red[0].outcome).toMatch(/^intégration refusée : tests rouges au sommet intégré/);
    expect(subjects(repo).filter((s) => s.startsWith('feat('))).toHaveLength(1);
    // le sommet qui contient les deux lots est joué deux fois : le contrôle, puis une seule relance
    expect(readFileSync(log, 'utf8').split('\n').filter((x) => x === 'combo')).toHaveLength(2);
  });
  it('L328 R3 — le refus nomme les tests rouges (la sortie du dernier essai), pas seulement la commande', async () => {
    process.env.CHECK_LOG = join(tempDir(), 'checks.log');
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', { 'check.sh': CHECK });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    const red = ['L1', 'L2'].map((id) => store(parent).readLot('a', id)!).filter((l) => l.status === 'handed-back');
    expect(red[0].outcome).toContain('FAIL combo-des-deux-lots');
  });
  it('R7 — fast-forward pur : aucune relance des tests', async () => {
    const log = join(tempDir(), 'checks.log');
    process.env.CHECK_LOG = log;
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', files);
    const f = fake();
    // plafond 1 : chaque lot part du sommet que l'autre vient de laisser, rien ne bouge entre son départ et son intégration
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], f);
    expect(r.code).toBe(0);
    const runs = readFileSync(log, 'utf8').trim().split('\n').length;
    expect(runs).toBe(f.calls.filter((c) => c.kind === 'implement').length); // une seule fois par écriture, pas à l'intégration
  });
  it('R7 — rouge présent au sha de base : ne rend pas le lot', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\ntest: sh check.sh', { 'check.sh': 'echo "FAIL test-deja-rouge"\nexit 1\n' });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.code).toBe(0);
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
});

describe('R8 — l\'arbre du lead n\'est jamais écrasé', () => {
  it('R8 — arbre du lead modifié pendant la vague : lot rendu, fichiers listés, arbre inchangé', async () => {
    const { parent, repo } = setup();
    const meet = meeting(2);
    const f = fake({
      implement: async (cwd, brief) => {
        await meet();
        if (lotOf(brief) === 'L1') appendFileSync(join(repo, 'base.txt'), 'édité par le lead\n');
        const lot = lotOf(brief);
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(1);
    for (const id of ['L1', 'L2']) {
      const l = store(parent).readLot('a', id)!;
      expect(l.status).toBe('handed-back');
      expect(l.next).toBe('integrate');
      expect(l.outcome).toMatch(/^intégration refusée : arbre du dépôt modifié \(base\.txt\) ; branche conservée : cadence\/2026-10-04-1412\/a--L\d$/);
    }
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('base\nédité par le lead\n');
    expect(git(repo, 'status', '--porcelain')).toBe('M base.txt');
    expect(subjects(repo).some((s) => s.startsWith('feat('))).toBe(false);
  });
});

describe('R9 / R17 — verdict reporté ou revue courte après un rebase', () => {
  it('R9 — rebase non vide, patch-id identique, tests et build verts : verdict au sha intégré, trace avec ancien et nouveau sha', async () => {
    const { parent, repo } = setup();
    const f = fake({ implement: writes(meeting(2)) });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    const reported = ['L1', 'L2'].map((id) => planOf(repo).lot(id).review!).filter((v) => v.reporte);
    expect(reported.length).toBeGreaterThan(0);
    for (const v of reported) {
      expect(v.reporte!.de).not.toBe(v.reporte!.vers);
      expect(v.commit).toBe(v.reporte!.vers); // R18 : le verdict désigne le dernier commit de travail intégré
      expect(v.reporte!.patchId).toMatch(/^[0-9a-f]{40}$/);
      expect(git(repo, 'merge-base', '--is-ancestor', v.reporte!.vers, 'main')).toBe('');
      expect(() => git(repo, 'merge-base', '--is-ancestor', v.reporte!.de, 'main')).toThrow(); // l'ancien sha relu n'est plus dans la branche
    }
    expect(r.out).toMatch(/a:L\d verdict reporté : [0-9a-f]{7} → [0-9a-f]{7} \(patch-id identique\)/);
  });
  it('L397 R9 — rebase non vide : la porte enregistrée porte le sommet rebasé et son arbre, que verify --gate reprend', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\nbuild: "true"');
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.code).toBe(0);
    const rebased = ['L1', 'L2'].map((id) => store(parent).readLot('a', id)!).filter((l) => planOf(repo).lot(l.lot).review!.reporte);
    expect(rebased.length).toBeGreaterThan(0);
    for (const l of rebased) {
      expect(l.checks!.head).toBe(planOf(repo).lot(l.lot).review!.commit);
      expect(git(repo, 'merge-base', '--is-ancestor', l.checks!.head, 'main')).toBe('');
      expect(l.checks!.tree).toBe(git(repo, 'rev-parse', `${l.checks!.head}^{tree}`));
    }
  });
  it('R17 — patch-id identique : aucune revue jouée', async () => {
    const { parent } = setup();
    const f = fake({ implement: writes(meeting(2)) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(f.calls.filter((c) => c.kind === 'review-small')).toHaveLength(0);
    expect(f.calls.filter((c) => c.kind === 'review')).toHaveLength(2); // les revues d'origine, rien de plus
  });
  it('R9 — fast-forward pur : le sha du verdict est celui relu, aucune trace de report', async () => {
    const { parent, repo } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake());
    expect(r.code).toBe(0);
    for (const id of ['L1', 'L2']) {
      const v = planOf(repo).lot(id).review!;
      expect(v.reporte).toBeUndefined();
      expect(v.commit).toBe(store(parent).readLot('a', id)!.code!.head);
    }
    expect(r.out).not.toContain('verdict reporté');
  });
  it('R9 — patch-id identique mais build rouge : pas de report, lot rendu', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true\nbuild: sh build.sh', { 'build.sh': 'if [ -f L1.txt ] && [ -f L2.txt ]; then echo "build cassé"; exit 1; fi\n' });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.code).toBe(1);
    const red = ['L1', 'L2'].map((id) => store(parent).readLot('a', id)!).filter((l) => l.status === 'handed-back');
    expect(red).toHaveLength(1);
    expect(red[0].outcome).toMatch(/tests rouges au sommet intégré \(sh build\.sh en échec/);
    expect(planOf(repo).lot(red[0].lot).review).toBeUndefined();
  });
  const f5 = { 'f.txt': lines(12) };
  const edit = (cwd: string, n: number, lot: string) => {
    writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
    git(cwd, 'add', '--', 'f.txt');
    git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
    return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
  };
  const near = (over: Parameters<typeof fake>[0] = {}) =>
    fake({
      implement: async (cwd, brief) => {
        await meeting(2)();
        const lot = lotOf(brief);
        return edit(cwd, lot === 'L1' ? 4 : 7, lot); // deux lignes voisines : le rebase passe, le contexte de l'un contient la ligne de l'autre
      },
      ...over,
    });
  it('R17 — patch-id différent : une revue review-small est jouée sur le diff rebasé avant l\'avance', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', f5);
    const f = near();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    const small = f.calls.filter((c) => c.kind === 'review-small');
    expect(small).toHaveLength(1);
    expect(inWorktree(small[0].cwd)).toBe(true);
    expect(small[0].brief).toContain('Integration re-review');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toContain('l4 par L1');
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toContain('l7 par L2');
  });
  it('R17 — un lot passé par la passe des mineurs reçoit quand même le gabarit d\'intégration (pas review-recheck)', async () => {
    const { parent } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', f5);
    const seenMinors = new Set<string>();
    const f = near({
      review: async (_cwd, brief) => {
        const lot = lotOf(brief);
        if (seenMinors.has(lot)) return claudeOut(reviewReport());
        seenMinors.add(lot);
        return claudeOut(reviewReport({ mineurs: 1, constats: [{ gravite: 'mineur', fichier: 'f.txt', ligne: 1, texte: 'nommage' }], verdict: 'conforme, un mineur' }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(0);
    const small = f.calls.filter((c) => c.kind === 'review-small');
    const integ = small.filter((c) => c.brief.includes('Integration re-review'));
    expect(integ).toHaveLength(1);
    expect(f.calls.some((c) => c.kind === 'fix' && c.lot === integ[0].lot)).toBe(true); // ce lot a bien eu sa passe des mineurs
    expect(integ[0].brief).not.toContain('Check that the minor findings fixed are fixed');
    expect(small.filter((c) => c.lot === integ[0].lot).length).toBeGreaterThanOrEqual(2); // revue de rappel puis revue d'intégration
  });
  it('R17 — revue sans constat : verdict au sha intégré, branche avancée', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', f5);
    const f = near({ 'review-small': async () => claudeOut(reviewReport({ verdict: 'rebase sans dégât' })) });
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const small = f.calls.find((c) => c.kind === 'review-small')!;
    const lot = planOf(repo).lot(small.lot);
    expect(lot.review!.verdict).toContain('revue courte du diff rebasé');
    expect(lot.review!.verdict).toContain('rebase sans dégât');
    expect(lot.review!.reporte).toBeUndefined(); // le patch-id a changé : rien n'est reporté, une revue a eu lieu
    expect(lot.review!.commit).toBe(git(repo, 'log', '--format=%H', '-1', `--grep=feat(${small.lot})`, 'main'));
    expect(store(parent).readLot('a', small.lot)!.status).toBe('ready');
  });
  it('R17 — un constat bloquant ou majeur : lot rendu, branche du dépôt inchangée, worktree conservé', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', f5);
    const f = near({ 'review-small': async () => claudeOut(reviewReport({ majeurs: 1, constats: [{ gravite: 'majeur', fichier: 'f.txt', ligne: 5, texte: 'ligne cassée par le rebase' }], verdict: 'non conforme' })) });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    expect(r.code).toBe(1);
    const small = f.calls.find((c) => c.kind === 'review-small')!;
    const l = store(parent).readLot('a', small.lot)!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('integrate');
    expect(l.outcome).toMatch(/^intégration refusée : revue courte du diff rebasé : 1 constat\(s\) bloquant\(s\) ou majeur\(s\) ; branche du dépôt inchangée, worktree conservé : /);
    expect(subjects(repo).filter((s) => s.startsWith('feat('))).toHaveLength(1);
    expect(existsSync(join(store(parent).dir, 'worktrees', `a--${small.lot}`))).toBe(true);
  });
});

describe('R24 / R8 — le dépôt du lead est revérifié juste avant l\'avance et l\'écriture du plan (L299)', () => {
  const f5 = { 'f.txt': lines(12) };
  const edit = (cwd: string, n: number, lot: string) => {
    writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
    git(cwd, 'add', '--', 'f.txt');
    git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
    return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
  };
  // deux lots voisins : le second à s'intégrer est rebasé avec un patch-id différent, donc passe par une revue courte (le temps où le lead peut bouger)
  async function movesDuringShortReview(how: (repo: string) => void) {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], 'worktrees: true', f5);
    const f = fake({
      implement: async (cwd, brief) => {
        await meeting(2)();
        const lot = lotOf(brief);
        return edit(cwd, lot === 'L1' ? 4 : 7, lot);
      },
      'review-small': async () => {
        how(repo);
        return claudeOut(reviewReport({ verdict: 'rebase sans dégât' }));
      },
    });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    const small = f.calls.find((c) => c.kind === 'review-small')!;
    return { parent, repo, r, lot: small.lot };
  }
  it('R24 — le lead passe sur une autre branche pendant la revue courte : ni fast-forward ni commit de plan, lot rendu next: integrate', async () => {
    const { parent, repo, r, lot } = await movesDuringShortReview((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    expect(r.code).toBe(1);
    const l = store(parent).readLot('a', lot)!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('integrate');
    expect(l.outcome).toMatch(/^intégration refusée : le dépôt est sur autre et non sur main ; branche du dépôt inchangée, worktree conservé : /);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('autre');
    expect(subjects(repo).some((s) => s.startsWith(`feat(${lot})`))).toBe(false);
    expect(subjects(repo).some((s) => s.startsWith(`plan: ${lot} revue`))).toBe(false);
    expect(git(repo, 'log', '--format=%s', 'main').split('\n').some((s) => s.startsWith(`feat(${lot})`))).toBe(false); // la branche de départ n'a pas avancé
  });
  it('R8 — le lead modifie un fichier suivi pendant la revue courte : ni fast-forward ni commit de plan, lot rendu next: integrate', async () => {
    const { parent, repo, r, lot } = await movesDuringShortReview((repo) => appendFileSync(join(repo, 'base.txt'), 'sale\n'));
    expect(r.code).toBe(1);
    const l = store(parent).readLot('a', lot)!;
    expect(l.status).toBe('handed-back');
    expect(l.next).toBe('integrate');
    expect(l.outcome).toMatch(/^intégration refusée : arbre du dépôt modifié \(base\.txt\) ; branche du dépôt inchangée, worktree conservé : /);
    expect(subjects(repo).some((s) => s.startsWith(`feat(${lot})`))).toBe(false);
    expect(subjects(repo).some((s) => s.startsWith(`plan: ${lot} revue`))).toBe(false);
  });
  it('L303 — refus tardif puis --resume --integrate : la revue courte est rejouée, mais son verdict n\'est écrit qu\'une fois dans celui du plan', async () => {
    const { parent, repo, lot } = await movesDuringShortReview((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    expect(store(parent).readLot('a', lot)!.verdict).toContain('revue courte du diff rebasé');
    git(repo, 'checkout', '-q', 'main');
    const again = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake({ 'review-small': () => claudeOut(reviewReport({ verdict: 'seconde lecture' })) }));
    expect(again.err).toBe('');
    expect(store(parent).readLot('a', lot)!.status).toBe('ready');
    const verdict = planOf(repo).lot(lot).review!.verdict;
    expect(verdict.split('revue courte du diff rebasé')).toHaveLength(2);
    expect(verdict).toContain('seconde lecture');
    expect(verdict).not.toContain('rebase sans dégât');
  });
  /** Une autre vague vivante (un `sleep`) tient le dépôt ; `after` ms plus tard elle finit (le processus meurt) — jamais si `after` est null. */
  async function otherWaveHolds(repo: string, after: number | null) {
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: sleeper.pid, wave: 'autre-vague', started: '2026-10-04T00:00:00Z' }));
    if (after !== null) setTimeout(() => sleeper.kill(), after);
    return sleeper;
  }
  it('L443 — --resume --integrate dont le dépôt est tenu par une autre vague attend sa fin, le dit, puis intègre au lieu de sortir en 2', async () => {
    const { parent, repo, lot } = await movesDuringShortReview((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    git(repo, 'checkout', '-q', 'main');
    const sleeper = await otherWaveHolds(repo, 400);
    try {
      const again = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake({ 'review-small': () => claudeOut(reviewReport({ verdict: 'seconde lecture' })) }), { repoWait: { waitMs: 20_000, pollMs: 50 } });
      expect(again.err).toMatch(/^orchestrate : verrou de dépôt périmé retiré \(a, pid \d+ mort\)$/); // le verrou de l'autre vague, tombé avec son processus, est repris
      expect(again.code).toBe(0);
      expect(again.out.match(/a : tenu par la vague autre-vague \(pid \d+\) : attente de sa fin/g)).toHaveLength(1);
      expect(store(parent).readLot('a', lot)!.status).toBe('ready');
    } finally {
      sleeper.kill();
    }
  });
  it('L443 — pendant l\'attente, la reprise est inscrite parmi les vagues vivantes (le garde d\'une seconde reprise la voit), et l\'inscription tombe quand l\'attente finit', async () => {
    const { parent, repo, lot } = await movesDuringShortReview((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    git(repo, 'checkout', '-q', 'main');
    const sleeper = await otherWaveHolds(repo, null);
    const during: string[][] = [];
    const probe = setInterval(() => during.push(liveWaves(cadenceHome()).map((w) => w.wave)), 40);
    try {
      const again = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 400, pollMs: 50 } });
      expect(again.code).toBe(2);
      expect(during.some((w) => w.includes('2026-10-04-1412'))).toBe(true);
      expect(liveWaves(cadenceHome())).toHaveLength(0);
    } finally {
      clearInterval(probe);
      sleeper.kill();
    }
  });
  it('L443 — l\'autre vague tient le dépôt au-delà de l\'attente : refus en 2 avec le texte habituel, le lot reste rendu', async () => {
    const { parent, repo, lot } = await movesDuringShortReview((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    git(repo, 'checkout', '-q', 'main');
    const sleeper = await otherWaveHolds(repo, null);
    try {
      const again = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${lot}`], fake(), { repoWait: { waitMs: 300, pollMs: 50 } });
      expect(again.code).toBe(2);
      expect(again.err).toMatch(new RegExp(`orchestrate : a : une orchestration y est déjà en cours \\(autre-vague, pid ${sleeper.pid}\\)`));
      expect(store(parent).readLot('a', lot)!.status).toBe('handed-back');
    } finally {
      sleeper.kill();
    }
  });
});

describe('R23 — le verdict est écrit après l\'avance, dans un commit de plan seul', () => {
  it('R23 — après report, la branche du dépôt se termine par un commit de plan seul et `vers` est le dernier commit de travail intégré ; la branche du lot ne porte aucun commit de plan', async () => {
    const { parent, repo } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    expect(r.code).toBe(0);
    expect(subjects(repo)[0]).toMatch(/^plan: L\d revue de code enregistrée/);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('.cadence/raf.yaml');
    for (const id of ['L1', 'L2']) {
      const v = planOf(repo).lot(id).review!;
      expect(git(repo, 'show', '-s', '--format=%s', v.commit!)).toBe(`feat(${id}): travail`);
      // aucun commit de travail ne touche le plan
      expect(git(repo, 'log', '--format=%h', '--grep', `^feat(${id})`, '--', '.cadence/raf.yaml')).toBe('');
    }
  });
  it('R23 — raf done après report : unreviewedWork vaut 0', async () => {
    const { parent, repo } = setup();
    await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    const { unreviewedWork } = await import('../src/audit.js');
    for (const id of ['L1', 'L2']) expect(unreviewedWork(planOf(repo), repo, id)).toBe(0);
  });
  it('R23 — le sha cité dans la trace du journal est `vers`, pas le tête de branche', async () => {
    const { parent, repo } = setup();
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], fake({ implement: writes(meeting(2)) }));
    for (const id of ['L1', 'L2']) {
      const v = planOf(repo).lot(id).review!;
      if (!v.reporte) continue;
      expect(r.out).toContain(`a:${id} verdict reporté : ${v.reporte.de.slice(0, 7)} → ${v.reporte.vers.slice(0, 7)}`);
      expect(v.reporte.vers).not.toBe(git(repo, 'rev-parse', 'HEAD'));
    }
  });
  it('L303 — le lead change de branche entre l\'avance et l\'écriture du plan : le contrôle de branche de writeVerdict rend le lot, aucun commit de plan', async () => {
    const { parent, repo } = setup();
    // un hook post-merge du lead passe sur une autre branche juste après l'avance : le premier contrôle de départ et le contrôle tardif sont déjà passés
    // une session à la fois : L1 va de l'avance à l'écriture du plan refusée avant que L2 ne démarre. En parallèle, L2 pouvait prendre le verrou d'intégration avant L1 : c'est alors L1 qui recevait « intégration refusée » (la branche changée par le hook de L2), et non l'écriture du plan refusée.
    writeFileSync(join(repo, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ngit checkout -q -b autre\n', { mode: 0o755 });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], fake({ implement: writes() }));
    expect(r.code).toBe(1);
    const first = store(parent).readLot('a', 'L1')!;
    expect(first.status).toBe('handed-back');
    expect(first.next).toBe('integrate');
    expect(first.outcome).toBe('écriture du plan refusée : dépôt sur autre et non main');
    expect(planOf(repo).lot(first.lot).review).toBeUndefined();
    expect(subjects(repo).some((s) => s.startsWith(`plan: ${first.lot} revue`))).toBe(false);
  });
  it('R23 — arrêt entre l\'avance et l\'écriture du verdict puis --resume --integrate : verdict écrit une fois, au sha intégré, aucun second rebase', async () => {
    const { parent, repo } = setup();
    // un hook post-merge du lead salit un fichier suivi juste après l'avance : l'écriture du plan est refusée, le lot est rendu à l'étape d'intégration
    const hook = join(repo, '.git', 'hooks', 'post-merge');
    writeFileSync(hook, '#!/bin/sh\necho sale >> base.txt\n', { mode: 0o755 });
    // une session à la fois : L1 passe seul de l'avance à l'écriture du plan refusée ; avec deux sessions, L2 pouvait prendre le verrou d'intégration avant L1 et c'est L1 qui recevait « intégration refusée »
    const f = fake({ implement: writes() });
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '1'], f);
    expect(r.code).toBe(1);
    const first = store(parent).readLot('a', 'L1')!;
    expect(first.status).toBe('handed-back');
    expect(first.next).toBe('integrate');
    expect(first.outcome).toBe('écriture du plan refusée : arbre du dépôt modifié (base.txt)');
    expect(planOf(repo).lot(first.lot).review).toBeUndefined(); // le plan n'a rien reçu : ni commit, ni modification laissée dans l'arbre
    expect(git(repo, 'status', '--porcelain', '--', '.cadence/raf.yaml')).toBe('');
    // le lead nettoie, retire le hook, et nomme le lot
    git(repo, 'checkout', '--', 'base.txt');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const tip = git(repo, 'rev-parse', 'main');
    const again = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', `a:${first.lot}`], fake());
    expect(again.err).toBe('');
    expect(store(parent).readLot('a', first.lot)!.status).toBe('ready');
    const reviews = git(repo, 'log', '--format=%s', `${tip}..main`).split('\n');
    expect(reviews.filter((s) => s.startsWith(`plan: ${first.lot} revue de code enregistrée`))).toHaveLength(1);
    expect(subjects(repo).filter((s) => s === `feat(${first.lot}): travail`)).toHaveLength(1); // aucun second rebase : un seul commit de travail
    expect(planOf(repo).lot(first.lot).review!.commit).toBe(git(repo, 'log', '--format=%H', '-1', `--grep=^feat(${first.lot})`, 'main'));
  });
});

describe('R24 — la branche du lead n\'est jamais changée', () => {
  async function leadMoves(how: (repo: string) => void) {
    const { parent, repo } = setup();
    const meet = meeting(2);
    const f = fake({
      implement: async (cwd, brief) => {
        await meet();
        const lot = lotOf(brief);
        const out = claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
        if (lot === 'L1') how(repo);
        return out;
      },
    });
    const before = git(repo, 'rev-parse', 'main');
    const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
    return { parent, repo, r, before };
  }
  it('R24 — le lead passe sur une autre branche pendant la vague : lot rendu, aucune branche avancée, HEAD du lead inchangé', async () => {
    const { parent, repo, r } = await leadMoves((repo) => git(repo, 'checkout', '-q', '-b', 'autre'));
    expect(r.code).toBe(1);
    for (const id of ['L1', 'L2']) {
      const l = store(parent).readLot('a', id)!;
      expect(l.status).toBe('handed-back');
      expect(l.next).toBe('integrate');
      expect(l.outcome).toMatch(/^intégration refusée : le dépôt est sur autre et non sur main ; branche conservée : cadence\//);
    }
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('autre');
    expect(subjects(repo).some((s) => s.startsWith('feat('))).toBe(false);
    expect(subjects(repo).some((s) => s.startsWith('plan: L1 revue'))).toBe(false); // aucun commit de plan non plus
  });
  it('R24 — HEAD détaché du lead à l\'intégration : lot rendu', async () => {
    const { parent, repo } = await leadMoves((repo) => git(repo, 'checkout', '-q', '--detach'));
    for (const id of ['L1', 'L2']) expect(store(parent).readLot('a', id)!.outcome).toMatch(/le dépôt est sur HEAD détaché et non sur main/);
    expect(() => git(repo, 'symbolic-ref', 'HEAD')).toThrow();
  });
});

describe('R10 — un lot qui attend le verrou ne retient aucun créneau de session', () => {
  it('R10 — pendant l\'attente du verrou aucun créneau de session n\'est occupé', async () => {
    const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }]);
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    const meet = meeting(2);
    const slotsDuringWait: number[] = [];
    const f = fake({
      implement: async (cwd, brief) => {
        await meet();
        const lot = lotOf(brief);
        if (lot === 'L1') writeFileSync(join(sharedStateDir(repo), INTEGRATION_LOCK), JSON.stringify({ pid: sleeper.pid, wave: 'autre-vague', started: '2026-10-24T00:00:00Z' }));
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
      review: async () => {
        // la revue rendue, le lot va attendre le verrou : on mesure les créneaux quand les deux lots y sont, puis le porteur disparaît
        setTimeout(() => slotsDuringWait.push(liveSlots(cadenceHome()).length), 250);
        setTimeout(() => sleeper.kill(), 450);
        return claudeOut(reviewReport());
      },
    });
    try {
      const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, { integrate: { waitMs: 8_000, pollMs: 20 } });
      expect(r.code).toBe(0);
      expect(slotsDuringWait.length).toBeGreaterThan(0);
      expect(slotsDuringWait.every((n) => n === 0)).toBe(true);
    } finally {
      sleeper.kill();
    }
  });
});

describe('R25 — l\'attente du verrou d\'intégration est bornée', () => {
  /** Un porteur vivant d'un autre processus tient le verrou d'intégration du dépôt. */
  function holder(repo: string) {
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    const file = join(sharedStateDir(repo), INTEGRATION_LOCK);
    writeFileSync(file, JSON.stringify({ pid: sleeper.pid, wave: 'autre-vague', started: '2026-10-24T00:00:00Z' }));
    return { file, pid: sleeper.pid!, stop: () => sleeper.kill() };
  }
  /** Une porte que le test ouvre : L2 n'avance pas (donc ne s'intègre pas) avant que le porteur du verrou existe — plus de course sur le temps. */
  function gate() {
    let open: () => void = () => {};
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
  }
  it('R25 — verrou tenu plus que la borne : lot rendu, worktree conservé, branche du dépôt inchangée', async () => {
    const { parent, repo } = setup();
    let h: ReturnType<typeof holder> | undefined;
    const porte = gate();
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        if (lot === 'L1') {
          h = holder(repo); // le porteur arrive avant que L2 ne puisse s'intégrer
          porte.open();
        } else await porte.opened;
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    try {
      const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, { integrate: { waitMs: 200, pollMs: 20 } });
      expect(r.code).toBe(1);
      for (const id of ['L1', 'L2']) {
        const l = store(parent).readLot('a', id)!;
        expect(l.status).toBe('handed-back');
        expect(l.next).toBe('integrate');
        expect(l.outcome).toMatch(new RegExp(`^intégration refusée : verrou d'intégration tenu par autre-vague \\(pid ${h!.pid}\\) depuis plus de [^;]+ ; worktree conservé : .*a--${id}$`));
        expect(existsSync(join(store(parent).dir, 'worktrees', `a--${id}`))).toBe(true);
      }
      expect(subjects(repo).some((s) => s.startsWith('feat('))).toBe(false);
    } finally {
      h?.stop();
    }
  });
  it('R25 — verrou libéré avant la borne : le lot s\'intègre', async () => {
    const { parent } = setup();
    let h: ReturnType<typeof holder> | undefined;
    const meet = meeting(2);
    const f = fake({
      implement: async (cwd, brief) => {
        await meet();
        const lot = lotOf(brief);
        if (lot === 'L1') {
          h = holder(cwd);
          setTimeout(() => h!.stop(), 300); // le porteur meurt avant la borne : son verrou est périmé
        }
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    try {
      const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, { integrate: { waitMs: 8_000, pollMs: 20 } });
      expect(r.code).toBe(0);
    } finally {
      h?.stop();
    }
  });
  it('R25 — --resume --integrate d\'un lot rendu sur le délai : repris à l\'intégration (next: integrate) sans rejouer ses étapes', async () => {
    const { parent } = setup();
    let h: ReturnType<typeof holder> | undefined;
    const porte = gate();
    const f = fake({
      implement: async (cwd, brief) => {
        const lot = lotOf(brief);
        if (lot === 'L1') {
          h = holder(cwd);
          porte.open();
        } else await porte.opened;
        return claudeOut(workReport({ commits: [commitFile(cwd, `${lot}.txt`, `feat(${lot}): travail`)] }));
      },
    });
    try {
      // La borne couvre aussi les écritures de plan du départ des lots (raf start, sous le même verrou) : sous charge, un git de 150 ms y rendrait L2 avant son implémentation.
      await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f, { integrate: { waitMs: 1_500, pollMs: 20 } });
    } finally {
      h?.stop();
    }
    expect(store(parent).readLot('a', 'L1')!.status).toBe('handed-back');
    const steps = store(parent).readLot('a', 'L1')!.steps.length;
    const g = fake();
    const r = await run(parent, ['--resume', '2026-10-04-1412', '--integrate', 'a:L1', '--integrate', 'a:L2'], g);
    expect(r.err).toBe('');
    expect(g.calls).toHaveLength(0); // aucune session : l'intégration seule est rejouée
    expect(store(parent).readLot('a', 'L1')!.status).toBe('ready');
    expect(store(parent).readLot('a', 'L1')!.steps).toHaveLength(steps);
  });
});
