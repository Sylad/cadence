import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo } from './helpers.js';

// L582 (M10, §152) — `plan.journal` : le format du journal d'événements de l'autre outil, que `raf import --to-config` réécrit avec le plan.
const BASE = `plan:
  path: docs/plan/taches.yaml
  lots: taches
  fields:
    id: [ident]
    title: [titre]
    status: [etat]
    estimate: [effort]
    notes: [note]
    parent: [parent]
    created: [cree_le]
    started: [demarre_le]
  statuses:
    todo: [a_faire]
    doing: [code]
    done: [termine]
    dropped: [caduc]
  estimates: { S: 0.25, M: 0.5 }
`;
const JOURNAL = `  journal:
    path: docs/plan/journal.ndjson
    types: { created: cree, started: demarre, state: etat, note: note, closed: ferme, delivered: livre }
    extra: { source: retour }
`;
const CONFIG = BASE + JOURNAL;
const SOURCE = `taches:
  - ident: AB-1
    titre: Premier lot
    etat: code
    cree_le: 2026-11-01
    demarre_le: 2026-11-02
    note:
      - { date: 2026-11-02, text: première note }
  - ident: AB-2
    titre: Autre
    etat: a_faire
`;
const SEED = `${JSON.stringify({ at: '2026-11-01T00:00:00+00:00', task: 'AB-1', type: 'cree', message: 'Premier lot', source: 'import' })}\n`;

function raf(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-04T09:00:00Z') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function project(config = CONFIG, journal: string | null = SEED) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), config);
  mkdirSync(join(dir, 'docs/plan'), { recursive: true });
  writeFileSync(join(dir, 'docs/plan/taches.yaml'), SOURCE);
  if (journal !== null) writeFileSync(join(dir, 'docs/plan/journal.ndjson'), journal);
  return dir;
}
/** Le plan natif importé, puis la bascule : cadence.yaml vide, la description gardée à part pour le retour. */
function switched(dir: string, config = CONFIG) {
  expect(raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml').code).toBe(0);
  writeFileSync(join(dir, 'cadence-origine.yaml'), config);
  writeFileSync(join(dir, 'cadence.yaml'), '');
  return ['--config', 'cadence-origine.yaml'];
}
const events = (dir: string) => readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('L582 — plan.journal, lecture de cadence.yaml', () => {
  it('R1 — plan.journal sans types, avec un type inconnu ou une clé inconnue est refusé en le nommant (par raf import --to-config)', () => {
    for (const [bad, what] of [['    path: j.ndjson\n', /journal\.types/], ['    types: { created: cree, fini: x }\n', /journal\.types\.fini/], ['    types: { created: cree }\n    tâche: x\n', /journal\.tâche/], ['    types: { created: 3 }\n', /journal\.types\.created/], ['    types: { created: cree }\n    extra: [a]\n', /journal\.extra/]] as const) {
      const dir = project(`${BASE}  journal:\n${bad}`);
      expect(raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml').code).toBe(0);
      const r = raf(dir, 'import', '--to-config', '--force');
      expect(r.code).toBe(2);
      expect(r.err).toMatch(what);
    }
  });
});

describe('L582 — raf import --to-config réécrit le journal', () => {
  it('R2 — les lignes déjà au journal restent telles quelles, et chaque fait du natif qu\'il n\'a pas s\'ajoute au format déclaré : cree, demarre, note, ferme', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'add', 'Lot neuf', '--estimate', '0.25').code).toBe(0);
    expect(raf(dir, 'note', 'AB-2', 'dit côté natif').code).toBe(0);
    expect(raf(dir, 'drop', 'AB-2').code).toBe(0);
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin);
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8');
    expect(text.startsWith(SEED)).toBe(true);
    const added = events(dir).slice(1);
    expect(added).toContainEqual({ at: '2026-11-02T00:00:00+00:00', task: 'AB-1', type: 'demarre', message: '', source: 'retour' });
    expect(added).toContainEqual({ at: '2026-11-02T00:00:00+00:00', task: 'AB-1', type: 'note', message: 'première note', source: 'retour' });
    expect(added).toContainEqual({ at: '2026-11-04T00:00:00+00:00', task: 'AB-2', type: 'note', message: 'dit côté natif', source: 'retour' });
    expect(added).toContainEqual({ at: '2026-11-04T09:00:00+00:00', task: 'AB-2', type: 'ferme', message: '', source: 'retour' });
    expect(added.find((e) => e.type === 'cree' && e.message === 'Lot neuf')).toMatchObject({ at: '2026-11-04T00:00:00+00:00', source: 'retour' });
    expect(added.some((e) => e.type === 'cree' && e.task === 'AB-1')).toBe(false);
    expect(r.out).toMatch(/journal\.ndjson : \d+ événements? ajoutés?/);
  });
  it('R3 — un état qui a changé depuis le plan réécrit (--force) donne un événement « état » nommant le nouvel état ; un état inchangé, aucun', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    const before = events(dir).length;
    expect(raf(dir, 'start', 'AB-2').code).toBe(0);
    expect(raf(dir, 'done', 'AB-1', '--force').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    const states = events(dir).slice(before).filter((e) => e.type === 'etat');
    expect(states.map((e) => [e.task, e.message]).sort()).toEqual([['AB-1', 'termine'], ['AB-2', 'code']]);
  });
  it('R4 — rejouée sans rien de neuf, la commande n\'ajoute aucun événement (ni doublon de note, ni de création)', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    const once = readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8');
    const r = raf(dir, 'import', '--to-config', '--force', ...origin);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8')).toBe(once);
    expect(r.out).toMatch(/journal\.ndjson : aucun événement à ajouter/);
  });
  it('R5 — --dry-run compte les événements et n\'écrit rien, ni journal ni plan', () => {
    const dir = project();
    const origin = switched(dir);
    const r = raf(dir, 'import', '--to-config', '--dry-run', '--out', 'tmp/retour.yaml', ...origin);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/journal\.ndjson : \d+ événements? à ajouter — rien n'est écrit/);
    expect(readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8')).toBe(SEED);
    expect(existsSync(join(dir, 'tmp/retour.yaml'))).toBe(false);
  });
  it('R6 — un journal que la commande ne sait pas lire (ligne qui n\'est pas du JSON, ligne sans task ou type) est refusé en citant la ligne, le plan n\'est pas écrit non plus', () => {
    for (const bad of ['{"task":"AB-1","type":"cree"}\nceci n\'est pas du json\n', '{"at":"x"}\n', '[1]\n']) {
      const dir = project(CONFIG, bad);
      const origin = switched(dir);
      const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/journal\.ndjson.*ligne \d/);
      expect(existsSync(join(dir, 'tmp/retour.yaml'))).toBe(false);
      expect(readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8')).toBe(bad);
    }
  });
  it('R7 — journal absent : créé avec ses dossiers ; dernière ligne sans saut de ligne : le saut est ajouté avant les nouveaux événements', () => {
    const none = project(CONFIG, null);
    expect(raf(none, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(none)).code).toBe(0);
    expect(events(none).length).toBeGreaterThan(0);
    const open = project(CONFIG, SEED.trimEnd());
    expect(raf(open, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(open)).code).toBe(0);
    expect(readFileSync(join(open, 'docs/plan/journal.ndjson'), 'utf8').startsWith(SEED)).toBe(true);
    expect(events(open)[0]).toMatchObject({ task: 'AB-1', type: 'cree' });
  });
  it('R8 — un type absent de plan.journal.types n\'est pas écrit ; sans plan.journal, le journal reste tel quel et la commande le dit', () => {
    const partial = BASE + '  journal:\n    path: docs/plan/journal.ndjson\n    types: { note: note }\n';
    const dir = project(partial);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(dir, partial)).code).toBe(0);
    expect(new Set(events(dir).map((e) => e.type))).toEqual(new Set(['cree', 'note']));
    const without = project(BASE);
    const r = raf(without, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(without, BASE));
    expect(r.code).toBe(0);
    expect(r.out).toContain('journal.ndjson inchangé : plan.journal n\'est pas déclaré');
    expect(readFileSync(join(without, 'docs/plan/journal.ndjson'), 'utf8')).toBe(SEED);
  });
  it('R9 — un lot livré (delivered: date, sha) donne un événement « livré » portant le sha sous la clé déclarée ; déjà au journal avec ce sha, il n\'est pas répété', () => {
    const cfg = CONFIG.replace('    extra:', '    keys: { sha: sha }\n    extra:');
    const dir = project(cfg);
    const origin = switched(dir, cfg);
    const plan = join(dir, '.cadence/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('    status: doing\n', '    status: done\n    delivered: { date: 2026-11-03, sha: abc1234 }\n'));
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const delivered = events(dir).filter((e) => e.type === 'livre');
    expect(delivered).toEqual([{ at: '2026-11-03T00:00:00+00:00', task: 'AB-1', type: 'livre', message: '', source: 'retour', sha: 'abc1234' }]);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', '--force', ...origin).code).toBe(0);
    expect(events(dir).filter((e) => e.type === 'livre')).toHaveLength(1);
  });
});
