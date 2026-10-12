import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockViolations, redSha, resealAcceptation, sealAcceptation, setVert } from '../src/orchestrate/accept.js';
import { run } from '../src/cli.js';
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

  it('exige --reason, un lot en cours, et refuse pendant une vague orchestrée', () => {
    const { repo, a } = avecPlan();
    writeFileSync(join(repo, a.test), 'autre\n');
    expect(cli(repo, {}, 'spec', 'reseal', 'L1', a.test).code).not.toBe(0);
    expect(cli(repo, { CADENCE_ORCHESTRATED: 'w1' }, 'spec', 'reseal', 'L1', a.test, '--reason', 'x').err).toMatch(/vague orchestrée/);
    const todo = avecPlan('todo');
    writeFileSync(join(todo.repo, todo.a.test), 'autre\n');
    expect(cli(todo.repo, {}, 'spec', 'reseal', 'L1', todo.a.test, '--reason', 'x').err).toMatch(/pas en cours/);
  });
});
