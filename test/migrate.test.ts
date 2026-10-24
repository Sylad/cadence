import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../src/cli.js';
import { gitRepo, tempDir } from './helpers.js';

const PLAN = 'project: demo\nprefix: L\nlots:\n  - { id: L1, title: Un lot, status: todo }\n';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-24' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-24T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function put(dir: string, file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

/** Un dépôt git dont le plan est à l'ancien emplacement, avec ses lecteurs (`files`), le tout commité. */
function legacyRepo(files: Record<string, string> = {}): string {
  const dir = gitRepo();
  put(dir, 'docs/plan/raf.yaml', PLAN);
  for (const [f, t] of Object.entries(files)) put(dir, f, t);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@e.x', '-c', 'user.name=T', 'commit', '-q', '-m', 'chore: base');
  return dir;
}

const READERS = {
  'scripts/plan-data.sh': '#!/bin/sh\ncat docs/plan/raf.yaml\n',
  '.github/workflows/ci.yml': 'on: push\njobs:\n  x:\n    paths: [docs/plan/raf.yaml]\n',
  'skills/x/SKILL.md': 'Lire `docs/plan/raf.yaml`, puis docs/plan/raf.yaml.\n',
};

describe('raf migrate', () => {
  it('R1 — déplace le plan par git mv vers .cadence/raf.yaml : l\'historique le suit, rien n\'est commité', () => {
    const dir = legacyRepo();
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(false);
    expect(read(dir, '.cadence/raf.yaml')).toBe(PLAN);
    expect(git(dir, 'status', '--porcelain')).toBe('R  docs/plan/raf.yaml -> .cadence/raf.yaml');
    expect(r.out).toContain('git mv docs/plan/raf.yaml .cadence/raf.yaml');
  });

  it('R1 — un plan que git ne suit pas est déplacé par un simple mv', () => {
    const dir = gitRepo();
    put(dir, 'docs/plan/raf.yaml', PLAN);
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, '.cadence/raf.yaml')).toBe(PLAN);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(false);
    expect(r.out).toContain('mv docs/plan/raf.yaml .cadence/raf.yaml');
    expect(r.out).not.toContain('git mv');
  });

  it('R2 — met à jour chaque lecteur du chemin (scripts, CI, skills), toutes les occurrences, et les liste', () => {
    const dir = legacyRepo(READERS);
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, 'scripts/plan-data.sh')).toBe('#!/bin/sh\ncat .cadence/raf.yaml\n');
    expect(read(dir, '.github/workflows/ci.yml')).toContain('paths: [.cadence/raf.yaml]');
    expect(read(dir, 'skills/x/SKILL.md')).toBe('Lire `.cadence/raf.yaml`, puis .cadence/raf.yaml.\n');
    expect(r.out).toContain('scripts/plan-data.sh (1)');
    expect(r.out).toContain('skills/x/SKILL.md (2)');
    expect(r.out).toContain('3 fichiers');
  });

  it('R3 — --dry-run montre le déplacement et chaque fichier touché sans rien modifier', () => {
    const dir = legacyRepo(READERS);
    const before = git(dir, 'status', '--porcelain');
    const r = raf(dir, 'migrate', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('--dry-run');
    for (const f of Object.keys(READERS)) expect(r.out).toContain(f);
    expect(r.out).toContain('git mv docs/plan/raf.yaml .cadence/raf.yaml');
    expect(git(dir, 'status', '--porcelain')).toBe(before);
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.cadence'))).toBe(false);
    expect(read(dir, 'scripts/plan-data.sh')).toContain('docs/plan/raf.yaml');
  });

  it('R4 — refuse, sans rien toucher, tant qu\'un lecteur reste non traité (autre chemin sous docs/plan, chemin construit)', () => {
    const dir = legacyRepo({
      ...READERS,
      'scripts/journal.sh': 'tail docs/plan/journal.ndjson\n',
      'test/x.test.ts': "join(root, 'docs', 'plan', 'raf.yaml')\n",
    });
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(2);
    expect(r.err).toContain('scripts/journal.sh:1');
    expect(r.err).toContain('test/x.test.ts:1');
    expect(r.err).not.toContain('scripts/plan-data.sh');
    expect(existsSync(join(dir, 'docs/plan/raf.yaml'))).toBe(true);
    expect(read(dir, 'scripts/plan-data.sh')).toContain('docs/plan/raf.yaml');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('R4 — --dry-run liste aussi les lecteurs non traités et sort en erreur', () => {
    const dir = legacyRepo({ ...READERS, 'scripts/journal.sh': 'tail docs/plan/journal.ndjson\n' });
    const r = raf(dir, 'migrate', '--dry-run');
    expect(r.code).toBe(2);
    expect(r.out).toContain('scripts/plan-data.sh');
    expect(r.err).toContain('scripts/journal.sh:1');
  });

  it('R5 — un lecteur déclaré sous migrate.keep de cadence.yaml est laissé tel quel et ne bloque pas', () => {
    const dir = legacyRepo({
      ...READERS,
      'cadence.yaml': 'migrate:\n  keep: [scripts/journal.sh, "docs/specs/**"]\n',
      'scripts/journal.sh': 'tail docs/plan/journal.ndjson\n',
      'docs/specs/a/fiche.yaml': 'docs/plan/raf.yaml\n',
    });
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, 'scripts/journal.sh')).toBe('tail docs/plan/journal.ndjson\n');
    expect(read(dir, 'docs/specs/a/fiche.yaml')).toBe('docs/plan/raf.yaml\n');
    expect(r.out).toContain('migrate.keep');
    expect(r.out).toContain('docs/specs/a/fiche.yaml');
  });

  it('R5 — migrate.keep mal formé est refusé avec le nom du fichier', () => {
    const dir = legacyRepo({ 'cadence.yaml': 'migrate:\n  keep: 3\n' });
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(2);
    expect(r.err).toContain('migrate.keep');
  });

  it('R6 — l\'historique reste : CHANGELOG, journaux ndjson et .cadence/ ne sont pas des lecteurs', () => {
    const dir = legacyRepo({
      'CHANGELOG.md': '- le plan vivait dans docs/plan/raf.yaml\n',
      'docs/plan/journal.ndjson': '{"p":"docs/plan/raf.yaml"}\n',
      '.cadence/runs/a.json': '{"plan":"docs/plan/raf.yaml"}\n',
    });
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, 'CHANGELOG.md')).toContain('docs/plan/raf.yaml');
    expect(read(dir, 'docs/plan/journal.ndjson')).toContain('docs/plan/raf.yaml');
    expect(read(dir, '.cadence/runs/a.json')).toContain('docs/plan/raf.yaml');
    expect(r.out).toContain('rien à mettre à jour');
  });

  it('R7 — rejouable : une seconde exécution ne trouve rien à faire et rend 0', () => {
    const dir = legacyRepo(READERS);
    expect(raf(dir, 'migrate').code).toBe(0);
    const after = git(dir, 'status', '--porcelain');
    const again = raf(dir, 'migrate');
    expect(again.code).toBe(0);
    expect(again.out).toContain('rien à migrer');
    expect(git(dir, 'status', '--porcelain')).toBe(after);
  });

  it('R7 — rejouable après un déplacement fait à la main : les lecteurs restants sont traités', () => {
    const dir = legacyRepo(READERS);
    mkdirSync(join(dir, '.cadence'));
    git(dir, 'mv', 'docs/plan/raf.yaml', '.cadence/raf.yaml');
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, 'scripts/plan-data.sh')).toContain('.cadence/raf.yaml');
    expect(r.out).toContain('plan : déjà à .cadence/raf.yaml');
  });

  it('R8 — refuse quand les deux plans existent (rien à choisir à la place de l\'humain)', () => {
    const dir = legacyRepo(READERS);
    put(dir, '.cadence/raf.yaml', PLAN);
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(2);
    expect(r.err).toContain('docs/plan/raf.yaml et .cadence/raf.yaml existent tous deux');
    expect(read(dir, 'scripts/plan-data.sh')).toContain('docs/plan/raf.yaml');
  });

  it('R8 — refuse quand aucun plan n\'existe', () => {
    const dir = gitRepo();
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(2);
    expect(r.err).toContain('aucun plan');
  });

  it('R9 — hors dépôt git, parcourt le dossier (sans node_modules) et déplace par mv', () => {
    const dir = tempDir();
    put(dir, 'docs/plan/raf.yaml', PLAN);
    put(dir, 'run.sh', 'cat docs/plan/raf.yaml\n');
    put(dir, 'node_modules/p/x.js', 'docs/plan/raf.yaml\n');
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, 'run.sh')).toBe('cat .cadence/raf.yaml\n');
    expect(read(dir, 'node_modules/p/x.js')).toBe('docs/plan/raf.yaml\n');
    expect(read(dir, '.cadence/raf.yaml')).toBe(PLAN);
  });

  it('R10 — le plan migré se lit sans l\'avertissement « ancien emplacement »', () => {
    const dir = legacyRepo();
    expect(raf(dir, 'list').err).toContain('ancien emplacement');
    expect(raf(dir, 'migrate').code).toBe(0);
    const r = raf(dir, 'list');
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('L1');
  });

  it('R11 — un fichier binaire qui porte le chemin est un lecteur non traité', () => {
    const dir = legacyRepo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('docs/plan/raf.yaml')]));
    git(dir, 'add', 'blob.bin');
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(2);
    expect(r.err).toContain('blob.bin');
  });

  it('R12 — un lien symbolique vers un dossier suivi par git n\'est pas lu comme un fichier', () => {
    const dir = legacyRepo(READERS);
    symlinkSync('scripts', join(dir, 'lien'));
    git(dir, 'add', 'lien');
    const r = raf(dir, 'migrate');
    expect(r.code).toBe(0);
    expect(read(dir, 'scripts/plan-data.sh')).toContain('.cadence/raf.yaml');
  });
});
