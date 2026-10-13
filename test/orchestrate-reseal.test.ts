import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_LOCK } from '../src/orchestrate/lock.js';
import { sharedStateDir } from '../src/state.js';
import { lockViolations, redSha, resealAcceptation, resealedRouge, sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { run } from '../src/cli.js';
import { DISALLOWED } from '../src/orchestrate/launch.js';
import { gitRepo } from './helpers.js';
import { git } from './orchestrate-harness.js';
import { DIR, ecritAcceptation } from './accept-helpers.js';

// L200 : un test d'acceptation scellé qui contredit la fiche du lot en cours se corrige par un chemin tracé (cadence spec reseal), le verrou gardant tout le reste.

const commitPaths = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};

/** Un lot en cours (L1) dont l'acceptation est scellée et commitée, avec deux fichiers de tests. */
function lotScelle(opts: { vert?: boolean } = {}) {
  const repo = gitRepo();
  const a = ecritAcceptation(repo);
  const second = 'test/autre.acceptation.test.ts';
  writeFileSync(join(repo, second), "it('autre', () => { throw new Error('rouge'); });\n");
  const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
  doc.fichiers.push(second);
  writeFileSync(join(repo, a.json), JSON.stringify(doc, null, 2));
  commitPaths(repo, 'test(L1): second fichier', second, a.json);
  sealAcceptation(repo, a.json);
  commitPaths(repo, 'test(L1): acceptation scellée', a.json);
  if (opts.vert) {
    setVert(repo, a.json);
    commitPaths(repo, 'chore(L1): acceptation verte', a.json);
  }
  return { repo, a, second };
}

describe('resealAcceptation : refaire l’empreinte d’un seul test, la fiche inchangée', () => {
  it('refait l’empreinte du test corrigé, garde celle des autres et note la raison dans acceptation.json', () => {
    const { repo, a, second } = lotScelle();
    const avant = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// regex corrigée\n`);
    const r = resealAcceptation(repo, a.json, a.test, 'regex /\\d{1,2} / contre « T3 2027 annoncée »', '2026-10-12');
    const apres = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(apres.empreintes[a.test]).toBe(git(repo, 'hash-object', a.test).trim());
    expect(apres.empreintes[a.test]).not.toBe(avant.empreintes[a.test]);
    expect(apres.empreintes[second]).toBe(avant.empreintes[second]);
    expect(apres.vert).toBe(false);
    expect(apres.resceaux).toEqual([{ test: a.test, raison: 'regex /\\d{1,2} / contre « T3 2027 annoncée »', date: '2026-10-12', avant: avant.empreintes[a.test], apres: apres.empreintes[a.test] }]);
    expect(r.avant).toBe(avant.empreintes[a.test]);
  });

  it('après le commit du rescellé, le verrou est de nouveau muet ; il garde le reste (un autre test modifié reste un écart)', () => {
    const { repo, a, second } = lotScelle();
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    expect(lockViolations(repo, DIR, head).join('\n')).toContain(a.test); // avant : verrou total
    resealAcceptation(repo, a.json, a.test, 'contredit la fiche', '2026-10-12');
    commitPaths(repo, 'test(L1): acceptation rescellée', a.json, a.test);
    const rescelle = git(repo, 'rev-parse', 'HEAD').trim();
    expect(redSha(repo, a.json)).toBe(rescelle);
    expect(lockViolations(repo, DIR, rescelle)).toEqual([]);
    writeFileSync(join(repo, second), 'modifié\n');
    expect(lockViolations(repo, DIR, rescelle).join('\n')).toContain(second);
  });

  it('refuse un test qui n’est pas listé, une raison vide, un test inchangé', () => {
    const { repo, a } = lotScelle();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(() => resealAcceptation(repo, a.json, 'test/inconnu.test.ts', 'x', '2026-10-12')).toThrow(/n'est pas listé/);
    expect(() => resealAcceptation(repo, a.json, a.test, '  ', '2026-10-12')).toThrow(/--reason/);
    git(repo, 'checkout', '-q', '--', a.test);
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(/inchangé/);
  });

  it('refuse si la fiche a changé depuis le commit rouge (le chemin est celui de la fiche inchangée)', () => {
    const { repo, a } = lotScelle();
    writeFileSync(join(repo, a.test), 'autre\n');
    writeFileSync(join(repo, a.fiche), `${readFileSync(join(repo, a.fiche), 'utf8')}# modifiée\n`);
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(/fiche .* a changé/);
  });

  it('refuse si un autre test listé a été touché : le rescellé ne couvre que le test nommé', () => {
    const { repo, a, second } = lotScelle();
    writeFileSync(join(repo, a.test), 'autre\n');
    writeFileSync(join(repo, second), 'touché\n');
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(new RegExp(second.replace(/\./g, '\\.')));
  });

  it('à la reprise, l’ancre du commit rouge suit un rescellé commité, mais pas une réécriture ordinaire', () => {
    const { repo, a } = lotScelle();
    const ancre = redSha(repo, a.json)!;
    expect(resealedRouge(repo, a.json, ancre)).toBeNull(); // rien n'a bougé
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    resealAcceptation(repo, a.json, a.test, 'contredit la fiche', '2026-10-12');
    commitPaths(repo, 'test(L1): acceptation rescellée', a.json, a.test);
    const rescelle = git(repo, 'rev-parse', 'HEAD').trim();
    expect(lockViolations(repo, DIR, rescelle, { rouge: { [a.json]: ancre } }).join('\n')).toContain('réécrit depuis son commit rouge'); // l'ancre périmée
    expect(resealedRouge(repo, a.json, ancre)).toBe(rescelle);
    expect(lockViolations(repo, DIR, rescelle, { rouge: { [a.json]: rescelle } })).toEqual([]);
  });

  it('un rescellé fait par une session de la vague n’est pas adopté, celui du lead (hors de toute session) l’est', () => {
    const { repo, a } = lotScelle();
    const ancre = redSha(repo, a.json)!;
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    resealAcceptation(repo, a.json, a.test, 'contredit la fiche', '2026-10-12');
    commitPaths(repo, 'test(L1): acceptation rescellée', a.json, a.test);
    const rescelle = git(repo, 'rev-parse', 'HEAD').trim();
    expect(resealedRouge(repo, a.json, ancre, (sha) => sha === rescelle)).toBeNull();
    expect(resealedRouge(repo, a.json, ancre, () => false)).toBe(rescelle);
  });

  it('une réécriture d’acceptation.json sans journal de rescellé n’est pas adoptée comme nouvelle ancre', () => {
    const { repo, a } = lotScelle();
    const ancre = redSha(repo, a.json)!;
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    doc.empreintes[a.test] = 'forgé';
    writeFileSync(join(repo, a.json), JSON.stringify(doc, null, 2));
    commitPaths(repo, 'réécriture par une session', a.json);
    expect(resealedRouge(repo, a.json, ancre)).toBeNull();
  });

  it('refuse une acceptation non scellée', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(() => resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12')).toThrow(/scellée/);
  });
});

describe('cadence spec reseal <lot> <test> --reason', () => {
  function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-12', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-12T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  function avecPlan(statut = 'doing') {
    const s = lotScelle();
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    if (statut === 'doing') cli(s.repo, {}, 'start', 'L1');
    commitPaths(s.repo, 'plan: L1', 'docs/plan/raf.yaml', '.gitignore');
    return s;
  }

  it('commite le test et l’acceptation (rescellés), note la raison au lot, et laisse un dépôt propre', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '-2', '--format=%s').split('\n')[1]).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(repo, 'docs/plan/raf.yaml'), 'utf8')).toContain('le test contredit la fiche');
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  it('un plan tenu par un autre outil (lecture seule) : le rescellé réussit, la note du lot reste à la main du lead', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, 'cadence.yaml'), 'plan:\n  path: docs/plan/raf.yaml\n  lots: lots\n');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/rescellé/);
    expect(r.out).toMatch(/note à ajouter/);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  it('exige --reason, un lot en cours, et refuse pendant une vague orchestrée', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test).code).not.toBe(0);
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/vague orchestrée/);
    const todo = avecPlan('todo');
    writeFileSync(join(todo.repo, todo.a.test), 'autre\n');
    expect(cli(todo.repo, {}, 'spec', 'reseal', 'L1', todo.a.test, '--reason', 'x').err).toMatch(/pas en cours/);
  });

  it('refuse tant qu’une vague tient le verrou du dépôt (le lot suivant de la file travaille sur la même branche)', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), 'autre\n');
    writeFileSync(join(sharedStateDir(repo), REPO_LOCK), JSON.stringify({ pid: process.pid, wave: 'w9', started: 'x' }));
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/orchestration en cours \(vague w9/);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1');
  });

  it('le commit de la note du plan refusé (commit-msg) : erreur lisible qui dit que le rescellé a eu lieu et que la note reste à commiter', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const hook = join(repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\ncase "$(head -1 "$1")" in plan:*) echo "plan refusé" >&2; exit 1;; esac\n');
    chmodSync(hook, 0o755);
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/rescellé a eu lieu.*commit [0-9a-f]+.*note.*à commiter.*plan refusé/);
    expect(r.err).not.toMatch(/\n\s+at /);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toMatch(/^test\(L1\): acceptation rescellée/);
    expect(readFileSync(join(repo, 'docs/plan/raf.yaml'), 'utf8')).toContain('le test contredit la fiche');
  });
});

describe('cadence spec reseal d’un lot livré (L212)', () => {
  function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-13', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-13T10:00:00') });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }
  /** L1 livré (acceptation verte, lot clos), L2 en cours : le lot porteur du rescellé. */
  function livre() {
    const s = lotScelle({ vert: true });
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    cli(s.repo, {}, 'done', 'L1', '--force');
    cli(s.repo, {}, 'start', 'L2');
    commitPaths(s.repo, 'plan: L1 L2', 'docs/plan/raf.yaml', '.gitignore');
    writeFileSync(join(s.repo, s.a.test), `${readFileSync(join(s.repo, s.a.test), 'utf8')}// test instable corrigé\n`);
    return s;
  }

  it('rescelle le test d’un lot livré : le commit cite le lot porteur, le journal porte la date, la raison et le porteur, vert reste vrai', () => {
    const { repo, a } = livre();
    const r = cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'onglet lu à « blank » en CI', '--porteur', 'L2');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'log', '-2', '--format=%s').split('\n')[1]).toBe(`test(L2): acceptation rescellée du lot livré L1, ${a.test} : onglet lu à « blank » en CI`);
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(doc.vert).toBe(true);
    expect(doc.resceaux).toHaveLength(1);
    expect(doc.resceaux[0]).toMatchObject({ test: a.test, raison: 'onglet lu à « blank » en CI', date: '2026-10-13', porteur: 'L2' });
    expect(readFileSync(join(repo, 'docs/plan/raf.yaml'), 'utf8')).toContain('onglet lu à « blank » en CI');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(lockViolations(repo, DIR, git(repo, 'rev-parse', 'HEAD').trim())).toEqual([]);
  });

  it('exige le lot porteur, en cours et distinct du lot livré', () => {
    const { repo, a } = livre();
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/--porteur/);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L1').err).toMatch(/porteur/);
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L9').err).toMatch(/L9/);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1 L2');
  });

  it('--porteur n’a de sens que pour un lot livré ; un lot clos sans acceptation verte reste refusé', () => {
    const { repo, a } = avecPlanEnCours();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L2').err).toMatch(/lot livré/);
  });

  it('refuse pendant une vague orchestrée, comme pour un lot en cours', () => {
    const { repo, a } = livre();
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x', '--porteur', 'L2').err).toMatch(/vague orchestrée/);
  });

  function avecPlanEnCours() {
    const s = lotScelle();
    cli(s.repo, {}, 'init', '--project', 'demo');
    cli(s.repo, {}, 'add', 'Lot un');
    cli(s.repo, {}, 'add', 'Lot deux');
    cli(s.repo, {}, 'start', 'L1');
    cli(s.repo, {}, 'start', 'L2');
    commitPaths(s.repo, 'plan: L1 L2', 'docs/plan/raf.yaml', '.gitignore');
    return s;
  }
});

describe('rescellé atomique et interdit aux sessions', () => {
  it('un commit refusé (hook pre-commit) restaure acceptation.json et le test, sans index à moitié prêt, et lève une erreur lisible', () => {
    const repo = gitRepo();
    const a = ecritAcceptation(repo);
    sealAcceptation(repo, a.json);
    commitPaths(repo, 'test(L1): acceptation scellée', a.json);
    const cli = (...argv: string[]) => {
      const err: string[] = [];
      const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-12' }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-10-12T10:00:00') });
      return { code, err: err.join('\n') };
    };
    cli('init', '--project', 'demo');
    cli('add', 'Lot un');
    cli('start', 'L1');
    commitPaths(repo, 'plan: L1', 'docs/plan/raf.yaml', '.gitignore');
    writeFileSync(join(repo, a.test), `${readFileSync(join(repo, a.test), 'utf8')}// corrigé\n`);
    const jsonAvant = readFileSync(join(repo, a.json), 'utf8');
    const testAvant = readFileSync(join(repo, a.test), 'utf8');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "refusé par le hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = cli('spec', 'reseal', 'L1', a.test, '--reason', 'le test contredit la fiche');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/commit du rescellé a échoué.*rien n'est rescellé.*refusé par le hook/);
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(jsonAvant);
    expect(readFileSync(join(repo, a.test), 'utf8')).toBe(testAvant);
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('plan: L1');
  });

  it('cadence spec reseal est interdit aux sessions, comme raf done/review/ux', () => {
    expect(DISALLOWED).toContain('Bash(cadence spec reseal:*)');
  });

  it('raf spec reseal (même dispatch, bin/raf.js) est interdit aux sessions aussi', () => {
    expect(DISALLOWED).toContain('Bash(raf spec reseal:*)');
  });
});

describe('aide de cadence', () => {
  it('liste cadence spec reseal, le seul chemin de correction d’un test scellé faux', () => {
    expect(readFileSync(join(__dirname, '..', 'bin', 'cadence.js'), 'utf8')).toContain('cadence spec reseal <lot> <test> --reason');
  });
});
