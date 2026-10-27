import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L371 — raf done n'a pas commité le plan (26-10, L365) : c'est voulu (raf n'écrit que dans le fichier, docs/raf.md), pas un réglage ;
// le message de raf done le dit et donne la commande de commit, au gabarit plan.commit du projet.

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-27' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-27T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt dont le plan (L1 en cours) est commité ; `config` : le cadence.yaml, commité avec. */
function depot(config?: string) {
  const repo = gitRepo();
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  if (config) writeFileSync(join(repo, 'cadence.yaml'), config);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  return repo;
}

describe('raf done dit que le plan n\'est pas commité (L371)', () => {
  it('R1 — le plan reste modifié, non commité, et le message de raf done le dit avec la commande de commit', () => {
    const repo = depot();
    const r = cli(repo, 'done', 'L1');
    expect(r.code).toBe(0);
    expect(git(repo, 'status', '--porcelain')).toContain('.cadence/raf.yaml');
    expect(r.out).toContain('L1 → done');
    expect(r.out).toMatch(/plan non commité.*raf ne commite jamais/);
    expect(r.out).toContain("git commit -m 'plan: L1 terminé' -- .cadence/raf.yaml");
  });

  it('R2 — avec plan.commit, la commande donnée reprend le gabarit du projet, sans le groupe de la vague', () => {
    const repo = depot("plan:\n  commit: 'chore({lot}): {action} (orchestrate {vague})'\n");
    const r = cli(repo, 'done', 'L1');
    expect(r.out).toContain("git commit -m 'chore(L1): terminé' -- .cadence/raf.yaml");
  });

  it('R3 — la commande, rejouée telle qu\'imprimée, commite le plan et laisse l\'arbre propre', () => {
    const repo = depot("plan:\n  commit: 'chore({lot}): {action}'\n");
    const r = cli(repo, 'done', 'L1');
    const cmd = r.out.split('\n').find((l) => l.includes('git add'))!.trim();
    execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: 'ignore' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(L1): terminé');
  });

  it('R4 — les fichiers que plan.onWrite produit sont dans la commande, avec le plan', () => {
    const repo = depot("plan:\n  onWrite: { command: 'mkdir -p out && date > out/plan.json', files: [out/plan.json] }\n");
    mkdirSync(join(repo, 'out'), { recursive: true });
    const r = cli(repo, 'done', 'L1');
    expect(r.err).toBe('');
    expect(r.out).toContain('-- .cadence/raf.yaml out/plan.json');
  });

  it('R5 — une sous-tâche close n\'a pas de commit de lot à proposer : rien n\'est dit', () => {
    const repo = depot();
    cli(repo, 'add', 'une tâche', '--parent', 'L1');
    git(repo, 'commit', '-q', '-a', '-m', 'chore: tâche');
    const r = cli(repo, 'done', 'L1/t1');
    expect(r.out).toContain('→ done');
    expect(r.out).not.toContain('plan non commité');
  });

  it('R6 — hors dépôt git, ou plan déjà identique à HEAD, rien n\'est dit', () => {
    const hors = tempDir();
    cli(hors, 'init', '--project', 'demo');
    cli(hors, 'add', 'Lot un');
    expect(cli(hors, 'done', 'L1').out).not.toContain('plan non commité');
  });
});
