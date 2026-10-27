import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { commit, gitRepo } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { docText } from './docs-text.js';

// L386 — un plan tenu par un autre outil (plan.lots dans cadence.yaml) ne reçoit jamais d'écriture de raf : l'acquittement docs-ok va dans .cadence/docs-ok.yaml.
const root = join(import.meta.dirname, '..');
const SYNC = 'docs:\n  sync:\n    - paths: [src/**]\n      docs: [README.md]\n';
const FOREIGN = `plan:\n  lots: lots\n${SYNC}`;

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-27' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-27T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt dont le plan est en lecture seule, avec L1 en cours et un commit de src/ sans README. */
async function lateForeignRepo() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Un lot');
  await cad(dir, 'start', 'L1');
  writeFileSync(join(dir, 'cadence.yaml'), FOREIGN);
  execFileSync('git', ['add', '--', '.cadence', 'cadence.yaml'], { cwd: dir });
  commit(dir, 'chore(L1): départ', '2026-10-27T08:00:00');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'x');
  execFileSync('git', ['add', '--', 'src/a.ts'], { cwd: dir });
  commit(dir, 'feat(L1): a', '2026-10-27T10:00:00');
  return dir;
}

describe('L386 — raf docs-ok sur un plan en lecture seule', () => {
  it('R1 — l\'écart est acquitté dans .cadence/docs-ok.yaml, le plan n\'est pas touché, et raf check ne compte plus le lot', async () => {
    const dir = await lateForeignRepo();
    expect((await cad(dir, 'check')).out).toContain('documentation');
    const plan = readFileSync(join(dir, '.cadence', 'raf.yaml'), 'utf8');
    const r = await cad(dir, 'docs-ok', 'L1', '--reason', 'la page décrit déjà ce comportement');
    expect(r.code).toBe(0);
    expect(r.out).toContain('.cadence/docs-ok.yaml');
    expect(readFileSync(join(dir, '.cadence', 'raf.yaml'), 'utf8')).toBe(plan);
    expect(readFileSync(join(dir, '.cadence', 'docs-ok.yaml'), 'utf8')).toContain('la page décrit déjà ce comportement');
    const check = await cad(dir, 'check');
    expect(check.out).not.toContain('documentation en retard');
    expect((await cad(dir, 'show', 'L1')).out).toContain('docs-ok : 2026-10-27 — la page décrit déjà ce comportement');
  });

  it('R2 — sans raison, pour un lot inconnu ou une sous-tâche : refusé, aucun fichier d\'acquittement n\'est écrit', async () => {
    const dir = await lateForeignRepo();
    for (const argv of [['docs-ok', 'L1'], ['docs-ok', 'L1', '--reason', '  '], ['docs-ok', 'L99', '--reason', 'x'], ['docs-ok', 'L1/t1', '--reason', 'x']]) {
      expect((await cad(dir, ...argv)).code).toBe(2);
    }
    expect(existsSync(join(dir, '.cadence', 'docs-ok.yaml'))).toBe(false);
  });

  it('R3 — un second acquittement du même lot remplace le premier, et ceux des autres lots sont gardés', async () => {
    const dir = await lateForeignRepo();
    await cad(dir, 'docs-ok', 'L1', '--reason', 'première raison');
    writeFileSync(join(dir, '.cadence', 'docs-ok.yaml'), `${readFileSync(join(dir, '.cadence', 'docs-ok.yaml'), 'utf8')}L7: { date: 2026-10-01, reason: autre lot }\n`);
    await cad(dir, 'docs-ok', 'L1', '--reason', 'seconde raison');
    const text = readFileSync(join(dir, '.cadence', 'docs-ok.yaml'), 'utf8');
    expect(text).toContain('seconde raison');
    expect(text).not.toContain('première raison');
    expect(text).toContain('autre lot');
  });

  it('R4 — un fichier d\'acquittement illisible ou sans raison n\'acquitte rien et ne plante pas raf check', async () => {
    const dir = await lateForeignRepo();
    writeFileSync(join(dir, '.cadence', 'docs-ok.yaml'), 'L1: { date: 2026-10-27, reason: "" }\n');
    expect((await cad(dir, 'check')).out).toContain('documentation en retard');
    writeFileSync(join(dir, '.cadence', 'docs-ok.yaml'), 'L1: [oups\n');
    const bad = await cad(dir, 'check');
    expect(bad.code).toBe(2);
    expect(bad.err + bad.out).toContain('docs-ok.yaml');
  });

  it('R5 — sur un plan au format de raf, rien ne change : l\'acquittement reste la clé docs_ok du plan', async () => {
    const dir = gitRepo();
    await cad(dir, 'init', '--project', 'demo', '--no-hook');
    await cad(dir, 'add', 'Un lot');
    expect((await cad(dir, 'docs-ok', 'L1', '--reason', 'ok')).code).toBe(0);
    expect(existsSync(join(dir, '.cadence', 'docs-ok.yaml'))).toBe(false);
    expect(readFileSync(join(dir, '.cadence', 'raf.yaml'), 'utf8')).toContain('docs_ok');
  });
});

describe('L386 — orchestrate lit l\'acquittement d\'un plan en lecture seule', () => {
  const impl = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
  const ok: Handler = () => claudeOut(reviewReport());

  it('R6 — acquittement committé avant la vague : pas de passe du bibliothécaire, la revue part', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], review: [ok] } });
    const started = h.plan();
    started.setStatus('L1', 'doing', '2026-10-27');
    started.save();
    writeFileSync(join(h.repo, 'cadence.yaml'), `plan:\n  path: .cadence/raf.yaml\n  lots: lots\ndocs:\n  sync:\n    - paths: [src-*.txt]\n      docs: [README.md]\n`);
    writeFileSync(join(h.repo, '.cadence', 'docs-ok.yaml'), 'L1: { date: 2026-10-27, reason: décidé avec le lead }\n');
    git(h.repo, 'add', '--', 'cadence.yaml', '.cadence/docs-ok.yaml', '.cadence/raf.yaml');
    git(h.repo, 'commit', '-q', '-m', 'chore(L1): docs-ok', '--', 'cadence.yaml', '.cadence/docs-ok.yaml', '.cadence/raf.yaml');
    const c = h.lot('L1');
    const config = join(h.repo, 'cadence.yaml');
    c.loadPlan = () => Plan.load(join(h.repo, '.cadence', 'raf.yaml'), { ...readPlanConfig(config)?.settings, config });
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });
});

describe('L386 — consigne du bibliothécaire sur un plan en lecture seule', () => {
  it('R8 — elle nomme .cadence/docs-ok.yaml à commiter, pas le plan', async () => {
    const noop: Handler = () => claudeOut(workReport({ resume: 'rien à écrire' }));
    const h = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'src-a.txt', 'feat(L1): src-a.txt')] }))], fix: [noop] } });
    const started = h.plan();
    started.setStatus('L1', 'doing', '2026-10-27');
    started.save();
    writeFileSync(join(h.repo, 'cadence.yaml'), 'plan:\n  lots: lots\ndocs:\n  sync:\n    - paths: [src-*.txt]\n      docs: [README.md]\n');
    git(h.repo, 'add', '--', 'cadence.yaml', '.cadence/raf.yaml');
    git(h.repo, 'commit', '-q', '-m', 'chore(L1): config', '--', 'cadence.yaml', '.cadence/raf.yaml');
    const c = h.lot('L1');
    const config = join(h.repo, 'cadence.yaml');
    c.loadPlan = () => Plan.load(join(h.repo, '.cadence', 'raf.yaml'), { ...readPlanConfig(config)?.settings, config });
    await runLot(c);
    const fix = h.calls.find((k) => k.kind === 'fix');
    expect(fix?.brief).toContain('.cadence/docs-ok.yaml');
    expect(fix?.brief).not.toContain('git add -- .cadence/raf.yaml');
  });
});

describe('L386 — documentation', () => {
  it('R7 — la documentation et le CHANGELOG décrivent le fichier .cadence/docs-ok.yaml', () => {
    expect(docText()).toContain('.cadence/docs-ok.yaml');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('.cadence/docs-ok.yaml');
  });
});
