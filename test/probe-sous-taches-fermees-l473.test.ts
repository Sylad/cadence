import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closableLines } from '../src/audit.js';
import { run } from '../src/cli.js';
import type { Lot } from '../src/plan.js';
import { gitRepo } from './helpers.js';

const lot = (id: string, status: string, extra = '') => `  - id: ${id}\n    title: "Titre ${id}"\n    status: ${status}\n    estimate: 1\n${extra}`;
const task = (id: number, status: string) => `      - { id: ${id}, title: "Tâche ${id}", status: ${status} }\n`;
const tasks = (...s: string[]) => `    tasks:\n${s.map((x, i) => task(i + 1, x)).join('')}`;

function project(lots: string): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  return dir;
}

async function cad(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-04' }, out: (l) => out.push(l), err: () => {}, now: () => new Date('2026-11-04T10:00:00') });
  return { code, out: out.join('\n') };
}

const HEAD = 'Sous-tâches toutes fermées';
const mk = (status: string, ts: string[]) => ({ id: 'X-1', title: 'T', status, tasks: ts.map((s, i) => ({ id: String(i), title: 't', status: s })) }) as unknown as Lot;

describe('probe L473 — closableLines aux bords', () => {
  it('liste vide de lots → aucune ligne', () => {
    expect(closableLines([], false)).toEqual([]);
  });
  it('lot dropped avec sous-tâches fermées : non signalé', () => {
    expect(closableLines([mk('dropped', ['done'])], false)).toEqual([]);
  });
  it('tasks vide : non signalé', () => {
    expect(closableLines([mk('doing', [])], false)).toEqual([]);
  });
  it('même lot passé deux fois : une ligne par entrée, appel répété identique', () => {
    const l = mk('doing', ['done']);
    expect(closableLines([l], false)).toEqual(closableLines([l], false));
    expect(closableLines([l, l], false)).toHaveLength(2);
  });
  it('pluriel : 1 sous-tâche fermée, 2 sous-tâches fermées', () => {
    expect(closableLines([mk('todo', ['done'])], false)[0]).toContain('1 sous-tâche fermée :');
    expect(closableLines([mk('todo', ['done', 'dropped', 'done'])], false)[0]).toContain('3 sous-tâches fermées :');
  });
});

describe('probe L473 — plan réel', () => {
  for (const argv of [['now'], ['session', 'start']]) {
    it(`${argv.join(' ')} : tasks: [] vide → pas de section`, async () => {
      const { out } = await cad(project(lot('L1', 'doing', '    tasks: []\n')), ...argv);
      expect(out).not.toContain(HEAD);
    });
    it(`${argv.join(' ')} : tous les lots clos → pas de section`, async () => {
      const { out } = await cad(project(lot('L1', 'done', tasks('done')) + lot('L2', 'dropped', tasks('dropped'))), ...argv);
      expect(out).not.toContain(HEAD);
    });
    it(`${argv.join(' ')} : la section n'apparaît qu'une fois`, async () => {
      const { out } = await cad(project(lot('L1', 'doing', tasks('done'))), ...argv);
      expect(out.split(HEAD).length - 1).toBe(1);
    });
  }

  it('la commande suggérée raf done L1 réussit réellement, puis le lot disparaît du signal', async () => {
    const dir = project(lot('L1', 'doing', tasks('done', 'dropped')));
    const before = await cad(dir, 'now');
    expect(before.out).toContain('raf done L1');
    const d = await cad(dir, 'done', 'L1');
    expect(d.code).toBe(0);
    const after = await cad(dir, 'now');
    expect(after.out).not.toContain(HEAD);
  });
});
