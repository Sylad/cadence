import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseDocument, type YAMLSeq } from 'yaml';
import { Plan } from '../src/plan.js';
import { repoWork } from '../src/repos.js';
import { fileIds, repoWithPlan } from './archive-helpers.js';
import { commit, tempDir } from './helpers.js';
import { claudeOut, commitFile, git, harness, reviewReport, workReport, type Call } from './orchestrate-harness.js';
import { until } from './orchestrate-worktree-harness.js';
import { runLot } from '../src/orchestrate/cycle.js';

/** `plan.onWrite` du dépôt : `command` lancé après chaque écriture du plan. */
const onWrite = (dir: string, command: string) => writeFileSync(join(dir, 'cadence.yaml'), `plan:\n  path: .cadence/raf.yaml\n  onWrite:\n    command: '${command}'\n`);

describe('L396 — revue de code, constat 1 : archivage sans perte', () => {
  it("R17 — plan.onWrite en échec pendant raf archive : rien ne reste dans l'archive, et le rejeu après correction emporte la note ajoutée entre-temps", async () => {
    const r = repoWithPlan();
    onWrite(r.dir, 'exit 2');
    const failed = await r.raf('archive');
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain('plan.onWrite en échec');
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    // « plan inchangé » doit être vrai de l'archive aussi : aucune copie de L1 n'y attend.
    expect(existsSync(join(r.dir, '.cadence/archive'))).toBe(false);

    onWrite(r.dir, 'true');
    expect((await r.raf('note', 'L1', 'décision importante')).code).toBe(0);
    const again = await r.raf('archive');
    expect(again.code).toBe(0);
    expect(again.out).toContain('L1');
    const text = readFileSync(r.archive('2025'), 'utf8');
    expect(text.match(/id: L1/g)).toHaveLength(1);
    expect(text).toContain('décision importante');
    expect((await r.raf('show', 'L1', '--notes')).out).toContain('décision importante');
  });

  it('R18 — un même identifiant dans le plan et dans l’archive est une erreur nommée : raf archive et raf note refusent, rien n’est écrit', async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-01-01');
    const archived = parseDocument(readFileSync(r.archive('2025'), 'utf8'));
    const plan = parseDocument(readFileSync(r.plan, 'utf8'));
    (plan.get('lots') as YAMLSeq).add((archived.get('lots') as YAMLSeq).items[0]);
    writeFileSync(r.plan, plan.toString({ lineWidth: 0 }));
    const before = { plan: readFileSync(r.plan, 'utf8'), archive: readFileSync(r.archive('2025'), 'utf8') };

    const res = await r.raf('archive');
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/identifiant en double : L1 .*\.cadence\/archive\/2025\.yaml.*\.cadence\/raf\.yaml/);
    const note = await r.raf('note', 'L1', 'laquelle ?');
    expect(note.code).not.toBe(0);
    expect(note.err).toContain('identifiant en double : L1');
    expect(readFileSync(r.plan, 'utf8')).toBe(before.plan);
    expect(readFileSync(r.archive('2025'), 'utf8')).toBe(before.archive);
    expect(() => Plan.load(r.plan).lots()).toThrow(/L1/);
  });
});

describe('L396 — l’écriture renvoie un lot archivé dans son fichier d’année', () => {
  it('R26 — raf note et raf review sur un lot archivé écrivent dans archive/<année>.yaml, le fichier du plan ne bouge pas ; show les relit', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const planText = readFileSync(r.plan, 'utf8');
    expect((await r.raf('note', 'L1', 'décision après archivage')).code).toBe(0);
    expect((await r.raf('review', 'L1', 'conforme')).code).toBe(0);
    expect(readFileSync(r.plan, 'utf8')).toBe(planText);
    const year = readFileSync(r.archive('2025'), 'utf8');
    expect(year).toContain('décision après archivage');
    expect(year).toMatch(/review: \{.*conforme/);
    expect(year.match(/id: L1/g)).toHaveLength(1);
    expect((await r.raf('show', 'L1', '--notes')).out).toContain('décision après archivage');
    expect(Plan.load(r.plan).lot('L1').review?.verdict).toBe('conforme');
  });

  it('R27 — un lot archivé rouvert par raf todo revient dans le fichier du plan : l’archive ne porte que des lots clos', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    // Rouvrir un lot clos passe par la commande (L396), jamais par le YAML : le lot quitte son fichier d'année à l'écriture.
    const reopened = await r.raf('todo', 'L3', '--reason', 'à reprendre');
    expect(reopened.code).toBe(0);
    expect(reopened.out).toContain('L3 → todo');
    expect(Plan.load(r.plan).lot('L3').status).toBe('todo');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5', 'L3']);
    expect(fileIds(r.archive('2026'))).toEqual(['L2']);
    expect((await r.raf('show', 'L3', '--notes')).out).toContain('rouvert (était done) : à reprendre');
    expect((await r.raf('start', 'L3')).code).toBe(0);
    expect((await r.raf('now')).out).toContain('L3');
    // Un lot remis à la main en doing dans son fichier d'année revient aussi à la première écriture.
    writeFileSync(r.archive('2026'), readFileSync(r.archive('2026'), 'utf8').replace(/(id: L2\n\s+title: [^\n]+\n\s+status: )dropped/, '$1doing'));
    expect((await r.raf('note', 'L2', 'reprise')).code).toBe(0);
    expect(fileIds(r.plan)).toEqual(['L4', 'L5', 'L3', 'L2']);
    expect(fileIds(r.archive('2026'))).toEqual([]);
  });

  it('R28 — un fichier d’année illisible est une erreur nommée, pas un lot de moins', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    writeFileSync(r.archive('2025'), 'lots: [\n');
    const res = await r.raf('show', 'L4');
    expect(res.code).not.toBe(0);
    expect(res.err).toContain('2025.yaml');
  });
});

describe('L396 — revue de code, constat 2 : le hook post-commit voit un lot archivé comme tout autre lot', () => {
  it("R19 — le commit du plan que propose raf archive, puis un fix qui cite le lot archivé, ne sont pas « n'existe pas dans le plan »", async () => {
    const r = repoWithPlan();
    expect((await r.raf('archive')).code).toBe(0);
    execFileSync('git', ['add', '--', '.cadence'], { cwd: r.dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'plan: L1 1 lot(s) archivé(s)'], { cwd: r.dir, stdio: 'ignore' });
    const planHook = await r.raf('hook', 'post-commit');
    expect(planHook.code).toBe(0);
    expect(planHook.err).not.toContain("n'existe pas dans le plan");
    expect(planHook.err).toMatch(/raf: L1 \(done\) premier/);

    commit(r.dir, 'fix(L1): suite', '2026-10-28T11:00:00');
    const fixHook = await r.raf('hook', 'post-commit');
    expect(fixHook.err).not.toContain("n'existe pas dans le plan");
    expect(fixHook.err).toMatch(/raf: L1 \(done\) premier/);
    // Un identifiant qui n'est ni dans le plan ni dans l'archive reste signalé.
    commit(r.dir, 'fix(L77): fantôme', '2026-10-28T11:30:00');
    expect((await r.raf('hook', 'post-commit')).err).toContain("raf: L77 n'existe pas dans le plan");
  });

  it("R20 — un lot done qui a un écart ouvert (visible sans Nouveauté, ce que raf check signale) reste dans le plan, la raison affichée", async () => {
    const r = repoWithPlan();
    const p = Plan.load(r.plan);
    p.setVisible('L1', true);
    p.save();
    const res = await r.raf('archive');
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/L1 reste dans le plan : écart ouvert — L1 est visible et terminé sans entrée Nouveautés/);
    expect(fileIds(r.plan)).toEqual(['L1', 'L4', 'L5']);
    expect(fileIds(r.archive('2025'))).toEqual([]);
    expect(fileIds(r.archive('2026'))).toEqual(['L2', 'L3']);
    // L'écart levé, le lot part au tour suivant.
    expect((await r.raf('news', 'new', 'L1', '--title', 'Un titre', '--dir', join(r.dir, 'docs/nouveautes'))).code).toBe(0);
    expect((await r.raf('archive')).out).toContain('archivé dans .cadence/archive/2025.yaml : L1');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
  });
});

describe('L396 — revue de code, constat 3 : les dépôts voisins (repos:) d’un lot archivé gardent la période du lot', () => {
  /** L1 (démarré le 2025-06-01, fini le 2025-06-10) travaille aussi dans ../v, où un commit du lot est dans la période et un autre hors. */
  function withNeighbour() {
    const parent = tempDir();
    const r = repoWithPlan('2026-10-28', parent);
    const v = join(parent, 'v');
    mkdirSync(v);
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['config', 'commit.gpgsign', 'false']]) execFileSync('git', args, { cwd: v, stdio: 'ignore' });
    commit(v, 'feat(L1): dans la période', '2025-06-05T10:00:00');
    commit(v, 'feat(L1): hors période', '2026-02-01T10:00:00');
    const p = Plan.load(r.plan);
    p.setRepos('L1', [{ path: '../v' }]);
    p.save();
    writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace('started: 2025-06-10', 'started: 2025-06-01'));
    return { ...r, v };
  }

  it('R21 — raf commits et raf show d’un lot archivé ne listent que les commits voisins de sa période, comme avant l’archivage', async () => {
    const r = withNeighbour();
    const avant = await r.raf('commits', 'L1');
    expect(avant.out).toContain('dans la période');
    expect(avant.out).not.toContain('hors période');
    expect((await r.raf('archive')).code).toBe(0);
    const apres = await r.raf('commits', 'L1');
    expect(apres.code).toBe(0);
    expect(apres.out).toContain('dépôt ../v');
    expect(apres.out).toContain('dans la période');
    expect(apres.out).not.toContain('hors période');
    const show = await r.raf('show', 'L1');
    expect(show.out).toContain('dans la période');
    expect(show.out).not.toContain('hors période');
    expect(repoWork(Plan.load(r.plan), { rel: '../v', path: r.v }, 'L1').map((c) => c.subject)).toEqual(['feat(L1): dans la période']);
  });
});

describe('L396 — revue de code, constat 4 : le commit du plan de la vague prend les fichiers d’année de l’archive', () => {
  it("R29 — un raf archive non commité pendant la vague (entre deux sessions) : le commit du plan prend l'archive non suivie, HEAD porte les lots archivés", async () => {
    const script = { implement: [(call: Call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a.txt')] }))], review: [() => claudeOut(reviewReport())] };
    const h = harness({ lots: [{ title: 'un' }, { title: 'clos' }], script });
    const p = h.plan();
    p.setStatus('L2', 'done', '2025-06-10', { force: true });
    p.save();
    git(h.repo, 'commit', '-q', '-m', 'chore: L2 clos', '--', '.cadence/raf.yaml');
    // La commande de tests de la vague est le rendez-vous : cadence l'attend entre la session de travail et la revue, le lead archive pendant ce temps, sans commiter.
    const sync = tempDir();
    const test = `touch ${sync}/running; while [ ! -f ${sync}/go ]; do sleep 0.05; done`;
    const c = h.lot('L1', {}, { test });
    const done = runLot(c);
    await until(() => existsSync(join(sync, 'running')));
    const live = h.plan();
    expect(live.archive('2026-10-04').moved.map((m) => m.lot.id)).toEqual(['L2']);
    live.save();
    expect(git(h.repo, 'status', '--porcelain')).toContain('?? .cadence/archive/');
    writeFileSync(join(sync, 'go'), '');
    await done;
    expect(c.lot.status, c.lot.outcome ?? undefined).not.toBe('failed');
    expect(git(h.repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('.cadence/archive/2025.yaml');
    expect(git(h.repo, 'show', 'HEAD:.cadence/archive/2025.yaml')).toContain('id: L2');
    expect(git(h.repo, 'show', 'HEAD:.cadence/raf.yaml')).not.toContain('id: L2');
    expect(git(h.repo, 'status', '--porcelain')).toBe('');
  });
});
