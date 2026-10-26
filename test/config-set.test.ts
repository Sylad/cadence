import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo, tempDir, NO_BACKGROUND_GIT } from './helpers.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', [...NO_BACKGROUND_GIT, ...args], { cwd: dir, encoding: 'utf8' });

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un projet : dépôt propre sous `parent`, plan raf initialisé, cadence.yaml optionnel, tout commité. */
function project(parent: string, name: string, files: Record<string, string> = {}) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries({ 'cadence.yaml': '', ...files })) {
    mkdirSync(join(dir, k, '..'), { recursive: true });
    if (v !== '' || k !== 'cadence.yaml') writeFileSync(join(dir, k), v);
  }
  const init = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  init('init', '-q', '-b', 'main');
  init('config', 'user.email', 't@example.com');
  init('config', 'user.name', 'T');
  init('config', 'commit.gpgsign', 'false');
  cadence(dir, 'init', '--project', name, '--no-hook');
  init('add', '-A');
  init('commit', '-q', '-m', 'init');
  return dir;
}

const COMMENTED = '# En-tête du projet\norchestrate:\n  # la porte de tests\n  test: npx vitest run   # la suite\n  worktrees: true\n\ndocs:\n  since: 2026-10-09\n';

describe('cadence config set --all (L342)', () => {
  it('R1 — pose la clé dans chaque projet du dossier, garde commentaires et ordre, crée un lot de config qui la cite, commite à chemin explicite', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const b = project(parent, 'beta', { 'cadence.yaml': COMMENTED });
    writeFileSync(join(a, 'notes.txt'), 'à ne pas commiter'); // le fichier d'un autre travail, déjà stagé
    git(a, 'add', 'notes.txt');
    const r = cadence(parent, 'config', 'set', 'orchestrate.escalation', '{ model: fable }', '--all');
    expect(r.code).toBe(0);
    for (const dir of [a, b]) {
      const text = readFileSync(join(dir, 'cadence.yaml'), 'utf8');
      expect(text).toContain('orchestrate:\n  # la porte de tests\n  test: npx vitest run # la suite\n  worktrees: true\n  escalation: { model: fable }\n');
      expect(text.startsWith('# En-tête du projet\n')).toBe(true);
      expect(text.indexOf('orchestrate:')).toBeLessThan(text.indexOf('docs:'));
      const plan = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
      expect(plan).toMatch(/id: L1\n\s+title: .*orchestrate\.escalation.*\n(?:.*\n)*?\s+status: doing/);
      const last = git(dir, 'log', '-1', '--format=%s', '--name-only').trim().split('\n');
      expect(last[0]).toMatch(/^chore\(L1\): .*orchestrate\.escalation/);
      expect(last.slice(1).filter(Boolean).sort()).toEqual(['.cadence/raf.yaml', 'cadence.yaml']);
    }
    expect(git(a, 'status', '--porcelain').trim()).toBe('A  notes.txt');
    expect(r.out).toContain('alpha');
    expect(r.out).toContain('beta');
  });

  it('R2 — --dry-run liste ce qui serait fait sans rien écrire ni commiter', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const head = git(a, 'rev-parse', 'HEAD');
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/alpha.*serait/);
    expect(readFileSync(join(a, 'cadence.yaml'), 'utf8')).toBe(COMMENTED);
    expect(git(a, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(a, 'status', '--porcelain')).toBe('');
  });

  it('R3 — modifie une clé existante en gardant son commentaire de fin de ligne', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const r = cadence(parent, 'config', 'set', 'orchestrate.test', 'npm test', '--all');
    expect(r.code).toBe(0);
    expect(readFileSync(join(a, 'cadence.yaml'), 'utf8')).toContain('  # la porte de tests\n  test: npm test # la suite\n');
  });

  it('R4 — saute un projet déjà à la valeur, un projet au dépôt sale sur ses fichiers, un plan en lecture seule ; les autres sont traités et le tout est listé', () => {
    const parent = tempDir();
    const same = project(parent, 'deja', { 'cadence.yaml': 'orchestrate:\n  build: npx tsc --noEmit\n' });
    const dirty = project(parent, 'sale', { 'cadence.yaml': COMMENTED });
    writeFileSync(join(dirty, 'cadence.yaml'), `${COMMENTED}# modif en cours\n`);
    const ro = project(parent, 'autre-outil', { 'cadence.yaml': 'plan:\n  path: taches.yaml\n  lots: taches\n', 'taches.yaml': 'taches:\n  - { id: T1, title: x, status: todo }\n' });
    const ok = project(parent, 'ok', { 'cadence.yaml': COMMENTED });
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deja.*sauté.*déjà/);
    expect(r.out).toMatch(/sale.*sauté.*non commité/);
    expect(r.out).toMatch(/autre-outil.*sauté.*lecture seule/);
    expect(r.out).toMatch(/ok.*L1/);
    expect(r.out).toMatch(/1 fait.*3 sauté/);
    expect(git(same, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(git(ro, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(readFileSync(join(dirty, 'cadence.yaml'), 'utf8')).toContain('# modif en cours');
    expect(git(ok, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('R5 — s\'arrête sur un projet dont la config ne se relit pas : rien n\'est écrit chez lui, les suivants sont nommés non traités', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const b = project(parent, 'beta', { 'cadence.yaml': 'orchestrate:\n  test: [oups\n' });
    const c = project(parent, 'gamma', { 'cadence.yaml': COMMENTED });
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/alpha.*L1/);
    expect(r.out).toMatch(/beta.*arrêt.*ne se relit pas/);
    expect(r.out).toMatch(/non traités? : gamma/);
    expect(readFileSync(join(b, 'cadence.yaml'), 'utf8')).toBe('orchestrate:\n  test: [oups\n');
    expect(git(c, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(git(a, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('R6 — une valeur que le chargeur de config refuse arrête le passage avant toute écriture', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const b = project(parent, 'beta', { 'cadence.yaml': COMMENTED });
    const r = cadence(parent, 'config', 'set', 'orchestrate.worktrees', 'oui', '--all');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/alpha.*arrêt/);
    expect(r.out).toMatch(/non traités? : beta/);
    expect(readFileSync(join(a, 'cadence.yaml'), 'utf8')).toBe(COMMENTED);
    expect(git(b, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('R7 — ne pousse pas : le dépôt distant ne reçoit rien', () => {
    const parent = tempDir();
    const remote = gitRepo();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(remote, 'bare.git')]);
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    git(a, 'remote', 'add', 'origin', join(remote, 'bare.git'));
    git(a, 'push', '-q', 'origin', 'main');
    cadence(parent, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all');
    expect(git(a, 'rev-list', '--count', 'origin/main..HEAD').trim()).toBe('1');
    expect(git(join(remote, 'bare.git'), 'rev-list', '--count', 'main').trim()).toBe('1');
  });

  it('R8 — un projet sans cadence.yaml en reçoit un ; un chemin qui traverse une valeur simple est sauté', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha');
    const b = project(parent, 'beta', { 'cadence.yaml': 'lead: human\n' });
    expect(existsSync(join(a, 'cadence.yaml'))).toBe(false);
    const r = cadence(parent, 'config', 'set', 'lead.ux', 'lead', '--all');
    expect(r.code).toBe(0);
    expect(readFileSync(join(a, 'cadence.yaml'), 'utf8')).toBe('lead:\n  ux: lead\n');
    expect(r.out).toMatch(/beta.*sauté.*ne se pose pas/);
    expect(git(b, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('R9 — un commit refusé (hook) arrête le passage et remet les fichiers dans leur état', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const b = project(parent, 'beta', { 'cadence.yaml': COMMENTED });
    const hook = join(a, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho refusé >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/alpha.*arrêt.*commit/);
    expect(r.out).toMatch(/non traités? : beta/);
    expect(git(a, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(a, 'cadence.yaml'), 'utf8')).toBe(COMMENTED);
    expect(git(b, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('R10 — refuse sans --all, sans valeur, une clé mal formée, une valeur YAML illisible', () => {
    const parent = tempDir();
    project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    expect(cadence(parent, 'config', 'set', 'orchestrate.build', 'x').code).toBe(2);
    expect(cadence(parent, 'config', 'set', 'orchestrate.build', '--all').code).toBe(2);
    expect(cadence(parent, 'config', 'set', 'a..b', 'x', '--all').code).toBe(2);
    expect(cadence(parent, 'config', 'set', 'a', '[oups', '--all').code).toBe(2);
    expect(cadence(parent, 'config', 'get', 'a', 'x', '--all').code).toBe(2);
  });

  it('R11 — --depth descend d\'un niveau de plus, comme lead tour ; un dossier sans projet le dit', () => {
    const parent = tempDir();
    const g = project(join(parent, 'groupe'), 'gamma', { 'cadence.yaml': COMMENTED });
    expect(cadence(parent, 'config', 'set', 'orchestrate.build', 'x', '--all').out).toMatch(/aucun projet/);
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'x', '--all', '--depth', '2');
    expect(r.out).toContain('groupe/gamma');
    expect(readFileSync(join(g, 'cadence.yaml'), 'utf8')).toContain('build: x');
  });
  it('R12 — le commentaire de l\'ancienne valeur d\'un projet ne passe pas dans un autre projet', () => {
    const parent = tempDir();
    project(parent, 'alpha', { 'cadence.yaml': 'orchestrate:\n  escalation: { model: x } # commentaire propre à alpha\n' });
    const b = project(parent, 'beta', { 'cadence.yaml': 'orchestrate:\n  worktrees: true\n' });
    const r = cadence(parent, 'config', 'set', 'orchestrate.escalation', '{ model: fable }', '--all');
    expect(r.code).toBe(0);
    expect(readFileSync(join(b, 'cadence.yaml'), 'utf8')).toBe('orchestrate:\n  worktrees: true\n  escalation: { model: fable }\n');
  });

  it('R13 — lancée dans un projet seul (sans sous-projet), elle traite ce projet, comme lead tour', () => {
    const parent = tempDir();
    const a = project(parent, 'alpha', { 'cadence.yaml': COMMENTED });
    const r = cadence(a, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/alpha.*L1/);
    expect(readFileSync(join(a, 'cadence.yaml'), 'utf8')).toContain('build: npx tsc --noEmit');
    expect(git(a, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('R14 — un plan en lecture seule qui nomme sa commande de création (plan.add) reçoit son lot de config par cette commande, commité avec cadence.yaml', () => {
    const parent = tempDir();
    const yaml = "plan:\n  path: taches.yaml\n  lots: taches\n  add: 'node add.mjs {title}'\n";
    const script = "import{appendFileSync}from'node:fs';appendFileSync('taches.yaml','  - { id: T2, title: '+JSON.stringify(process.argv[2])+', status: doing }\\n');console.log('créé T2');\n";
    const ro = project(parent, 'autre-outil', { 'cadence.yaml': yaml, 'taches.yaml': 'taches:\n  - { id: T1, title: x, status: todo }\n', 'add.mjs': script });
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'npx tsc --noEmit', '--all');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/autre-outil.*T2/);
    expect(readFileSync(join(ro, 'taches.yaml'), 'utf8')).toContain('orchestrate.build');
    const last = git(ro, 'log', '-1', '--format=%s', '--name-only').trim().split('\n');
    expect(last[0]).toMatch(/^chore\(T2\): .*orchestrate\.build/);
    expect(last.slice(1).filter(Boolean).sort()).toEqual(['cadence.yaml', 'taches.yaml']);
    expect(git(ro, 'status', '--porcelain')).toBe('');
  });

  it('R15 — un plan en lecture seule sans plan.add est sauté en nommant la clé plan.add', () => {
    const parent = tempDir();
    project(parent, 'autre-outil', { 'cadence.yaml': 'plan:\n  path: taches.yaml\n  lots: taches\n', 'taches.yaml': 'taches:\n  - { id: T1, title: x, status: todo }\n' });
    const r = cadence(parent, 'config', 'set', 'orchestrate.build', 'x', '--all');
    expect(r.out).toMatch(/autre-outil.*sauté.*lecture seule.*plan\.add/);
  });
});
