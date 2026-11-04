import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { orchestrate, type OrchestrateIo } from '../src/orchestrate/command.js';
import { RunStore, newLot, type WaveState } from '../src/orchestrate/state.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const TODAY = '2026-11-04';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: TODAY, CADENCE_HOME: tempDir() }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${TODAY}T18:30:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const setStatus = (dir: string, id: string, status: string) => {
  const plan = join(dir, '.cadence/raf.yaml');
  const text = readFileSync(plan, 'utf8');
  const i = text.indexOf(`id: ${id}\n`);
  const head = text.slice(0, i);
  const tail = text.slice(i).replace(/status: \w+/, `status: ${status}`);
  writeFileSync(plan, head + tail);
};

/** Dépôt qui publie : package.json + tag v1.46.0 ; L1 (travail avant le tag), L2 et L3 (travail après), L4 (à faire). */
async function publishing(opts: { tag?: boolean; packageJson?: string | null } = {}) {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  for (const t of ['Un', 'Deux', 'Trois', 'Quatre']) await cad(dir, 'add', t);
  if (opts.packageJson !== null) writeFileSync(join(dir, 'package.json'), opts.packageJson ?? '{"name":"demo","version":"1.46.0"}');
  const plan = join(dir, '.cadence/raf.yaml');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace(`since: ${TODAY}`, 'since: 2026-11-01')); // adopté avant les commits de travail
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-11-01T09:00:00');
  commit(dir, 'feat(L1): un', '2026-11-02T09:00:00');
  if (opts.tag !== false) git(dir, 'tag', 'v1.46.0');
  commit(dir, 'feat(L2): deux', '2026-11-03T09:00:00');
  commit(dir, 'feat(L3): trois', '2026-11-03T10:00:00');
  for (const id of ['L1', 'L2', 'L3']) setStatus(dir, id, 'done');
  git(dir, 'commit', '-qam', 'plan: L1 L2 L3 terminés');
  return dir;
}

const LINE = /⚠ 2 lots done depuis le dernier tag v1\.46\.0 \(L2, L3\)/;

describe('L571 — lots en service non publiés', () => {
  it('R1 — lead tour dit ⚠ N lots done depuis le dernier tag, avec cadence release ; le lot fini avant le tag (statut changé après) ne compte pas', async () => {
    const dir = await publishing();
    const { out } = await cad(dir, 'lead', 'tour');
    expect(out).toMatch(LINE);
    expect(out).toContain('cadence release patch|minor|major');
    expect(out).not.toMatch(/\(L1/);
  });

  it('R1b — lead tour --json porte unpublished { tag, lots } ; une ligne propre n’en porte pas', async () => {
    const dir = await publishing();
    const rows = JSON.parse((await cad(dir, 'lead', 'tour', '--json')).out);
    expect(rows[0].unpublished).toEqual({ tag: 'v1.46.0', lots: ['L2', 'L3'] });
    const clean = await publishing({ tag: false });
    expect(JSON.parse((await cad(clean, 'lead', 'tour', '--json')).out)[0]).not.toHaveProperty('unpublished');
  });

  it('R2 — session close met la ligne juste sous le titre, avant toute section', async () => {
    const dir = await publishing();
    const lines = (await cad(dir, 'session', 'close')).out.split('\n');
    expect(lines[0]).toContain('clôture du');
    expect(lines[1]).toMatch(LINE);
  });

  it('R3 — orchestrate --status la dit sous le tableau de la vague', async () => {
    const dir = await publishing();
    const home = tempDir();
    process.env.CADENCE_HOME = home;
    const wave: WaveState = { id: 'w1', created: '2026-11-04T10:00:00Z', cwd: dir, budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L2'] };
    const store = new RunStore(dir, 'w1');
    store.writeWave(wave);
    const l = newLot({ project: 'demo', repo: dir, lot: 'L2', title: 'Deux', visible: false, small: false, model: 'sonnet', readOnlyPlan: false });
    store.writeLot(l);
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: dir, env: { CADENCE_HOME: home }, out: (x) => out.push(x), err: (x) => out.push(x), now: () => new Date(`${TODAY}T18:30:00`) } as OrchestrateIo;
    await orchestrate(['--status'], io, {} as never);
    expect(out.join('\n')).toMatch(LINE);
  });

  it('R3b — orchestrate --status lancé depuis un dossier parent : une ligne ⚠ par projet, préfixée de son nom', async () => {
    const parent = tempDir();
    for (const name of ['alpha', 'beta']) renameSync(await publishing(), join(parent, name));
    const home = tempDir();
    process.env.CADENCE_HOME = home;
    const wave: WaveState = { id: 'w1', created: '2026-11-04T10:00:00Z', cwd: parent, budget: 1, consumed: 0, cacheRead: 0, status: 'done', pid: 1, lots: ['demo:L2'] };
    const store = new RunStore(parent, 'w1');
    store.writeWave(wave);
    store.writeLot(newLot({ project: 'demo', repo: join(parent, 'alpha'), lot: 'L2', title: 'Deux', visible: false, small: false, model: 'sonnet', readOnlyPlan: false }));
    const out: string[] = [];
    const io: OrchestrateIo = { cwd: parent, env: { CADENCE_HOME: home }, out: (x) => out.push(x), err: (x) => out.push(x), now: () => new Date(`${TODAY}T18:30:00`) } as OrchestrateIo;
    await orchestrate(['--status'], io, {} as never);
    const lines = out.join('\n').split('\n').filter((l) => l.includes('depuis le dernier tag'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^alpha · ⚠ 2 lots done depuis le dernier tag v1\.46\.0 \(L2, L3\)/);
    expect(lines[1]).toMatch(/^beta · ⚠ 2 lots done/);
  });

  it('R4 — sans tag de version : aucune ligne', async () => {
    const dir = await publishing({ tag: false });
    expect((await cad(dir, 'lead', 'tour')).out).not.toContain('depuis le dernier tag');
  });

  it('R4b — sans package.json, ou un package.json illisible ou sans version : aucune ligne', async () => {
    for (const packageJson of [null, '{ pas du json', '{"name":"demo"}']) {
      const dir = await publishing({ packageJson });
      expect((await cad(dir, 'lead', 'tour')).out).not.toContain('depuis le dernier tag');
    }
  });

  it('R5 — un tag qui n’est pas v<x.y.z> ne compte pas ; le plus récent des tags de version l’emporte (v1.9.0 < v1.10.0)', async () => {
    const dir = await publishing();
    git(dir, 'tag', 'v1.9.0');
    git(dir, 'tag', 'v1.10.0-rc1');
    git(dir, 'tag', 'vnext');
    expect((await cad(dir, 'lead', 'tour')).out).toMatch(/depuis le dernier tag v1\.46\.0/);
    git(dir, 'tag', 'v1.46.1');
    expect((await cad(dir, 'lead', 'tour')).out).not.toContain('depuis le dernier tag');
  });

  it('R6 — un seul lot : singulier ; plus aucun lot done après le tag : aucune ligne', async () => {
    const dir = await publishing();
    setStatus(dir, 'L3', 'doing');
    expect((await cad(dir, 'lead', 'tour')).out).toContain('⚠ 1 lot done depuis le dernier tag v1.46.0 (L2) — en service, non publié :');
    setStatus(dir, 'L2', 'doing');
    expect((await cad(dir, 'lead', 'tour')).out).not.toContain('depuis le dernier tag');
  });

  it('R7 — un lot done sans commit de travail (seulement du plan) après le tag ne compte pas', async () => {
    const dir = await publishing();
    setStatus(dir, 'L4', 'done');
    git(dir, 'commit', '-qam', 'plan: L4 terminé');
    expect((await cad(dir, 'lead', 'tour')).out).toMatch(LINE);
  });
});
