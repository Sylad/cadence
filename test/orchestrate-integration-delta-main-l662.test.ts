import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deltaTouchesLot } from '../src/orchestrate/cycle/integration-porte.js';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store } from './orchestrate-worktree-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (2) : après « main a avancé », la porte d'intégration n'est rejouée que si le delta de main touche un fichier ou un test lié au diff du lot.
const fileHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = fileHome;
  cleanupTempDirs();
});

const put = (repo: string, file: string, text = 'x\n') => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', `chore: ${file}`);
  return git(repo, 'rev-parse', 'HEAD');
};
/** Un dépôt : un commit de base, un delta de main (les fichiers de `delta`), et le diff du lot (`lot`) posé sur la base. */
function scene(lot: string[], delta: string[], yaml = '') {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'cadence.yaml'), yaml);
  const from = put(repo, 'base.txt');
  for (const f of delta) put(repo, f);
  const to = git(repo, 'rev-parse', 'HEAD');
  return { repo, from, to, lot };
}

describe('L662 R4 — deltaTouchesLot : le delta de main est-il lié au diff du lot ?', () => {
  it('R4 — un delta sans fichier (rien n\'a bougé) : non lié', () => {
    const s = scene(['src/a/x.ts'], []);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — un commit de plan d\'un autre dossier : non lié', () => {
    const s = scene(['src/a/x.ts'], ['.cadence/raf.yaml']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — le delta touche un fichier du diff du lot : lié', () => {
    const s = scene(['src/a/x.ts'], ['src/a/x.ts']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(true);
  });
  it('R4 — le delta touche un voisin du fichier de code du lot (même dossier) : lié', () => {
    const s = scene(['src/a/x.ts'], ['src/a/y.ts']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(true);
  });
  it('R4 — le delta touche un test que `bounds` déclare pour un fichier du lot : lié', () => {
    const s = scene(['README.md'], ['test/readme.test.ts'], 'bounds:\n  - { paths: [README.md], lines: 64, tests: [test/readme.test.ts] }\n');
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(true);
  });
  it('R4 — le delta touche un autre test, d\'un autre sujet : non lié', () => {
    const s = scene(['src/a/x.ts'], ['test/autre.test.ts']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — le dossier de tests du lot n\'est pas un voisinage : le test du lot dans test/ ne lie pas un test d\'un autre lot', () => {
    const s = scene(['src/a/x.ts', 'test/a.test.ts'], ['test/autre.test.ts']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — un sha que git ne lit pas : lié (le doute rejoue la porte)', () => {
    const s = scene(['src/a/x.ts'], ['docs/x.md']);
    expect(deltaTouchesLot(s.repo, 'f'.repeat(40), s.to, s.lot)).toBe(true);
  });
  it('R4 — un diff de lot vide : le delta de main ne peut lier que par `bounds`, donc non lié', () => {
    const s = scene([], ['src/a/x.ts']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
/** Deux lots modifient `f.txt` (à la racine) ; pendant la revue courte du second, le lead commite `leadFile` sur main (une fois) : le rebase est rejoué. Rend les suites complètes jouées au sommet de L2 et le journal. */
async function scenario(leadFile: string) {
  const log = join(tempDir(), 'portes.log');
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], `worktrees: true\ntest: echo "FULL $PWD" >> ${log}`, { 'f.txt': lines(12) });
  let moved = 0;
  const f = fake({
    implement: async (cwd, brief) => {
      await meeting(2)();
      const lot = lotOf(brief);
      const n = lot === 'L1' ? 4 : 7;
      writeFileSync(join(cwd, 'f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
      git(cwd, 'add', '--', 'f.txt');
      git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
      return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
    },
    'review-small': async () => {
      if (!moved++) put(repo, leadFile);
      return claudeOut(reviewReport({ verdict: 'rebase sans dégât' }));
    },
  });
  const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  const suites = readFileSync(log, 'utf8').trim().split('\n').filter((x) => x.includes('/worktrees/') && !x.includes('baseline'));
  return { r, parent, suites, repo };
}

describe('L662 R5 — la porte d\'intégration rejouée après « main a avancé » seulement si le delta est lié', () => {
  it('R5 — le lead commite un fichier sans lien avec le lot : le rebase est rejoué, la suite complète du sommet ne l\'est pas', async () => {
    const lié = await scenario('g.txt');
    const sansLien = await scenario('docs/lead.txt');
    expect(sansLien.r.code).toBe(0);
    expect(sansLien.r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(sansLien.r.out).toContain('porte d\'intégration non rejouée');
    expect(sansLien.suites).toHaveLength(lié.suites.length - 1);
  });
  it('R5 — le lead commite un voisin du fichier du lot : la porte est rejouée, aucune ligne « non rejouée »', async () => {
    const { r, parent } = await scenario('g.txt');
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
});
