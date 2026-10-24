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

describe('CHANGELOG.md — une entrée est rangée sous la version qui la contient', () => {
  const sections = changelog.split(/^## /m).slice(1);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const tagged = (v: string) => git('tag', '--list', `v${v}`).trim() !== '';

  it('un lot cité sous le dernier tag a au moins un commit dans ce tag', () => {
    const latest = sections.find((section) => {
      const v = /^\[(\d+\.\d+\.\d+)\]/.exec(section)?.[1];
      return v !== undefined && tagged(v);
    });
    for (const section of latest ? [latest] : []) {
      const v = /^\[(\d+\.\d+\.\d+)\]/.exec(section)![1];
      const lots = new Set([...section.matchAll(/\((L\d+)[,)]/g)].map((m) => m[1]));
      for (const lot of lots) {
        const shas = git('log', '--format=%h', '-E', `--grep=^[a-z]+\\(${lot}\\)`, 'HEAD').split('\n').filter(Boolean);
        const inside = shas.filter((sha) => {
          try { git('merge-base', '--is-ancestor', sha, `v${v}`); return true; } catch { return false; }
        });
        expect(inside.length, `${lot} cité sous [${v}] mais aucun de ses commits n'est dans le tag`).toBeGreaterThan(0);
      }
    }
  });
});
