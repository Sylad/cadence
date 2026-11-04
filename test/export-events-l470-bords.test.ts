import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { PLAN_LEGACY } from '../src/config.js';
import { gitRepo } from './helpers.js';

// Sonde L470 — les bords de raf export et raf events.
const PLAN = '.cadence/raf.yaml';
const CONFIG = `plan:
  states: { a_faire: todo, code: doing, teste: doing, termine: done, abandonne: dropped }
  doneState: termine
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
function commit(dir: string, stamp: string, message: string, ...paths: string[]) {
  process.env.TEST_DAY = stamp;
  git(dir, 'add', '--', ...paths);
  git(dir, 'commit', '-q', '-m', message, '--', ...paths);
  return git(dir, 'rev-parse', 'HEAD');
}
function project() {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG);
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  // Adoption avant les jours des commits d'essai : sinon `raf commits` les écarte comme antérieurs au plan.
  writeFileSync(join(dir, PLAN), readFileSync(join(dir, PLAN), 'utf8').replace(/^since: \S+/m, 'since: 2026-10-01'));
  return dir;
}
const evs = (dir: string, ...args: string[]) => JSON.parse(raf(dir, 'events', '--json', ...args).out).events as Record<string, unknown>[];
function setState(dir: string, line: string | null) {
  const p = join(dir, PLAN);
  const t = readFileSync(p, 'utf8').replace(/\n    state:.*/g, '');
  writeFileSync(p, line === null ? t : t.replace(/(id: L1\n)/, `$1    ${line}\n`));
}

describe('L470 bords — raf events', () => {
  it('since : un commit d\'état tôt le jour J reste vu par --since J (git --since date seule ne dépend pas de l\'heure)', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    setState(dir, 'state: code');
    const c = commit(dir, '2026-10-15T00:01:00', 'plan: code', PLAN);
    const etats = evs(dir, '--since', '2026-10-15').filter((e) => e.type === 'etat');
    expect(etats).toMatchObject([{ day: '2026-10-15', from: null, to: 'code', sha: c }]);
  });
  it('un plan déplacé (raf migrate, git mv) garde son historique d\'état et ne reçoit pas de faux etat au jour du déplacement', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    const legacy = PLAN_LEGACY;
    execFileSync('mkdir', ['-p', dirname(join(dir, legacy))]);
    commit(dir, '2026-09-30T10:00:00', 'plan', PLAN, 'cadence.yaml');
    git(dir, 'mv', PLAN, legacy);
    process.env.TEST_DAY = '2026-10-01T10:00:00';
    git(dir, 'commit', '-q', '-m', 'plan ancien chemin');
    const edit = (line: string) => writeFileSync(join(dir, legacy), readFileSync(join(dir, legacy), 'utf8').replace(/\n    state:.*/g, '').replace(/(id: L1\n)/, `$1    ${line}\n`));
    edit('state: code');
    const a = commit(dir, '2026-10-02T10:00:00', 'plan: code', legacy);
    edit('state: teste');
    const b = commit(dir, '2026-10-03T10:00:00', 'plan: teste', legacy);
    git(dir, 'mv', legacy, PLAN);
    process.env.TEST_DAY = '2026-10-20T10:00:00';
    git(dir, 'commit', '-q', '-m', 'chore: raf migrate');
    const etats = evs(dir).filter((e) => e.type === 'etat');
    expect(etats).toMatchObject([
      { day: '2026-10-02', from: null, to: 'code', sha: a },
      { day: '2026-10-03', from: 'code', to: 'teste', sha: b },
    ]);
    expect(etats.map((e) => e.day)).not.toContain('2026-10-20');
    // --since après le déplacement : la version d'avant, au chemin d'avant, sert de point de départ.
    expect(evs(dir, '--since', '2026-10-20').filter((e) => e.type === 'etat')).toEqual([]);
  });
  it('state: null (valeur YAML vide) n\'est pas un état « null »', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    setState(dir, 'state: ~');
    commit(dir, '2026-10-11T10:00:00', 'plan: state vide', PLAN);
    expect(evs(dir).filter((e) => e.type === 'etat')).toEqual([]);
  });
  it('state numérique : to est la chaîne « 1 », pas un plantage', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    setState(dir, 'state: 1');
    commit(dir, '2026-10-11T10:00:00', 'plan: 1', PLAN);
    expect(evs(dir).filter((e) => e.type === 'etat')).toMatchObject([{ lot: 'L1', from: null, to: '1' }]);
  });
  it('un lot qui quitte le plan (lots: []) ne donne aucun événement etat', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    setState(dir, 'state: code');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    writeFileSync(join(dir, PLAN), readFileSync(join(dir, PLAN), 'utf8').replace(/lots:[\s\S]*/, 'lots: []\n'));
    commit(dir, '2026-10-11T10:00:00', 'plan: vide', PLAN);
    expect(evs(dir).filter((e) => e.type === 'etat' && e.day === '2026-10-11')).toEqual([]);
  });
  it('--since sans valeur : refus code 2', () => {
    const dir = project();
    expect(raf(dir, 'events', '--since').code).toBe(2);
  });
  it('--since vide : refus code 2', () => {
    const dir = project();
    expect(raf(dir, 'events', '--since', '').code).toBe(2);
  });
  it('--since dans le futur : aucun événement, code 0, pas de plantage', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    const r = raf(dir, 'events', '--json', '--since', '2030-01-01');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).events).toEqual([]);
  });
  it('--since le jour d\'un premier commit racine du plan : pas de plantage, état initial vu', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    setState(dir, 'state: code');
    commit(dir, '2026-10-10T00:01:00', 'plan', PLAN, 'cadence.yaml');
    const r = raf(dir, 'events', '--json', '--since', '2026-10-10');
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
  it('un commit qui cite deux fois le même lot ne donne qu\'un événement commit', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    writeFileSync(join(dir, 'f.txt'), 'x');
    commit(dir, '2026-10-11T10:00:00', 'feat(L1,L1): double L1 et encore L1', 'f.txt');
    expect(evs(dir).filter((e) => e.type === 'commit')).toHaveLength(1);
  });
  it('événements --json : deux appels identiques et même ordre qu\'en lignes', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'note', 'L1', 'a');
    raf(dir, 'note', 'L1', 'b');
    const lines = raf(dir, 'events').out.split('\n');
    const json = evs(dir).map((e) => `${e.day}  ${e.type}  ${e.lot}  ${e.text ?? ''}`.trimEnd());
    expect(lines).toEqual(json);
  });
  it('un plan dont le fichier est vide à un commit est signalé illisible sans tout casser', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    const good = readFileSync(join(dir, PLAN), 'utf8');
    writeFileSync(join(dir, PLAN), '');
    commit(dir, '2026-10-11T10:00:00', 'vide', PLAN);
    writeFileSync(join(dir, PLAN), good);
    const r = raf(dir, 'events', '--json');
    expect(r.code).toBe(0);
  });
});

describe('L470 bords — raf export', () => {
  it('export refuse un argument en trop ou reste exit 0 avec --json seul ; sortie JSON valide terminée', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    const r = raf(dir, 'export', '--json');
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });
  it('export reflète les champs state et les dates d\'un lot (round-trip avec raf list --json)', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'start', 'L1');
    const list = JSON.parse(raf(dir, 'list', '--json').out);
    expect(JSON.parse(raf(dir, 'export').out).lots).toEqual(list);
  });
});

describe('L470 bords — passe mineure', () => {
  it('un lot archivé puis rouvert garde son état d\'avant : termine → a_faire, pas ∅ → a_faire', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    raf(dir, 'status', 'L1', 'code');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    raf(dir, 'done', 'L1', '--force');
    commit(dir, '2026-10-11T10:00:00', 'plan: termine', PLAN);
    expect(raf(dir, 'archive').code).toBe(0);
    commit(dir, '2026-10-12T10:00:00', 'plan: archive', PLAN, '.cadence/archive');
    raf(dir, 'todo', 'L1');
    const c = commit(dir, '2026-10-13T10:00:00', 'plan: rouvert', PLAN, '.cadence/archive');
    expect(evs(dir).filter((e) => e.type === 'etat' && e.day === '2026-10-13')).toMatchObject([{ lot: 'L1', from: 'termine', to: 'a_faire', sha: c }]);
  });
  it('un lot présent dont le state: est effacé donne to: null', () => {
    const dir = project();
    raf(dir, 'add', 'A');
    setState(dir, 'state: code');
    commit(dir, '2026-10-10T10:00:00', 'plan', PLAN, 'cadence.yaml');
    setState(dir, null);
    const c = commit(dir, '2026-10-11T10:00:00', 'plan: état effacé', PLAN);
    expect(evs(dir).filter((e) => e.type === 'etat' && e.day === '2026-10-11')).toMatchObject([{ lot: 'L1', from: 'code', to: null, sha: c }]);
  });
  it('un plan d\'un autre outil (plan: au format étranger) : export et events répondent, sans événement etat', () => {
    const dir = gitRepo();
    execFileSync('mkdir', ['-p', join(dir, 'tracker')]);
    writeFileSync(join(dir, 'tracker/tickets.yaml'), 'tickets:\n  - { id: ENG-12, titre: Un, etat: en_cours }\n');
    writeFileSync(
      join(dir, 'cadence.yaml'),
      `plan:\n  path: tracker/tickets.yaml\n  lots: tickets\n  fields: { title: [titre], status: [etat] }\n  statuses: { doing: en_cours }\n`,
    );
    commit(dir, '2026-10-10T10:00:00', 'plan', 'tracker/tickets.yaml', 'cadence.yaml');
    writeFileSync(join(dir, 'tracker/tickets.yaml'), 'tickets:\n  - { id: ENG-12, titre: Deux, etat: en_cours }\n');
    commit(dir, '2026-10-11T10:00:00', 'plan: teste', 'tracker/tickets.yaml');
    const ex = raf(dir, 'export', '--json');
    expect(ex.err).toBe('');
    expect(ex.code).toBe(0);
    expect(JSON.parse(ex.out).lots.map((l: { id: string }) => l.id)).toEqual(['ENG-12']);
    const ev = raf(dir, 'events', '--json');
    expect(ev.code).toBe(0);
    expect((JSON.parse(ev.out).events as { type: string }[]).filter((e) => e.type === 'etat')).toEqual([]);
  });
});
