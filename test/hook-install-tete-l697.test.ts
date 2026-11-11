import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { moveBlockToHead } from '../src/hook.js';
import { holdRepo } from '../src/repo-held.js';
import { gitRepo, tempDir, testPackage } from './helpers.js';

// L697 (suite de L695) : le bloc raf du pre-commit se pose en TÊTE d'un pre-commit existant. Ajouté à la fin, il ne s'exécutait
// pas quand le script maison sortait tôt (cadence, 10-11 : « exit 0 » quand aucun fichier de doc n'est indexé), et un commit
// sur une branche tenue passait. Une réinstallation déplace en tête un bloc déjà posé à la fin, sans le dupliquer.

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-10' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-10T19:30:00Z') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un `raf` réel (paquet jetable) en tête du PATH, pour le hook git. */
function rafEnv(): NodeJS.ProcessEnv {
  const bin = tempDir();
  writeFileSync(join(bin, 'raf'), `#!/bin/sh\nexec node "${join(testPackage(), 'bin/raf.js')}" "$@"\n`);
  chmodSync(join(bin, 'raf'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAF_TODAY: '2026-11-10' };
}

const sh = (cwd: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });

/** Le pre-commit maison de cadence (10-11) : sort en 0 dès que rien de ce qu'il contrôle n'est indexé. */
const MAISON = `#!/bin/sh
# Contrôles de doc avant le commit.
git diff --cached --name-only | grep -qE '^(README\\.md|docs/)' || exit 0
echo "controles de doc" >&2
exit 1
`;
const BLOC = /# >>> raf \(cadence\)\nif command -v raf[^\n]*\n# <<< raf \(cadence\)\n/;

/** Un dépôt avec son plan commité, un pre-commit maison à exit précoce, puis `raf hook install`. */
function project(preCommit = MAISON): { dir: string; env: NodeJS.ProcessEnv; pre: string } {
  const dir = gitRepo(tempDir());
  raf(dir, 'init', '--no-hook');
  raf(dir, 'add', 'Lot du lead');
  const env = rafEnv();
  sh(dir, env, 'git', 'add', '-A');
  expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: plan').status).toBe(0);
  const pre = join(dir, '.git/hooks/pre-commit');
  writeFileSync(pre, preCommit);
  chmodSync(pre, 0o755);
  return { dir, env, pre };
}

describe('L697 : le bloc raf du pre-commit est en tête du script', () => {
  it('raf hook install pose le bloc juste après le shebang, avant le script maison intact', () => {
    const { dir, pre } = project();
    expect(raf(dir, 'hook', 'install').out).toMatch(/hook installé/);
    const text = readFileSync(pre, 'utf8');
    expect(text.startsWith('#!/bin/sh\n# >>> raf (cadence)\n')).toBe(true);
    expect(text.endsWith(MAISON.slice('#!/bin/sh\n'.length))).toBe(true);
    expect(text.match(/>>> raf/g)).toHaveLength(1);
  });

  it('un pre-commit maison qui sort tôt en 0 ne masque plus le refus : le commit sur un dépôt tenu est refusé', () => {
    const { dir, env } = project();
    raf(dir, 'hook', 'install');
    writeFileSync(join(dir, 'src.txt'), 'du lead');
    sh(dir, env, 'git', 'add', 'src.txt');
    const unhold = holdRepo(dir, 'run', 'cadence run');
    try {
      const commit = sh(dir, env, 'git', 'commit', '-qm', 'chore: commit du lead');
      expect(commit.status).not.toBe(0);
      expect(commit.stderr).toMatch(/commit refusé : la branche main est tenue par cadence run/);
    } finally {
      unhold();
    }
    // Rendu, le commit passe : le script maison garde son exit 0 précoce (aucun fichier de doc indexé).
    expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: commit du lead').status).toBe(0);
  });

  it('une réinstallation déplace en tête un bloc déjà posé à la fin, sans le dupliquer, et le dit', () => {
    const { dir, env, pre } = project();
    raf(dir, 'hook', 'install');
    const installe = readFileSync(pre, 'utf8');
    // Le bloc tel qu'un raf d'avant L697 le posait : à la fin, après l'exit précoce.
    const bloc = installe.match(BLOC)![0];
    writeFileSync(pre, `${MAISON}${bloc}`);
    expect(readFileSync(pre, 'utf8').startsWith('#!/bin/sh\n# Contrôles')).toBe(true);

    const r = raf(dir, 'hook', 'install');
    expect(r.out).toMatch(/bloc raf déplacé en tête du script .* : .*pre-commit/);
    expect(r.out).toMatch(/hook installé/);
    expect(readFileSync(pre, 'utf8')).toBe(installe);
    expect(readFileSync(pre, 'utf8').match(/>>> raf/g)).toHaveLength(1);
    // Et le refus tient désormais.
    writeFileSync(join(dir, 'src.txt'), 'du lead');
    sh(dir, env, 'git', 'add', 'src.txt');
    const unhold = holdRepo(dir, 'run', 'cadence run');
    try {
      expect(sh(dir, env, 'git', 'commit', '-qm', 'chore: commit du lead').stderr).toMatch(/commit refusé/);
    } finally {
      unhold();
    }
    // Déjà en tête : rien ne bouge.
    expect(raf(dir, 'hook', 'install').out).toBe(`hook déjà présent : ${join(dir, '.git/hooks/post-commit')}`);
  });

  it('moveBlockToHead : en tête malgré des commentaires et des lignes vides avant ; sans marqueur de fin, rien', () => {
    expect(moveBlockToHead('#!/bin/sh\n\n# note\n# >>> raf (cadence)\nraf\n# <<< raf (cadence)\n')).toBeNull();
    expect(moveBlockToHead('#!/bin/sh\nexit 0\n# >>> raf (cadence)\nraf\n')).toBeNull();
    expect(moveBlockToHead('#!/bin/sh\nset -e\nexit 0\n# >>> raf (cadence)\nraf\n# <<< raf (cadence)\n'))
      .toBe('#!/bin/sh\n# >>> raf (cadence)\nraf\n# <<< raf (cadence)\nset -e\nexit 0\n');
    expect(moveBlockToHead('echo a\n# >>> raf (cadence)\nraf\n# <<< raf (cadence)\n')).toBe('# >>> raf (cadence)\nraf\n# <<< raf (cadence)\necho a\n');
  });
});
