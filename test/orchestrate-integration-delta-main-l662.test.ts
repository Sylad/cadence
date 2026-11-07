import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run as cli } from '../src/cli.js';
import { recordedGate } from '../src/gate-record.js';
import { deltaPlanOnly, fullSuiteGreen } from '../src/orchestrate/cycle/integration-porte.js';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store } from './orchestrate-worktree-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (2) : après « main a avancé », la porte d'intégration n'est sautée que si le delta de main ne change que le plan (ni code, ni test, ni script, ni fichier racine, ni docs).
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
/** Un dépôt : un commit de base, puis un delta de main (les fichiers de `delta`). */
function scene(delta: string[]) {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const from = put(repo, 'base.txt');
  for (const f of delta) put(repo, f);
  const to = git(repo, 'rev-parse', 'HEAD');
  return { repo, from, to };
}
/** Les fichiers du plan d'un projet (`planFileSet`) : le plan et sa page Gantt. */
const PLAN = new Set(['.cadence/raf.yaml', '.cadence/gantt.html']);

describe('L662 R4 — deltaPlanOnly : le delta de main ne change-t-il que le plan ?', () => {
  it('R4 — un delta sans fichier (rien n\'a bougé) : plan seul', () => {
    const s = scene([]);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(true);
  });
  it('R4 — un commit de plan (le fichier du plan) : plan seul, la porte est sautée', () => {
    const s = scene(['.cadence/raf.yaml']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(true);
  });
  it('R4 — le plan et sa page Gantt : plan seul', () => {
    const s = scene(['.cadence/raf.yaml', '.cadence/gantt.html']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(true);
  });
  it('R4 — le plan et un fichier de code : pas plan seul', () => {
    const s = scene(['.cadence/raf.yaml', 'src/a/x.ts']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(false);
  });
  it('R4 — un fichier de code hors du dossier du lot (lib/api.txt, le lot est dans app/) : pas plan seul, la porte rejoue (un import n\'est pas cherché)', () => {
    const s = scene(['lib/api.txt']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(false);
  });
  it('R4 — un nouveau test de main : pas plan seul, la porte rejoue', () => {
    const s = scene(['test/nouveau.test.ts']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(false);
  });
  it('R4 — une page de docs (des tests la lisent) : pas plan seul', () => {
    const s = scene(['docs/x.md']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(false);
  });
  it('R4 — CHANGELOG.md (test/changelog.test.ts le lit) : pas plan seul', () => {
    const s = scene(['CHANGELOG.md']);
    expect(deltaPlanOnly(s.repo, s.from, s.to, PLAN)).toBe(false);
  });
  it('R4 — un fichier racine que la porte exécute (package.json), un script (scripts/qualite.mjs) : pas plan seul', () => {
    expect(deltaPlanOnly(...Object.values(scene(['package.json'])) as [string, string, string], PLAN)).toBe(false);
    expect(deltaPlanOnly(...Object.values(scene(['scripts/qualite.mjs'])) as [string, string, string], PLAN)).toBe(false);
  });
  it('R4 — un sha que git ne lit pas : pas plan seul (le doute rejoue la porte)', () => {
    const s = scene(['.cadence/raf.yaml']);
    expect(deltaPlanOnly(s.repo, 'f'.repeat(40), s.to, PLAN)).toBe(false);
  });
  it('R4 — aucun fichier de plan connu : seul un delta vide est plan seul', () => {
    expect(deltaPlanOnly(...Object.values(scene(['.cadence/raf.yaml'])) as [string, string, string], new Set())).toBe(false);
    expect(deltaPlanOnly(...Object.values(scene([])) as [string, string, string], new Set())).toBe(true);
  });
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
/** Le commit de plan du lead pendant la revue courte : une note ajoutée au plan. */
const planNote = (repo: string) => `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}# note du lead\n`;
const planOnly = (yaml = '') => scenario('.cadence/raf.yaml', yaml, planNote);
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

describe('L662 R5 — la porte d\'intégration rejouée après « main a avancé », sauf pour un delta de plan seul', () => {
  it('R5 — le lead commite le plan seul : le rebase est rejoué, la suite complète du sommet ne l\'est pas', async () => {
    const code = await scenario('src/g.txt');
    const plan = await planOnly();
    expect(plan.r.code).toBe(0);
    expect(plan.r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(plan.r.out).toContain('porte d\'intégration non rejouée');
    expect(plan.r.out).toContain('ne change que le plan');
    expect(plan.suites).toHaveLength(code.suites.length - 1);
  });
  it('R5 — le lead commite un voisin du fichier du lot : la porte est rejouée, aucune ligne « non rejouée »', async () => {
    const { r, parent } = await scenario('src/g.txt');
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
  it('R5 — un fichier hors du dossier du lot (lib/api.txt, le lot est dans src/), un nouveau test, une page de docs : la porte est rejouée à chaque fois', async () => {
    for (const leadFile of ['lib/api.txt', 'test/nouveau.test.ts', 'docs/lead.md']) {
      const { r, parent, suites } = await scenario(leadFile);
      expect(r.code, leadFile).toBe(0);
      expect(r.out, leadFile).toContain("main a avancé pendant l'intégration, rebase rejoué");
      expect(r.out, leadFile).not.toContain("porte d'intégration non rejouée");
      expect(store(parent).readLot('a', 'L2')!.checks!.reprise, leadFile).toBeUndefined();
      expect(suites.length, leadFile).toBeGreaterThan(0);
    }
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
    const s = await planOnly();
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
    expect(v.text).toContain('plan seul');
  });
  it('R5 — le sommet de main, sous lequel ne reposent que des commits de plan, reprend aussi la porte sautée', async () => {
    const s = await planOnly();
    const before = portes(s.log);
    const v = await verify(s.repo, git(s.repo, 'rev-parse', 'main'));
    expect(v.code).toBe(0);
    expect(portes(s.log)).toBe(before);
    expect(v.text).toContain('plan seul');
  });
  it('R5 — un delta qui touche le lot : la porte joue au sommet, l\'enregistrement n\'est pas une reprise', async () => {
    const s = await scenario('src/g.txt');
    const k = store(s.parent).readLot('a', 'L2')!.checks!;
    expect(k.head).toBe(lotTip(s.repo));
    expect(k.reprise).toBeUndefined();
  });
  it('R5 — un fichier changé après la reprise : l\'arbre n\'est plus celui enregistré, verify --gate rejoue', async () => {
    const s = await planOnly();
    const sha = put(s.repo, 'docs/apres.txt');
    const before = portes(s.log);
    const v = await verify(s.repo, sha);
    expect(v.text).toContain('verdict rejoué');
    expect(portes(s.log)).toBeGreaterThan(before);
  });
  it('R5 — `orchestrate.gate.readsPlan` déclaré : un delta de plan a un effet sur un test, la porte joue au sommet', async () => {
    const s = await planOnly('gate: { readsPlan: true }');
    expect(s.r.code).toBe(0);
    expect(s.r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(s.r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(s.parent).readLot('a', 'L2')!.checks!.reprise).toBeUndefined();
  });
  it('R5 — sans déclaration, le même delta de plan seul saute la porte', async () => {
    const s = await planOnly();
    expect(s.r.out).toContain("porte d'intégration non rejouée");
    expect(store(s.parent).readLot('a', 'L2')!.checks!.reprise).toBeDefined();
  });
  it('R5 — la revue courte après une reprise ne lit pas « contrôles joués à HEAD » : le brief dit le sha d\'origine', async () => {
    const s = await planOnly();
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
    const s = await planOnly();
    const sha = lotTip(s.repo);
    const found = recordedGate([s.parent], s.repo, sha, [{ name: 'tests', cmd: `echo "FULL $PWD" >> ${s.log}` }]);
    expect(found).toHaveProperty('found');
    expect('found' in found && found.found.reprise?.head).toBe(store(s.parent).readLot('a', 'L2')!.checks!.reprise!.head);
  });
});
