import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appliquer, BASELINE, lireRef } from '../scripts/qualite.mjs';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterAll(cleanupTempDirs);

const plan = (id1: string) => `lots:\n  - id: ${id1}\n    title: "config"\n    status: doing\n    config: true\n  - id: L2\n    title: "code"\n    status: doing\n`;

function integration(planTexte = plan('L1')) {
  const dir = gitRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, BASELINE), '{}');
  writeFileSync(join(dir, 'vitest.workspace.ts'), 'a');
  writeFileSync(join(dir, '.cadence/raf.yaml'), planTexte);
  git('add', '-A');
  git('commit', '-qm', 'depart');
  git('checkout', '-qb', 'integration');
  const commit = (message: string, ...fichiers: [string, string | null][]) => {
    for (const [f, c] of fichiers) {
      if (c === null) rmSync(join(dir, f));
      else { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
    }
    git('add', '-A', '--', ...fichiers.map(([f]) => f));
    git('commit', '-qm', message);
  };
  return { dir, commit, verifier: () => appliquer(dir, 'verifier', {}, lireRef(dir, 'main')) };
}

describe('L613 — bords de la reconnaissance du lot de config à ses commits', () => {
  it('un id de lot entre guillemets au plan est reconnu comme config', () => {
    const { commit, verifier } = integration(plan('"L1"'));
    commit('feat(L1): workspace', ['vitest.workspace.ts', 'b']);
    expect(verifier().code).toBe(0);
  });

  it('un scope avec espaces et plusieurs lots de config (feat(L1, L3)) passe', () => {
    const p = `${plan('L1')}  - id: L3\n    title: "c"\n    status: doing\n    config: true\n`;
    const { commit, verifier } = integration(p);
    commit('feat(L1, L3): workspace', ['vitest.workspace.ts', 'b']);
    expect(verifier().code).toBe(0);
  });

  it('une config supprimée par le lot de config passe, par un lot de code est refusée', () => {
    const ok = integration();
    ok.commit('feat(L1): sans workspace', ['vitest.workspace.ts', null]);
    expect(ok.verifier().code).toBe(0);
    const ko = integration();
    ko.commit('feat(L2): sans workspace', ['vitest.workspace.ts', null]);
    expect(ko.verifier().code).toBe(1);
  });

  it('un lot ne se déclare pas exempté : un commit qui passe L2 en config: true au plan ne l’exempte pas', () => {
    const { commit, verifier } = integration();
    commit('feat(L2): se déclare', ['.cadence/raf.yaml', plan('L1') + '    config: true\n']);
    commit('feat(L2): workspace', ['vitest.workspace.ts', 'b']);
    expect(verifier().code).toBe(1);
  });

  it('un scope mentionné ailleurs que dans le préfixe (« chore: x (L1) ») n’exempte pas', () => {
    const { commit, verifier } = integration();
    commit('chore: workspace (L1)', ['vitest.workspace.ts', 'b']);
    expect(verifier().code).toBe(1);
  });

  it('config de lot de config modifiée puis remise à l’identique par un lot de code : rien ne diffère, passe', () => {
    const { commit, verifier } = integration();
    commit('feat(L1): workspace', ['vitest.workspace.ts', 'b']);
    commit('feat(L2): remet', ['vitest.workspace.ts', 'a']);
    expect(verifier().code).toBe(0);
  });

  it('une autre config touchée par un lot de code reste refusée même si une première vient du lot de config', () => {
    const { commit, verifier } = integration();
    commit('feat(L1): workspace', ['vitest.workspace.ts', 'b']);
    commit('feat(L2): eslint', ['eslint.config.mjs', 'export default [];\n']);
    const r = verifier();
    expect(r.code).toBe(1);
    expect(r.texte).toContain('eslint.config.mjs');
  });

  it('sans commit depuis le départ (HEAD = départ), rien à juger : passe', () => {
    const { verifier } = integration();
    expect(verifier().code).toBe(0);
  });
});
