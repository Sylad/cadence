import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { guardPresent, installPrePush, keepGateGuard, removePrePush } from '../src/orchestrate/guard.js';
import { cleanupTempDirs, gitRepo, tempDir, testPackage } from './helpers.js';

// L766, revue r1, constat 2 : la garde de revue au push ne tournait que là où une vague avait posé un hook pre-push. Sur maritime-atlas
// (core.hooksPath = .githooks, dans l'arbre suivi) aucun hook ne restait après la vague : le push de HEAD non relu du 17-11 se rejouait.
// `raf hook install` pose désormais un bloc pre-push durable (fichier du dépôt quand le dossier des hooks est suivi), que la vague reconnaît.

afterEach(cleanupTempDirs);

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-17' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-17T10:00:00Z') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un `raf` réel (paquet jetable) en tête du PATH, pour les hooks git. */
function rafEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${join(testPackage(), 'bin/raf.js')}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-17', ...extra };
  delete env.CADENCE_ORCHESTRATED;
  delete env.CADENCE_PUSH_UNREVIEWED;
  return env;
}

const sh = (cwd: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });

const PLAN = 'suivi/plan.yaml';
const planText = (note?: string) => `taches:\n  - { code: Q-LEG10, titre: Légende, etat: en_cours${note === undefined ? '' : `, note: "${note}"`} }\n`;

/** Un dépôt comme maritime-atlas : plan en lecture seule à note unique, verdict par orchestrate.verdict, hooks dans `.githooks` (suivi), distant nu. */
function maritimeLike(): { dir: string; env: NodeJS.ProcessEnv; hooks: string } {
  const dir = gitRepo(tempDir());
  const env = rafEnv();
  const bare = tempDir();
  sh(bare, env, 'git', 'init', '-q', '--bare');
  sh(dir, env, 'git', 'remote', 'add', 'origin', bare);
  writeFileSync(join(dir, 'cadence.yaml'), `plan:\n  path: ${PLAN}\n  since: 2026-11-01\n  lots: taches\n  idPattern: 'Q-[A-Z]+\\d+'\n  fields: { id: code, title: titre, status: etat, notes: note }\n  statuses: { todo: prevu, doing: en_cours, done: livre }\norchestrate:\n  verdict: ${JSON.stringify('python3 scripts/raf.py note {lot} "revue de code : {verdict}"')}\n`);
  mkdirSync(join(dir, 'suivi'), { recursive: true });
  writeFileSync(join(dir, PLAN), planText());
  const hooks = join(dir, '.githooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(hooks, 'post-commit'), 0o755);
  sh(dir, env, 'git', 'config', 'core.hooksPath', '.githooks');
  sh(dir, env, 'git', 'add', '-A');
  expect(sh(dir, env, 'git', 'commit', '-qm', 'init').status).toBe(0);
  expect(sh(dir, env, 'git', 'push', '-q', 'origin', 'HEAD:main').status).toBe(0);
  return { dir, env, hooks };
}

function commitFile(dir: string, env: NodeJS.ProcessEnv, file: string, text: string, message: string): string {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
  sh(dir, env, 'git', 'add', file);
  expect(sh(dir, env, 'git', 'commit', '-qm', message).status).toBe(0);
  return sh(dir, env, 'git', 'rev-parse', 'HEAD').stdout.trim();
}

describe('L766 r1 : raf hook install pose une garde pre-push durable, hors vague', () => {
  it('R16 — core.hooksPath dans l\'arbre (maritime) : raf hook install pose .githooks/pre-push, et un vrai git push de HEAD non relu est refusé hors vague', () => {
    const { dir, env, hooks } = maritimeLike();
    expect(raf(dir, 'hook', 'install').code).toBe(0);
    const pre = join(hooks, 'pre-push');
    expect(existsSync(pre)).toBe(true);
    expect(readFileSync(pre, 'utf8')).toMatch(/^#!\/bin\/sh\n# >>> raf \(cadence\)\n[\s\S]*raf hook pre-push "\$@"[\s\S]*# <<< raf \(cadence\)\n$/);
    sh(dir, env, 'git', 'add', '.githooks');
    expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: hooks').status).toBe(0);
    expect(sh(dir, env, 'git', 'push', '-q', 'origin', 'HEAD:main').status).toBe(0);

    const a = commitFile(dir, env, 'src/legende.ts', '1\n', 'feat(Q-LEG10): légende');
    const refused = sh(dir, env, 'git', 'push', 'origin', 'HEAD:main');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`Q-LEG10 (${a.slice(0, 7)})`);

    commitFile(dir, env, PLAN, planText('revue de code : conforme'), 'plan: Q-LEG10 revue de code notée');
    const pushed = sh(dir, env, 'git', 'push', 'origin', 'HEAD:main');
    expect(pushed.stderr).not.toContain('push refusé');
    expect(pushed.status).toBe(0);
  });

  it('R17 — le bloc rend son entrée au script maison qui le suit, et refuse une session d\'orchestrate', () => {
    const { dir, env, hooks } = maritimeLike();
    const pre = join(hooks, 'pre-push');
    const trace = join(tempDir(), 'stdin.txt');
    writeFileSync(pre, `#!/bin/sh\ncat > "${trace}"\nexit 0\n`);
    chmodSync(pre, 0o755);
    raf(dir, 'hook', 'install');
    expect(readFileSync(pre, 'utf8').startsWith('#!/bin/sh\n# >>> raf (cadence)\n')).toBe(true);
    commitFile(dir, env, 'notes.txt', 'n\n', 'docs: notes');
    expect(sh(dir, env, 'git', 'push', '-q', 'origin', 'HEAD:main').status).toBe(0);
    expect(readFileSync(trace, 'utf8')).toMatch(/^\S+ [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}\n$/);

    commitFile(dir, env, 'notes.txt', 'm\n', 'docs: notes 2');
    const orchestrated = sh(dir, { ...env, CADENCE_ORCHESTRATED: 'w1' }, 'git', 'push', 'origin', 'HEAD:main');
    expect(orchestrated.status).not.toBe(0);
    expect(orchestrated.stderr).toContain('push refusé pendant la vague w1');
  });

  it('R18 — la vague reconnaît le bloc : elle ne refuse pas le dépôt, n\'écrit rien, le garde à la fin ; raf hook install remplace un hook de vague ou de porte sans doubler', () => {
    const { dir, hooks } = maritimeLike();
    raf(dir, 'hook', 'install');
    const pre = join(hooks, 'pre-push');
    const installed = readFileSync(pre, 'utf8');
    expect(installPrePush(dir, 'w1')).toEqual({ ok: true });
    expect(readFileSync(pre, 'utf8')).toBe(installed);
    expect(guardPresent(dir)).toBe(true);
    removePrePush(dir, 'w1');
    keepGateGuard(dir);
    expect(readFileSync(pre, 'utf8')).toBe(installed);

    // Un dépôt sans hook où une vague a posé le sien : raf hook install le remplace par le bloc durable (un seul appel à raf hook pre-push).
    const other = gitRepo(tempDir());
    expect(installPrePush(other, 'w2')).toEqual({ ok: true });
    raf(other, 'hook', 'install');
    const text = readFileSync(join(other, '.git/hooks/pre-push'), 'utf8');
    expect(text.match(/raf hook pre-push/g)).toHaveLength(1);
    expect(text).toContain('# >>> raf (cadence)');
    expect(text).not.toContain('# wave: w2');
  });
});
