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

describe('entretien du plan : les fichiers décident, jamais le sujet', () => {
  const PLAN = 'docs/plan/raf.yaml';
  /** Plan publié que le projet dérive du plan (ol-companion, warhammer40k : « npm run plan »). */
  const PUBLISHED = 'frontend/public/plan-data/plan.json';
  const DECLARED = `plan:\n  files: [${PUBLISHED}]\n`;

  async function project() {
    const { run } = await import('../src/cli.js');
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, rmSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const dir = gitRepo();
    const raf = async (today: string, ...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, { cwd: dir, env: { RAF_TODAY: today }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${today}T12:00:00`) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-03T12:00:00', GIT_COMMITTER_DATE: '2026-10-03T12:00:00' } });
    /** Commit qui touche exactement ces fichiers (une ligne ajoutée à chacun ; le plan garde ses modifications en attente). */
    const touch = (subject: string, files: string[]) => {
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        if (f !== PLAN && f !== 'cadence.yaml') writeFileSync(join(dir, f), `${existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : ''}// ${subject}\n`);
        else writeFileSync(join(dir, f), `${existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : ''}# ${subject}\n`);
      }
      git('add', ...files);
      git('commit', '-qm', subject);
    };
    /** Le projet déclare (ou cesse de déclarer) son plan publié ; cadence.yaml reste hors de l'historique. */
    const declare = (on = true) => (on ? writeFileSync(join(dir, 'cadence.yaml'), DECLARED) : rmSync(join(dir, 'cadence.yaml'), { force: true }));
    await raf('2026-10-03', 'init', '--no-hook');
    git('add', PLAN);
    git('commit', '-qm', 'chore: adoption');
    return { raf, touch, declare };
  }

  const orphans = (out: string) => out.split('\n').filter((l) => l.includes('commit sans lot'));

  it('(a) « chore(plan): … » qui ne touche qu’un fichier source, sans lot : signalé par raf check, le hook et session close', async () => {
    const { raf, touch } = await project();
    touch('chore(plan): refonte du calcul des scores', ['src/app.ts']);
    const check = await raf('2026-10-03', 'check');
    expect(check.code).toBe(1);
    expect(orphans(check.out)).toHaveLength(1);
    expect(check.out).toMatch(/commit sans lot : [0-9a-f]{7} chore\(plan\): refonte du calcul des scores/);
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).toContain('commit sans lot');
    expect((await raf('2026-10-03', 'session', 'close', '--since', '2026-10-01')).out).toMatch(/1 commit\(s\) sans lot :\n {4}[0-9a-f]{7} chore\(plan\): refonte/);
    expect((await raf('2026-10-03', 'session', 'start', '--since', '2026-10-01')).out).toContain('1 commit(s) sans lot');
  });

  it('(b) plan + fichier déclaré dans plan.files, sans lot : pas un « commit sans lot », quel que soit le sujet', async () => {
    const { raf, touch, declare } = await project();
    declare();
    touch('chore(plan): titres publics pour les lots visibles ouverts', [PLAN, PUBLISHED]);
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).not.toContain('commit sans lot');
    touch('docs: plan publié régénéré', [PUBLISHED]);
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).not.toContain('commit sans lot');
    touch('wip', [PLAN]);
    expect(await raf('2026-10-03', 'check')).toMatchObject({ code: 0, out: '✓ plan et historique cohérents' });
    expect((await raf('2026-10-03', 'session', 'close', '--since', '2026-10-01')).out).not.toContain('sans lot');
    expect((await raf('2026-10-03', 'session', 'start', '--since', '2026-10-01')).out).not.toContain('sans lot');
  });

  it('(c) plan + fichier généré NON déclaré, sans lot : signalé, même sous « chore(plan): … » — forme mesurée le 03-10 (ol-companion b7017e3, cbc4ffc ; warhammer40k f785f48)', async () => {
    const { raf, touch, declare } = await project();
    touch('chore(plan): titres publics pour les 18 lots visibles ouverts — la page Plan montre ce qui se prépare', [PLAN, PUBLISHED]);
    touch('chore(plan): audit des liens morts et campagne UX densité planifiés', [PLAN, PUBLISHED]);
    const check = await raf('2026-10-03', 'check');
    expect(check.code).toBe(1);
    expect(orphans(check.out)).toHaveLength(2);
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).toContain('commit sans lot');
    expect((await raf('2026-10-03', 'session', 'close', '--since', '2026-10-01')).out).toContain('2 commit(s) sans lot');
    // Le remède est une déclaration du projet, pas un sujet de commit : les mêmes commits ne sont plus signalés.
    declare();
    expect(await raf('2026-10-03', 'check')).toMatchObject({ code: 0, out: '✓ plan et historique cohérents' });
  });

  it('(d) un commit d’entretien qui cite un lot relu ne périme pas sa revue, n’est pas listé par raf commits ; sans la déclaration, il compte', async () => {
    const { raf, touch, declare } = await project();
    await raf('2026-10-03', 'review', 'enable');
    await raf('2026-10-03', 'add', 'Calendrier');
    await raf('2026-10-03', 'start', 'L1');
    touch('feat(L1): calendrier', ['src/app.ts']);
    expect((await raf('2026-10-03', 'review', 'L1', 'conforme')).code).toBe(0);
    declare();
    touch('chore(plan): L1 relu, plan publié régénéré', [PLAN, PUBLISHED]);
    // La forme d'ol-companion 1869af7 : le plan publié seul, qui cite le lot.
    touch('chore(plan): plan publié régénéré (L1 terminé)', [PUBLISHED]);

    expect((await raf('2026-10-04', 'commits', 'L1')).out).toMatch(/^[0-9a-f]{7} feat\(L1\): calendrier$/);
    expect((await raf('2026-10-04', 'done', 'L1')).code).toBe(0);
    expect(await raf('2026-10-05', 'check')).toMatchObject({ code: 0, out: '✓ plan et historique cohérents' });

    // Sans plan.files, le plan publié est un fichier comme un autre : les deux commits comptent pour le lot.
    declare(false);
    expect((await raf('2026-10-05', 'commits', 'L1')).out.split('\n')).toHaveLength(3);
    expect((await raf('2026-10-05', 'check')).out).toContain('L1 est terminé avec 2 commit(s) postérieur(s) à sa revue de code');
  });

  it('(d) un commit d’entretien qui cite un lot « todo » ne le démarre pas', async () => {
    const { raf, touch, declare } = await project();
    await raf('2026-10-03', 'add', 'Page Plan');
    declare();
    touch('chore(plan): L1 planifié, plan publié régénéré', [PLAN, PUBLISHED]);
    expect(await raf('2026-10-03', 'check')).toMatchObject({ code: 0, out: '✓ plan et historique cohérents' });
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).not.toContain('encore todo');
    // plan.files seul ne met pas le plan en lecture seule.
    expect((await raf('2026-10-03', 'start', 'L1')).code).toBe(0);
  });

  it('(f) un commit qui ne touche que cadence.yaml (et le plan) est de l’entretien du plan, pas un commit sans lot', async () => {
    const { raf, touch } = await project();
    touch('chore: déclare le plan publié', ['cadence.yaml']);
    touch('chore: déclare le plan publié, plan à jour', ['cadence.yaml', PLAN]);
    expect(await raf('2026-10-03', 'check')).toMatchObject({ code: 0, out: '✓ plan et historique cohérents' });
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).not.toContain('commit sans lot');
    touch('chore: config + source', ['cadence.yaml', 'src/app.ts']);
    expect(orphans((await raf('2026-10-03', 'check')).out)).toHaveLength(1);
  });

  it('(e) un commit mixte (plan + fichier source) qui cite un lot compte pour ce lot, quel que soit son sujet', async () => {
    const { raf, touch, declare } = await project();
    declare();
    await raf('2026-10-03', 'review', 'enable');
    await raf('2026-10-03', 'add', 'Scores');
    touch('chore(plan): L1 planifié et calcul des scores refait', [PLAN, PUBLISHED, 'src/app.ts']);
    expect((await raf('2026-10-03', 'commits', 'L1')).out).toMatch(/^[0-9a-f]{7} chore\(plan\): L1 planifié et calcul des scores refait$/);
    expect((await raf('2026-10-03', 'check')).out).toContain('L1 a 1 commit(s) mais est encore todo');
    expect((await raf('2026-10-03', 'hook', 'post-commit')).err).toContain('L1 est encore todo');
    // Et il périme une revue : relu, puis un second commit mixte.
    await raf('2026-10-03', 'start', 'L1');
    expect((await raf('2026-10-03', 'review', 'L1', 'conforme')).code).toBe(0);
    touch('chore(plan): L1 terminé, dernier réglage', [PLAN, 'src/app.ts']);
    const refused = await raf('2026-10-03', 'done', 'L1');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('la revue de code précède 1 commit(s) du lot');
  });

  it('(e) un commit mixte sans lot est un « commit sans lot », plan.files déclaré ou non', async () => {
    const { raf, touch, declare } = await project();
    declare();
    touch('chore(plan): plan publié régénéré et style retouché', [PLAN, PUBLISHED, 'src/app.css']);
    expect(orphans((await raf('2026-10-03', 'check')).out)).toHaveLength(1);
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

describe('attribution d’un commit à ses lots : la portée prime', () => {
  const lotsOf = (...subjects: string[]) => {
    const dir = gitRepo();
    const plan = Plan.create(join(dir, 'raf.yaml'), 'demo');
    for (let i = 0; i < 50; i++) plan.add(`lot ${i + 1}`, '2026-09-01');
    plan.addTask('L3', 'étape');
    for (const [i, s] of subjects.entries()) commit(dir, s, `2026-09-2${i}T10:00:00`);
    const linked = linkCommits(plan.lots(), readCommits(dir), plan.refs);
    return { ids: [...linked.byLot].map(([id]) => id).sort(), linked };
  };

  it('ne compte que les lots de la portée, pas les mentions en passage ni les plages', () => {
    expect(lotsOf('chore(L24): lot terminé, page équipe de France (L27) et constats (L28–L31) planifiés').ids).toEqual(['L24']);
    expect(lotsOf('chore(L31,L32,L33,L36,L42): réglages — L45 à L48 planifiés').ids).toEqual(['L31', 'L32', 'L33', 'L36', 'L42']);
  });

  it('les références du corps ne comptent pas non plus quand la portée cite un lot', () => {
    const { ids } = lotsOf('fix(L24): barre du bas à 5 cases\n\nla règle « 8 cases » de L2/L13 est remplacée');
    expect(ids).toEqual(['L24']);
  });

  it('une portée peut citer une sous-tâche ; une portée qui cite un lot absent du plan est signalée', () => {
    expect(lotsOf('feat(L3/t1): x — voir L4').ids).toEqual(['L3']);
    expect(lotsOf('fix(L99): x — L4').linked.unknown.map((u) => u.ref)).toEqual(['L99']);
  });

  it('(L15/t4) la portée est reconnue aussi avec une espace avant les deux-points', () => {
    expect(lotsOf('feat(L24) : barre du bas — voir L27 et (L28) planifié').ids).toEqual(['L24']);
  });

  it('sans portée citant un lot, les formes documentées continuent de compter', () => {
    expect(lotsOf('fix: L2 corrigé', 'L3/t1 : suite', 'feat(api): L4 et L5').ids).toEqual(['L2', 'L3', 'L4', 'L5']);
    expect(lotsOf('feat(api): L7 : x').ids).toEqual(['L7']);
  });
});
