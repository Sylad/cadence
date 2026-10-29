import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { sharedStateDir } from '../src/state.js';
import { installPrePush, keepGateGuard, removePrePush } from '../src/orchestrate/guard.js';
import { cleanupTempDirs, gitRepo, tempDir } from './helpers.js';

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

  it('R13 — docs/raf.md décrit le refus de la porte de `raf hook pre-push` et son contournement', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'raf.md'), 'utf8');
    const line = doc.split('\n').find((l) => l.startsWith('| `raf hook pre-push`'))!;
    expect(line).toContain('verdict');
    expect(line).toContain('CADENCE_PUSH_UNGATED=1');
    expect(line).not.toContain('exits 0 with no live wave');
  });
});

describe('la garde de la porte survit au hook de la vague (L426)', () => {
  const bare = (repo: string) => {
    const origin = tempDir();
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', origin);
  };
  const hookFile = (repo: string) => join(repo, '.git/hooks/pre-push');

  it('R14 — quand la vague retire son hook et que le projet déclare une porte, il reste un hook qui refuse un push sans verdict vert', () => {
    const { repo } = project('true');
    bare(repo);
    expect(installPrePush(repo, 'w1')).toEqual({ ok: true });
    removePrePush(repo, 'w1');
    keepGateGuard(repo);
    expect(existsSync(hookFile(repo))).toBe(true);
    expect(readFileSync(hookFile(repo), 'utf8')).not.toContain('CADENCE_ORCHESTRATED');
    // le hook appelle `raf` du PATH (pas de dist dans les tests) : un faux `raf` qui refuse (code 3) montre que le hook le consulte et en suit le refus
    const bin = tempDir();
    writeFileSync(join(bin, 'raf'), '#!/bin/sh\necho "raf: push refusé — faux" >&2\nexit 3\n', { mode: 0o755 });
    const refused = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('push refusé — faux');
    const ok = tempDir();
    writeFileSync(join(ok, 'raf'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${ok}:${process.env.PATH}` } }).status).toBe(0);
  });

  it('R15 — sans porte déclarée, ou devant un hook du projet, la vague ne laisse rien ; une vague suivante remplace le hook laissé', () => {
    const { repo } = project(null);
    expect(installPrePush(repo, 'w1')).toEqual({ ok: true });
    removePrePush(repo, 'w1');
    expect(existsSync(hookFile(repo))).toBe(false);
    const gated = project('true').repo;
    writeFileSync(hookFile(gated), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    keepGateGuard(gated);
    expect(readFileSync(hookFile(gated), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    const again = project('true').repo;
    keepGateGuard(again);
    expect(installPrePush(again, 'w2')).toEqual({ ok: true });
    expect(readFileSync(hookFile(again), 'utf8')).toContain('# wave: w2');
    removePrePush(again, 'w2');
    keepGateGuard(again);
    expect(readFileSync(hookFile(again), 'utf8')).not.toContain('# wave: w2');
  });
});
