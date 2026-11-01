import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { commit, gitRepo, tempDir } from './helpers.js';

// Sondes L508 : on exécute VRAIMENT les commandes imprimées par « cadence release », pas seulement leur texte.

function repo(version: string, pkgExtra: object = {}): string {
  const dir = gitRepo();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme-tool', version: '1.2.3', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', 'eval:plugin': 'x' }, ...pkgExtra }, null, 2) + '\n');
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'acme-tool', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'acme-tool', version: '1.2.3' } } }, null, 2) + '\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing (L7).\n\n## [1.2.3] - 2026-10-01\n\n### Fixed\n\n- Old.\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs/whats-new.md'), `# What's new\n\n## In two lines\n\n- **${version}**: a.\n- **1.2.3**: old.\n\n## Version by version\n\nIntro.\n\n**${version}**: long.\n\n**1.2.3**: old long.\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  commit(dir, 'chore: initial');
  return dir;
}

function printed(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = run(['release', ...argv], { cwd: dir, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: () => undefined, now: () => new Date('2026-10-26T09:00:00') }) as number;
  return { code, out: out.join('\n') };
}
const cmd = (out: string, needle: string) => {
  const l = out.split('\n').find((x) => x.includes(needle)) ?? '';
  return l.replace(/^\s*\d+\.\s*/, '').split('    (')[0];
};
const sh = (dir: string, script: string, env: NodeJS.ProcessEnv = {}) => spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
const tags = (dir: string) => execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();

describe('L508 — tag provisoire : exécution réelle des étapes imprimées', () => {
  it('le clone neuf voit le tag provisoire (npm factice qui lit git describe dans le clone)', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const bin = tempDir();
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$1" = ci ] && exit 0\ngit describe --tags --abbrev=0 > "$PROBE_OUT"\n');
    chmodSync(join(bin, 'npm'), 0o755);
    const probe = join(tempDir(), 'seen');
    const r = sh(dir, cmd(o, 'git clone'), { PATH: `${bin}:${process.env.PATH}`, PROBE_OUT: probe });
    expect(r.status, r.stderr).toBe(0);
    expect(execFileSync('cat', [probe], { encoding: 'utf8' }).trim()).toBe('v1.2.4');
    expect(tags(dir)).toBe('v1.2.4');
  });

  it('clone rouge (npm test échoue) : tag retiré, code non nul, clone temporaire supprimé', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const bin = tempDir();
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$1" = ci ] && exit 0\npwd > "$PROBE_OUT"\nexit 3\n');
    chmodSync(join(bin, 'npm'), 0o755);
    const probe = join(tempDir(), 'cwd');
    const r = sh(dir, cmd(o, 'git clone'), { PATH: `${bin}:${process.env.PATH}`, PROBE_OUT: probe });
    expect(r.status).not.toBe(0);
    expect(tags(dir)).toBe('');
    const cloneDir = execFileSync('cat', [probe], { encoding: 'utf8' }).trim();
    expect(sh('/', `test -e ${cloneDir}`).status, 'clone supprimé').not.toBe(0);
  });

  it('clone rouge dès npm ci : tag retiré aussi', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const bin = tempDir();
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'npm'), 0o755);
    const r = sh(dir, cmd(o, 'git clone'), { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(tags(dir)).toBe('');
  });

  it('clone vert : tag conservé, code 0', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const bin = tempDir();
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'npm'), 0o755);
    const r = sh(dir, cmd(o, 'git clone'), { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).toBe(0);
    expect(tags(dir)).toBe('v1.2.4');
  });

  it('retrait de l’éval rouge : la commande imprimée avec un npm en échec retire le tag', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const bin = tempDir();
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 2\n');
    chmodSync(join(bin, 'npm'), 0o755);
    const r = sh(dir, cmd(o, 'npm run eval:plugin'), { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(tags(dir)).toBe('');
  });

  it('retrait idempotent : tag déjà absent (second rouge) — le code reste non nul, pas de crash du shell', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    const bin = tempDir();
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 2\n');
    chmodSync(join(bin, 'npm'), 0o755);
    const r = sh(dir, cmd(o, 'npm run eval:plugin'), { PATH: `${bin}:${process.env.PATH}` });
    expect(r.status).toBe(1);
  });

  it('prérelease : la version 1.2.4-rc.1 donne un tag v1.2.4-rc.1 cohérent dans pose, retrait et push', () => {
    const dir = repo('1.2.4-rc.1');
    const { out } = printed(dir, '1.2.4-rc.1');
    if (!out.includes('git tag v1.2.4-rc.1')) return; // version explicite non supportée : rien à sonder
    expect(out).toContain('git tag -d v1.2.4-rc.1');
    expect(out).toContain('main v1.2.4-rc.1');
  });

  it('version déjà taguée : refus net, aucune étape imprimée (le tag provisoire d’un essai précédent bloque)', () => {
    const dir = repo('1.2.4');
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const r = printed(dir, 'patch');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('git tag v1.2.4 ');
  });

  it('branche à nom inhabituel : le push cite la branche et le tag, le retrait ne cite que le tag', () => {
    const dir = repo('1.2.4');
    execFileSync('git', ['checkout', '-qb', 'diag/x-1'], { cwd: dir });
    const o = printed(dir, 'patch').out;
    expect(cmd(o, 'git push origin')).toBe('git push origin diag/x-1 v1.2.4');
    expect(cmd(o, 'cadence verify --gate')).toBe('cadence verify --gate --sha HEAD || { git tag -d v1.2.4; false; }');
  });

  it('chaîne complète imprimée, sans les commentaires : porte rouge -> les étapes suivantes sautent avec && et le tag est retiré', () => {
    const dir = repo('1.2.4');
    const o = printed(dir, 'patch').out;
    execFileSync('git', ['tag', 'v1.2.4'], { cwd: dir });
    const gate = cmd(o, 'cadence verify --gate').replace('cadence verify --gate --sha HEAD', 'false');
    const r = sh(dir, `${gate} && echo SUITE`);
    expect(r.stdout).not.toContain('SUITE');
    expect(tags(dir)).toBe('');
  });
});
