import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

const T = '2026-10-23';

async function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: T }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${T}T09:30:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('raf show affiche goal (L272, revue L258)', () => {
  it('goal natif — la ligne « goal : » suit le titre ; un lot sans goal n\'en affiche pas', async () => {
    const dir = gitRepo();
    await raf(dir, 'init', '--project', 'demo');
    await raf(dir, 'add', 'Titre périmé');
    await raf(dir, 'add', 'Autre');
    const file = join(dir, '.cadence/raf.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/(- id: L1\n\s+title: [^\n]*\n)/, '$1    goal: Livrer seulement B28.6\n'));
    const r = await raf(dir, 'show', 'L1');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^L1 +todo +Titre périmé$/);
    expect(lines[1]).toBe('goal : Livrer seulement B28.6');
    expect((await raf(dir, 'show', 'L2')).out).not.toContain('goal');
  });

  it('goal mappé — plan.fields.goal d\'un plan en lecture seule est affiché', async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: suivi/taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, goal: objectif }\n  statuses: { todo: prevu }\n');
    mkdirSync(join(dir, 'suivi'));
    writeFileSync(join(dir, 'suivi/taches.yaml'), 'taches:\n- { id: A1, titre: Vieux titre, etat: prevu, objectif: Le vrai but }\n');
    const r = await raf(dir, 'show', 'A1');
    expect(r.code).toBe(0);
    expect(r.out.split('\n')[1]).toBe('goal : Le vrai but');
  });
});
