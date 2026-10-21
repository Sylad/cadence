import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-10-21' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-10-21T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const yaml = (dir: string) => readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');
const lots = (dir: string): Record<string, any>[] => parse(yaml(dir)).lots;

/** Un plan avec L1 (done), L2 (doing) et L3 (todo). */
function setup(): string {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  raf(dir, 'add', 'Ancien un', '--estimate', '2');
  raf(dir, 'add', 'Ancien deux');
  raf(dir, 'add', 'Ancien trois');
  raf(dir, 'start', 'L1');
  raf(dir, 'done', 'L1', '--force');
  raf(dir, 'start', 'L2');
  return dir;
}

describe('raf title', () => {
  it('R1 — remplace le titre d\'un lot, quel que soit son statut (done compris), et note l\'ancien', () => {
    const dir = setup();
    for (const [id, old] of [['L1', 'Ancien un'], ['L2', 'Ancien deux'], ['L3', 'Ancien trois']]) {
      const r = raf(dir, 'title', id, `Nouveau ${id}`);
      expect(r.code, r.err).toBe(0);
      const lot = lots(dir).find((l) => l.id === id)!;
      expect(lot.title).toBe(`Nouveau ${id}`);
      expect(lot.notes.at(-1)).toEqual({ date: '2026-10-21', text: `titre remplacé : « ${old} »` });
    }
    expect(lots(dir)[0].status).toBe('done');
  });

  it('R1 — les autres clés du lot et les autres lots sont inchangés', () => {
    const dir = setup();
    const before = lots(dir);
    raf(dir, 'title', 'L2', 'Autre');
    const after = lots(dir);
    expect(after[1]).toEqual({ ...before[1], title: 'Autre', notes: [{ date: '2026-10-21', text: 'titre remplacé : « Ancien deux »' }] });
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
  });

  it('R2 — raf now, raf show, raf list et session start affichent le nouveau titre', () => {
    const dir = setup();
    raf(dir, 'title', 'L2', 'Titre corrigé');
    for (const argv of [['now'], ['show', 'L2'], ['list'], ['session', 'start']]) {
      const r = raf(dir, ...argv);
      expect(r.out, argv.join(' ')).toContain('Titre corrigé');
    }
    for (const argv of [['now'], ['list'], ['session', 'start']]) expect(raf(dir, ...argv).out, argv.join(' ')).not.toContain('Ancien deux');
  });

  it('R3 — titre vide, identique, lot inconnu, sous-tâche : refus, plan inchangé', () => {
    const dir = setup();
    const before = yaml(dir);
    for (const argv of [['title', 'L2', '  '], ['title', 'L2', 'Ancien deux'], ['title', 'L99', 'x'], ['title', 'L2/1', 'x'], ['title', 'L2']]) {
      const r = raf(dir, ...argv);
      expect(r.code, argv.join(' ')).not.toBe(0);
      expect(r.err, argv.join(' ')).not.toBe('');
    }
    expect(yaml(dir)).toBe(before);
  });

  it('R4 — l\'aide de raf décrit raf title', () => {
    const r = raf(gitRepo(), 'help');
    expect(r.out + r.err).toContain('raf title <id>');
  });
});
