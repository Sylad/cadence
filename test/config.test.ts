import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig, readSessionConfig } from '../src/config.js';
import { parseDeliverConfig } from '../src/deliver.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo, tempDir } from './helpers.js';

const CONFIG = `plan:
  path: docs/suivi/taches.yaml
  project: demo
  since: 2026-09-01
  ignore: ['^auto: ']
  files: [docs/suivi/journal.ndjson]
  lots: taches
  fields:
    title: titre
    status: etat
    estimate: effort
    created: cree_le
    started: demarre_le
    finished: [livre_le, ferme_le]
    notes: note
    parent: parent
  statuses:
    todo: [prevu, specifie]
    doing: en_cours
    done: [deploye, valide]
    dropped: caduc
  estimates: { S: 0.5, M: 1, L: 3 }
`;

const TACHES = `# tenu par un autre outil
taches:
- id: B33
  titre: Une seule base
  etat: en_cours
  effort: L
  cree_le: '2026-09-09T00:00:00+00:00'
  demarre_le: '2026-09-10T08:00:00+00:00'
  note: mesuré sur la prod
- id: B33/t1-compression
  titre: Compression
  etat: deploye
  parent: B33
  livre_le: '2026-09-12T10:00:00+00:00'
- id: B33/t2-fusion
  titre: Fusion
  etat: prevu
  parent: B33
- id: E-A2
  titre: TAF
  etat: specifie
  effort: S
- id: NC2.4
  titre: Scores
  etat: caduc
  ferme_le: '2026-09-20T00:00:00+00:00'
- id: R12a
  titre: Export
  etat: valide
  livre_le: '2026-09-15T00:00:00+00:00'
`;

function write(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function foreign(dir = tempDir()): Plan {
  const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), CONFIG))!;
  return Plan.load(write(join(dir, cfg.path!), TACHES), cfg.settings);
}

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-09-28' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-09-28T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('readPlanConfig', () => {
  it('returns null without a file or without a plan key', () => {
    const dir = tempDir();
    expect(readPlanConfig(join(dir, 'cadence.yaml'))).toBeNull();
    expect(readPlanConfig(write(join(dir, 'cadence.yaml'), 'deliver:\n  verify: []\n'))).toBeNull();
  });

  it('accepts the short form: a path, native format, still writable', () => {
    const cfg = readPlanConfig(write(join(tempDir(), 'cadence.yaml'), 'plan: plan/todo.yaml\n'))!;
    expect(cfg.path).toBe('plan/todo.yaml');
    expect(cfg.settings.format).toBeUndefined();
  });

  it('reads the field mapping and inverts the statuses', () => {
    const cfg = readPlanConfig(write(join(tempDir(), 'cadence.yaml'), CONFIG))!;
    expect(cfg.settings).toMatchObject({ project: 'demo', since: '2026-09-01', ignore: ['^auto: '], files: ['docs/suivi/journal.ndjson'] });
    expect(cfg.settings.format).toMatchObject({
      lots: 'taches',
      fields: { title: ['titre'], finished: ['livre_le', 'ferme_le'] },
      statuses: { prevu: 'todo', specifie: 'todo', en_cours: 'doing', caduc: 'dropped' },
      estimates: { L: 3 },
    });
  });

  it.each([
    ['plan:\n  chemin: x.yaml\n', /plan\.chemin inconnu/],
    ['plan:\n  fields: { titre: title }\n', /plan\.fields\.titre inconnu/],
    ['plan:\n  statuses: { fini: [deploye] }\n', /plan\.statuses\.fini inconnu/],
    ['plan:\n  statuses: { todo: [a], done: [a] }\n', /« a » correspond à deux statuts/],
    ['plan:\n  estimates: { S: petit }\n', /plan\.estimates\.S/],
    ['plan:\n  since: hier\n', /plan\.since/],
    ['plan: [\n', /illisible/],
    ['plan: 42\n', /plan doit être un chemin ou un objet/],
    ['plan: ""\n', /plan doit être un chemin ou un objet/],
    ['plan:\n  path: ""\n', /plan\.path est vide/],
  ])('refuses %j', (text, message) => {
    expect(() => readPlanConfig(write(join(tempDir(), 'cadence.yaml'), text))).toThrow(message);
  });

  it('reads qa.expectations as the file kept with the plan (L65): accepted beside plan, session and deliver', () => {
    const text = 'qa:\n  expectations: docs/quality/pages.md\nplan: plan/todo.yaml\nsession:\n  start: ./morning.sh\ndeliver:\n  verify:\n    - url: https://app.example.com/\n';
    const file = write(join(tempDir(), 'cadence.yaml'), text);
    expect(readPlanConfig(file)).toEqual({ path: 'plan/todo.yaml', settings: { qaExpectations: 'docs/quality/pages.md' } });
    expect(readSessionConfig(file)).toEqual({ start: './morning.sh' });
    expect(parseDeliverConfig(text, file).verify).toHaveLength(1);
    // Seule, la clé ne déplace pas le plan (pas de path) : il reste celui par défaut.
    expect(readPlanConfig(write(join(tempDir(), 'cadence.yaml'), 'qa:\n  expectations: docs/quality/pages.md\n'))).toEqual({ settings: { qaExpectations: 'docs/quality/pages.md' } });
    expect(readPlanConfig(write(join(tempDir(), 'cadence.yaml'), 'session:\n  start: x\n'))).toBeNull();
  });

  it('(L65/t2) normalise qa.expectations : ./ retiré, chemin absolu sous la racine rendu relatif, séparateurs posix', () => {
    const dir = tempDir();
    const of = (v: string) => readPlanConfig(write(join(dir, 'cadence.yaml'), `qa:\n  expectations: '${v}'\n`))?.settings.qaExpectations;
    expect(of('./docs/quality/pages.md')).toBe('docs/quality/pages.md');
    expect(of('docs\\quality\\pages.md')).toBe('docs/quality/pages.md');
    expect(of('docs//quality/./pages.md')).toBe('docs/quality/pages.md');
    expect(of(join(dir, 'docs/quality/pages.md'))).toBe('docs/quality/pages.md');
  });

  it('(L66) un chemin absolu est résolu depuis la racine git, pas depuis le dossier du --config', () => {
    const repo = gitRepo();
    mkdirSync(join(repo, 'config'));
    const file = write(join(repo, 'config', 'cadence.yaml'), `qa:\n  expectations: '${join(repo, 'config', 'x.md')}'\n`);
    expect(readPlanConfig(file)?.settings.qaExpectations).toBe('config/x.md');
    const docs = write(join(repo, 'config', 'cadence.yaml'), `qa:\n  expectations: '${join(repo, 'docs', 'qa.md')}'\n`);
    expect(readPlanConfig(docs)?.settings.qaExpectations).toBe('docs/qa.md');
    const out = write(join(repo, 'config', 'cadence.yaml'), `qa:\n  expectations: '${join(tempDir(), 'x.md')}'\n`);
    expect(() => readPlanConfig(out)).toThrow(/hors du dépôt/);
  });

  it('(L66) un chemin absolu passant par un lien symbolique vers le dépôt est résolu comme le chemin réel', () => {
    const repo = gitRepo();
    const link = join(tempDir(), 'link');
    symlinkSync(repo, link);
    const file = write(join(link, 'cadence.yaml'), `qa:\n  expectations: '${join(link, 'docs', 'qa.md')}'\n`);
    expect(readPlanConfig(file)?.settings.qaExpectations).toBe('docs/qa.md');
  });

  it.each([
    ['qa:\n  expectations: 42\n', /qa\.expectations doit être un chemin/],
    ['qa:\n  expectations: [a.md]\n', /qa\.expectations doit être un chemin/],
    ['qa: docs/qa.md\n', /qa doit être un objet/],
    ['qa:\n  expectations: /ailleurs/pages.md\n', /hors du dépôt/],
    ['qa:\n  expectations: ../pages.md\n', /hors du dépôt/],
  ])('(L65/t2) refuses %j', (text, message) => {
    expect(() => readPlanConfig(write(join(tempDir(), 'cadence.yaml'), text))).toThrow(message);
  });
});

describe('a plan in another format', () => {
  it('translates fields, statuses, estimates and timestamps', () => {
    const plan = foreign();
    expect(plan.project).toBe('demo');
    expect(plan.since).toBe('2026-09-01');
    expect(plan.lots().map((l) => `${l.id} ${l.status}`)).toEqual(['B33 doing', 'E-A2 todo', 'NC2.4 dropped', 'R12a done']);
    expect(plan.lot('B33')).toMatchObject({
      title: 'Une seule base',
      estimate: 3,
      created: '2026-09-09',
      started: '2026-09-10',
      notes: [{ text: 'mesuré sur la prod' }],
      problems: [],
    });
    expect(plan.lot('E-A2').estimate).toBe(0.5);
    expect(plan.lot('NC2.4').finished).toBe('2026-09-20');
  });

  it('reads the public title from the field mapped to `public`, trimmed, and ignores a blank or non-string one', () => {
    const dir = tempDir();
    const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), 'plan:\n  lots: taches\n  fields: { title: titre, status: etat, public: titre_public }\n  statuses: { todo: prevu }\n'))!;
    const plan = Plan.load(
      write(join(dir, 'p.yaml'), "taches:\n- { id: A1, titre: x, etat: prevu, titre_public: '  Cartes plus nettes ' }\n- { id: A2, titre: y, etat: prevu, titre_public: '   ' }\n- { id: A3, titre: z, etat: prevu, titre_public: 7 }\n- { id: A4, titre: w, etat: prevu }\n"),
      cfg.settings,
    );
    expect(plan.lot('A1').public).toBe('Cartes plus nettes');
    for (const id of ['A2', 'A3', 'A4']) expect(plan.lot(id)).not.toHaveProperty('public');
  });

  it('folds entries that name a parent into its sub-tasks', () => {
    expect(foreign().lot('B33').tasks).toEqual([
      { id: 't1-compression', title: 'Compression', status: 'done' },
      { id: 't2-fusion', title: 'Fusion', status: 'todo' },
    ]);
  });

  it('reports a status the mapping does not know', () => {
    const dir = tempDir();
    const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), CONFIG))!;
    const plan = Plan.load(write(join(dir, 'p.yaml'), 'taches:\n- id: A1\n  titre: x\n  etat: bloque\n'), cfg.settings);
    expect(plan.lot('A1')).toMatchObject({ status: 'todo', problems: ['état « bloque » sans correspondance (cadence.yaml : plan.statuses)'] });
  });

  it('refuses an entry without an id or that is not an object, reports an unknown effort', () => {
    const dir = tempDir();
    const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), CONFIG))!;
    const load = (text: string) => Plan.load(write(join(dir, 'p.yaml'), text), cfg.settings).lots();
    expect(() => load('taches:\n- titre: x\n')).toThrow(/entrée n° 1 du plan : identifiant absent/);
    expect(() => load('taches:\n- id: A1\n-\n')).toThrow(/entrée n° 2 du plan : un objet est attendu/);
    expect(load('taches:\n- id: A1\n  etat: prevu\n  effort: XL\n')[0].problems).toEqual(['effort « XL » sans correspondance (cadence.yaml : plan.estimates)']);
  });

  it('refuses a file without the list', () => {
    const dir = tempDir();
    const cfg = readPlanConfig(write(join(dir, 'cadence.yaml'), CONFIG))!;
    expect(() => Plan.load(write(join(dir, 'p.yaml'), 'lots: []\n'), cfg.settings)).toThrow(/« taches »/);
  });

  it('finds references by the ids of the plan, whatever their shape', () => {
    const { refs } = foreign();
    expect(refs('fix(api) (B33/t1-compression) : x — voir E-A2, NC2.4.')).toEqual([
      { lot: 'B33', task: 't1-compression' },
      { lot: 'E-A2' },
      { lot: 'NC2.4' },
    ]);
    expect(refs('R12a puis R12 et PRE-A2, NC2.45, docs/B33')).toEqual([{ lot: 'R12a' }]);
    expect(refs('B33/inconnue et B33/E-A2')).toEqual([{ lot: 'B33' }, { lot: 'B33' }, { lot: 'E-A2' }]);
  });

  it('is read-only', () => {
    const plan = foreign();
    const before = readFileSync(plan.path, 'utf8');
    for (const write of [
      () => plan.add('x', '2026-09-28'),
      () => plan.addTask('B33', 'x'),
      () => plan.setStatus('E-A2', 'doing', '2026-09-28'),
      () => plan.note('B33', 'x', '2026-09-28'),
      () => plan.enableUx('2026-09-28'),
      () => plan.recordUx('B33', 'ok', '2026-09-28'),
      () => plan.enableReview('2026-09-28'),
      () => plan.recordReview('B33', 'ok', '2026-09-28', null),
      () => plan.save(),
    ]) expect(write).toThrow(/lecture seule/);
    expect(readFileSync(plan.path, 'utf8')).toBe(before);
  });
});

describe('raf CLI with cadence.yaml', () => {
  it('still installs the hook when cadence.yaml is broken', () => {
    const dir = gitRepo();
    write(join(dir, 'cadence.yaml'), 'plan:\n  chemin: x\n');
    expect(raf(dir, 'hook', 'install').code).toBe(0);
    expect(raf(dir, 'list').code).toBe(2);
  });

  it('follows plan: to a native plan elsewhere and still writes it', () => {
    const dir = gitRepo();
    write(join(dir, 'cadence.yaml'), 'plan: plan/todo.yaml\n');
    expect(raf(dir, 'init', '--no-hook').out).toContain(join(dir, 'plan/todo.yaml'));
    expect(raf(dir, 'add', 'Cache').out).toBe('L1');
    expect(raf(dir, 'list').out).toMatch(/^L1 +todo +Cache$/);
  });

  it('reads a foreign plan: now, check and session start, no write', () => {
    const dir = gitRepo();
    write(join(dir, 'cadence.yaml'), CONFIG);
    write(join(dir, 'docs/suivi/taches.yaml'), TACHES);
    write(join(dir, 'docs/suivi/journal.ndjson'), '{}\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'auto: installation', '2026-09-25T10:00:00');
    write(join(dir, 'docs/suivi/journal.ndjson'), '{}\n{}\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'plan: add E-A2 — TAF', '2026-09-26T10:00:00');
    commit(dir, 'feat(api) (B33/t2-fusion) : fusion', '2026-09-27T10:00:00');
    commit(dir, 'auto: synchro E-A2', '2026-09-27T11:00:00');
    // Avant l'adoption (since), citer un lot n'engageait à rien.
    commit(dir, 'feat: brouillon de E-A2', '2026-08-01T10:00:00');

    const now = raf(dir, 'now');
    expect(now.code).toBe(0);
    expect(now.out).toMatch(/En cours\n {2}B33 {2}Une seule base {2}\(3 j, 1 commit\(s\), sous-tâches 1\/2\)/);
    expect(now.out).toContain('E-A2  TAF');

    // Le commit de plan (plan + journal) ne « démarre » pas E-A2 ; le commit automatique ne compte pour aucun lot.
    const check = raf(dir, 'check');
    expect(check.out).toBe('✓ plan et historique cohérents');

    const start = raf(dir, 'session', 'start', '--since', '2026-09-25');
    expect(start.code).toBe(0);
    expect(start.out).toContain('demo — reprise du 2026-09-28');
    expect(start.out).toMatch(/1\. B33 {2}Une seule base — en cours/);

    // Aucun conseil vers une commande raf qui refuserait ; un cadence.yaml fautif n'empêche pas d'installer.
    commit(dir, 'feat(E-A2): décodeur', '2026-09-27T12:00:00');
    expect(raf(dir, 'check').out).toContain('✗ E-A2 a 1 commit(s) mais est encore todo\n');
    for (const argv of [['start', 'E-A2'], ['note', 'B33', 'x'], ['add', 'x'], ['init']]) {
      const r = raf(dir, ...argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/lecture seule/);
    }
  });

  it('leaves a foreign plan untouched by the code review gate, with a clear message', () => {
    const dir = gitRepo();
    write(join(dir, 'cadence.yaml'), CONFIG);
    const path = write(join(dir, 'docs/suivi/taches.yaml'), TACHES);
    commit(dir, 'feat(B33): fusion', '2026-09-27T10:00:00');
    for (const argv of [['review', 'enable'], ['review', 'B33', 'conforme'], ['done', 'B33']]) {
      const r = raf(dir, ...argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^raf: plan en lecture seule : .*taches\.yaml est tenu par un autre outil/);
    }
    expect(readFileSync(path, 'utf8')).toBe(TACHES);
  });

  it('ignores uxSince and reviewSince written by hand in a foreign plan: no finding raf could never clear', () => {
    const dir = gitRepo();
    write(join(dir, 'cadence.yaml'), CONFIG);
    const gated = `uxSince: 2026-09-01\nreviewSince: 2026-09-01\n${TACHES}  visible: true\n`;
    write(join(dir, 'docs/suivi/taches.yaml'), gated);
    commit(dir, 'feat(R12a): export', '2026-09-14T10:00:00');
    const plan = Plan.load(join(dir, 'docs/suivi/taches.yaml'), readPlanConfig(join(dir, 'cadence.yaml'))!.settings);
    expect(plan.lot('R12a')).toMatchObject({ status: 'done', visible: true, finished: '2026-09-15' });
    expect([plan.uxSince, plan.reviewSince]).toEqual(['2026-09-01', '2026-09-01']);

    // Le reste de l'audit tourne toujours : seules les deux portes sont ignorées.
    expect(raf(dir, 'check').out).toBe(
      '✗ B33 en cours sans commit depuis 18 j (Une seule base)\n✗ R12a est visible et terminé sans entrée Nouveautés — cadence news new R12a\n2 écart(s)',
    );
  });
});
