import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, lireRef } from '../scripts/qualite.mjs';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

const PLAN = 'lots:\n  - id: L1\n    title: "config"\n    status: doing\n    config: true\n  - id: L2\n    title: "code"\n    status: doing\n';

/** Un dépôt sur main (base vide, plan avec L1 de config et L2 de code) puis une branche d'intégration SANS nom de lot ; `commit` y pose un commit. */
function integration(branche = 'integration') {
  const dir = gitRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, BASELINE), '{}');
  writeFileSync(join(dir, 'vitest.workspace.ts'), 'a');
  writeFileSync(join(dir, '.cadence/raf.yaml'), PLAN);
  git('add', '-A');
  git('commit', '-qm', 'depart');
  git('checkout', '-qb', branche);
  const commit = (message: string, ...fichiers: [string, string][]) => {
    for (const [f, c] of fichiers) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
    git('add', '--', ...fichiers.map(([f]) => f));
    git('commit', '-qm', message);
  };
  return { dir, commit, verifier: () => appliquer(dir, 'verifier', {}, lireRef(dir, 'main')) };
}

describe('L613 — la porte d’intégration reconnaît le lot de config à ses commits, pas au nom de la branche', () => {
  it('R1 — un sommet intégré dont la config ne vient que du lot config: true (plus le code d’un autre lot) passe', () => {
    const { commit, verifier } = integration();
    commit('feat(L1): workspace', ['vitest.workspace.ts', 'b'], ['test/w.test.ts', 'x']);
    commit('feat(L2): code', ['src/code.ts', 'export const a = 1;\n']);
    expect(verifier().code).toBe(0);
  });

  it('R2 — la même config changée par un commit d’un lot de code est refusée', () => {
    const { commit, verifier } = integration();
    commit('feat(L2): workspace', ['vitest.workspace.ts', 'b']);
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('vitest.workspace.ts (modifié)');
  });

  it('R2 — un lot de config et un lot de code touchent la même config : refusée', () => {
    const { commit, verifier } = integration();
    commit('feat(L1): workspace', ['vitest.workspace.ts', 'b']);
    commit('fix(L2): workspace', ['vitest.workspace.ts', 'c']);
    expect(verifier().code).toBe(1);
  });

  it('R3 — un commit du lot de config qui touche du code est refusé, en nommant le fichier', () => {
    const { commit, verifier } = integration();
    commit('feat(L1): workspace et code', ['vitest.workspace.ts', 'b'], ['src/code.ts', 'export const a = 1;\n']);
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('src/code.ts');
  });

  it('bord — un commit sans lot cité, un lot inconnu du plan, ou un scope multiple dont un lot est de code : refusés', () => {
    for (const message of ['chore: workspace', 'feat(L9): workspace', 'feat(L1,L2): workspace']) {
      const { commit, verifier } = integration();
      commit(message, ['vitest.workspace.ts', 'b']);
      expect(verifier().code, message).toBe(1);
    }
  });

  it('bord — une config modifiée sans commit (arbre sale) n’est attribuée à aucun lot : refusée', () => {
    const { dir, verifier } = integration();
    writeFileSync(join(dir, 'vitest.workspace.ts'), 'b');
    expect(verifier().code).toBe(1);
  });

  it('bord — une clé de package.json changée par le lot de config passe, par un lot de code est refusée', () => {
    const ok = integration();
    ok.commit('feat(L1): scripts', ['package.json', '{"scripts":{"a":"b"}}']);
    expect(ok.verifier().code).toBe(0);
    const ko = integration();
    ko.commit('feat(L2): scripts', ['package.json', '{"scripts":{"a":"b"}}']);
    expect(ko.verifier().code).toBe(1);
  });
});
