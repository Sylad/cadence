import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L509 — warhammer, 01-11 : après `raf ux` / `raf review`, la copie publiée du plan (plan.onWrite) était régénérée mais rien ne disait de la commiter
// avec le plan (seul `raf done` le disait) : la CI « plan publié à jour » est restée rouge. Les trois commandes disent le fichier à commiter.

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-11-01' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-01T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const PUBLIE = "plan:\n  onWrite: { command: 'mkdir -p out && date +%s%N > out/plan.json', files: [out/plan.json] }\n";

/** Un dépôt dont le plan (L1 en cours, visible) et la copie publiée sont commités. */
function depot(config?: string) {
  const repo = gitRepo();
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  if (config) writeFileSync(join(repo, 'cadence.yaml'), config);
  mkdirSync(join(repo, 'out'), { recursive: true });
  cli(repo, 'visible', 'L1', 'on');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  return repo;
}

describe('raf ux et raf review disent le plan et la copie publiée à commiter (L509)', () => {
  for (const [commande, action] of [['ux', 'verdict UX enregistré'], ['review', 'revue de code enregistrée']] as const) {
    it(`R1 — raf ${commande} : la copie publiée régénérée est dans la commande de commit, avec le plan et l'action « ${action} »`, () => {
      const repo = depot(PUBLIE);
      const r = cli(repo, commande, 'L1', 'conforme');
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.out).toMatch(/plan non commité.*raf ne commite jamais/);
      expect(r.out).toContain(`git commit -m 'plan: L1 ${action}' -- .cadence/raf.yaml out/plan.json`);
    });

    it(`R2 — raf ${commande} : la commande, rejouée telle qu'imprimée, laisse l'arbre propre`, () => {
      const repo = depot(PUBLIE);
      const r = cli(repo, commande, 'L1', 'conforme');
      const cmd = r.out.split('\n').find((l) => l.includes('git add'))!.trim();
      execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: 'ignore' });
      expect(git(repo, 'status', '--porcelain')).toBe('');
    });

    it(`R3 — raf ${commande} : hors dépôt git, ou refusé (lot inconnu), rien n'est dit`, () => {
      const hors = tempDir();
      cli(hors, 'init', '--project', 'demo');
      cli(hors, 'add', 'Lot un');
      expect(cli(hors, commande, 'L1', 'conforme').out).not.toContain('plan non commité');
      const repo = depot(PUBLIE);
      const inconnu = cli(repo, commande, 'L99', 'conforme');
      expect(inconnu.code).not.toBe(0);
      expect(inconnu.out).not.toContain('plan non commité');
    });
  }

  it('R4 — raf ux enable écrit le plan sans lot à citer : rien n\'est dit', () => {
    const repo = depot(PUBLIE);
    expect(cli(repo, 'ux', 'enable').out).not.toContain('plan non commité');
  });

  it('R5 — le gabarit plan.commit du projet s\'applique à la commande de raf ux', () => {
    const repo = depot(PUBLIE + "  commit: 'chore({lot}): {action}'\n");
    expect(cli(repo, 'ux', 'L1', 'conforme').out).toContain("git commit -m 'chore(L1): verdict UX enregistré' --");
  });
});
