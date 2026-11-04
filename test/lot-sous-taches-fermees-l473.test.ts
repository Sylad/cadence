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

describe('lot dont toutes les sous-tâches sont fermées (L473, M11)', () => {
  const plan = () =>
    project(
      lot('L1', 'doing', tasks('done', 'dropped')) + // tout fermé : signalé
        lot('L2', 'doing', tasks('done', 'todo')) + // une ouverte
        lot('L3', 'doing') + // aucune sous-tâche
        lot('L4', 'done', tasks('done')) + // lot clos
        lot('L5', 'todo', `    every: 7\n${tasks('done')}`) + // récurrent
        lot('L6', 'todo', tasks('dropped')), // ouvert pas démarré, tout fermé
    );

  for (const [name, argv] of [['raf now', ['now']], ['session start', ['session', 'start']]] as const) {
    it(`R1 — ${name} liste les lots ouverts dont toutes les sous-tâches sont done ou dropped, avec raf done <id>`, async () => {
      const { out } = await cad(plan(), ...argv);
      expect(out).toContain(`\n${HEAD}\n  L1  Titre L1 — 2 sous-tâches fermées : raf done L1\n  L6  Titre L6 — 1 sous-tâche fermée : raf done L6`);
    });

    it(`R2 — ${name} : ni lot à sous-tâche ouverte, ni sans sous-tâche, ni clos, ni récurrent`, async () => {
      const { out } = await cad(plan(), ...argv);
      const section = out.split(`\n${HEAD}\n`)[1]!.split('\n\n')[0]!;
      for (const id of ['L2', 'L3', 'L4', 'L5']) expect(section).not.toContain(id);
    });

    it(`R3 — ${name} : aucun lot concerné, aucune section`, async () => {
      const { out } = await cad(project(lot('L1', 'doing', tasks('todo')) + lot('L2', 'doing')), ...argv);
      expect(out).not.toContain(HEAD);
    });
  }

  it('R4 — plan tenu par un autre outil : la ligne renvoie à l’outil du projet, pas à raf done', () => {
    const l = { id: 'AB-1', title: 'T', status: 'doing', tasks: [{ id: '1', title: 't', status: 'done' }] } as Lot;
    expect(closableLines([l], true)).toEqual(["AB-1  T — 1 sous-tâche fermée : le fermer avec l'outil du projet"]);
    expect(closableLines([l], false)).toEqual(['AB-1  T — 1 sous-tâche fermée : raf done AB-1']);
  });
});
