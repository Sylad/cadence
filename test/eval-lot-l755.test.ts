import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { casesFor, evalCommand, pathsOf, readEvalEntries, readEvalRecords, runLotEvals } from '../src/lot-evals.js';
import { validateConfig } from '../src/config-set.js';
import { RafError } from '../src/plan.js';
import { git } from './orchestrate-harness.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

// L755 (D-26) : un lot qui touche un skill, un agent ou leur doc rejoue les cas d'éval du plugin qui les concernent avant d'être clos.
// Le 16-11, L744 (skills/lead, agents/livreur) a passé deux revues et n'a été vu rouge par livrer-sh-sans-bloc qu'à la publication de 2.0.12.

afterAll(cleanupTempDirs);

const root = join(import.meta.dirname, '..');

describe('la clé evals du dépôt cadence', () => {
  const entries = readEvalEntries(join(root, 'cadence.yaml'));
  const cases = readdirSync(join(root, 'evals'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'results').map((d) => d.name);

  it('lie chaque cas de evals/ à des fichiers, et ne cite aucun cas absent', () => {
    const cited = [...new Set(entries.flatMap((e) => e.cases))].sort();
    expect(cited).toEqual([...cases].sort());
  });

  it('les fichiers de L744 rejouent livrer-sh-sans-bloc (la régression de la publication 2.0.12)', () => {
    const l744 = ['agents/livreur.md', 'docs/lead.md', 'docs/skills.md', 'docs/specs/livreur-delegue/fiche.yaml', 'skills/lead/SKILL.md'];
    expect(casesFor(entries, l744)).toContain('livrer-sh-sans-bloc');
  });

  it('chaque skill du plugin est couvert par au moins un cas', () => {
    const skills = readdirSync(join(root, 'skills'));
    for (const s of skills) expect(casesFor(entries, [`skills/${s}/SKILL.md`]), s).not.toEqual([]);
  });

  it('docs/concepts.md, citée par skills/lead et porteuse de la réponse de deliver-sha, rejoue deliver-sha (revue L755)', () => {
    expect(casesFor(entries, ['docs/concepts.md'])).toContain('deliver-sha');
  });

  it('un lot de code seul ne rejoue rien', () => {
    expect(casesFor(entries, ['src/deliver.ts', 'test/deliver.test.ts'])).toEqual([]);
  });

  it('changer la question ou un grader d\'un cas rejoue ce cas (son dossier compte d\'office)', () => {
    expect(casesFor(entries, ['evals/deliver-sha/graders/option-sha.md'])).toEqual(['deliver-sha']);
    expect(pathsOf(entries, 'deliver-sha')).toContain('evals/deliver-sha/**');
  });
});

describe('readEvalEntries : forme de la clé', () => {
  const cfg = (text: string) => {
    const f = join(tempDir(), 'cadence.yaml');
    writeFileSync(f, text);
    return f;
  };
  it('absente : aucune entrée', () => {
    expect(readEvalEntries(cfg('orchestrate: {}\n'))).toEqual([]);
  });
  it.each([
    ['evals: { a: 1 }\n', /liste attendue/],
    ['evals:\n  - cases: [a]\n', /paths/],
    ['evals:\n  - paths: [skills/**]\n', /cases/],
    ['evals:\n  - paths: [skills/**]\n    cases: ["../x"]\n', /cases/],
    ['evals:\n  - paths: [skills/**]\n    cases: [a]\n    tests: [b]\n', /tests inconnu/],
  ])('refuse %j', (text, msg) => {
    expect(() => readEvalEntries(cfg(text))).toThrow(msg);
  });
});

describe('une clé evals mal formée est refusée, jamais une porte coupée en silence (revue L755)', () => {
  const malformees: [string, string, RegExp][] = [
    ['une carte au lieu d\'une liste', 'evals:\n  skills/a/**: [c1]\n', /evals : liste attendue/],
    ['case au lieu de cases', 'evals:\n  - paths: [skills/a/**]\n    case: [c1]\n', /evals\[0\]\.case inconnu/],
    ['un nom de cas avec une espace', 'evals:\n  - paths: [skills/a/**]\n    cases: [c 1]\n', /evals\[0\]\.cases/],
  ];

  it.each(malformees)('validateConfig (porte qui relit cadence.yaml) refuse %s', (_, text, msg) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), text);
    expect(() => validateConfig(join(dir, 'cadence.yaml'), dir)).toThrow(msg);
  });

  it.each(malformees)('raf done refuse un lot quand la clé evals est mal formée (%s), --force avertit', (_, text, msg) => {
    const repo = depot();
    commit(repo, 'chore: evals cassée', { 'cadence.yaml': text });
    commit(repo, 'feat(L1): skill a', { 'skills/a/SKILL.md': 'v2\n' });
    const refus = cli(repo, {}, 'done', 'L1', '--now');
    expect(refus.code).not.toBe(0);
    expect(refus.err).toMatch(msg);
    expect(refus.err).toMatch(/porte des cas d'éval/);
    const forced = cli(repo, {}, 'done', 'L1', '--force', '--now');
    expect(forced.out).toContain('L1 → done');
    expect(forced.err).toMatch(/avertissement : .*evals/);
  });
});

describe('evalCommand : la commande d\'un cas', () => {
  it('sans script eval:plugin : claude plugin eval ., bras with seul', () => {
    const repo = tempDir();
    expect(evalCommand(repo, 'c1', 'evals/results/x')).toEqual(['claude', 'plugin', 'eval', '.', '--no-publish', '--trust-plugin', '--case', 'c1', '--ablation', 'none', '-j', '3', '--output-dir', 'evals/results/x']);
  });
  it('avec eval:plugin et scripts/eval-plugin.mjs : la commande de la publication, enveloppée par le rejeu (L740)', () => {
    const repo = tempDir();
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'eval:plugin': 'claude plugin eval . --max-cost-usd 5 --no-publish' } }));
    expect(evalCommand(repo, 'c1', 'd').slice(0, 6)).toEqual(['npm', 'run', 'eval:plugin', '--', '--trust-plugin', '--case']);
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'scripts/eval-plugin.mjs'), '');
    expect(evalCommand(repo, 'c1', 'd').slice(0, 5)).toEqual(['node', 'scripts/eval-plugin.mjs', 'npm', 'run', 'eval:plugin']);
  });
});

/** Un faux `claude` : écrit aggregate-result.json dans --output-dir avec le score de FAUX_SCORE et sort avec FAUX_CODE ; note chaque appel. */
function fauxClaude(): string {
  const bin = tempDir();
  const f = join(bin, 'claude');
  writeFileSync(f, `#!/usr/bin/env node
const a = process.argv.slice(2);
const at = (n) => a[a.indexOf(n) + 1];
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(bin, 'appels.log'))}, a.join(' ') + '\\n');
fs.mkdirSync(at('--output-dir'), { recursive: true });
fs.writeFileSync(at('--output-dir') + '/aggregate-result.json', JSON.stringify({ suite: { threshold: 1 }, cases: [{ name: at('--case'), aggregates: { score: Number(process.env.FAUX_SCORE ?? 1) } }] }));
process.exit(Number(process.env.FAUX_CODE ?? 0));
`);
  chmodSync(f, 0o755);
  return bin;
}

const commit = (repo: string, message: string, files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), t);
  }
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
};

function cli(repo: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-11-16', PATH: process.env.PATH ?? '', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-16T10:00:00Z') }) as number;
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    err.push(e.message);
    code = 2;
  }
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt avec deux cas (c1 couvre skills/a, c2 couvre docs/b.md), et L1 démarré. */
function depot() {
  const repo = gitRepo();
  commit(repo, 'chore: base', {
    'cadence.yaml': 'evals:\n  - paths: [skills/a/**]\n    cases: [c1]\n  - paths: [docs/b.md]\n    cases: [c2]\n',
    'evals/c1/prompt.md': 'q1\n',
    'evals/c2/prompt.md': 'q2\n',
    'skills/a/SKILL.md': 'v1\n',
    'docs/b.md': 'b\n',
    '.gitignore': 'evals/results/\n',
  });
  cli(repo, {}, 'init', '--project', 'demo');
  cli(repo, {}, 'add', 'Lot un');
  cli(repo, {}, 'start', 'L1');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'plan: L1');
  return repo;
}

describe('raf done et cadence eval (L755)', () => {
  it('refuse de clore un lot qui touche un skill couvert sans verdict, puis le clôt après un cadence eval vert', () => {
    const repo = depot();
    const bin = fauxClaude();
    const env = { PATH: `${bin}:${process.env.PATH}` };
    commit(repo, 'feat(L1): skill a', { 'skills/a/SKILL.md': 'v2\n' });

    const refus = cli(repo, env, 'done', 'L1');
    expect(refus.code).not.toBe(0);
    expect(refus.err).toMatch(/c1 \(jamais rejoué\)/);
    expect(refus.err).toContain('cadence eval L1');
    expect(refus.err).not.toContain('c2');

    const ev = cli(repo, env, 'eval', 'L1');
    expect(ev.err).toBe('');
    expect(ev.code).toBe(0);
    expect(readFileSync(join(bin, 'appels.log'), 'utf8')).toMatch(/^plugin eval \. --no-publish --trust-plugin --case c1 --ablation none -j 3 --output-dir evals\/results\/L1-c1-/);
    const [r] = readEvalRecords(repo);
    expect(r).toMatchObject({ case: 'c1', lot: 'L1', code: 0, score: 1, sha: git(repo, 'rev-parse', 'HEAD') });

    const ok = cli(repo, env, 'done', 'L1', '--now');
    expect(ok.err).not.toMatch(/éval/);
    expect(ok.out).toContain('L1 → done');
  });

  it('un commit de plan au-dessus du verdict ne le périme pas ; un changement du skill, si', () => {
    const repo = depot();
    const env = { PATH: `${fauxClaude()}:${process.env.PATH}` };
    commit(repo, 'feat(L1): skill a', { 'skills/a/SKILL.md': 'v2\n' });
    expect(cli(repo, env, 'eval', 'L1').code).toBe(0);
    commit(repo, 'plan: note', { '.cadence/raf.yaml': `${readFileSync(join(repo, '.cadence/raf.yaml'), 'utf8')}\n` });
    commit(repo, 'feat(L1): skill a, suite', { 'skills/a/SKILL.md': 'v3\n' });
    const refus = cli(repo, env, 'done', 'L1');
    expect(refus.err).toMatch(/c1 \(fichiers changés depuis le dernier verdict/);
  });

  it('un cas rouge refuse le lot en le disant, --force passe avec un avertissement', () => {
    const repo = depot();
    const env = { PATH: `${fauxClaude()}:${process.env.PATH}`, FAUX_CODE: '1', FAUX_SCORE: '0.67' };
    commit(repo, 'feat(L1): doc b', { 'docs/b.md': 'b2\n' });
    const ev = cli(repo, env, 'eval', 'L1');
    expect(ev.code).toBe(1);
    expect(ev.out).toMatch(/c2 : rouge \(code 1\), score 0,67/);
    expect(cli(repo, env, 'done', 'L1').err).toMatch(/c2 \(rouge au dernier rejeu/);
    const forced = cli(repo, env, 'done', 'L1', '--force', '--now');
    expect(forced.out).toContain('L1 → done');
    expect(forced.err).toMatch(/avertissement : L1 : touche docs\/b\.md/);
  });

  it('un lot qui ne touche aucun fichier couvert se clôt sans éval', () => {
    const repo = depot();
    commit(repo, 'feat(L1): code', { 'src/x.ts': 'x\n' });
    const ok = cli(repo, {}, 'done', 'L1', '--now');
    expect(ok.out).toContain('L1 → done');
    expect(cli(repo, {}, 'eval', 'L1').out).toMatch(/rien à rejouer/);
  });

  it('cadence eval refuse un fichier couvert non commité ; --dry-run dit la commande sans rien lancer', () => {
    const repo = depot();
    const bin = fauxClaude();
    const env = { PATH: `${bin}:${process.env.PATH}` };
    commit(repo, 'feat(L1): skill a', { 'skills/a/SKILL.md': 'v2\n' });
    const dry = cli(repo, env, 'eval', 'L1', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/L1 · c1 : claude plugin eval \./);
    expect(existsSync(join(bin, 'appels.log'))).toBe(false);
    writeFileSync(join(repo, 'skills/a/SKILL.md'), 'v3 non commité\n');
    const refus = cli(repo, env, 'eval', 'L1');
    expect(refus.err).toMatch(/skills\/a\/SKILL\.md non commité/);
    expect(readEvalRecords(repo)).toEqual([]);
  });

  it('runLotEvals : un cas cité absent de evals/ est refusé avant tout lancement', () => {
    const repo = gitRepo();
    commit(repo, 'base', { 'x.md': 'x\n' });
    let ran = 0;
    expect(() => runLotEvals({ root: repo, entries: [{ paths: ['x.md'], cases: ['absent'] }], id: 'L1', files: ['x.md'] }, { run: () => ran++, now: new Date(), out: () => {} })).toThrow(/introuvable/);
    expect(ran).toBe(0);
  });
});
