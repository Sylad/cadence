import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { findProjects, tourLine, type TourRow } from '../src/lead.js';
import { sharedStateDir, stateDir, writeLock, writeNext } from '../src/state.js';
import { cadenceHome, registerWave, unregisterWave } from '../src/orchestrate/registry.js';
import { commit, gitRepo, tempDir } from './helpers.js';

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-09-28' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Dossier parent avec « alpha » (plan raf) et « beta » (plan en lecture seule, nommé par cadence.yaml), plus un dossier sans plan. */
async function parent() {
  const root = tempDir();
  const alpha = join(root, 'alpha');
  mkdirSync(alpha);
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(alpha, ...a);
  await cad(alpha, 'init', '--project', 'alpha', '--no-hook');
  await cad(alpha, 'add', 'Cache');
  await cad(alpha, 'add', 'Export, un titre assez long pour être tronqué à soixante caractères, au moins');
  git(alpha, 'add', '.');
  commit(alpha, 'chore: plan', '2026-09-20T09:00:00');
  await cad(alpha, 'start', 'L1');
  const plan = join(alpha, 'docs/plan/raf.yaml');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('started: 2026-09-28', 'started: 2026-09-22'));
  git(alpha, 'commit', '-qam', 'chore: plan');
  commit(alpha, 'feat(L1): cache', '2026-09-24T10:00:00');
  writeNext(stateDir(alpha), '2026-09-27', ['finir L1 puis livrer']);

  const beta = join(root, 'beta');
  mkdirSync(join(beta, 'suivi'), { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@e.x'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(beta, ...a);
  writeFileSync(join(beta, 'cadence.yaml'), 'plan:\n  path: suivi/taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat }\n  statuses: { todo: prevu, doing: en_cours, done: livre }\n');
  writeFileSync(join(beta, 'suivi/taches.yaml'), 'taches:\n  - { id: T1, titre: Premier, etat: livre }\n  - { id: T2, titre: Second, etat: prevu }\n');
  git(beta, 'add', '.');
  commit(beta, 'chore: suivi', '2026-09-28T09:00:00');
  mkdirSync(join(root, 'sans-plan'));
  return { root, alpha, beta };
}

describe('cadence lead tour', () => {
  it('imprime une ligne par projet, plan raf et plan en lecture seule, sans toucher au plan', async () => {
    const { root, alpha, beta } = await parent();
    writeFileSync(join(alpha, 'sale.txt'), 'x');
    const before = readFileSync(join(beta, 'suivi/taches.yaml'), 'utf8');
    const planA = readFileSync(join(alpha, 'docs/plan/raf.yaml'), 'utf8');
    const { code, out, err } = await cad(root, 'lead', 'tour');
    expect(code).toBe(0);
    expect(err).toBe('');
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^alpha · en cours L1 \(silencieux 4 ?j\) · dérive /);
    expect(lines[0]).toContain('notes : finir L1 puis livrer');
    expect(lines[0]).toMatch(/prochain L2 Export, un titre assez long pour être tronqué à soixante ca…/);
    expect(lines[0]).toMatch(/dépôt non commité$/);
    expect(lines[1]).toMatch(/^beta · en cours rien · dérive .* · notes : aucune · prochain T2 Second · dépôt propre$/);
    expect(readFileSync(join(beta, 'suivi/taches.yaml'), 'utf8')).toBe(before);
    expect(readFileSync(join(alpha, 'docs/plan/raf.yaml'), 'utf8')).toBe(planA);
  });

  it('prend le dossier en argument, et le dossier courant par défaut', async () => {
    const { root, alpha } = await parent();
    const explicit = await cad(alpha, 'lead', 'tour', root);
    const implicit = await cad(root, 'lead', 'tour');
    expect(explicit.out).toBe(implicit.out);
    expect(explicit.out.split('\n')).toHaveLength(2);
  });

  it('dit « livraison en cours » et « non poussé »', async () => {
    const { root, alpha } = await parent();
    const bare = tempDir();
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(alpha, 'remote', 'add', 'origin', bare);
    git(alpha, 'push', '-q', '-u', 'origin', 'main');
    commit(alpha, 'feat(L1): suite', '2026-09-28T09:00:00');
    writeLock(sharedStateDir(alpha), { pid: process.pid, sha: 'abcdef1234567', started: '2026-09-28 10:00:00' });
    const { out } = await cad(root, 'lead', 'tour');
    expect(out.split('\n')[0]).toMatch(/dépôt non poussé, livraison en cours$/);
  });

  it('ajoute une ligne « créneaux libres » quand une vague tourne, rien sinon (L141)', async () => {
    const { root } = await parent();
    expect((await cad(root, 'lead', 'tour')).out).not.toContain('créneaux libres');
    registerWave(cadenceHome(), { pid: process.ppid, wave: '2026-10-09-1253', started: '2026-10-09T12:53:00Z', cwd: root, repos: ['/x/a'], cap: 2 });
    const { out } = await cad(root, 'lead', 'tour');
    expect(out.split('\n')[2]).toBe('vagues en cours : 1 · sessions en cours : 0 · créneaux libres : 1 sur 2');
    const json = JSON.parse((await cad(root, 'lead', 'tour', '--json')).out);
    expect(Array.isArray(json)).toBe(true);
    unregisterWave(cadenceHome(), process.ppid);
  });

  it('tronque les notes de clôture à 120 caractères', async () => {
    const { root, alpha } = await parent();
    writeNext(stateDir(alpha), '2026-09-27', ['a'.repeat(200)]);
    const { out } = await cad(root, 'lead', 'tour');
    const notes = /notes : (.*?) · prochain/.exec(out.split('\n')[0]!)![1]!;
    expect(notes).toHaveLength(120);
    expect(notes.endsWith('…')).toBe(true);
  });

  it('une erreur sur un projet se lit sur sa ligne, le code reste 0', async () => {
    const { root, beta } = await parent();
    writeFileSync(join(beta, 'suivi/taches.yaml'), 'taches: [\n');
    const { code, out } = await cad(root, 'lead', 'tour');
    expect(code).toBe(0);
    expect(out.split('\n')[0]).toMatch(/^alpha · /);
    expect(out.split('\n')[1]).toMatch(/^beta · ✗ erreur : /);
  });

  it('--json donne le même contenu', async () => {
    const { root } = await parent();
    const { code, out } = await cad(root, 'lead', 'tour', '--json');
    expect(code).toBe(0);
    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.project)).toEqual(['alpha', 'beta']);
    expect(rows[0]).toMatchObject({ project: 'alpha', doing: [{ id: 'L1', silentDays: 4 }], next: { id: 'L2' }, notes: ['finir L1 puis livrer'], repo: [] });
    expect(rows[1]).toMatchObject({ project: 'beta', doing: [], next: { id: 'T2', title: 'Second' }, repo: [] });
    expect(Array.isArray(rows[0]!.drift)).toBe(true);
  });

  it("--json compte les lots faits / en cours / à faire / ajoutés sur 7 jours, sans les abandonnés ni les récurrents (L149)", async () => {
    const { root, alpha } = await parent();
    await cad(alpha, 'add', 'Abandonné');
    await cad(alpha, 'drop', 'L3');
    const plan = join(alpha, 'docs/plan/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace(/(title: Export[^\n]*\n(?:.*\n)*?\s+created: )2026-09-28/, '$12026-09-10'));
    const rows = JSON.parse((await cad(root, 'lead', 'tour', '--json')).out) as Array<Record<string, unknown>>;
    expect(rows[0]!.progress).toEqual({ done: 0, doing: 1, todo: 1, added7: 1 });
    expect(rows[1]!.progress).toEqual({ done: 1, doing: 0, todo: 1, added7: 0 });
  });

  it("--json range les projets selon la clé priority: du cadence.yaml du dossier, les autres après, par ordre alphabétique (L149)", async () => {
    const { root } = await parent();
    writeFileSync(join(root, 'cadence.yaml'), 'priority: [beta]\n');
    const rows = JSON.parse((await cad(root, 'lead', 'tour', '--json')).out) as Array<{ project: string }>;
    expect(rows.map((r) => r.project)).toEqual(['beta', 'alpha']);
  });

  it("les lots « ajoutés cette semaine » sont ceux de moins de 7 jours : 6 jours comptent, 7 non (L149)", async () => {
    const { root, alpha } = await parent();
    const plan = join(alpha, 'docs/plan/raf.yaml');
    const text = readFileSync(plan, 'utf8');
    const created = (day: string) => text.replace(/(title: Export[^\n]*\n(?:.*\n)*?\s+created: )2026-09-28/, `$1${day}`);
    const added7 = async () => (JSON.parse((await cad(root, 'lead', 'tour', '--json')).out) as Array<{ progress: { added7: number } }>)[0]!.progress.added7;
    writeFileSync(plan, created('2026-09-22')); // 6 jours avant le 28
    expect(await added7()).toBe(2);
    writeFileSync(plan, created('2026-09-21')); // 7 jours avant
    expect(await added7()).toBe(1);
  });

  it.each([
    ['priority: ol\n', /priority doit être une liste/],
    ['priority: []\n', /priority doit être une liste/],
    ['priority: [a, 3]\n', /priority doit être une liste/],
    ['priority: [\n', /illisible/],
  ])("une priorité invalide (%j) est signalée sur une ligne « cadence.yaml » en erreur, texte et --json, l'ordre alphabétique reste (L149)", async (yaml, cause) => {
    const { root } = await parent();
    writeFileSync(join(root, 'cadence.yaml'), yaml);
    const text = await cad(root, 'lead', 'tour');
    expect(text.code).toBe(0);
    const lines = text.out.split('\n');
    expect(lines[0]).toMatch(/^cadence\.yaml · ✗ erreur : /);
    expect(lines[0]).toMatch(cause);
    expect(lines.slice(1).map((l) => l.split(' · ')[0])).toEqual(['alpha', 'beta']);
    const rows = JSON.parse((await cad(root, 'lead', 'tour', '--json')).out) as Array<{ project: string; error?: string }>;
    expect(rows.map((r) => r.project)).toEqual(['cadence.yaml', 'alpha', 'beta']);
    expect(rows[0]!.error).toMatch(cause);
    expect(rows[1]!.error).toBeUndefined();
  });

  it('un cadence.yaml sans priority: ne produit aucune ligne d\'erreur', async () => {
    const { root } = await parent();
    writeFileSync(join(root, 'cadence.yaml'), 'qa:\n  expectations: docs/qa.md\n');
    expect((await cad(root, 'lead', 'tour')).out.split('\n').map((l) => l.split(' · ')[0])).toEqual(['alpha', 'beta']);
  });

  it("depuis un projet sans sous-projet, la ligne de ce projet seul ; --json la donne avec son avancement (L149)", async () => {
    const { alpha, beta } = await parent();
    const { code, out } = await cad(alpha, 'lead', 'tour');
    expect(code).toBe(0);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toMatch(/^alpha · en cours L1 /);
    const rows = JSON.parse((await cad(beta, 'lead', 'tour', '--json')).out) as Array<{ project: string; progress: unknown }>;
    expect(rows.map((r) => r.project)).toEqual(['beta']);
    expect(rows[0]!.progress).toEqual({ done: 1, doing: 0, todo: 1, added7: 0 });
    expect((await cad(alpha, 'lead', 'tour', alpha)).out).toBe(out);
  });

  it('sans projet : une ligne le dit', async () => {
    const { code, out } = await cad(tempDir(), 'lead', 'tour');
    expect(code).toBe(0);
    expect(out).toMatch(/aucun projet/);
  });

  it("n'écrit rien dans les dépôts", async () => {
    const { root, alpha } = await parent();
    await cad(root, 'lead', 'tour');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: alpha, encoding: 'utf8' })).toBe('');
  });

  it('findProjects écarte dossiers cachés, node_modules et cadence.yaml avec seulement qa:, garde le cadence.yaml illisible', async () => {
    const { root } = await parent();
    const planned = (name: string) => {
      mkdirSync(join(root, name, 'docs/plan'), { recursive: true });
      writeFileSync(join(root, name, 'docs/plan/raf.yaml'), 'lots: []\n');
    };
    planned('.hidden');
    planned('node_modules');
    mkdirSync(join(root, 'qa-seul'));
    writeFileSync(join(root, 'qa-seul/cadence.yaml'), 'qa:\n  expectations: docs/qa.md\n');
    mkdirSync(join(root, 'casse'));
    writeFileSync(join(root, 'casse/cadence.yaml'), 'plan: [\n');
    expect(findProjects(root).map((d) => d.slice(root.length + 1))).toEqual(['alpha', 'beta', 'casse']);
  });

  it('--idle règle le seuil de silence et refuse une valeur invalide', async () => {
    const { root } = await parent();
    const strict = await cad(root, 'lead', 'tour', '--idle', '10');
    expect(strict.code).toBe(0);
    expect(strict.out.split('\n')[0]).toMatch(/^alpha · en cours L1 · /);
    const zero = await cad(root, 'lead', 'tour', '--idle', '0');
    expect(zero.out.split('\n')[0]).toMatch(/en cours L1 \(silencieux 4 ?j\)/);
    for (const bad of ['x', '-1', '1.5']) {
      const r = await cad(root, 'lead', 'tour', `--idle=${bad}`);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--idle invalide');
    }
  });

  it('la dérive : le nombre, les deux premiers messages, puis « ; … »', () => {
    const row = (drift: string[]): TourRow => ({ project: 'p', doing: [], drift, notes: [], next: null, progress: { done: 0, doing: 0, todo: 0, added7: 0 }, repo: [] });
    expect(tourLine(row([]))).toContain('dérive aucune');
    expect(tourLine(row(['⚠ a']))).toContain('dérive 1 (⚠ a) ·');
    expect(tourLine(row(['⚠ a', '✗ b']))).toContain('dérive 2 (⚠ a ; ✗ b) ·');
    expect(tourLine(row(['⚠ a', '✗ b', '✗ c', '✗ d']))).toContain('dérive 4 (⚠ a ; ✗ b ; …) ·');
  });

  it('un lot en cours sans aucune activité datée est dit « aucune activité », comme session start', async () => {
    const { root, beta } = await parent();
    writeFileSync(join(beta, 'suivi/taches.yaml'), 'taches:\n  - { id: T1, titre: Premier, etat: livre }\n  - { id: T2, titre: Second, etat: en_cours }\n');
    const { out } = await cad(root, 'lead', 'tour');
    expect(out.split('\n')[1]).toMatch(/^beta · en cours T2 \(aucune activité\) · /);
    const json = JSON.parse((await cad(root, 'lead', 'tour', '--json')).out) as TourRow[];
    expect(json[1]!.doing).toEqual([{ id: 'T2', noActivity: true }]);
  });
});

describe('point d\'entrée', () => {
  it('bin/cadence.js route « lead » vers le CLI et le liste dans son aide', () => {
    const bin = readFileSync(new URL('../bin/cadence.js', import.meta.url), 'utf8');
    expect(bin).toMatch(/\[[^\]]*'lead'[^\]]*\]\.includes\(tool\)/);
    expect(bin).toContain('cadence lead tour [dossier]');
  });
});
