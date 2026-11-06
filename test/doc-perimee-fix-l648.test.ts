import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { readHookConfig } from '../src/config.js';
import { changedIdentifiers, docsOkReason, staleCitations, touchedLines } from '../src/doc-follow.js';
import { gitRepo, tempDir } from './helpers.js';

// L648 : un correctif qui change un identifiant doit toucher les lignes de doc et d'aide qui le citent, dans le même commit.

const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

const HELP_CLI = ['import x from "y";', 'const HELP = `cadence', '  cadence deliver [--dry-run] [--block nom]   la CI', '  raf start <id>', '`;', 'export const other = 1;'].join('\n');

/** Un dépôt avec src/lib.ts, README.md, docs/page.md et src/cli.ts (aide), commités ; `hook.docs` écrit dans cadence.yaml. */
function project(docs?: string): string {
  const dir = gitRepo();
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'src/lib.ts'), 'export function oldName(a: number): number {\n  return a;\n}\n');
  writeFileSync(join(dir, 'src/cli.ts'), HELP_CLI);
  writeFileSync(join(dir, 'README.md'), '# Titre\n\nSee `oldName` for details.\n');
  writeFileSync(join(dir, 'docs/page.md'), 'Une phrase sans code.\nLe mot oldName nu, hors accents graves.\nL’option --block nom reste.\n');
  if (docs) writeFileSync(join(dir, 'cadence.yaml'), `hook:\n  docs: ${docs}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'chore: base');
  return dir;
}

function preCommit(dir: string, message: string): { code: number; err: string } {
  const err: string[] = [];
  const code = run(['hook', 'pre-commit'], { cwd: dir, env: { CADENCE_COMMIT_MESSAGE: message }, out: () => {}, err: (l) => err.push(l), now: () => new Date('2026-11-06T09:00:00') });
  return { code: code as number, err: err.join('\n') };
}

const rename = (dir: string): void => {
  writeFileSync(join(dir, 'src/lib.ts'), 'export function newName(a: number): number {\n  return a;\n}\n');
  git(dir, 'add', 'src/lib.ts');
};

describe('L648 — identifiants changés par un diff', () => {
  it('R1 — retiré ou ajouté : une déclaration d’un seul côté, une option d’un seul côté ; déplacée ou au corps changé, rien', () => {
    expect(changedIdentifiers(['export function oldName(a) {', 'const same = 1;'], ['export function newName(a) {', 'const same = 2;'])).toEqual(['newName', 'oldName']);
    expect(changedIdentifiers(["'--old-flag'"], ["'--new-flag'"])).toEqual(['--new-flag', '--old-flag']);
    expect(changedIdentifiers(['function moved() {'], ['function moved() {'])).toEqual([]);
    expect(changedIdentifiers([], [])).toEqual([]);
  });
  it('R1 — un nom de moins de 4 caractères n’est pas un identifiant (bruit)', () => {
    expect(changedIdentifiers(['const a = 1;', 'let id = 2;'], [])).toEqual([]);
  });
  it('R2 — touchedLines lit les hunks -U0 : ajout, remplacement, suppression pure (aucune ligne nouvelle)', () => {
    const diff = '@@ -3 +3 @@ x\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,2 +22,0 @@\n-e\n-f\n';
    expect([...touchedLines(diff)]).toEqual([3, 11, 12]);
  });
  it('R2 — staleCitations : une citation entre accents graves, pas le mot nu ; une option nue compte ; une ligne touchée est quitte', () => {
    const lines = ['`oldName` ici', 'oldName nu', 'avec --block nom', 'sans rien'];
    expect(staleCitations('d.md', lines, ['oldName', '--block'], new Set()).map((c) => [c.id, c.line])).toEqual([['oldName', 1], ['--block', 3]]);
    expect(staleCitations('d.md', lines, ['oldName', '--block'], new Set([1, 3]))).toEqual([]);
    expect(staleCitations('d.md', lines, ['oldName', '--block'], new Set(), true).map((c) => c.id)).toEqual(['--block']);
    expect(staleCitations('d.md', ['`oldNameX`', '`--blocks`'], ['oldName', '--block'], new Set())).toEqual([]);
  });
  it('R3 — docs-ok : une raison non vide exigée', () => {
    expect(docsOkReason('fix(L1): x\n\ndocs-ok: la doc reste vraie')).toBe('la doc reste vraie');
    expect(docsOkReason('fix(L1): x\n\ndocs-ok:   ')).toBeNull();
    expect(docsOkReason('fix(L1): x')).toBeNull();
  });
});

describe('L648 — hook pre-commit : fix( touchant src/', () => {
  it('R4 — hook.docs: refuse : le renommage sans la doc est refusé, le message nomme la ligne de README', () => {
    const dir = project('refuse');
    rename(dir);
    const r = preCommit(dir, 'fix(L1): renomme');
    expect(r.code).toBe(3);
    expect(r.err).toContain('README.md:3');
    expect(r.err).toContain('oldName');
    expect(r.err).not.toContain('docs/page.md:2');
  });
  it('R4 — la doc touchée dans le même commit passe', () => {
    const dir = project('refuse');
    rename(dir);
    writeFileSync(join(dir, 'README.md'), '# Titre\n\nSee `newName` for details.\n');
    git(dir, 'add', 'README.md');
    expect(preCommit(dir, 'fix(L1): renomme').code).toBe(0);
  });
  it('R5 — docs-ok motivé : passe ; sans raison : refusé', () => {
    const dir = project('refuse');
    rename(dir);
    expect(preCommit(dir, 'fix(L1): renomme\n\ndocs-ok: le README parle d’un autre oldName').code).toBe(0);
    expect(preCommit(dir, 'fix(L1): renomme\n\ndocs-ok:').code).toBe(3);
  });
  it('R6 — un commit feat( ou chore( n’est pas concerné', () => {
    const dir = project('refuse');
    rename(dir);
    expect(preCommit(dir, 'feat(L1): renomme').code).toBe(0);
  });
  it('R6 — un fix( qui ne touche pas src/ n’est pas concerné', () => {
    const dir = project('refuse');
    writeFileSync(join(dir, 'README.md'), '# Titre\n\nSee `oldName` still.\n');
    git(dir, 'add', 'README.md');
    expect(preCommit(dir, 'fix(L1): doc').code).toBe(0);
  });
  it('R7 — l’aide : une option retirée citée par HELP et non touchée est refusée ; touchée, elle passe', () => {
    const dir = project('refuse');
    writeFileSync(join(dir, 'src/lib.ts'), 'export function oldName(a: number): number {\n  return a + Number(process.argv.includes("--dry-run"));\n}\n');
    git(dir, 'add', 'src/lib.ts');
    const r = preCommit(dir, 'fix(L1): option');
    expect(r.code).toBe(3);
    expect(r.err).toContain('src/cli.ts:3');
    writeFileSync(join(dir, 'src/cli.ts'), HELP_CLI.replace('[--dry-run] ', ''));
    git(dir, 'add', 'src/cli.ts');
    expect(preCommit(dir, 'fix(L1): option').code).toBe(0);
  });
  it('R8 — hook.docs: warn avertit et laisse passer ; absent ne dit rien', () => {
    const warn = project('warn');
    rename(warn);
    const w = preCommit(warn, 'fix(L1): renomme');
    expect(w.code).toBe(0);
    expect(w.err).toContain('README.md:3');
    const off = project();
    rename(off);
    expect(preCommit(off, 'fix(L1): renomme')).toEqual({ code: 0, err: '' });
  });
  it('R8 — hook.docs : refuse|warn seulement', () => {
    const file = join(tempDir(), 'cadence.yaml');
    writeFileSync(file, 'hook:\n  docs: refuse\n');
    expect(readHookConfig(file)).toEqual({ docs: 'refuse' });
    writeFileSync(file, 'hook:\n  docs: non\n');
    expect(() => readHookConfig(file)).toThrow(/hook\.docs/);
  });
  it('R10 — le cadence.yaml du dépôt ne pose pas hook.docs avant la mise en service (la copie en service le refuse)', () => {
    expect(readHookConfig(join(import.meta.dirname, '..', 'cadence.yaml')).docs).toBeUndefined();
  });
  it('R9 — sans identifiant changé (corps seul) : rien', () => {
    const dir = project('refuse');
    writeFileSync(join(dir, 'src/lib.ts'), 'export function oldName(a: number): number {\n  return a + 1;\n}\n');
    git(dir, 'add', 'src/lib.ts');
    expect(preCommit(dir, 'fix(L1): corps seul')).toEqual({ code: 0, err: '' });
  });
});
