import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run as cli } from '../src/cli.js';
import { recordedGate } from '../src/gate-record.js';
import { deltaTouchesLot, fullSuiteGreen } from '../src/orchestrate/cycle/integration-porte.js';
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
  it('R4 — le delta est le CHANGELOG.md d\'un autre lot et le lot touche CHANGELOG.md : non lié (tous les lots le touchent)', () => {
    const s = scene(['src/a/x.ts', 'CHANGELOG.md'], ['CHANGELOG.md']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — un lot qui touche CHANGELOG.md ne lie pas un fichier de la racine (package.json) par voisinage : non lié', () => {
    const s = scene(['src/a/x.ts', 'CHANGELOG.md'], ['package.json']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — un lot dont un fichier est à la racine ne lie pas un autre fichier de la racine : non lié', () => {
    const s = scene(['README.md'], ['cadence.yaml.bak']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
  it('R4 — le delta touche un fichier racine du lot lui-même (package.json) : lié', () => {
    const s = scene(['package.json', 'CHANGELOG.md'], ['package.json']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(true);
  });
  it('R4 — un diff de lot vide : le delta de main ne peut lier que par `bounds`, donc non lié', () => {
    const s = scene([], ['src/a/x.ts']);
    expect(deltaTouchesLot(s.repo, s.from, s.to, s.lot)).toBe(false);
  });
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
/** Deux lots modifient `src/f.txt` ; pendant la revue courte du second, le lead commite `leadFile` sur main (une fois) : le rebase est rejoué. Rend les suites complètes jouées au sommet de L2 et le journal. */
async function scenario(leadFile: string, yaml = '', leadText?: (repo: string) => string) {
  const log = join(tempDir(), 'portes.log');
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], `worktrees: true\ntest: echo "FULL $PWD" >> ${log}\n${yaml}`, {});
  put(repo, 'src/f.txt', lines(12));
  let moved = 0;
  const shortBriefs: string[] = [];
  const f = fake({
    implement: async (cwd, brief) => {
      await meeting(2)();
      const lot = lotOf(brief);
      const n = lot === 'L1' ? 4 : 7;
      writeFileSync(join(cwd, 'src/f.txt'), lines(12).replace(`l${n}\n`, `l${n} par ${lot}\n`));
      git(cwd, 'add', '--', 'src/f.txt');
      git(cwd, 'commit', '-q', '-m', `feat(${lot}): travail`);
      return claudeOut(workReport({ commits: [{ sha: git(cwd, 'rev-parse', 'HEAD'), sujet: `feat(${lot}): travail` }] }));
    },
    'review-small': async (_cwd, brief) => {
      shortBriefs.push(brief);
      if (!moved++) put(repo, leadFile, leadText?.(repo));
      return claudeOut(reviewReport({ verdict: 'rebase sans dégât' }));
    },
  });
  const r = await run(parent, ['a:L1', 'a:L2', '--max-sessions', '2'], f);
  const suites = readFileSync(log, 'utf8').trim().split('\n').filter((x) => x.includes('/worktrees/') && !x.includes('baseline'));
  return { r, parent, suites, repo, log, shortBriefs };
}

describe('L662 R5 — la porte d\'intégration rejouée après « main a avancé » seulement si le delta est lié', () => {
  it('R5 — le lead commite un fichier sans lien avec le lot : le rebase est rejoué, la suite complète du sommet ne l\'est pas', async () => {
    const lié = await scenario('src/g.txt');
    const sansLien = await scenario('docs/lead.txt');
    expect(sansLien.r.code).toBe(0);
    expect(sansLien.r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(sansLien.r.out).toContain('porte d\'intégration non rejouée');
    expect(sansLien.suites).toHaveLength(lié.suites.length - 1);
  });
  it('R5 — le lead commite un voisin du fichier du lot : la porte est rejouée, aucune ligne « non rejouée »', async () => {
    const { r, parent } = await scenario('src/g.txt');
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
});

const portes = (log: string) => readFileSync(log, 'utf8').trim().split('\n').length;
const verify = async (repo: string, sha: string) => {
  const lines: string[] = [];
  const code = await cli(['verify', '--gate', '--sha', sha], { cwd: repo, env: {}, out: (x: string) => lines.push(x), err: (x: string) => lines.push(x), now: () => new Date('2026-11-06T12:00:00') });
  return { code, text: lines.join('\n') };
};
const lotTip = (repo: string) => git(repo, 'log', '--format=%H', '--grep=feat(L2)', '--fixed-strings', '-1', 'main');

describe('L662 R5 — la porte sautée reste reconnue au sha rebasé, et dit d\'où elle vient', () => {
  it('R5 — verify --gate --sha <sha rebasé> : rien n\'est rejoué, la sortie nomme le sha d\'origine et le delta jugé sans lien', async () => {
    const s = await scenario('docs/lead.txt');
    expect(s.r.out).toContain('porte d\'intégration non rejouée');
    const sha = lotTip(s.repo);
    const before = portes(s.log);
    const v = await verify(s.repo, sha);
    expect(v.code).toBe(0);
    expect(portes(s.log)).toBe(before);
    const k = store(s.parent).readLot('a', 'L2')!.checks!;
    expect(k.head).toBe(sha);
    expect(k.tree).toBe(git(s.repo, 'rev-parse', `${sha}^{tree}`));
    expect(k.reprise!.head).not.toBe(sha);
    expect(v.text).toContain('verdict repris');
    expect(v.text).toContain(k.reprise!.head.slice(0, 7));
    expect(v.text).toContain(`${k.reprise!.from.slice(0, 7)}..${k.reprise!.to.slice(0, 7)}`);
    expect(v.text).toContain('sans lien avec le lot');
  });
  it('R5 — le sommet de main, sous lequel ne reposent que des commits de plan, reprend aussi la porte sautée', async () => {
    const s = await scenario('docs/lead.txt');
    const before = portes(s.log);
    const v = await verify(s.repo, git(s.repo, 'rev-parse', 'main'));
    expect(v.code).toBe(0);
    expect(portes(s.log)).toBe(before);
    expect(v.text).toContain('sans lien avec le lot');
  });
  it('R5 — un delta qui touche le lot : la porte joue au sommet, l\'enregistrement n\'est pas une reprise', async () => {
    const s = await scenario('src/g.txt');
    const k = store(s.parent).readLot('a', 'L2')!.checks!;
    expect(k.head).toBe(lotTip(s.repo));
    expect(k.reprise).toBeUndefined();
  });
  it('R5 — un fichier changé après la reprise : l\'arbre n\'est plus celui enregistré, verify --gate rejoue', async () => {
    const s = await scenario('docs/lead.txt');
    const sha = put(s.repo, 'docs/apres.txt');
    const before = portes(s.log);
    const v = await verify(s.repo, sha);
    expect(v.text).toContain('verdict rejoué');
    expect(portes(s.log)).toBeGreaterThan(before);
  });
  it('R5 — `orchestrate.gate.readsPlan` déclaré : un delta de plan a un effet sur un test, la porte joue au sommet', async () => {
    const plan = (repo: string) => `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}# note du lead\n`;
    const s = await scenario('.cadence/raf.yaml', 'gate: { readsPlan: true }', plan);
    expect(s.r.code).toBe(0);
    expect(s.r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(s.r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(s.parent).readLot('a', 'L2')!.checks!.reprise).toBeUndefined();
  });
  it('R5 — sans déclaration, le même delta de plan reste sans lien (la porte n\'est pas rejouée)', async () => {
    const plan = (repo: string) => `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}# note du lead\n`;
    const s = await scenario('.cadence/raf.yaml', '', plan);
    expect(s.r.out).toContain("porte d'intégration non rejouée");
    expect(store(s.parent).readLot('a', 'L2')!.checks!.reprise).toBeDefined();
  });
  it('R5 — la revue courte après une reprise ne lit pas « contrôles joués à HEAD » : le brief dit le sha d\'origine', async () => {
    const s = await scenario('docs/lead.txt');
    const k = store(s.parent).readLot('a', 'L2')!.checks!;
    expect(s.shortBriefs.length).toBeGreaterThan(1);
    const last = s.shortBriefs.at(-1)!;
    expect(last).toContain(`at ${k.reprise!.head.slice(0, 7)}, before the rebase`);
    expect(last).not.toContain(`at HEAD ${k.head.slice(0, 7)}, just before this review`);
  });
  it('R5 — une reprise n\'est pas une suite jouée à cet arbre : une nouvelle intégration la rejoue', () => {
    const runs = [{ label: 'tests' as const, command: 'npm test', code: 0 }];
    const c = (reprise?: { head: string; tree?: string; from: string; to: string }) => ({ lot: { checks: { head: 'b', tree: 'T', runs, ...(reprise ? { reprise } : {}) } }, config: { test: 'npm test' } }) as never;
    expect(fullSuiteGreen(c(), 'T')).toBe(true);
    expect(fullSuiteGreen(c({ head: 'a', tree: 'S', from: 'x', to: 'y' }), 'T')).toBe(false);
  });
  it('R5 — recordedGate rend l\'origine du verdict repris', async () => {
    const s = await scenario('docs/lead.txt');
    const sha = lotTip(s.repo);
    const found = recordedGate([s.parent], s.repo, sha, [{ name: 'tests', cmd: `echo "FULL $PWD" >> ${s.log}` }]);
    expect(found).toHaveProperty('found');
    expect('found' in found && found.found.reprise?.head).toBe(store(s.parent).readLot('a', 'L2')!.checks!.reprise!.head);
  });
});
