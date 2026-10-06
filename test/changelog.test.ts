import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);

describe('CHANGELOG.md', () => {
  it('a une section pour la version de package.json', () => {
    expect(headings).toContain(version);
  });

  it('met la version courante en tête (la plus récente en premier)', () => {
    expect(headings[0]).toBe(version);
  });

  it('a une section par tag git existant', () => {
    const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean).map((t) => t.slice(1));
    for (const tag of tags) expect(headings, `section [${tag}] manquante`).toContain(tag);
  });

  it('ne répète aucune version', () => {
    expect(new Set(headings).size).toBe(headings.length);
  });
});
