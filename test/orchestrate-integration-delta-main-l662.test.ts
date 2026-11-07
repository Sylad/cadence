import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run as cli } from '../src/cli.js';
import { recordedGate } from '../src/gate-record.js';
import { deltaCrossable, fullSuiteGreen } from '../src/orchestrate/cycle/integration-porte.js';
import { claudeOut, git, reviewReport, workReport } from './orchestrate-harness.js';
import { fake, lotOf, meeting, run, setup, store } from './orchestrate-worktree-harness.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

// L662 (2) : après « main a avancé », la porte d'intégration n'est sautée que si le delta de main est celui que `verify --gate` traverserait : des commits du seul fichier du plan, qu'aucun test ne lit (crossablePlan, planChain).
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
/** Un dépôt : un commit de base (`files` déjà présents, pour un lecteur du plan), puis un commit de main par entrée de `delta` (une liste = un commit de plusieurs fichiers). */
function scene(delta: (string | string[])[], files: Record<string, string> = {}) {
  const repo = tempDir();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
    git(repo, 'add', '--', f);
  }
  const from = put(repo, 'base.txt');
  delta.forEach((d, i) => {
    const fs = Array.isArray(d) ? d : [d];
    for (const f of fs) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), `${f} ${i}\n`);
    }
    git(repo, 'add', '--', ...fs);
    git(repo, 'commit', '-q', '-m', `chore: ${fs.join(' ')}`);
  });
  const to = git(repo, 'rev-parse', 'HEAD');
  return { repo, from, to };
}
const PLAN = '.cadence/raf.yaml';
const crossable = (s: { repo: string; from: string; to: string }, declared: unknown = undefined) => deltaCrossable(s.repo, s.from, s.to, PLAN, declared);

describe('L662 R4 — deltaCrossable : le delta de main est-il celui que verify --gate traverserait ?', () => {
  it('R4 — un delta sans commit (rien n\'a bougé) : traversable', () => {
    expect(crossable(scene([]))).toBe(true);
  });
  it('R4 — un commit du seul fichier du plan, sans lecteur : traversable, la porte est sautée', () => {
    expect(crossable(scene([PLAN]))).toBe(true);
  });
  it('R4 — deux commits de plan seul à la suite : traversables (planChain remonte jusqu\'à from)', () => {
    expect(crossable(scene([PLAN, PLAN]))).toBe(true);
  });
  it('R4 — le plan et sa page Gantt dans un même commit, ou la page Gantt seule : non traversable (verify --gate ne traverse que le fichier du plan)', () => {
    expect(crossable(scene([[PLAN, '.cadence/gantt.html']]))).toBe(false);
    expect(crossable(scene(['.cadence/gantt.html']))).toBe(false);
  });
  it('R4 — cas A : un fichier de plan.files (news.json) seul, gate.readsPlan déclaré : non traversable', () => {
    expect(crossable(scene(['news.json']), true)).toBe(false);
    expect(crossable(scene(['news.json']))).toBe(false);
  });
  it('R4 — le plan seul mais gate.readsPlan déclaré (true ou liste) : non traversable', () => {
    expect(crossable(scene([PLAN]), true)).toBe(false);
    expect(crossable(scene([PLAN]), ['test/plan.test.ts'])).toBe(false);
  });
  it('R4 — cas B : le plan seul, et un fichier du dépôt cite son chemin sans déclaration (lecteur deviné, L482) : non traversable', () => {
    expect(crossable(scene([PLAN], { 'check.sh': 'cat .cadence/raf.yaml\n' }))).toBe(false);
  });
  it('R4 — un lecteur dans docs/ ou dans un .md ne compte pas (L482 les exclut) : traversable', () => {
    expect(crossable(scene([PLAN], { 'docs/plan.md': 'voir .cadence/raf.yaml\n', 'NOTES.md': '.cadence/raf.yaml\n' }))).toBe(true);
  });
  it('R4 — le plan et un fichier de code dans un même commit, ou un commit de plan puis un commit de code : non traversable', () => {
    expect(crossable(scene([[PLAN, 'src/a/x.ts']]))).toBe(false);
    expect(crossable(scene([PLAN, 'src/a/x.ts']))).toBe(false);
  });
  it('R4 — un fichier de code hors du dossier du lot (lib/api.txt, le lot est dans app/), un nouveau test, une page de docs, CHANGELOG.md, package.json, un script : non traversable', () => {
    for (const f of ['lib/api.txt', 'test/nouveau.test.ts', 'docs/x.md', 'CHANGELOG.md', 'package.json', 'scripts/qualite.mjs']) expect(crossable(scene([f])), f).toBe(false);
  });
  it('R4 — un sha que git ne lit pas : non traversable (le doute rejoue la porte)', () => {
    const s = scene([PLAN]);
    expect(deltaCrossable(s.repo, 'f'.repeat(40), s.to, PLAN, undefined)).toBe(false);
    expect(deltaCrossable(s.repo, s.from, 'f'.repeat(40), PLAN, undefined)).toBe(false);
  });
  it('R4 — le fichier de plan d\'un autre chemin (plan.path du projet) : seul ce chemin compte', () => {
    const s = scene(['docs/plan/taches.yaml']);
    expect(deltaCrossable(s.repo, s.from, s.to, 'docs/plan/taches.yaml', undefined)).toBe(true);
    expect(crossable(s)).toBe(false);
  });
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';
/** Le commit de plan du lead pendant la revue courte : une note ajoutée au plan. */
const planNote = (repo: string) => `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}# note du lead\n`;
const planOnly = (yaml = '') => scenario('.cadence/raf.yaml', yaml, planNote);
/** Deux lots modifient `src/f.txt` ; pendant la revue courte du second, le lead commite `leadFile` sur main (une fois) : le rebase est rejoué. Rend les suites complètes jouées au sommet de L2 et le journal. */
async function scenario(leadFile: string, yaml = '', leadText?: (repo: string) => string, prepare?: (repo: string) => void) {
  const log = join(tempDir(), 'portes.log');
  const { parent, repo } = setup([{ title: 'un' }, { title: 'deux' }], `worktrees: true\ntest: echo "FULL $PWD" >> ${log}\n${yaml}`, {});
  put(repo, 'src/f.txt', lines(12));
  prepare?.(repo);
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
    expect(plan.r.out).toContain('ne change que le plan (.cadence/raf.yaml seul');
    expect(plan.suites).toHaveLength(code.suites.length - 1);
  });
  it('R5 — le lead commite un voisin du fichier du lot : la porte est rejouée, aucune ligne « non rejouée »', async () => {
    const { r, parent } = await scenario('src/g.txt');
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
  });
  it('R5 — cas A : news.json, listé dans plan.files, seul dans le delta, gate.readsPlan déclaré : la porte est rejouée, pas de reprise', async () => {
    const planFiles = (repo: string) => {
      writeFileSync(join(repo, 'cadence.yaml'), `plan:\n  files: [news.json]\n${readFileSync(join(repo, 'cadence.yaml'), 'utf8')}`);
      git(repo, 'add', '--', 'cadence.yaml');
      git(repo, 'commit', '-q', '-m', 'chore: plan.files');
      put(repo, 'news.json', '[]\n');
    };
    const { r, parent, suites } = await scenario('news.json', 'gate: { readsPlan: true }', () => '[1]\n', planFiles);
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(parent).readLot('a', 'L2')!.checks!.reprise).toBeUndefined();
    expect(store(parent).readLot('a', 'L2')!.status).toBe('ready');
    expect(suites.length).toBeGreaterThan(0);
  });
  it('R5 — cas B : le plan seul, cité par un fichier du dépôt sans gate.readsPlan (lecteur deviné, L482) : la porte est rejouée, pas de reprise', async () => {
    const reader = (repo: string) => put(repo, 'check.sh', 'grep -c L2 .cadence/raf.yaml\n');
    const { r, parent } = await scenario('.cadence/raf.yaml', '', planNote, reader);
    expect(r.code).toBe(0);
    expect(r.out).toContain("main a avancé pendant l'intégration, rebase rejoué");
    expect(r.out).not.toContain("porte d'intégration non rejouée");
    expect(store(parent).readLot('a', 'L2')!.checks!.reprise).toBeUndefined();
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
  it('R5 — verify --gate --sha <sha rebasé> : rien n\'est rejoué, la sortie nomme le sha d\'origine et le delta de plan seul', async () => {
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
  it('R5 — sans déclaration ni lecteur dans le dépôt, le même delta de plan seul saute la porte', async () => {
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
