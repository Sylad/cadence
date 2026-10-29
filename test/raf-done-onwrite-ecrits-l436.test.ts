import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { git } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

// L436 — raf done proposait un commit qui ne citait que le plan alors que plan.onWrite avait régénéré un autre fichier que ceux de onWrite.files :
// deliver refusait ensuite « 1 fichier modifié ». Les fichiers que la commande a réellement écrits sont cités, déclarés ou non.

function cli(repo: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: repo, env: { RAF_TODAY: '2026-10-27' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-27T10:00:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un dépôt dont le plan (L1 en cours) est commité, avec le fichier `out/plan.json` suivi ; `config` : le cadence.yaml. */
function depot(config: string) {
  const repo = gitRepo();
  cli(repo, 'init', '--project', 'demo');
  cli(repo, 'add', 'Lot un');
  cli(repo, 'start', 'L1');
  mkdirSync(join(repo, 'out'), { recursive: true });
  writeFileSync(join(repo, 'out/plan.json'), '0\n');
  writeFileSync(join(repo, 'out/autre.json'), '0\n');
  writeFileSync(join(repo, 'cadence.yaml'), config);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: plan');
  return repo;
}

const commande = (r: { out: string }) => r.out.split('\n').find((l) => l.includes('git add'))!.trim();

describe('raf done cite les fichiers que plan.onWrite a écrits (L436)', () => {
  it('R1 — un fichier écrit par la commande et absent de onWrite.files est cité dans le commit proposé, et la notice dit de le déclarer', () => {
    const repo = depot("plan:\n  onWrite: { command: 'date +%s%N > out/plan.json; date +%s%N > out/autre.json', files: [out/plan.json] }\n");
    const r = cli(repo, 'done', 'L1');
    expect(commande(r)).toContain('git add -- .cadence/raf.yaml out/autre.json out/plan.json &&');
    expect(r.err).toContain('out/autre.json');
    expect(r.err).toContain('plan.onWrite.files');
    execFileSync('sh', ['-c', commande(r)], { cwd: repo, stdio: 'ignore' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('R2 — un fichier déclaré et écrit n\'est cité qu\'une fois, sans notice', () => {
    const repo = depot("plan:\n  onWrite: { command: 'date +%s%N > out/plan.json', files: [out/plan.json] }\n");
    const r = cli(repo, 'done', 'L1');
    expect(commande(r)).toContain('git add -- .cadence/raf.yaml out/plan.json &&');
    expect(commande(r).match(/out\/plan\.json/g)).toHaveLength(2);
    expect(r.err).toBe('');
  });

  it('R3 — un fichier que le lead avait déjà modifié et que la commande n\'a pas touché n\'est pas cité', () => {
    const repo = depot("plan:\n  onWrite: { command: 'date +%s%N > out/plan.json', files: [out/plan.json] }\n");
    writeFileSync(join(repo, 'out/autre.json'), 'travail du lead\n');
    const r = cli(repo, 'done', 'L1');
    expect(r.out).not.toContain('autre.json');
    expect(r.err).toBe('');
  });

  it('R4 — un fichier déjà modifié par le lead que la commande réécrit autrement est cité', () => {
    const repo = depot("plan:\n  onWrite: { command: 'date +%s%N > out/autre.json', files: [out/plan.json] }\n");
    writeFileSync(join(repo, 'out/autre.json'), 'travail du lead\n');
    const r = cli(repo, 'done', 'L1');
    expect(r.out).toContain('out/autre.json');
  });

  it('R5 — une commande qui échoue refuse l\'écriture : rien n\'est cité, le plan reste inchangé', () => {
    const repo = depot("plan:\n  onWrite: { command: 'date > out/autre.json; exit 3', files: [out/plan.json] }\n");
    const r = cli(repo, 'done', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('git add');
  });

  it('R6 — hors dépôt git, la commande s\'exécute sans citer ni échouer', () => {
    const hors = tempDir();
    writeFileSync(join(hors, 'cadence.yaml'), "plan:\n  onWrite: { command: 'date > autre.json', files: [] }\n");
    cli(hors, 'init', '--project', 'demo');
    cli(hors, 'add', 'Lot un');
    const r = cli(hors, 'done', 'L1');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('git add');
  });
});
