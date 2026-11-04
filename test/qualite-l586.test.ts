import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, lireRef } from '../scripts/qualite.mjs';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

const PLAN = (config: string) => `lots:\n  - id: L1\n    title: "un lot"\n    status: doing\n${config}  - id: L2\n    title: "autre"\n    status: doing\n`;

/** Un dépôt avec base vide et vitest.workspace.ts, sur la branche d'un lot dont le plan porte `config` (ligne de YAML, éventuellement vide) pour L1 ; `lot` en pose la modification. */
function depot(config: string, branche = 'cadence/v/p--L1', plan = PLAN(config), base = '{}') {
  const dir = gitRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, BASELINE), base);
  writeFileSync(join(dir, 'vitest.workspace.ts'), 'a');
  writeFileSync(join(dir, '.cadence/raf.yaml'), plan);
  git('add', '-A');
  git('commit', '-qm', 'depart');
  git('checkout', '-qb', branche);
  const verifier = () => appliquer(dir, 'verifier', {}, lireRef(dir, 'main'));
  const ecrire = (f: string, c: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); };
  return { dir, git, verifier, ecrire };
}

describe('L586 — un lot de config déclaré (config: true) échappe au refus de configChangee, et lui seul', () => {
  it('R1 — le lot déclaré config: true peut modifier vitest.workspace.ts et son test', () => {
    const { verifier, ecrire } = depot('    config: true\n');
    ecrire('vitest.workspace.ts', 'b');
    ecrire('test/workspace.test.ts', 'x');
    expect(verifier().code).toBe(0);
  });

  it('R2 — sans config: true, le même changement reste refusé', () => {
    const { verifier, ecrire } = depot('');
    ecrire('vitest.workspace.ts', 'b');
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('vitest.workspace.ts (modifié)');
  });

  it('R2 — config: true sur un AUTRE lot du plan ne lève pas le refus, config: false non plus', () => {
    const autre = depot('', 'cadence/v/p--L1', PLAN('').replace('title: "autre"', 'title: "autre"\n    config: true'));
    autre.ecrire('vitest.workspace.ts', 'b');
    expect(autre.verifier().code).toBe(1);
    const faux = depot('    config: false\n');
    faux.ecrire('vitest.workspace.ts', 'b');
    expect(faux.verifier().code).toBe(1);
  });

  it('R3 — un lot de config qui touche aussi du code est refusé, en nommant le fichier', () => {
    const { verifier, ecrire } = depot('    config: true\n');
    ecrire('vitest.workspace.ts', 'b');
    ecrire('src/code.ts', 'export const a = 1;\n');
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/code.ts');
  });

  it('R3 — un fichier de code déjà commité sur la branche est vu comme une modification hors config', () => {
    const { verifier, ecrire, git } = depot('    config: true\n');
    ecrire('src/code.ts', 'x');
    git('add', 'src/code.ts');
    git('commit', '-qm', 'code');
    expect(verifier().texte).toContain('src/code.ts');
  });

  it('R3 — un renommage de code vers test/ remonte le chemin de code supprimé (--no-renames) : refusé', () => {
    const { dir, verifier, ecrire, git } = depot('    config: true\n');
    git('checkout', '-q', 'main');
    ecrire('src/code.ts', 'export const a = 1;\n');
    git('add', 'src/code.ts');
    git('commit', '-qm', 'code au depart');
    git('checkout', '-q', 'cadence/v/p--L1');
    git('merge', '-q', 'main');
    mkdirSync(join(dir, 'test'), { recursive: true });
    git('mv', 'src/code.ts', 'test/code.test.ts');
    git('commit', '-qm', 'renomme');
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/code.ts');
  });

  it('R3 — un lien symbolique non suivi posé par la vague dans le worktree (evals/results → dépôt principal) ne compte pas comme fichier touché ; un fichier ordinaire non suivi compte toujours', () => {
    const { dir, verifier, ecrire } = depot('    config: true\n');
    ecrire('vitest.workspace.ts', 'b');
    mkdirSync(join(dir, 'evals'));
    symlinkSync(dir, join(dir, 'evals/results'));
    expect(verifier().code).toBe(0);
    ecrire('src/code.ts', 'x');
    expect(verifier().texte).toContain('src/code.ts');
  });

  it('R4 — un lot de config reste jugé par les autres mesures : la base ne peut pas remonter', () => {
    const { dir, ecrire, verifier } = depot('    config: true\n', 'cadence/v/p--L1', PLAN('    config: true\n'), '{"eslint|vitest.workspace.ts|max-lines":1}');
    ecrire('vitest.workspace.ts', 'b');
    writeFileSync(join(dir, BASELINE), '{"eslint|vitest.workspace.ts|max-lines":2}');
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('remonte');
  });

  it('R4 — un lot de config dont la mesure empire est refusé', () => {
    const { dir, ecrire } = depot('    config: true\n');
    ecrire('vitest.workspace.ts', 'b');
    const r = appliquer(dir, 'verifier', { 'eslint|vitest.workspace.ts|max-lines': 5 }, lireRef(dir, 'main'));
    expect(r.code).toBe(1);
    expect(r.texte).toContain('empirent');
  });

  it('bord — un id de lot avec « / » (branche en « __ ») est reconnu, et une branche sans « -- » n\'est pas un lot de config', () => {
    const sous = depot('', 'cadence/v/p--Q4__x', 'lots:\n  - id: Q4/x\n    title: "t"\n    config: true\n');
    sous.ecrire('vitest.workspace.ts', 'b');
    expect(sous.verifier().code).toBe(0);
    const hors = depot('    config: true\n', 'travail');
    hors.ecrire('vitest.workspace.ts', 'b');
    expect(hors.verifier().code).toBe(1);
  });

  it('bord — plan absent ou illisible : le lot n\'est pas de config, le refus reste', () => {
    const { ecrire, git, verifier } = depot('    config: true\n');
    git('checkout', '-q', 'main');
    git('rm', '-q', '-f', '.cadence/raf.yaml');
    git('commit', '-qm', 'main sans plan');
    git('checkout', '-q', 'cadence/v/p--L1');
    git('rebase', '-q', 'main');
    ecrire('vitest.workspace.ts', 'b');
    expect(verifier().code).toBe(1);
  });

  it('R1 — la déclaration est lue au départ du lot : un lot qui se pose lui-même config: true n\'est pas exempté', () => {
    const { verifier, ecrire } = depot('');
    ecrire('.cadence/raf.yaml', PLAN('    config: true\n'));
    ecrire('vitest.workspace.ts', 'b');
    expect(verifier().code).toBe(1);
  });
});
