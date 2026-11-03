import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealAcceptation, resealAcceptation } from '../src/orchestrate/accept.js';
import { commitRefusal, resealCommitMessage } from '../src/plan-commit.js';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';
import { git } from './orchestrate-harness.js';
import { ecritAcceptation } from './accept-helpers.js';

// Sondes L546 : bords de `spec reseal` à plusieurs tests, du message de commit et de commitRefusal.

const commitPaths = (repo: string, message: string, ...paths: string[]) => {
  git(repo, 'add', '--', ...paths);
  git(repo, 'commit', '-q', '-m', message, '--', ...paths);
};

function lotScelle() {
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
  return { repo, a, second };
}

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-12' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-12T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function avecPlan() {
  const s = lotScelle();
  cli(s.repo, 'init', '--project', 'demo');
  cli(s.repo, 'add', 'Lot un');
  cli(s.repo, 'start', 'L1');
  commitPaths(s.repo, 'plan: L1', '.cadence/raf.yaml', '.cadence/notes/.gitkeep', '.gitignore');
  return s;
}

const touche = (repo: string, f: string, marque = 'corrigé') => writeFileSync(join(repo, f), `${readFileSync(join(repo, f), 'utf8')}// ${marque}\n`);

describe('L546 bord — message du commit', () => {
  it('le corps ne dépasse jamais 100 colonnes pour une raison ordinaire très longue, avec retours à la ligne', () => {
    const reason = `${'mot '.repeat(80)}\n\nsecond paragraphe ${'autre '.repeat(60)}`;
    const [subject, body] = resealCommitMessage({ cite: 'L1', tests: ['test/a.ts', 'test/b.ts'], reason });
    expect(subject.length).toBeLessThanOrEqual(72);
    for (const l of body.split('\n')) expect(l.length).toBeLessThanOrEqual(100);
    expect(body.split('\n')[0]).toBe('- test/a.ts');
  });

  it('un mot de raison plus long que la ligne (non URL) n’est pas laissé tel quel au-delà de 100 colonnes', () => {
    const [, body] = resealCommitMessage({ cite: 'L1', tests: ['test/a.ts'], reason: `regex ${'a'.repeat(160)} fausse` });
    for (const l of body.split('\n')) expect(l.length).toBeLessThanOrEqual(100);
  });

  it('le sujet reste fixe quel que soit le nombre de tests, la raison et la fiche amendée', () => {
    const tests = Array.from({ length: 30 }, (_, i) => `test/un/chemin/assez/long/pour/gonfler/le/sujet/${i}.acceptation.test.ts`);
    const [s1] = resealCommitMessage({ cite: 'L546', tests, reason: 'x'.repeat(500), ficheAmendee: 'abcdef0' });
    const [s2] = resealCommitMessage({ cite: 'L546', tests: ['t'], reason: 'y' });
    expect(s1).toBe(s2);
  });
});

describe('L546 bord — commitRefusal', () => {
  it('cite la règle même quand commitlint colorise (séquence ANSI en fin de ligne)', () => {
    const e = { stderr: '\x1b[31m✖\x1b[39m   header must not be longer than 100 characters, current length is 140 \x1b[90m[header-max-length]\x1b[39m\n\n✖   found 1 problems, 0 warnings', message: 'x' };
    expect(commitRefusal(e)).toContain('[header-max-length]');
  });

  it('cite la règle quand la sortie de commitlint est sur stdout et que stderr ne porte qu’un message de husky', () => {
    const e = { stderr: 'husky - commit-msg hook exited with code 1 (error)', stdout: '✖   header must not be longer than 100 [header-max-length]\n✖   found 1 problems, 0 warnings', message: 'Command failed' };
    expect(commitRefusal(e)).toContain('[header-max-length]');
  });

  it('plusieurs règles : toutes citées, sans le résumé « found N problems »', () => {
    const e = { stderr: '✖   subject may not be empty [subject-empty]\n✖   type may not be empty [type-empty]\n\n✖   found 2 problems, 0 warnings\nⓘ   Get help: https://github.com/conventional-changelog/commitlint/#what-is-commitlint' , message: 'x' };
    const r = commitRefusal(e);
    expect(r).toContain('[subject-empty]');
    expect(r).toContain('[type-empty]');
    expect(r).not.toContain('found 2 problems');
  });

  it('entrée sans stderr ni stdout : le message de l’erreur', () => {
    expect(commitRefusal(new Error('boum'))).toBe('boum');
  });

  it('une valeur jetée qui n’est pas un objet Error (chaîne) ne fait pas planter la formulation du refus', () => {
    expect(() => commitRefusal('refusé')).not.toThrow();
  });

  it('sortie vide partout : ne renvoie pas une chaîne vide', () => {
    expect(commitRefusal({ stderr: '', stdout: '', message: '' }).length).toBeGreaterThan(0);
  });
});

describe('L546 bord — resealAcceptation à plusieurs tests', () => {
  it('liste vide de tests : refus net, rien d’écrit', () => {
    const { repo, a } = lotScelle();
    const avant = readFileSync(join(repo, a.json), 'utf8');
    expect(() => resealAcceptation(repo, a.json, [], 'x', '2026-10-12')).toThrow();
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(avant);
  });

  it('un des deux fichiers supprimé : refus entier, acceptation.json intacte', () => {
    const { repo, a, second } = lotScelle();
    touche(repo, a.test);
    rmSync(join(repo, second));
    const avant = readFileSync(join(repo, a.json), 'utf8');
    expect(() => resealAcceptation(repo, a.json, [a.test, second], 'x', '2026-10-12')).toThrow(/absent/);
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(avant);
  });

  it('même test écrit sous deux graphies (./ et ..) : une seule entrée de journal', () => {
    const { repo, a, second } = lotScelle();
    touche(repo, a.test);
    touche(repo, second);
    resealAcceptation(repo, a.json, [a.test, `./${a.test}`, `test/../${second}`, second], 'x', '2026-10-12');
    const doc = JSON.parse(readFileSync(join(repo, a.json), 'utf8'));
    expect(doc.resceaux).toHaveLength(2);
  });

  it('deux rescellés successifs : le second part de l’empreinte du premier', () => {
    const { repo, a, second } = lotScelle();
    touche(repo, a.test);
    touche(repo, second);
    const r1 = resealAcceptation(repo, a.json, [a.test, second], 'un', '2026-10-12');
    commitPaths(repo, 'test(L1): rescellé', a.json, a.test, second);
    touche(repo, a.test, 'encore');
    touche(repo, second, 'encore');
    const r2 = resealAcceptation(repo, a.json, [a.test, second], 'deux', '2026-10-13');
    expect(r2.resceles.map((x) => x.avant)).toEqual(r1.resceles.map((x) => x.apres));
    expect(JSON.parse(readFileSync(join(repo, a.json), 'utf8')).resceaux).toHaveLength(4);
  });

  it('un chemin hors de la liste (la fiche, l’acceptation elle-même) : refus', () => {
    const { repo, a } = lotScelle();
    touche(repo, a.test);
    expect(() => resealAcceptation(repo, a.json, [a.test, a.json], 'x', '2026-10-12')).toThrow(/pas listé/);
    expect(() => resealAcceptation(repo, a.json, [a.test, '../hors.ts'], 'x', '2026-10-12')).toThrow();
  });

  it('chaîne seule (ancienne signature) : encore acceptée', () => {
    const { repo, a } = lotScelle();
    touche(repo, a.test);
    const r = resealAcceptation(repo, a.json, a.test, 'x', '2026-10-12');
    expect(r.resceles).toHaveLength(1);
  });
});

describe('L546 bord — cadence spec reseal en ligne de commande', () => {
  it('sans test (lot seul) : usage, code non nul, rien commité', () => {
    const { repo } = avecPlan();
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const r = cli(repo, 'spec', 'reseal', 'L1', '--reason', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/usage/);
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  it('--reason placé avant les tests : les deux tests sont pris', () => {
    const { repo, a, second } = avecPlan();
    touche(repo, a.test);
    touche(repo, second);
    const r = cli(repo, 'spec', 'reseal', 'L1', '--reason', 'avant', a.test, second);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~1').split('\n').filter(Boolean)).toContain(second);
  });

  it('raison de 400 caractères sur plusieurs lignes, deux tests : commit accepté par un commit-msg à header ≤ 100 et corps ≤ 100', () => {
    const { repo, a, second } = avecPlan();
    const hook = join(repo, '.git/hooks/commit-msg');
    mkdirSync(join(repo, '.git/hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nawk \'NR==1 && length($0)>100 {print "✖   header [header-max-length]"; exit 1} NR>1 && length($0)>100 {print "✖   line [body-max-line-length]"; exit 1}\' "$1"\n');
    chmodSync(hook, 0o755);
    touche(repo, a.test);
    touche(repo, second);
    const reason = `${'raison très détaillée '.repeat(10)}\nsuite après retour ligne ${'mot '.repeat(40)}`;
    const r = cli(repo, 'spec', 'reseal', 'L1', a.test, second, '--reason', reason);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('refus par le hook : l’erreur cite la règle de commitlint et l’arbre est restauré pour les deux tests', () => {
    const { repo, a, second } = avecPlan();
    const hook = join(repo, '.git/hooks/commit-msg');
    mkdirSync(join(repo, '.git/hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\necho "✖   subject may not be empty [subject-empty]" >&2\necho "" >&2\necho "✖   found 1 problems, 0 warnings" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    touche(repo, a.test);
    touche(repo, second);
    const t1 = readFileSync(join(repo, a.test), 'utf8');
    const t2 = readFileSync(join(repo, second), 'utf8');
    const json = readFileSync(join(repo, a.json), 'utf8');
    const r = cli(repo, 'spec', 'reseal', 'L1', a.test, second, '--reason', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('[subject-empty]');
    expect(readFileSync(join(repo, a.test), 'utf8')).toBe(t1);
    expect(readFileSync(join(repo, second), 'utf8')).toBe(t2);
    expect(readFileSync(join(repo, a.json), 'utf8')).toBe(json);
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('la sortie nomme les deux tests et le commit unique', () => {
    const { repo, a, second } = avecPlan();
    touche(repo, a.test);
    touche(repo, second);
    const r = cli(repo, 'spec', 'reseal', 'L1', a.test, second, '--reason', 'x');
    expect(r.out).toContain(a.test);
    expect(r.out).toContain(second);
    expect(r.out).toContain(git(repo, 'rev-parse', '--short', 'HEAD~1').trim());
  });
});
