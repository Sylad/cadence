import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadTour, tourRow } from '../src/lead.js';
import { gitRepo } from './helpers.js';

/** Un lot natif écrit à la main : id, statut, puis le reste du YAML du lot (after, tasks, every…). */
const lot = (id: string, status: string, extra = '') => `  - id: ${id}\n    title: "Titre ${id}"\n    status: ${status}\n    estimate: 1\n${extra}`;
const task = (id: number, status: string) => `      - { id: ${id}, title: "Tâche ${id}", status: ${status} }\n`;

function nativeProject(lots: string): string {
  const dir = gitRepo();
  mkdirSync(join(dir, '.cadence'));
  writeFileSync(join(dir, '.cadence/raf.yaml'), `version: 1\nproject: demo\nprefix: L\nlots:\n${lots}`);
  return dir;
}

describe('champ lots de cadence lead tour --json (L401)', () => {
  it('R10 — lots : seuls les lots non clos non récurrents', () => {
    const dir = nativeProject(
      lot('L1', 'todo') + lot('L2', 'doing', '    after: [L1]\n') + lot('L3', 'done') + lot('L4', 'dropped') + lot('L5', 'todo', '    every: 7\n'),
    );
    expect(tourRow(dir, '2026-10-28').lots).toEqual([
      { id: 'L1', title: 'Titre L1', status: 'todo', after: [] },
      { id: 'L2', title: 'Titre L2', status: 'doing', after: ['L1'] },
    ]);
  });

  it('R10 — plan natif : une sous-tâche todo ou doing entre dans lots avec id <lot>/<n>, parent: <lot> et son statut, after vide', () => {
    const dir = nativeProject(lot('L7', 'doing', `    tasks:\n${task(1, 'doing')}${task(2, 'todo')}`));
    expect(tourRow(dir, '2026-10-28').lots).toEqual([
      { id: 'L7', title: 'Titre L7', status: 'doing', after: [] },
      { id: 'L7/1', title: 'Tâche 1', status: 'doing', after: [], parent: 'L7' },
      { id: 'L7/2', title: 'Tâche 2', status: 'todo', after: [], parent: 'L7' },
    ]);
  });

  it('R10 — sous-tâche done ou dropped : exclue de lots', () => {
    const dir = nativeProject(lot('L7', 'doing', `    tasks:\n${task(1, 'done')}${task(2, 'dropped')}${task(3, 'todo')}`));
    expect(tourRow(dir, '2026-10-28').lots!.map((l) => l.id)).toEqual(['L7', 'L7/3']);
  });

  it('R10 — sous-tâche d’un lot clos ou récurrent : exclue', () => {
    const dir = nativeProject(
      lot('L1', 'done', `    tasks:\n${task(1, 'todo')}`) + lot('L2', 'todo', `    every: 7\n    tasks:\n${task(1, 'todo')}`) + lot('L3', 'todo'),
    );
    expect(tourRow(dir, '2026-10-28').lots!.map((l) => l.id)).toEqual(['L3']);
  });

  it('R10 — plan d’un autre outil : parent vient de Lot.parent', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, 'suivi'));
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: suivi/taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, parent: parent }\n  statuses: { todo: prevu, doing: en_cours, done: livre }\n');
    writeFileSync(join(dir, 'suivi/taches.yaml'), 'taches:\n  - { id: T1, titre: Premier, etat: prevu }\n  - { id: T2, titre: Second, etat: en_cours, parent: T1 }\n  - { id: T3, titre: Troisième, etat: livre }\n');
    expect(tourRow(dir, '2026-10-28').lots).toEqual([
      { id: 'T1', title: 'Premier', status: 'todo', after: [] },
      { id: 'T2', title: 'Second', status: 'doing', after: [], parent: 'T1' },
    ]);
  });

  it('R10 — les champs existants de la ligne sont inchangés', () => {
    const dir = nativeProject(lot('L1', 'doing') + lot('L2', 'todo'));
    const { lots, ...rest } = tourRow(dir, '2026-10-28');
    expect(lots).toHaveLength(2);
    expect(Object.keys(rest).sort()).toEqual(['doing', 'drift', 'next', 'noTest', 'notes', 'progress', 'project', 'repo'].filter((k) => k in rest).sort());
    expect(rest.progress).toEqual({ done: 0, doing: 1, todo: 1, added7: 0 });
    expect(rest.next).toEqual({ id: 'L2', title: 'Titre L2' });
    expect(rest.doing.map((d) => d.id)).toEqual(['L1']);
  });

  it('R18 — after: vers un lot clos : id conservé tel quel dans lots[].after', () => {
    const dir = nativeProject(lot('L1', 'done') + lot('L2', 'todo', '    after: [L1, L99]\n'));
    expect(tourRow(dir, '2026-10-28').lots).toEqual([{ id: 'L2', title: 'Titre L2', status: 'todo', after: ['L1', 'L99'] }]);
  });

  it('R7 — une ligne en erreur n’a pas de champ lots', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, '.cadence'));
    writeFileSync(join(dir, '.cadence/raf.yaml'), 'lots: [');
    const row = tourRow(dir, '2026-10-28');
    expect(row.error).toBeDefined();
    expect(row.lots).toBeUndefined();
    expect(leadTour(dir, '2026-10-28')[0]!.lots).toBeUndefined();
  });
});

describe('revue posée dans lots de cadence lead tour --json (L413)', () => {
  it('R12 — un lot non clos dont le plan porte une revue de code a reviewed: true ; sans revue, le champ est absent ; une sous-tâche ne le porte jamais', () => {
    const review = '    review: { date: 2026-10-29, verdict: "conforme" }\n';
    const dir = nativeProject(lot('L1', 'doing', review + `    tasks:\n${task(1, 'doing')}`) + lot('L2', 'doing'));
    expect(tourRow(dir, '2026-10-29').lots).toEqual([
      { id: 'L1', title: 'Titre L1', status: 'doing', after: [], reviewed: true },
      { id: 'L1/1', title: 'Tâche 1', status: 'doing', after: [], parent: 'L1' },
      { id: 'L2', title: 'Titre L2', status: 'doing', after: [] },
    ]);
  });
});

describe('champ closed de cadence lead tour --json (L415)', () => {
  const done = (id: string, finished: string, extra = '') => lot(id, 'done', `    finished: ${finished}\n${extra}`);

  it('R1 — closed : les lots clos (done) non récurrents avec leur jour de clôture, dans l’ordre du plan', () => {
    const dir = nativeProject(done('L1', '2026-10-20') + lot('L2', 'todo') + done('L3', '2026-10-28'));
    expect(tourRow(dir, '2026-10-30').closed).toEqual([
      { id: 'L1', finished: '2026-10-20' },
      { id: 'L3', finished: '2026-10-28' },
    ]);
  });

  it('R1 — un lot abandonné, un lot récurrent et un lot clos sans jour de clôture ne sont pas des lots livrables', () => {
    const dir = nativeProject(lot('L1', 'dropped', '    finished: 2026-10-20\n') + done('L2', '2026-10-21', '    every: 7\n') + lot('L3', 'done') + done('L4', '2026-10-22'));
    expect(tourRow(dir, '2026-10-30').closed).toEqual([{ id: 'L4', finished: '2026-10-22' }]);
  });

  it('R1 — un plan sans lot clos n’écrit pas de champ closed, une ligne en erreur non plus', () => {
    expect(tourRow(nativeProject(lot('L1', 'todo')), '2026-10-30')).not.toHaveProperty('closed');
    expect(tourRow('/nonexistent-l415', '2026-10-30')).not.toHaveProperty('closed');
  });
});
