import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { missingEvents, type JournalFormat } from '../src/plan-journal.js';
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
    expect(added).toContainEqual({ at: '2026-11-04T00:00:00+00:00', task: 'AB-2', type: 'ferme', message: '', source: 'retour' });
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

describe('L582 — le journal, les noms déclarés et les règles de dédoublonnage', () => {
  it('R10 — la fermeture d\'un lot abandonné prend sa date propre (finished) ; sans date, l\'heure de now', () => {
    const dir = project();
    const origin = switched(dir);
    const plan = join(dir, '.cadence/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('    status: todo\n', '    status: dropped\n    finished: 2026-09-09\n'));
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    expect(events(dir).find((e) => e.type === 'ferme')).toMatchObject({ task: 'AB-2', at: '2026-09-09T00:00:00+00:00' });
    const bare = project();
    const originBare = switched(bare);
    const planBare = join(bare, '.cadence/raf.yaml');
    writeFileSync(planBare, readFileSync(planBare, 'utf8').replace('    status: todo\n', '    status: dropped\n'));
    expect(raf(bare, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...originBare).code).toBe(0);
    expect(events(bare).find((e) => e.type === 'ferme')).toMatchObject({ task: 'AB-2', at: '2026-11-04T09:00:00+00:00' });
  });
  it('R11 — un changement d\'état n\'est écrit qu\'une fois au journal, même relu contre un autre plan (--out différent)', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    writeFileSync(join(dir, 'tmp-apercu.yaml'), readFileSync(join(dir, 'docs/plan/taches.yaml'), 'utf8'));
    expect(raf(dir, 'start', 'AB-2').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp-apercu.yaml', '--force', ...origin).code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(events(dir).filter((e) => e.type === 'etat' && e.task === 'AB-2')).toHaveLength(1);
  });
  it('R12 — plan.journal.keys : chaque donnée se lit, s\'écrit et se dédoublonne sous le nom déclaré, différent du défaut', () => {
    const cfg = CONFIG.replace('    extra:', '    keys: { at: quand, task: lot, type: genre, message: texte, sha: commit }\n    extra:');
    const seed = `${JSON.stringify({ quand: '2026-11-01T00:00:00+00:00', lot: 'AB-1', genre: 'cree', texte: 'Premier lot' })}\n`;
    const dir = project(cfg, seed);
    const origin = switched(dir, cfg);
    const plan = join(dir, '.cadence/raf.yaml');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('    status: doing\n', '    status: done\n    delivered: { date: 2026-11-03, sha: abc1234 }\n'));
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const added = events(dir).slice(1);
    expect(added).toContainEqual({ quand: '2026-11-03T00:00:00+00:00', lot: 'AB-1', genre: 'livre', texte: '', source: 'retour', commit: 'abc1234' });
    expect(added.every((e) => e.at === undefined && e.task === undefined && e.type === undefined)).toBe(true);
    expect(added.some((e) => e.genre === 'cree' && e.lot === 'AB-1')).toBe(false);
    const once = readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8');
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', '--force', ...origin).code).toBe(0);
    expect(readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8')).toBe(once);
  });
  it('R13 — un plan.journal invalide est refusé en le nommant : clé de keys inconnue, path qui n\'est pas un chemin, constante d\'extra qui porte le nom d\'une clé de base', () => {
    for (const [bad, what] of [
      ['    types: { created: cree }\n    keys: { lot: x }\n', /journal\.keys\.lot/],
      ['    types: { created: cree }\n    path: 3\n', /journal\.path/],
      ['    types: { created: cree }\n    extra: { task: PIRATE }\n', /journal\.extra\.task/],
      ['    types: { created: cree }\n    keys: { task: lot }\n    extra: { lot: PIRATE }\n', /journal\.extra\.lot/],
    ] as const) {
      const dir = project(`${BASE}  journal:\n${bad}`);
      expect(raf(dir, 'import', '--from-config', '--out', '.cadence/raf.yaml').code).toBe(0);
      const r = raf(dir, 'import', '--to-config', '--force');
      expect(r.code).toBe(2);
      expect(r.err).toMatch(what);
      expect(readFileSync(join(dir, 'docs/plan/journal.ndjson'), 'utf8')).toBe(SEED);
    }
  });
  it('R14 — un lot abandonné écrit « ferme » et pas « état » ; un second sha livre de nouveau ; sans keys.sha, une livraison par lot seulement', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(raf(dir, 'drop', 'AB-2').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(events(dir).filter((e) => e.task === 'AB-2' && e.type === 'ferme')).toHaveLength(1);
    expect(events(dir).filter((e) => e.task === 'AB-2' && e.type === 'etat')).toHaveLength(0);

    const keyed = CONFIG.replace('    extra:', '    keys: { sha: sha }\n    extra:');
    const seen = `${SEED}${JSON.stringify({ at: '2026-11-02T00:00:00+00:00', task: 'AB-1', type: 'livre', message: '', sha: 'aaa1111' })}\n`;
    const two = project(keyed, seen);
    const originTwo = switched(two, keyed);
    const planTwo = join(two, '.cadence/raf.yaml');
    writeFileSync(planTwo, readFileSync(planTwo, 'utf8').replace('    status: doing\n', '    status: done\n    delivered: { date: 2026-11-03, sha: bbb2222 }\n'));
    expect(raf(two, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...originTwo).code).toBe(0);
    expect(events(two).filter((e) => e.type === 'livre').map((e) => e.sha)).toEqual(['aaa1111', 'bbb2222']);

    const plain = project(CONFIG, `${SEED}${JSON.stringify({ at: '2026-11-02T00:00:00+00:00', task: 'AB-1', type: 'livre', message: '' })}\n`);
    const originPlain = switched(plain);
    const planPlain = join(plain, '.cadence/raf.yaml');
    writeFileSync(planPlain, readFileSync(planPlain, 'utf8').replace('    status: doing\n', '    status: done\n    delivered: { date: 2026-11-03, sha: ccc3333 }\n'));
    expect(raf(plain, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...originPlain).code).toBe(0);
    expect(events(plain).filter((e) => e.type === 'livre')).toHaveLength(1);
    const fresh = project(CONFIG);
    const originFresh = switched(fresh);
    const planFresh = join(fresh, '.cadence/raf.yaml');
    writeFileSync(planFresh, readFileSync(planFresh, 'utf8').replace('    status: doing\n', '    status: done\n    delivered: { date: 2026-11-03, sha: ddd4444 }\n'));
    expect(raf(fresh, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...originFresh).code).toBe(0);
    expect(events(fresh).find((e) => e.type === 'livre')).toEqual({ at: '2026-11-03T00:00:00+00:00', task: 'AB-1', type: 'livre', message: '', source: 'retour' });
  });
});

describe('L582 — ordre d\'écriture, octets du journal et règles de dédoublonnage restantes', () => {
  it('R15 — le journal s\'écrit avant le plan : un journal qu\'on ne peut pas écrire refuse la commande en le nommant (code 2), le plan d\'origine n\'est pas réécrit, et le rejeu écrit l\'état une fois les droits rétablis', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    const once = readFileSync(join(dir, 'docs/plan/taches.yaml'), 'utf8');
    expect(raf(dir, 'start', 'AB-2').code).toBe(0);
    const journal = join(dir, 'docs/plan/journal.ndjson');
    chmodSync(journal, 0o444);
    try {
      const r = raf(dir, 'import', '--to-config', '--force', ...origin);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/journal\.ndjson.*(écrire|écriture)/);
      expect(readFileSync(join(dir, 'docs/plan/taches.yaml'), 'utf8')).toBe(once);
      expect(events(dir).filter((e) => e.type === 'etat')).toHaveLength(0);
    } finally {
      chmodSync(journal, 0o644);
    }
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(events(dir).filter((e) => e.type === 'etat').map((e) => [e.task, e.message])).toEqual([['AB-2', 'code']]);
    expect(readFileSync(join(dir, 'docs/plan/taches.yaml'), 'utf8')).toContain('etat: code');
  });
  it('R16 — les lignes existantes sont gardées octet pour octet : un octet qui n\'est pas de l\'UTF-8 (caf\\xe9) reste tel quel, les nouveaux événements s\'ajoutent après', () => {
    const seed = Buffer.concat([Buffer.from('{"at":"2026-11-01T00:00:00+00:00","task":"AB-1","type":"cree","message":"caf'), Buffer.from([0xe9]), Buffer.from('"}\n')]);
    const dir = project(CONFIG, null);
    writeFileSync(join(dir, 'docs/plan/journal.ndjson'), seed);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(dir)).code).toBe(0);
    const after = readFileSync(join(dir, 'docs/plan/journal.ndjson'));
    expect(after.subarray(0, seed.length).equals(seed)).toBe(true);
    expect(after.length).toBeGreaterThan(seed.length);
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });
  it('R17 — un état revenu (code → a_faire → code) s\'écrit de nouveau : seul le dernier événement « état » du lot compte, pas tout état antérieur', () => {
    const dir = project();
    const origin = switched(dir);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(raf(dir, 'start', 'AB-2').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(raf(dir, 'todo', 'AB-2').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(raf(dir, 'start', 'AB-2').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(events(dir).filter((e) => e.type === 'etat' && e.task === 'AB-2').map((e) => e.message)).toEqual(['code', 'a_faire', 'code']);
  });
  it('R18 — sans plan.journal.path, le journal est journal.ndjson à la racine du dépôt', () => {
    const cfg = CONFIG.replace('    path: docs/plan/journal.ndjson\n', '');
    const dir = project(cfg, null);
    const r = raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(dir, cfg));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^journal\.ndjson : \d+ événements? ajoutés?$/m);
    expect(existsSync(join(dir, 'docs/plan/journal.ndjson'))).toBe(false);
    const root = readFileSync(join(dir, 'journal.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(root.some((e) => e.type === 'demarre' && e.task === 'AB-1')).toBe(true);
  });
  it('R19 — un lot abandonné dont le format n\'a pas de type closed change d\'état comme les autres : un événement « état » nommant l\'état d\'origine (caduc)', () => {
    const cfg = CONFIG.replace(', closed: ferme', '');
    const dir = project(cfg);
    const origin = switched(dir, cfg);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(raf(dir, 'drop', 'AB-2').code).toBe(0);
    expect(raf(dir, 'import', '--to-config', '--force', ...origin).code).toBe(0);
    expect(events(dir).filter((e) => e.task === 'AB-2' && e.type === 'etat').map((e) => e.message)).toEqual(['caduc']);
    expect(events(dir).some((e) => e.type === 'ferme')).toBe(false);
  });
  it('R20 — une note se dédoublonne par (lot, texte), quel que soit le jour : le même texte noté un autre jour n\'est pas réécrit', () => {
    const seed = `${SEED}${JSON.stringify({ at: '2026-10-20T00:00:00+00:00', task: 'AB-1', type: 'note', message: 'première note' })}\n`;
    const dir = project(CONFIG, seed);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(dir)).code).toBe(0);
    expect(events(dir).filter((e) => e.type === 'note' && e.task === 'AB-1' && e.message === 'première note')).toHaveLength(1);
  });
  it('R21 — extra: { sha: null } sans keys.sha est permis (sha n\'est pas une clé de base tant qu\'il n\'est pas déclaré) et s\'écrit sur chaque ligne ajoutée', () => {
    const cfg = CONFIG.replace('    extra: { source: retour }\n', '    extra: { source: retour, sha: null }\n');
    const dir = project(cfg);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...switched(dir, cfg)).code).toBe(0);
    const added = events(dir).slice(1);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((e) => Object.hasOwn(e, 'sha') && e.sha === null && e.source === 'retour')).toBe(true);
  });
});

describe('L582 — l\'instant des faits datés : l\'horodatage d\'origine quand le plan le tient, le jour à minuit sinon', () => {
  const TIMED_CONFIG = BASE.replace('    started: [demarre_le]\n', '    started: [demarre_le]\n    finished: [ferme_le]\n') + JOURNAL;
  const TIMED_SOURCE = `taches:
  - ident: AB-1
    titre: Premier lot
    etat: code
    cree_le: '2026-11-01T08:15:00+00:00'
    demarre_le: '2026-11-02T12:48:16+00:00'
  - ident: AB-2
    titre: Abandonné
    etat: caduc
    cree_le: 2026-11-01
    ferme_le: '2026-11-03T17:05:00+00:00'
  - ident: AB-3
    titre: Sans heure
    etat: code
    cree_le: 2026-11-01
    demarre_le: 2026-11-02
`;
  it('R22 — created, started et closed prennent origin.<champ>.value (heure exacte) quand il existe, le jour à minuit UTC sinon ; le plan réécrit et le journal disent le même instant', () => {
    const dir = project(TIMED_CONFIG, null);
    writeFileSync(join(dir, 'docs/plan/taches.yaml'), TIMED_SOURCE);
    const origin = switched(dir, TIMED_CONFIG);
    expect(raf(dir, 'import', '--to-config', '--out', 'tmp/retour.yaml', ...origin).code).toBe(0);
    const at = (task: string, type: string) => events(dir).find((e) => e.task === task && e.type === type)?.at;
    expect(at('AB-1', 'cree')).toBe('2026-11-01T08:15:00+00:00');
    expect(at('AB-1', 'demarre')).toBe('2026-11-02T12:48:16+00:00');
    expect(at('AB-2', 'ferme')).toBe('2026-11-03T17:05:00+00:00');
    expect(at('AB-2', 'cree')).toBe('2026-11-01T00:00:00+00:00');
    expect(at('AB-3', 'cree')).toBe('2026-11-01T00:00:00+00:00');
    expect(at('AB-3', 'demarre')).toBe('2026-11-02T00:00:00+00:00');
    // Le même fait, le même instant : ce que taches.yaml réécrit dit, le journal le dit.
    const back = (parse(readFileSync(join(dir, 'tmp/retour.yaml'), 'utf8')) as { taches: Record<string, string>[] }).taches;
    const lot = (id: string) => back.find((t) => t.ident === id)!;
    expect(lot('AB-1').cree_le).toBe(at('AB-1', 'cree'));
    expect(lot('AB-1').demarre_le).toBe(at('AB-1', 'demarre'));
    expect(lot('AB-2').ferme_le).toBe(at('AB-2', 'ferme'));
    expect(lot('AB-3').demarre_le).toBe('2026-11-02');
  });
  it('R23 — missingEvents : les quatre faits (created, started, closed, delivered) lisent origin.<champ>.value ; un natif changé depuis l\'import ou sans origin reprend le jour à minuit', () => {
    const journal: JournalFormat = { path: 'j.ndjson', keys: { sha: 'sha' }, types: { created: 'cree', started: 'demarre', closed: 'ferme', delivered: 'livre' }, extra: {} };
    const states = { before: new Map<string, string>(), after: new Map<string, string>() };
    const now = new Date('2026-11-04T09:00:00Z');
    const timed = {
      id: 'T1', title: 'Horodaté', status: 'dropped', created: '2026-11-01', started: '2026-11-02', finished: '2026-11-03', delivered: { date: '2026-11-03', sha: 'abc1234' },
      origin: {
        created: { key: 'cree_le', value: '2026-11-01T08:15:00+00:00', native: '2026-11-01' },
        started: { key: 'demarre_le', value: '2026-11-02T12:48:16+00:00', native: '2026-11-02' },
        finished: { key: 'ferme_le', value: '2026-11-03T17:05:00+00:00', native: '2026-11-03' },
        delivered: { key: 'livre_le', value: '2026-11-03T18:30:00+00:00', native: { date: '2026-11-03', sha: 'abc1234' } },
      },
    };
    const byType = (evs: Record<string, unknown>[]) => Object.fromEntries(evs.map((e) => [e.type, e.at]));
    expect(byType(missingEvents([timed], [], journal, states, now))).toEqual({ cree: '2026-11-01T08:15:00+00:00', demarre: '2026-11-02T12:48:16+00:00', ferme: '2026-11-03T17:05:00+00:00', livre: '2026-11-03T18:30:00+00:00' });
    // Natif changé depuis l'import (started redaté, livraison d'un autre sha) : l'horodatage d'origine ne vaut plus, le jour à minuit reprend.
    const moved = { ...timed, started: '2026-11-05', delivered: { date: '2026-11-03', sha: 'def5678' } };
    expect(byType(missingEvents([moved], [], journal, states, now))).toMatchObject({ demarre: '2026-11-05T00:00:00+00:00', livre: '2026-11-03T00:00:00+00:00', cree: '2026-11-01T08:15:00+00:00' });
    // Sans origin : minuit UTC, comme avant.
    const bare = { id: 'T2', title: 'Nu', status: 'dropped', created: '2026-11-01', started: '2026-11-02', finished: '2026-11-03', delivered: { date: '2026-11-03', sha: 'abc1234' } };
    expect(byType(missingEvents([bare], [], journal, states, now))).toEqual({ cree: '2026-11-01T00:00:00+00:00', demarre: '2026-11-02T00:00:00+00:00', ferme: '2026-11-03T00:00:00+00:00', livre: '2026-11-03T00:00:00+00:00' });
  });
});
