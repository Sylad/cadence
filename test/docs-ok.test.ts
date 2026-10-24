import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { commit, gitRepo } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Handler } from './orchestrate-harness.js';
import { docText } from './docs-text.js';

const root = join(import.meta.dirname, '..');

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-25' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-25T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CONFIG = 'docs:\n  sync:\n    - paths: [src/**]\n      docs: [README.md]\n';

/** Un dépôt avec un lot L1 en cours dont un commit touche src/ sans toucher README.md. */
async function lateRepo() {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  await cad(dir, 'add', 'Un lot');
  await cad(dir, 'start', 'L1');
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG);
  execFileSync('git', ['add', '--', '.cadence', 'cadence.yaml'], { cwd: dir });
  commit(dir, 'chore(L1): départ', '2026-10-25T08:00:00');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'x');
  execFileSync('git', ['add', '--', 'src/a.ts'], { cwd: dir });
  commit(dir, 'feat(L1): a', '2026-10-25T10:00:00');
  return dir;
}

const SYNC = 'docs:\n  sync:\n    - paths: [src-*.txt]\n      docs: [README.md]\n';
const impl = (file: string): Handler => (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, file, `feat(L1): ${file}`)] }));
const ok: Handler = () => claudeOut(reviewReport());
const kinds = (h: ReturnType<typeof harness>) => h.calls.map((c) => c.kind);
function withConfig(h: ReturnType<typeof harness>) {
  writeFileSync(join(h.repo, 'cadence.yaml'), SYNC);
  git(h.repo, 'add', '--', 'cadence.yaml');
  git(h.repo, 'commit', '-q', '-m', 'chore(L1): docs.sync', '--', 'cadence.yaml');
}
/** Ce que fait une session qui acquitte l'écart : `raf docs-ok`, puis le commit du plan seul. */
const acknowledge = (reason = 'le texte de la page ne change pas'): Handler => (call) => {
  const file = join(call.opts.cwd, '.cadence', 'raf.yaml');
  const plan = Plan.load(file);
  plan.setDocsOk('L1', reason, '2026-10-25');
  plan.save();
  git(call.opts.cwd, 'add', '--', '.cadence/raf.yaml');
  git(call.opts.cwd, 'commit', '-q', '-m', 'chore(L1): docs-ok', '--', '.cadence/raf.yaml');
  return claudeOut(workReport({ commits: [{ sha: git(call.opts.cwd, 'rev-parse', 'HEAD'), sujet: 'chore(L1): docs-ok' }] }));
};

describe('raf docs-ok : l\'écart docs.sync acquitté et motivé (L317)', () => {
  it('R1 — raf docs-ok <lot> --reason inscrit la date et la raison sur le lot ; raf show les rend', async () => {
    const dir = await lateRepo();
    const r = await cad(dir, 'docs-ok', 'L1', '--reason', 'la page décrit déjà ce comportement');
    expect(r.code).toBe(0);
    const lot = Plan.load(join(dir, '.cadence', 'raf.yaml')).lot('L1');
    expect(lot.docsOk).toEqual({ date: '2026-10-25', reason: 'la page décrit déjà ce comportement' });
    expect((await cad(dir, 'show', 'L1')).out).toContain('docs-ok : 2026-10-25 — la page décrit déjà ce comportement');
  });

  it('R2 — sans raison (absente ou vide), pour un lot inconnu ou une sous-tâche : refusé, rien n\'est écrit', async () => {
    const dir = await lateRepo();
    const file = join(dir, '.cadence', 'raf.yaml');
    const before = readFileSync(file, 'utf8');
    for (const argv of [['docs-ok', 'L1'], ['docs-ok', 'L1', '--reason', '  '], ['docs-ok', 'L9', '--reason', 'x'], ['docs-ok', 'L1/t1', '--reason', 'x']]) {
      const r = await cad(dir, ...argv);
      expect(r.code, argv.join(' ')).not.toBe(0);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('R3 — docSyncIssues (raf check) : l\'écart reste rouge tant qu\'il n\'est pas acquitté, et ne l\'est plus une fois raf docs-ok posé', async () => {
    const dir = await lateRepo();
    const open = await cad(dir, 'check');
    expect(open.code).toBe(1);
    expect(open.out).toContain('L1 : documentation en retard');
    await cad(dir, 'docs-ok', 'L1', '--reason', 'rien à dire de plus');
    execFileSync('git', ['add', '--', '.cadence/raf.yaml'], { cwd: dir });
    commit(dir, 'chore(L1): docs-ok', '2026-10-25T11:00:00');
    const closed = await cad(dir, 'check');
    expect(closed.out).not.toContain('documentation en retard');
    expect(closed.code).toBe(0);
  });
});

describe('orchestrate : jamais prêt avec un écart docs.sync ouvert (L317)', () => {
  it('R4 — la passe du bibliothécaire ne commite rien et laisse l\'écart : le lot est rendu, la revue ne part pas', async () => {
    const noop: Handler = () => claudeOut(workReport({ resume: 'rien à écrire' }));
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [noop], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('documentation en retard');
    expect(c.lot.outcome).toContain('raf docs-ok');
  });

  it('R5 — la passe du bibliothécaire commite autre chose que la doc : l\'écart reste ouvert, le lot est rendu sans revue', async () => {
    const other: Handler = (call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'notes.txt', 'docs(L1): notes')] }));
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [other], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix']);
    expect(c.lot.status).toBe('handed-back');
  });

  it('R6 — la session acquitte l\'écart (raf docs-ok motivé, plan commité) : la revue part, le lot finit prêt', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [acknowledge()], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'fix', 'review']);
    expect(c.lot.status).toBe('ready');
    expect(h.calls[2].brief).not.toContain('ONE MAJOR finding per line');
  });

  it('R7 — un écart déjà acquitté avant la porte : pas de passe du bibliothécaire, la revue ne le compte pas', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], review: [ok] } });
    withConfig(h);
    const plan = h.plan();
    plan.setDocsOk('L1', 'décidé avec le lead', '2026-10-25');
    plan.save();
    git(h.repo, 'add', '--', '.cadence/raf.yaml');
    git(h.repo, 'commit', '-q', '-m', 'chore(L1): docs-ok', '--', '.cadence/raf.yaml');
    const c = h.lot('L1');
    await runLot(c);
    expect(kinds(h)).toEqual(['implement', 'review']);
    expect(c.lot.status).toBe('ready');
  });

  it('R8 — porte non jouée (passes ou budget épuisés) avec l\'écart ouvert : la revue conforme ne rend pas le lot prêt', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], review: [ok] } });
    withConfig(h);
    const c = h.lot('L1', { docsGate: true });
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain('documentation en retard');
  });

  it('R9 — le brief du bibliothécaire dit comment acquitter : raf docs-ok <lot> --reason, puis le plan commité seul', async () => {
    const h = harness({ script: { implement: [impl('src-a.txt')], fix: [acknowledge()], review: [ok] } });
    withConfig(h);
    await runLot(h.lot('L1'));
    expect(h.calls[1].brief).toContain('raf docs-ok L1 --reason');
    expect(h.calls[1].brief).toContain('plan');
  });
});

describe('docs-ok décrit (L317)', () => {
  it('R10 — le README et les pages de documentation décrivent raf docs-ok et la règle « jamais prêt avec un écart ouvert »', () => {
    const doc = docText();
    expect(doc).toContain('raf docs-ok');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('docs-ok');
    expect(readFileSync(join(root, 'src', 'cli.ts'), 'utf8')).toContain('raf docs-ok <lot> --reason');
  });
});
