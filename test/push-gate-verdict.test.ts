import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { sharedStateDir } from '../src/state.js';
import { cleanupTempDirs, gitRepo } from './helpers.js';

afterEach(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const ZERO = '0'.repeat(40);

async function cli(dir: string, stdin: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-29', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-29T10:00:00'), stdin: () => stdin });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Dépôt dont la porte (`orchestrate.test`) est la commande donnée ; `inPlace: false` pour ne pas toucher l'arbre principal. */
function project(testCmd: string | null) {
  const repo = gitRepo();
  writeFileSync(join(repo, 'cadence.yaml'), `${testCmd ? `orchestrate:\n  test: "${testCmd}"\n` : ''}verify:\n  inPlace: false\n`);
  writeFileSync(join(repo, 'a.txt'), '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const first = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), '2\n');
  git(repo, 'commit', '-qam', 'deux');
  return { repo, first, head: git(repo, 'rev-parse', 'HEAD') };
}

const verdicts = (repo: string) => JSON.parse(readFileSync(join(sharedStateDir(repo), 'gate-verdicts.json'), 'utf8')) as Record<string, { code: number; at: string }>;
const push = (head: string, remote = ZERO, ref = 'refs/heads/main') => `${ref} ${head} ${ref} ${remote}\n`;

describe('verify --gate enregistre son verdict par sha (L426)', () => {
  it('R1 — une porte verte enregistre le verdict du sha (code 0, date) dans l\'état partagé du dépôt', async () => {
    const { repo, head } = project('true');
    expect((await cli(repo, '', {}, 'verify', '--gate', '--sha', head)).code).toBe(0);
    expect(verdicts(repo)[head]!.at).toBe(new Date('2026-10-29T10:00:00').toISOString());
    expect(verdicts(repo)[head]!.code).toBe(0);
  });

  it('R2 — une porte rouge enregistre un verdict rouge (code 1), et un verdict vert plus récent du même sha le remplace', async () => {
    const { repo, head } = project('false');
    expect((await cli(repo, '', {}, 'verify', '--gate', '--sha', head)).code).toBe(1);
    expect(verdicts(repo)[head]!.code).toBe(1);
    writeFileSync(join(repo, 'cadence.yaml'), 'orchestrate:\n  test: "true"\nverify:\n  inPlace: false\n');
    // le sha reste le même : la config n'est pas versionnée ici, seul le verdict le plus récent compte
    expect((await cli(repo, '', {}, 'verify', '--gate', '--sha', head)).code).toBe(0);
    expect(verdicts(repo)[head]!.code).toBe(0);
  });

  it('R3 — rien à rejouer (code 2) n\'enregistre rien : ce n\'est pas un verdict', async () => {
    const { repo, head } = project(null);
    expect((await cli(repo, '', {}, 'verify', '--gate', '--sha', head)).code).toBe(2);
    expect(existsSync(join(sharedStateDir(repo), 'gate-verdicts.json'))).toBe(false);
  });
});

describe('verdict non inscriptible (L426)', () => {
  it('R13 — un verdict qu\'on ne peut pas noter n\'altère pas le code de sortie de la porte : il est dit sur la sortie', async () => {
    const { repo, head } = project('false');
    mkdirSync(join(sharedStateDir(repo), 'gate-verdicts.json')); // un dossier à la place du fichier : le renommage échoue
    const r = await cli(repo, '', {}, 'verify', '--gate', '--sha', head);
    expect(r.code).toBe(1);
    expect(r.out).toContain('verdict non noté');
  });
});

describe('hook pre-push : un push dont le sha de tête n\'a pas de verdict vert est refusé (L426)', () => {
  it('R4 — sans verdict pour le sha poussé : refus (code 3) qui nomme le sha et la commande à lancer', async () => {
    const { repo, first, head } = project('true');
    const r = await cli(repo, push(head, first), {}, 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain(head.slice(0, 7));
    expect(r.err).toContain(`cadence verify --gate --sha ${head.slice(0, 7)}`);
    expect(r.err).toContain('CADENCE_PUSH_UNGATED=1');
  });

  it('R5 — avec un verdict vert enregistré pour ce sha : le push passe', async () => {
    const { repo, first, head } = project('true');
    await cli(repo, '', {}, 'verify', '--gate', '--sha', head);
    expect((await cli(repo, push(head, first), {}, 'hook', 'pre-push')).code).toBe(0);
  });

  it('R6 — un verdict rouge refuse aussi, et le message dit « rouge » (pas « absent »)', async () => {
    const { repo, first, head } = project('false');
    await cli(repo, '', {}, 'verify', '--gate', '--sha', head);
    const r = await cli(repo, push(head, first), {}, 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain('rouge');
  });

  it('R7 — le verdict est celui du sha : le vert d\'un commit antérieur ne couvre pas la tête', async () => {
    const { repo, first, head } = project('true');
    await cli(repo, '', {}, 'verify', '--gate', '--sha', first);
    expect((await cli(repo, push(head, first), {}, 'hook', 'pre-push')).code).toBe(3);
  });

  it('R8 — CADENCE_PUSH_UNGATED=1 passe outre, et le dit sur la sortie d\'erreur', async () => {
    const { repo, first, head } = project('true');
    const r = await cli(repo, push(head, first), { CADENCE_PUSH_UNGATED: '1' }, 'hook', 'pre-push');
    expect(r.code).toBe(0);
    expect(r.err).toContain('CADENCE_PUSH_UNGATED');
  });

  it('R9 — un projet sans porte déclarée (ni orchestrate.test ni orchestrate.build) n\'exige aucun verdict', async () => {
    const { repo, first, head } = project(null);
    expect((await cli(repo, push(head, first), {}, 'hook', 'pre-push')).code).toBe(0);
  });

  it('R10 — la suppression d\'une branche et un tag (réf hors refs/heads/) ne demandent pas de verdict', async () => {
    const { repo, head } = project('true');
    expect((await cli(repo, push(ZERO, head, 'refs/heads/autre'), {}, 'hook', 'pre-push')).code).toBe(0);
    expect((await cli(repo, push(head, ZERO, 'refs/tags/v1'), {}, 'hook', 'pre-push')).code).toBe(0);
  });

  it('R11 — plusieurs réfs poussées : la première sans verdict vert refuse', async () => {
    const { repo, first, head } = project('true');
    await cli(repo, '', {}, 'verify', '--gate', '--sha', head);
    const r = await cli(repo, push(head, first) + push(first, ZERO, 'refs/heads/vieille'), {}, 'hook', 'pre-push');
    expect(r.code).toBe(3);
    expect(r.err).toContain(first.slice(0, 7));
  });

  it('R12 — un fichier de verdicts illisible vaut « pas de verdict » : le push est refusé, pas un plantage', async () => {
    const { repo, first, head } = project('true');
    writeFileSync(join(sharedStateDir(repo), 'gate-verdicts.json'), '{ pas du json');
    expect((await cli(repo, push(head, first), {}, 'hook', 'pre-push')).code).toBe(3);
    // et la porte suivante réécrit un fichier sain
    await cli(repo, '', {}, 'verify', '--gate', '--sha', head);
    expect(verdicts(repo)[head]!.code).toBe(0);
  });
});
