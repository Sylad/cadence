import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirtyPaths } from '../src/git.js';
import { commit, gitRepo } from './helpers.js';

describe('dirtyPaths', () => {
  it('liste vide → rien, même avec un arbre sale (sans pathspec git listerait tout l\'arbre — L388)', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'suivi.txt'), 'v1\n');
    execFileSync('git', ['add', '--', 'suivi.txt'], { cwd: dir });
    commit(dir, 'init');
    writeFileSync(join(dir, 'suivi.txt'), 'v2\n');
    writeFileSync(join(dir, 'brouillon.txt'), 'non suivi\n');
    expect(dirtyPaths(dir, [])).toEqual([]);
    expect(dirtyPaths(dir, ['suivi.txt']).sort()).toEqual(['suivi.txt']);
    expect(dirtyPaths(dir, ['suivi.txt', 'brouillon.txt', 'propre.txt']).sort()).toEqual(['brouillon.txt', 'suivi.txt']);
  });
});
