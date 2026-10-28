import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Plan } from '../src/plan.js';
import { readPlans } from '../src/perf.js';
import { PLAN_READING } from '../src/orchestrate/briefs.js';
import { commit, tempDir } from './helpers.js';
import { fileIds, repoWithPlan } from './archive-helpers.js';

describe('raf archive (L396)', () => {
  it('R1 — les lots done et dropped passent dans archive/<année de fin>.yaml, les autres restent dans le plan', async () => {
    const r = repoWithPlan();
    const res = await r.raf('archive');
    expect(res.code).toBe(0);
    expect(readFileSync(r.archive('2025'), 'utf8')).toContain('id: L1');
    const y2026 = readFileSync(r.archive('2026'), 'utf8');
    expect(y2026).toContain('id: L2');
    expect(y2026).toContain('id: L3');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
    // L'archive est un détail de stockage : le plan chargé présente toujours les cinq lots, raf list aussi.
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    expect((await r.raf('list')).out).toContain('L1     done');
  });

  it('R2 — --before ne déplace que les lots terminés strictement avant la date', async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-09-20');
    expect(fileIds(r.plan)).toEqual(['L3', 'L4', 'L5']);
    expect(existsSync(r.archive('2025'))).toBe(true);
    expect(readFileSync(r.archive('2026'), 'utf8')).toContain('id: L2');
    expect(readFileSync(r.archive('2026'), 'utf8')).not.toContain('id: L3');
  });

  it("R3 — un lot cité par after s'archive comme les autres : les lecteurs voyant l'archive, la dépendance reste lue (raf check sans bad-dependency, raf show pareil)", async () => {
    const r = repoWithPlan();
    const p = Plan.load(r.plan);
    p.add('dépend de L1', '2026-10-01', { after: ['L1'] });
    p.save();
    const avant = { check: await r.raf('check', '--since', '2025-01-01'), show: await r.raf('show', 'L6'), now: await r.raf('now') };
    expect(avant.check.out).not.toContain('bad-dependency');
    const res = await r.raf('archive');
    expect(res.code).toBe(0);
    expect(res.out).not.toContain('reste dans le plan');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5', 'L6']);
    expect(fileIds(r.archive('2025'))).toEqual(['L1']);
    expect((await r.raf('check', '--since', '2025-01-01')).out).toBe(avant.check.out);
    expect((await r.raf('show', 'L6')).out).toBe(avant.show.out);
    expect((await r.raf('now')).out).toBe(avant.now.out);
  });

  it("R3 — un lot done compté par le gate d'un lot ouvert s'archive : le compte du gate (raf show, raf now) est le même après", async () => {
    const r = repoWithPlan();
    writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace(/(- id: L3\n)/, '$1    spec: true\n').replace(/(- id: L5\n)/, '$1    gate: { count: 1, spec: true }\n'));
    const avant = { show: await r.raf('show', 'L5'), now: await r.raf('now') };
    expect(avant.show.out).toMatch(/gate : 1 lots/);
    const res = await r.raf('archive');
    expect(res.out).not.toContain('reste dans le plan');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
    expect((await r.raf('show', 'L5')).out).toBe(avant.show.out);
    expect((await r.raf('now')).out).toBe(avant.now.out);
  });

  it('R4 — rejouer ne déplace rien, un fichier d’année existant reçoit les nouveaux lots sans doublon', async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-01-01');
    const again = await r.raf('archive', '--before', '2026-01-01');
    expect(again.out).toContain('rien à archiver');
    await r.raf('archive');
    const text = readFileSync(r.archive('2026'), 'utf8');
    expect(text.match(/id: L2/g)).toHaveLength(1);
    expect(text).toContain('id: L3');
    expect([...fileIds(r.archive('2025')), ...fileIds(r.archive('2026'))]).toEqual(['L1', 'L2', 'L3']);
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
  });

  it('R5 — --dry-run annonce sans rien écrire ; --before invalide et plan en lecture seule sont refusés', async () => {
    const r = repoWithPlan();
    const before = readFileSync(r.plan, 'utf8');
    const dry = await r.raf('archive', '--dry-run');
    expect(dry.out).toContain('L1');
    expect(readFileSync(r.plan, 'utf8')).toBe(before);
    expect(existsSync(join(r.dir, '.cadence/archive'))).toBe(false);
    const bad = await r.raf('archive', '--before', 'hier');
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('--before');
  });

  it("R5 — un plan en lecture seule (tenu par un autre outil) refuse d'archiver et ne porte pas d'archive", () => {
    const dir = tempDir();
    const file = join(dir, 'taches.yaml');
    writeFileSync(file, 'lots:\n  - id: A1\n    title: t\n    status: done\n');
    const format = { lots: 'lots', fields: { id: ['id'], title: ['title'], status: ['status'] }, statuses: { done: 'done' as const }, estimates: {} };
    const plan = Plan.load(file, { format });
    expect(() => plan.archive('2026-10-28')).toThrow(/lecture seule/);
    expect(plan.archiveFiles()).toEqual([]);
    expect(plan.lots().map((l) => l.id)).toEqual(['A1']);
  });

  it("R2 — un lot sans date de fin reste quand --before est donné, et part sans --before", async () => {
    const r = repoWithPlan();
    writeFileSync(r.plan, readFileSync(r.plan, 'utf8').replace(/    finished: 2025-06-10\n/, ''));
    await r.raf('archive', '--before', '2030-01-01');
    expect(fileIds(r.plan)).toEqual(['L1', 'L4', 'L5']);
    await r.raf('archive');
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
  });

  it('R6 — show et commits lisent un lot archivé, commits compris', async () => {
    const r = repoWithPlan();
    commit(r.dir, 'feat(L1): travail ancien', '2025-06-01T10:00:00');
    await r.raf('archive');
    const show = await r.raf('show', 'L1');
    expect(show.code).toBe(0);
    expect(show.out).toContain('L1  done  premier');
    expect(show.out).toContain('commits (1)');
    expect(show.out).toContain('travail ancien');
    const commits = await r.raf('commits', 'L1');
    expect(commits.out).toContain('travail ancien');
    expect((await r.raf('show', 'L99')).err).toContain('lot inconnu');
  });

  it("R7 — check ne tient plus un commit qui cite un lot archivé pour inconnu et ne ré-audite pas le lot archivé", async () => {
    const r = repoWithPlan();
    commit(r.dir, 'feat(L1): travail ancien', '2025-06-01T10:00:00');
    commit(r.dir, 'feat(L4): en cours', '2026-10-27T10:00:00');
    const avant = await r.raf('check', '--since', '2025-01-01');
    expect(avant.out).not.toContain('inconnu');
    await r.raf('archive');
    const apres = await r.raf('check', '--since', '2025-01-01');
    expect(apres.out).not.toContain('inconnu');
    expect(apres.code).toBe(avant.code);
    commit(r.dir, 'feat(L77): fantôme', '2026-10-27T11:00:00');
    expect((await r.raf('check', '--since', '2025-01-01')).out).toContain('L77 inconnu');
  });

  it('R8 — raf add ne réutilise jamais l’identifiant d’un lot archivé', async () => {
    const r = repoWithPlan();
    const p = Plan.load(r.plan);
    p.setStatus('L5', 'done', '2026-10-02', { force: true });
    p.save();
    await r.raf('archive');
    expect(fileIds(r.plan)).toEqual(['L4']);
    const added = await r.raf('add', 'nouveau');
    expect(added.out).toContain('L6');
  });

  it('R9 — cadence news check : une entrée qui cite un lot archivé rend le même verdict qu’avant l’archivage', async () => {
    const r = repoWithPlan();
    const dir = join(r.dir, 'docs/nouveautes');
    expect((await r.raf('news', 'new', 'L1', '--title', 'Un titre', '--dir', dir)).code).toBe(0);
    const avant = await r.raf('news', 'check', '--dir', dir);
    expect(avant.out).not.toContain('absent du plan');
    await r.raf('archive');
    const apres = await r.raf('news', 'check', '--dir', dir);
    expect(apres.out).toBe(avant.out);
    expect(apres.code).toBe(avant.code);
  });

  it('R10 — cadence news new accepte un lot archivé', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const res = await r.raf('news', 'new', 'L1', '--title', 'Un titre', '--dir', join(r.dir, 'docs/nouveautes'));
    expect(res.code).toBe(0);
  });

  it('R11 — perf lit les lots archivés du plan de chaque projet', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const plans = readPlans(r.dir.replace(/\/[^/]+$/, ''), () => {});
    const mine = [...plans.entries()].find(([, lots]) => lots.some((l) => l.id === 'L4'));
    expect(mine?.[1].map((l) => l.id)).toContain('L1');
  });

  it("R12 — les fichiers d’archive sont tenus avec le plan : les toucher n'est pas travailler à un lot", async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const rel = (await import('node:path')).relative(r.dir, r.archive('2025'));
    expect(Plan.load(r.plan, { config: join(r.dir, 'cadence.yaml') }).maintained).toContain(rel);
  });

  it("R13 — le brief des sessions interdit de lire l'archive du plan", () => {
    expect(PLAN_READING).toMatch(/never read `\.cadence\/archive\//);
  });
});
