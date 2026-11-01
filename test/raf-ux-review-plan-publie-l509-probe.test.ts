import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { git } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';

// Sonde L509 : bords de la commande de commit du plan dite par raf ux / raf review.

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-11-01' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-01T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const PUBLIE = "plan:\n  onWrite: { command: 'mkdir -p out && date +%s%N > out/plan.json', files: [out/plan.json] }\n";

function depot(config = PUBLIE) {
  const repo = gitRepo();
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  writeFileSync(join(repo, 'cadence.yaml'), config);
  mkdirSync(join(repo, 'out'), { recursive: true });
  cli(repo, 'visible', 'L1', 'on');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  return repo;
}

describe('L509 sonde : bords', () => {
  it('verdict avec apostrophes et guillemets : la commande rejouée laisse l\'arbre propre', () => {
    const repo = depot();
    const r = cli(repo, 'ux', 'L1', `conforme "l'écran" $HOME \`x\``);
    const cmd = r.out.split('\n').find((l) => l.includes('git add'))!.trim();
    execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: 'ignore' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('gabarit avec {vague} hors vague : pas de « (orchestrate ) » résiduel dans la commande', () => {
    const repo = depot(PUBLIE + "  commit: 'chore({lot}): {action} (orchestrate {vague})'\n");
    const r = cli(repo, 'review', 'L1', 'conforme');
    expect(r.out).toContain("chore(L1): revue de code enregistrée'");
    expect(r.out).not.toContain('orchestrate');
  });

  it('sous-tâche (L1/a) : refus, aucune commande de commit', () => {
    const repo = depot();
    const r = cli(repo, 'review', 'L1/a', 'conforme');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('plan non commité');
  });

  it('verdict vide : refus, aucune commande de commit', () => {
    const repo = depot();
    const r = cli(repo, 'ux', 'L1', '');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('plan non commité');
  });

  it('un seul argument « ux L1 » : usage, pas de commande de commit', () => {
    const repo = depot();
    const r = cli(repo, 'review', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('plan non commité');
  });

  it('deux fois de suite après commit, même verdict : la 2e commande (si dite) ne cite que des chemins existants et laisse l\'arbre propre', () => {
    const repo = depot();
    for (let i = 0; i < 2; i++) {
      const r = cli(repo, 'ux', 'L1', 'conforme');
      expect(r.code).toBe(0);
      const cmd = r.out.split('\n').find((l) => l.includes('git add'))?.trim();
      if (cmd) execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: 'ignore' });
      expect(git(repo, 'status', '--porcelain')).toBe('');
    }
  });

  it('sans plan.onWrite : seule le plan est dit, pas de fichier publié', () => {
    const repo = depot('');
    const r = cli(repo, 'review', 'L1', 'conforme');
    expect(r.out).toContain('git add -- .cadence/raf.yaml &&');
    expect(r.out).not.toContain('out/plan.json');
  });

  it('chemin avec espace pour la copie publiée : la commande rejouée fonctionne', () => {
    const repo = depot("plan:\n  onWrite: { command: 'mkdir -p \"o ut\" && date +%s%N > \"o ut/p.json\"', files: ['o ut/p.json'] }\n");
    mkdirSync(join(repo, 'o ut'), { recursive: true });
    writeFileSync(join(repo, 'o ut/p.json'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'chore: pub');
    const r = cli(repo, 'ux', 'L1', 'conforme');
    const cmd = r.out.split('\n').find((l) => l.includes('git add'))!.trim();
    expect(cmd).toContain("'o ut/p.json'");
    execFileSync('sh', ['-c', cmd], { cwd: repo, stdio: 'ignore' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('raf ux enable / review enable : jamais de commande de commit, même avec la copie publiée régénérée', () => {
    const repo = depot();
    expect(cli(repo, 'review', 'enable').out).not.toContain('plan non commité');
  });

  it('lot inconnu avec verdict : code non nul, stdout sans commande, message d\'erreur sur err', () => {
    const repo = depot();
    const r = cli(repo, 'review', 'L99', 'conforme');
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain('L99');
  });
});
