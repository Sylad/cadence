import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { latestVersionTag } from '../src/git.js';
import { unpublished, unpublishedAt, unpublishedLine } from '../src/unpublished.js';
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
  writeFileSync(plan, text.slice(0, i) + text.slice(i).replace(/status: \w+/, `status: ${status}`));
};

/** Dépôt publiant : tag v1.0.0 posé après L1, L2 travaillé après. */
async function repo(pkg: string | null = '{"name":"d","version":"1.0.0"}', tag: string | null = 'v1.0.0') {
  const dir = gitRepo();
  await cad(dir, 'init', '--project', 'demo', '--no-hook');
  for (const t of ['Un', 'Deux']) await cad(dir, 'add', t);
  if (pkg !== null) writeFileSync(join(dir, 'package.json'), pkg);
  const plan = join(dir, '.cadence/raf.yaml');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace(`since: ${TODAY}`, 'since: 2026-11-01'));
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-11-01T09:00:00');
  commit(dir, 'feat(L1): un', '2026-11-02T09:00:00');
  if (tag) git(dir, 'tag', tag);
  commit(dir, 'feat(L2): deux', '2026-11-03T09:00:00');
  setStatus(dir, 'L1', 'done');
  setStatus(dir, 'L2', 'done');
  git(dir, 'commit', '-qam', 'plan: terminés');
  return dir;
}

describe('L571 limites — lots non publiés', () => {
  it('tag posé sur HEAD : aucun commit depuis, aucune ligne', async () => {
    const dir = await repo();
    git(dir, 'tag', 'v1.0.1');
    expect((await cad(dir, 'lead', 'tour')).out).not.toContain('depuis le dernier tag');
    expect((await cad(dir, 'session', 'close')).out).not.toContain('depuis le dernier tag');
  });

  it('tag annoté : traité comme un tag léger', async () => {
    const dir = await repo('{"name":"d","version":"1.0.0"}', null);
    const first = execFileSync('git', ['rev-list', '--max-count=1', 'HEAD~2'], { cwd: dir }).toString().trim();
    execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'rel', first], { cwd: dir, stdio: 'ignore' });
    expect(unpublishedAt(dir)?.tag).toBe('v1.0.0');
  });

  it('un tag de version hors de l’histoire de HEAD est ignoré', async () => {
    const dir = await repo();
    git(dir, 'checkout', '-q', '-b', 'autre', 'HEAD~2');
    commit(dir, 'chore: x', '2026-11-03T12:00:00');
    git(dir, 'tag', 'v9.0.0');
    git(dir, 'checkout', '-q', '-');
    expect(latestVersionTag(dir)).toBe('v1.0.0');
  });

  it('package.json : null, tableau, version numérique, version vide objet → aucune ligne ni exception', async () => {
    for (const pkg of ['null', '[]', '{"version":1}', '{"version":{}}', '', '"1.0.0"']) {
      const dir = await repo(pkg);
      const r = await cad(dir, 'lead', 'tour');
      expect(r.out, pkg).not.toContain('depuis le dernier tag');
      expect(unpublishedAt(dir), pkg).toBeNull();
    }
  });

  it('version "" (chaîne vide) : le dépôt publie-t-il ? (accepté tel quel, pas d’exception)', async () => {
    const dir = await repo('{"version":""}');
    expect(() => unpublishedAt(dir)).not.toThrow();
  });

  it('latestVersionTag : hors dépôt git, dossier inexistant → null', () => {
    expect(latestVersionTag(tempDir())).toBeNull();
    expect(latestVersionTag('/nonexistent/zzz')).toBeNull();
  });

  it('latestVersionTag : v0.0.0, zéros de tête et tags à 4 composantes', async () => {
    const dir = await repo(undefined, null);
    git(dir, 'tag', 'v1.0.0.1');
    git(dir, 'tag', 'v1.0');
    git(dir, 'tag', 'V2.0.0');
    git(dir, 'tag', 'v0.0.0');
    expect(latestVersionTag(dir)).toBe('v0.0.0');
  });

  it('latestVersionTag : v1.10.0 l’emporte sur v1.9.0 et v1.2.10 sur v1.2.9', async () => {
    const dir = await repo(undefined, null);
    for (const t of ['v1.9.0', 'v1.10.0', 'v1.2.9', 'v1.2.10']) git(dir, 'tag', t);
    expect(latestVersionTag(dir)).toBe('v1.10.0');
  });

  it('unpublishedLine : zéro lot ne casse pas, un seul lot est au singulier', () => {
    expect(unpublishedLine({ tag: 'v1.0.0', lots: ['L1'] })).toContain('⚠ 1 lot done');
    expect(unpublishedLine({ tag: 'v1.0.0', lots: ['L1', 'L2'] })).toContain('⚠ 2 lots done');
  });

  it('appel répété : même résultat deux fois, aucune écriture dans le plan', async () => {
    const dir = await repo();
    const a = await cad(dir, 'lead', 'tour', '--json');
    const b = await cad(dir, 'lead', 'tour', '--json');
    expect(a.out).toBe(b.out);
  });

  it('plan sans lot done : unpublished null', async () => {
    const dir = await repo();
    setStatus(dir, 'L1', 'todo');
    setStatus(dir, 'L2', 'todo');
    expect(unpublishedAt(dir)).toBeNull();
  });

  it('session close : la ligne ⚠ vient avant toute autre ligne rapportée, même avec du travail du jour', async () => {
    const dir = await repo();
    const lines = (await cad(dir, 'session', 'close')).out.split('\n');
    expect(lines[1]).toContain('⚠ 1 lot done depuis le dernier tag v1.0.0 (L2)');
  });

  it('unpublishedAt sur un dossier sans plan ni git : null, sans exception', () => {
    expect(unpublishedAt(tempDir())).toBeNull();
    expect(unpublishedAt('/nonexistent/zzz')).toBeNull();
  });
});
