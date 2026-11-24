import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, lireRef, serialiser } from '../scripts/qualite.mjs';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

// L1 est déclaré config: true au plan du départ quand `config` est vrai ; L2 est un lot de code
const PLAN = (config: boolean) => `lots:\n  - id: L1\n    title: "règles"\n    status: doing\n${config ? '    config: true\n' : ''}  - id: L2\n    title: "code"\n    status: doing\n`;
const DEPART = { 'eslint|src/a.ts|regle': 1 };
// ce que mesure le sommet une fois la règle activée : la clé existante monte, une clé neuve apparaît sur un fichier du départ
const SOMMET = { 'eslint|src/a.ts|regle': 3, 'eslint|src/a.ts|autre': 2 };

/** Un dépôt dont main porte la base DEPART, src/a.ts et eslint.config.mjs, puis une branche ; `commit` y pose un commit, `verifier` juge le sommet mesuré à `mesure`. */
function depot({ config = true, branche = 'cadence/v/p--L1' } = {}) {
  const dir = gitRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  const ecrire = (f: string, c: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); };
  ecrire(BASELINE, serialiser(DEPART));
  ecrire('src/a.ts', 'export const a = 1;\n');
  ecrire('eslint.config.mjs', 'export default [];\n');
  ecrire('.cadence/raf.yaml', PLAN(config));
  git('add', '-A');
  git('commit', '-qm', 'depart');
  git('checkout', '-qb', branche);
  const commit = (message: string, fichiers: Record<string, string>) => {
    for (const [f, c] of Object.entries(fichiers)) ecrire(f, c);
    git('add', '--', ...Object.keys(fichiers));
    git('commit', '-qm', message);
  };
  const juger = (mode: 'verifier' | 'ecrire', mesure: Record<string, number> = SOMMET) => appliquer(dir, mode, mesure, lireRef(dir, 'main'));
  return { dir, ecrire, commit, verifier: (mesure?: Record<string, number>) => juger('verifier', mesure), ecrireBase: () => juger('ecrire') };
}

const regle = 'export default [{ rules: { regle: "error", autre: "error" } }];\n';

describe('L824 — un lot config: true peut faire monter la base, seulement à la mesure exacte de son sommet', () => {
  it('sans config: true, la hausse est refusée même à la mesure exacte', () => {
    const { commit, verifier } = depot({ config: false });
    commit('feat(L1): base', { [BASELINE]: serialiser(SOMMET) });
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('remonte');
  });

  it('avec config: true, la base égale à la mesure, clé par clé, est acceptée (sur la branche du lot)', () => {
    const { commit, verifier } = depot();
    commit('feat(L1): règle activée, base à la mesure', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET) });
    expect(verifier()).toMatchObject({ code: 0 });
  });

  it('avec config: true, une base ≠ mesure est refusée : marge au-dessus, clé de trop, ou valeur sous la mesure', () => {
    const cas: Record<string, Record<string, number>> = {
      marge: { ...SOMMET, 'eslint|src/a.ts|regle': 4 },
      'clé de trop': { ...SOMMET, 'eslint|src/a.ts|fantome': 1 },
      'sous la mesure': { ...SOMMET, 'eslint|src/a.ts|autre': 1 },
    };
    for (const [nom, base] of Object.entries(cas)) {
      const { commit, verifier } = depot();
      commit('feat(L1): base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(base) });
      const r = verifier();
      expect(r.code, nom).toBe(1);
      expect(r.texte, nom).toMatch(/EXACTE|empirent/);
    }
    const { commit, verifier } = depot();
    commit('feat(L1): base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(cas.marge) });
    expect(verifier().texte).toContain('eslint|src/a.ts|regle : 4 → 3');
  });

  it('un lot config: true qui touche du code est refusé, en nommant le fichier', () => {
    const { commit, verifier } = depot();
    commit('feat(L1): base', { 'eslint.config.mjs': regle, 'src/a.ts': 'export const a = 2;\n', [BASELINE]: serialiser(SOMMET) });
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/a.ts');
  });

  it('--ecrire d’un lot config: true pose la mesure telle quelle, que la porte accepte ensuite', () => {
    const { dir, commit, ecrireBase, verifier } = depot();
    commit('feat(L1): règle', { 'eslint.config.mjs': regle });
    expect(ecrireBase().code).toBe(0);
    expect(readFileSync(join(dir, BASELINE), 'utf8')).toBe(serialiser(SOMMET));
    expect(verifier().code).toBe(0);
  });

  describe('sans nom de lot dans la branche (porte d’un run, porte d’intégration) : reconnu à ses commits', () => {
    it('chaque commit cite le lot config: true (un commit de plan est neutre) : acceptée à l’exact, refusée avec une marge', () => {
      const ok = depot({ branche: 'cadence/run-1' });
      ok.commit('plan: start L1', { '.cadence/raf.yaml': `${PLAN(true)}# start\n` });
      ok.commit('feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET) });
      expect(ok.verifier().code).toBe(0);
      const marge = depot({ branche: 'cadence/run-1' });
      marge.commit('feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser({ ...SOMMET, 'eslint|src/a.ts|regle': 4 }) });
      expect(marge.verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('EXACTE') });
    });

    it('un commit d’un lot de code dans l’intervalle ferme la voie : la hausse est refusée', () => {
      const { commit, verifier } = depot({ branche: 'cadence/run-1' });
      commit('feat(L2): code', { 'src/b.ts': 'export const b = 1;\n' });
      commit('feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET) });
      expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
    });

    it('un commit de fusion dans l’intervalle ferme la voie, même quand sa résolution n’ajoute que du code invisible au log', () => {
      const { dir, commit, verifier } = depot({ branche: 'cadence/run-1' });
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
      git('checkout', '-qb', 'autre');
      commit('feat(L1): règle', { 'eslint.config.mjs': regle });
      git('checkout', '-q', 'cadence/run-1');
      commit('feat(L1): base', { [BASELINE]: serialiser(SOMMET) });
      // « evil merge » : la résolution glisse src/evil.ts, que git log --name-only ne liste pas pour une fusion
      git('merge', '-q', '--no-ff', '--no-commit', 'autre');
      writeFileSync(join(dir, 'src/evil.ts'), 'export const e = 1;\n');
      git('add', 'src/evil.ts');
      git('commit', '-qm', 'feat(L1): fusion');
      expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
    });

    it('un commit à scope multi-lots dont un lot de code ferme la voie', () => {
      const { commit, verifier } = depot({ branche: 'cadence/run-1' });
      commit('feat(L1,L2): base', { [BASELINE]: serialiser(SOMMET) });
      expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
    });

    it('un commit sans scope ferme la voie', () => {
      const { commit, verifier } = depot({ branche: 'cadence/run-1' });
      commit('feat(L1): règle', { 'eslint.config.mjs': regle });
      commit('fix: base', { [BASELINE]: serialiser(SOMMET) });
      expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
    });

    it('un lot qui se déclare config: true dans son propre commit de plan reste refusé (le plan est lu au départ)', () => {
      const { commit, verifier } = depot({ config: false, branche: 'cadence/run-1' });
      commit('plan: L1 config', { '.cadence/raf.yaml': PLAN(true) });
      commit('feat(L1): base', { [BASELINE]: serialiser(SOMMET) });
      expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
    });

    it('un changement non commité autre que la base ferme la voie', () => {
      const { commit, ecrire, verifier } = depot({ branche: 'cadence/run-1' });
      commit('feat(L1): règle et base', { 'eslint.config.mjs': regle, [BASELINE]: serialiser(SOMMET) });
      ecrire('src/c.ts', 'export const c = 1;\n');
      expect(verifier()).toMatchObject({ code: 1, texte: expect.stringContaining('remonte') });
    });
  });
});
