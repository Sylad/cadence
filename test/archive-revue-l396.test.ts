import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseDocument, type YAMLSeq } from 'yaml';
import { Plan } from '../src/plan.js';
import { repoWork } from '../src/repos.js';
import { repoWithPlan } from './archive-helpers.js';
import { commit, tempDir } from './helpers.js';

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

  it('R18 — un lot archivé remis à la main dans le plan puis modifié : le réarchivage remplace la copie archivée, sans doublon ni perte', async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-01-01');
    const archived = parseDocument(readFileSync(r.archive('2025'), 'utf8'));
    const plan = parseDocument(readFileSync(r.plan, 'utf8'));
    (plan.get('lots') as YAMLSeq).add((archived.get('lots') as YAMLSeq).items[0]);
    writeFileSync(r.plan, plan.toString({ lineWidth: 0 }));
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toContain('L1');
    expect((await r.raf('note', 'L1', 'reprise après coup')).code).toBe(0);

    const res = await r.raf('archive', '--before', '2026-01-01');
    expect(res.code).toBe(0);
    expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L2', 'L3', 'L4', 'L5']);
    const text = readFileSync(r.archive('2025'), 'utf8');
    expect(text.match(/id: L1/g)).toHaveLength(1);
    expect(text).toContain('reprise après coup');
    expect((await r.raf('show', 'L1', '--notes')).out).toContain('reprise après coup');
  });
});

describe('L396 — revue de code, constat 2 : le hook post-commit connaît un lot archivé', () => {
  it("R19 — le commit du plan que propose raf archive, puis un fix qui cite le lot archivé, ne sont pas « n'existe pas dans le plan »", async () => {
    const r = repoWithPlan();
    expect((await r.raf('archive')).code).toBe(0);
    execFileSync('git', ['add', '--', '.cadence'], { cwd: r.dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'plan: L1 1 lot(s) archivé(s)'], { cwd: r.dir, stdio: 'ignore' });
    const planHook = await r.raf('hook', 'post-commit');
    expect(planHook.code).toBe(0);
    expect(planHook.err).not.toContain("n'existe pas dans le plan");
    expect(planHook.err).toMatch(/raf: L1 \(done, archivé\) premier/);

    commit(r.dir, 'fix(L1): suite', '2026-10-28T11:00:00');
    const fixHook = await r.raf('hook', 'post-commit');
    expect(fixHook.err).not.toContain("n'existe pas dans le plan");
    expect(fixHook.err).toMatch(/raf: L1 \(done, archivé\) premier/);
    // Un identifiant qui n'est ni dans le plan ni dans l'archive reste signalé.
    commit(r.dir, 'fix(L77): fantôme', '2026-10-28T11:30:00');
    expect((await r.raf('hook', 'post-commit')).err).toContain("raf: L77 n'existe pas dans le plan");
  });

  it("R20 — un lot archivé visible sans Nouveauté ne réclame pas d'entrée au hook (comme cadence news check)", async () => {
    const r = repoWithPlan();
    const p = Plan.load(r.plan);
    p.setVisible('L1', true);
    p.save();
    await r.raf('archive');
    commit(r.dir, 'fix(L1): suite', '2026-10-28T11:00:00');
    const hook = await r.raf('hook', 'post-commit');
    expect(hook.err).not.toContain('est visible');
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
