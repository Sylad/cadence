import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deltaTouchesLot } from '../src/orchestrate/cycle/integration-porte.js';
import { git } from './orchestrate-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (2) : bords de `deltaTouchesLot` — suppression, déplacement, noms à espaces, cadence.yaml réel, delta rejoué deux fois.
afterEach(cleanupTempDirs);

function repoWith(files: string[], yamlFrom?: string) {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  if (yamlFrom) copyFileSync(yamlFrom, join(repo, 'cadence.yaml'));
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), 'x\n');
  }
  writeFileSync(join(repo, 'base.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}
const head = (repo: string) => git(repo, 'rev-parse', 'HEAD');
const commit = (repo: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'delta');
  return head(repo);
};

describe('L662 R4 — deltaTouchesLot aux bords', () => {
  it('R4 — main supprime un fichier du lot : lié', () => {
    const repo = repoWith(['src/a/x.ts']);
    const from = head(repo);
    rmSync(join(repo, 'src/a/x.ts'));
    expect(deltaTouchesLot(repo, from, commit(repo), ['src/a/x.ts'])).toBe(true);
  });
  it('R4 — main déplace un fichier du lot vers un autre dossier : lié (l\'ancien nom compte)', () => {
    const repo = repoWith(['src/a/x.ts']);
    const from = head(repo);
    mkdirSync(join(repo, 'ailleurs'));
    renameSync(join(repo, 'src/a/x.ts'), join(repo, 'ailleurs/x.ts'));
    expect(deltaTouchesLot(repo, from, commit(repo), ['src/a/x.ts'])).toBe(true);
  });
  it('R4 — un fichier du lot dont le nom a des espaces et des accents : lié', () => {
    const f = 'docs/page é avec espace.md';
    const repo = repoWith([f]);
    const from = head(repo);
    writeFileSync(join(repo, f), 'y\n');
    expect(deltaTouchesLot(repo, from, commit(repo), [f])).toBe(true);
  });
  it('R4 — from égal à to (même sommet) : non lié', () => {
    const repo = repoWith(['src/a/x.ts']);
    expect(deltaTouchesLot(repo, head(repo), head(repo), ['src/a/x.ts'])).toBe(false);
  });
  it('R4 — le cadence.yaml du dépôt, tel quel : un lot sur package.json lie un test déclaré dans bounds', () => {
    const repo = repoWith([], join(process.cwd(), 'cadence.yaml'));
    const from = head(repo);
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test/docs-publiees-l626.test.ts'), 'x\n');
    expect(deltaTouchesLot(repo, from, commit(repo), ['package.json'])).toBe(true);
  });
  it('R4 — le cadence.yaml du dépôt, tel quel : un lot sur README.md ne lie pas le test d\'un autre fichier borné', () => {
    const repo = repoWith([], join(process.cwd(), 'cadence.yaml'));
    const from = head(repo);
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'test/concepts-doc.test.ts'), 'x\n');
    expect(deltaTouchesLot(repo, from, commit(repo), ['README.md'])).toBe(false);
  });
  it('R4 — un cadence.yaml illisible : pas d\'exception, seul le voisinage lie', () => {
    const repo = repoWith([]);
    writeFileSync(join(repo, 'cadence.yaml'), 'bounds: [: : :\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'yaml');
    const from = head(repo);
    writeFileSync(join(repo, 'autre.txt'), 'x\n');
    expect(deltaTouchesLot(repo, from, commit(repo), ['src/a/x.ts'])).toBe(false);
  });
});
