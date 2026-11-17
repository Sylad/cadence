import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { deliveredIds, planAtSha } from '../src/deliver-lots.js';
import { headSha } from '../src/git.js';
import { Plan, type PlanFormat } from '../src/plan.js';
import { appendDelivery, sharedStateDir } from '../src/state.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

// L765 : `deliver --constat <sha>` sur un plan en lecture seule annonçait « livré : Q-COUPE0 » (maritime, 17-11, constat d2e7039)
// alors que ce lot, démarré APRÈS le sha, n'avait aucun commit dessous : le plan lu était celui de la tête, où il est en cours, et
// un commit d'avant le sha le nommait en passant. Seuls les lots déjà en cours au sha sont nommés.

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const TODAY = '2026-11-17';
const FORMAT: PlanFormat = { lots: 'taches', fields: { title: ['titre'], status: ['etat'] }, statuses: { prevu: 'todo', en_cours: 'doing', livre: 'done' }, estimates: {} };
const taches = (coupe: string) => `taches:\n- { id: Q-SIGW3, titre: Jets, etat: en_cours }\n- { id: Q-COUPE0, titre: Coupe verticale, etat: ${coupe} }\n`;

/** Dépôt poussé : base livrée, puis un commit de Q-SIGW3 qui nomme Q-COUPE0 en passant (le sha constaté), puis Q-COUPE0 démarré et travaillé. */
function repo(): { dir: string; base: string; sha: string } {
  const origin = tempDir();
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const dir = gitRepo();
  writeFileSync(join(dir, 'taches.yaml'), taches('prevu'));
  writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat }\n  statuses: { todo: prevu, doing: en_cours, done: livre }\ndeliver:\n  script: "exit 7"\n');
  git(dir, 'add', '.');
  commit(dir, 'chore: plan');
  const base = headSha(dir)!;
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(dir, 'a.txt'), 'jets\n');
  git(dir, 'add', 'a.txt');
  commit(dir, 'fix: jets de Q-SIGW3 — la coupe viendra en Q-COUPE0');
  const sha = headSha(dir)!;
  writeFileSync(join(dir, 'taches.yaml'), taches('en_cours'));
  git(dir, 'add', 'taches.yaml');
  commit(dir, 'plan: Q-COUPE0 démarré');
  writeFileSync(join(dir, 'b.txt'), 'coupe\n');
  git(dir, 'add', 'b.txt');
  commit(dir, 'feat(Q-COUPE0): coupe verticale');
  git(dir, 'push', '-q', 'origin', 'main');
  appendDelivery(sharedStateDir(dir), '2026-11-16', base);
  return { dir, base, sha };
}

const ctx = (dir: string, planAt?: (sha: string) => Plan | null) => ({
  root: dir, plan: Plan.load(join(dir, 'taches.yaml'), { format: FORMAT }), today: TODAY, out: () => {}, err: () => {}, ...(planAt ? { planAt } : {}),
});

describe('L765 — deliver --constat ne nomme pas un lot démarré après le sha', () => {
  it('le plan de la tête seul nommait Q-COUPE0 ; lu au sha, seul Q-SIGW3, en cours dessous, reste', () => {
    const { dir, base, sha } = repo();
    expect(deliveredIds(ctx(dir), base, sha)).toEqual(['Q-COUPE0', 'Q-SIGW3']);
    const planAt = planAtSha(dir, join(dir, 'taches.yaml'), (p) => Plan.load(p, { format: FORMAT }));
    expect(planAt(sha)!.lots().find((l) => l.id === 'Q-COUPE0')!.status).toBe('todo');
    expect(deliveredIds(ctx(dir, planAt), base, sha)).toEqual(['Q-SIGW3']);
  });

  it('un plan absent au sha (ou illisible) : aucun lot nommé, plutôt qu\'un lot qui n\'y était pas', () => {
    const { dir, base, sha } = repo();
    expect(planAtSha(dir, join(dir, 'ailleurs.yaml'), (p) => Plan.load(p, { format: FORMAT }))(sha)).toBeNull();
    expect(planAtSha(dir, join(dir, 'a.txt'), (p) => Plan.load(p, { format: FORMAT }))(sha)).toBeNull();
    expect(deliveredIds(ctx(dir, () => null), base, sha)).toEqual([]);
  });

  it('en ligne de commande : « livré : Q-SIGW3 » seul pour le sha constaté, le plan de la tête inchangé', async () => {
    const { dir, sha } = repo();
    const before = readFileSync(join(dir, 'taches.yaml'), 'utf8');
    const lines: string[] = [];
    const io = { cwd: dir, env: { RAF_TODAY: TODAY }, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), now: () => new Date(`${TODAY}T12:00:00`) };
    expect(await run(['deliver', '--constat', sha], io)).toBe(0);
    expect(lines.filter((l) => l.startsWith('livré :'))).toEqual(["livré : Q-SIGW3 — à fermer avec l'outil du projet si l'effet est celui attendu"]);
    expect(readFileSync(join(dir, 'taches.yaml'), 'utf8')).toBe(before);
  });

  it('cadence deliver ordinaire (sans constat) : inchangé, le plan du départ fait foi', () => {
    const { dir, base } = repo();
    const head = headSha(dir)!;
    expect(deliveredIds(ctx(dir), base, head)).toEqual(['Q-COUPE0', 'Q-SIGW3']);
  });
});
