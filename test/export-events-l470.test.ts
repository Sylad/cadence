import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

// L470 (M8) — raf export : le plan en JSON stable ; raf events : le flux d'événements dérivé des dates, des notes, de l'historique git du plan et des commits.
const PLAN = '.cadence/raf.yaml';
const CONFIG = `plan:
  states: { a_faire: todo, code: doing, teste: doing, termine: done, abandonne: dropped }
  doneState: termine
  extras:
    theme: { enum: [infra, ui] }
`;

function raf(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function git(dir: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: process.env.TEST_DAY, GIT_AUTHOR_DATE: process.env.TEST_DAY } }).trim();
}
/** Un commit daté d'un jour donné. */
function commit(dir: string, day: string, message: string, ...paths: string[]) {
  process.env.TEST_DAY = `${day}T10:00:00`;
  git(dir, 'add', '--', ...paths);
  git(dir, 'commit', '-q', '-m', message, '--', ...paths);
  return git(dir, 'rev-parse', 'HEAD');
}
function project() {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG);
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  return dir;
}
const events = (dir: string, ...args: string[]) => JSON.parse(raf(dir, 'events', '--json', ...args).out) as { schema: number; project: string; events: Record<string, unknown>[] };

describe('L470 — raf export', () => {
  it('R1 — le plan entier en un document JSON versionné : schema, project, prefix, lots avec champs d\'extension et sous-tâches', () => {
    const dir = project();
    raf(dir, 'add', 'Un lot', '--set', 'theme=ui');
    raf(dir, 'add', 'Autre', '--after', 'L1');
    const r = raf(dir, 'export', '--json');
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ schema: 1, project: 'demo', prefix: 'L' });
    expect(doc.lots.map((l: { id: string }) => l.id)).toEqual(['L1', 'L2']);
    expect(doc.lots[0].extras).toEqual({ theme: 'ui' });
    expect(doc.lots[1].after).toEqual(['L1']);
    expect(doc.lots[0]).not.toHaveProperty('problems');
  });
  it('R2 — stable : deux exports du même plan sont identiques à l\'octet, sans date ni heure de génération', () => {
    const dir = project();
    raf(dir, 'add', 'Un lot');
    const a = raf(dir, 'export').out;
    const b = raf(dir, 'export', '--json').out;
    expect(a).toBe(b);
    expect(a).not.toMatch(/generated|genere/i);
  });
  it('R3 — un plan sans lot s\'exporte : lots vaut []', () => {
    const dir = project();
    expect(JSON.parse(raf(dir, 'export').out).lots).toEqual([]);
  });
  it('R4 — les lots archivés sont dans l\'export, comme dans raf list', () => {
    const dir = project();
    raf(dir, 'add', 'Fini');
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1', '--force');
    expect(raf(dir, 'archive').code).toBe(0);
    expect(JSON.parse(raf(dir, 'export').out).lots.map((l: { id: string }) => l.id)).toEqual(['L1']);
  });
});

describe('L470 — raf events', () => {
  it('R5 — demarre, termine, abandonne et livre portent le jour du champ du plan', () => {
    const dir = project();
    const p = join(dir, PLAN);
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        /lots:.*\n?/,
        `lots:
  - { id: L1, title: A, status: done, estimate: 1, created: 2026-10-01, started: 2026-10-02, finished: 2026-10-03, delivered: { date: 2026-10-05, sha: abcdef1234567 } }
  - { id: L2, title: B, status: dropped, estimate: 1, created: 2026-10-01, finished: 2026-10-04 }
`,
      ),
    );
    const got = events(dir).events.map((e) => `${e.day} ${e.type} ${e.lot}${e.sha ? ` ${e.sha}` : ''}`);
    expect(got).toEqual([
      '2026-10-01 cree L1',
      '2026-10-01 cree L2',
      '2026-10-02 demarre L1',
      '2026-10-03 termine L1',
      '2026-10-04 abandonne L2',
      '2026-10-05 livre L1 abcdef1234567',
    ]);
  });
  it('R6 — chaque note datée est un événement note, avec son texte', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'note', 'L1', 'une note\nsur deux lignes');
    const note = events(dir).events.find((e) => e.type === 'note');
    expect(note).toMatchObject({ day: '2026-11-02', lot: 'L1', text: 'une note\nsur deux lignes' });
  });
  it('R7 — un changement d\'état de l\'historique git du plan donne un événement etat (de, vers, jour et sha du commit)', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10', 'plan: A', PLAN, 'cadence.yaml');
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'code');
    const c1 = commit(dir, '2026-10-11', 'plan: code', PLAN);
    raf(dir, 'status', 'L1', 'teste');
    const c2 = commit(dir, '2026-10-12', 'plan: teste', PLAN);
    const etats = events(dir).events.filter((e) => e.type === 'etat');
    expect(etats).toEqual([
      { day: '2026-10-11', type: 'etat', lot: 'L1', from: null, to: 'code', sha: c1 },
      { day: '2026-10-12', type: 'etat', lot: 'L1', from: 'code', to: 'teste', sha: c2 },
    ]);
  });
  it('R8 — un commit qui ne change aucun état ne donne aucun événement etat', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10', 'plan: A', PLAN, 'cadence.yaml');
    raf(dir, 'note', 'L1', 'x');
    commit(dir, '2026-10-11', 'plan: note', PLAN);
    expect(events(dir).events.filter((e) => e.type === 'etat')).toEqual([]);
  });
  it('R9 — un commit qui cite des lots donne un événement commit par lot cité (sha, sujet)', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'add', 'B');
    commit(dir, '2026-10-10', 'plan', PLAN, 'cadence.yaml');
    writeFileSync(join(dir, 'f.txt'), 'x');
    const sha = commit(dir, '2026-10-11', 'feat(L1,L2): deux lots', 'f.txt');
    writeFileSync(join(dir, 'g.txt'), 'x');
    commit(dir, '2026-10-11', 'chore: sans lot', 'g.txt');
    const commits = events(dir).events.filter((e) => e.type === 'commit');
    expect(commits).toEqual([
      { day: '2026-10-11', type: 'commit', lot: 'L1', sha, subject: 'feat(L1,L2): deux lots' },
      { day: '2026-10-11', type: 'commit', lot: 'L2', sha, subject: 'feat(L1,L2): deux lots' },
    ]);
  });
  it('R10 — --since J ne garde que les événements du jour J et après, et l\'état d\'avant J sert de « de » au premier changement', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'code');
    commit(dir, '2026-10-10', 'plan: code', PLAN, 'cadence.yaml');
    raf(dir, 'status', 'L1', 'teste');
    commit(dir, '2026-10-20', 'plan: teste', PLAN);
    const etats = events(dir, '--since', '2026-10-15').events.filter((e) => e.type === 'etat');
    expect(etats).toMatchObject([{ day: '2026-10-20', from: 'code', to: 'teste' }]);
    expect(events(dir, '--since', '2026-10-15').events.every((e) => String(e.day) >= '2026-10-15')).toBe(true);
  });
  it('R11 — --since mal formé : refus (code 2) sans sortie', () => {
    const dir = project();
    const r = raf(dir, 'events', '--json', '--since', 'hier');
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/--since/);
  });
  it('R12 — ordre stable : par jour, puis type, puis lot ; deux appels donnent la même sortie', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'add', 'B');
    raf(dir, 'note', 'L2', 'n2');
    raf(dir, 'note', 'L1', 'n1');
    const a = raf(dir, 'events', '--json').out;
    expect(raf(dir, 'events', '--json').out).toBe(a);
    const lots = JSON.parse(a).events.filter((e: { type: string }) => e.type === 'note').map((e: { lot: string }) => e.lot);
    expect(lots).toEqual(['L1', 'L2']);
  });
  it('R13 — sans --json : une ligne par événement « jour  type  lot  détail »', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'note', 'L1', 'une note');
    const lines = raf(dir, 'events').out.split('\n');
    expect(lines).toContain('2026-11-02  note  L1  une note');
  });
  it('R14 — un plan vide ou sans commit donne events: [] (code 0)', () => {
    const dir = project();
    expect(events(dir).events).toEqual([]);
    expect(raf(dir, 'events').out).toBe('');
  });
  it('R15 — un plan non suivi par git : pas d\'événement etat, les autres événements restent', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'code');
    const types = events(dir).events.map((e) => e.type);
    expect(types).not.toContain('etat');
    expect(types).toContain('demarre');
  });
  it('R16 — l\'historique du plan illisible à un commit : avertissement sur la sortie d\'erreur, les autres événements restent', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10', 'plan', PLAN, 'cadence.yaml');
    const p = join(dir, PLAN);
    const good = readFileSync(p, 'utf8');
    writeFileSync(p, 'lots: [unclosed\n');
    commit(dir, '2026-10-11', 'plan cassé', PLAN);
    writeFileSync(p, good.replace('status: todo', 'status: doing').replace(/(id: L1\n)/, '$1    state: code\n'));
    commit(dir, '2026-10-12', 'plan réparé', PLAN);
    const r = raf(dir, 'events', '--json');
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/illisible/);
    expect(JSON.parse(r.out).events.some((e: { type: string }) => e.type === 'cree')).toBe(true);
  });
});
