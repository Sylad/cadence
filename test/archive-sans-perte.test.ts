import { describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from '../src/cli.js';
import { mergeArchived } from '../src/archive.js';
import { PLAN_LEGACY } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { planFileSet } from '../src/orchestrate/worktree.js';
import { fileIds, repoWithPlan } from './archive-helpers.js';
import { gitRepo } from './helpers.js';

/*
 * L396, revue finale. Constat 2 : l'écriture du plan est sans perte pour TOUTE exception, pas seulement un `plan.onWrite` en échec — les
 * fichiers d'année s'écrivent avant le plan (au pire un doublon, refusé et nommé au chargement) et tout revient en arrière sur une exception.
 * Constat 4 : l'archive ne va jamais sous docs/ — `raf archive` refuse tant que le plan est à l'ancien emplacement. Constat 7 : les fichiers
 * d'année sont des fichiers du plan pour l'orchestrateur. Constat 3 : l'ordre d'avant l'archivage.
 */

/** Le chemin (suffixe) dont l'écriture doit échouer, posé par un test ; vide : les écritures passent. */
const failing = vi.hoisted(() => ({ suffix: '', hits: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync: typeof actual.writeFileSync = (file, ...rest) => {
    if (failing.suffix && String(file).endsWith(failing.suffix)) {
      failing.hits++;
      throw new Error(`simulé : écriture de ${String(file)} refusée`);
    }
    return actual.writeFileSync(file, ...rest);
  };
  return { ...actual, writeFileSync, default: { ...actual, writeFileSync } };
});

/** chmod 444 n'arrête pas root : ces tests ne mesurent rien sous root. */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const snapshotFiles = (r: ReturnType<typeof repoWithPlan>) => ({
  plan: readFileSync(r.plan, 'utf8'),
  y2025: existsSync(r.archive('2025')) ? readFileSync(r.archive('2025'), 'utf8') : null,
  y2026: existsSync(r.archive('2026')) ? readFileSync(r.archive('2026'), 'utf8') : null,
});

describe('L396 — constat 2 : écriture sans perte pour toute exception', () => {
  it.skipIf(asRoot)("S1 — EACCES sur un fichier d'année (chmod 444) pendant raf archive : rien ne bouge, le lot reste lisible, le rejeu après chmod passe", async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-09-01'); // L1 → 2025.yaml, L2 → 2026.yaml ; L3 (done 2026-09-20) reste
    expect(fileIds(r.plan)).toEqual(['L3', 'L4', 'L5']);
    chmodSync(r.archive('2026'), 0o444);
    try {
      const before = snapshotFiles(r);
      const failed = await r.raf('archive');
      expect(failed.code).not.toBe(0);
      expect(failed.err).toMatch(/écriture du plan refusée \(EACCES/);
      expect(failed.err).toContain('plan et archive inchangés');
      expect(snapshotFiles(r)).toEqual(before);
      // Le lot n'est perdu nulle part : le plan chargé le présente, raf show le lit.
      expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
      expect((await r.raf('show', 'L3')).out).toContain('L3  done  troisième');
    } finally {
      chmodSync(r.archive('2026'), 0o644);
    }
    expect((await r.raf('archive')).out).toContain('archivé dans .cadence/archive/2026.yaml : L3');
    expect(fileIds(r.archive('2026'))).toEqual(['L2', 'L3']);
    expect(fileIds(r.plan)).toEqual(['L4', 'L5']);
  });

  it.skipIf(asRoot)('S2 — EACCES sur le fichier du plan (chmod 444) : les fichiers d’année écrits avant lui disparaissent, le dossier aussi', async () => {
    const r = repoWithPlan();
    chmodSync(r.plan, 0o444);
    try {
      const before = readFileSync(r.plan, 'utf8');
      const failed = await r.raf('archive');
      expect(failed.code).not.toBe(0);
      expect(failed.err).toMatch(/EACCES/);
      expect(readFileSync(r.plan, 'utf8')).toBe(before);
      expect(existsSync(join(r.dir, '.cadence/archive'))).toBe(false);
      expect(Plan.load(r.plan).lots().map((l) => l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    } finally {
      chmodSync(r.plan, 0o644);
    }
  });

  it('S3 — une exception au milieu de l’écriture (fichiers d’année écrits, plan refusé) remet tout tel qu’avant, sur le disque comme en mémoire', async () => {
    const r = repoWithPlan();
    await r.raf('archive', '--before', '2026-01-01'); // 2025.yaml existe déjà avec L1
    const before = snapshotFiles(r);
    const plan = Plan.load(r.plan);
    failing.suffix = '.cadence/raf.yaml';
    failing.hits = 0;
    try {
      expect(() => plan.archive('2026-10-28')).toThrow(/écriture du plan refusée \(simulé/);
    } finally {
      failing.suffix = '';
    }
    expect(failing.hits).toBe(1); // les fichiers d'année sont passés, le plan a échoué : l'exception est bien « au milieu »
    expect(snapshotFiles(r)).toEqual(before);
    expect(fileIds(r.archive('2026'))).toEqual([]);
    expect(fileIds(r.plan)).toEqual(['L2', 'L3', 'L4', 'L5']);
    // En mémoire aussi : le même objet réécrit ensuite ce qu'il y avait, et un rejeu archive sans doublon.
    plan.note('L3', 'après l’échec', '2026-10-28');
    plan.save();
    expect(fileIds(r.plan)).toEqual(['L2', 'L3', 'L4', 'L5']);
    expect(fileIds(r.archive('2025'))).toEqual(['L1']);
    expect(existsSync(r.archive('2026'))).toBe(false);
    const again = await r.raf('archive');
    expect(again.out).toContain('archivé dans .cadence/archive/2026.yaml : L2, L3');
    expect(readFileSync(r.archive('2026'), 'utf8')).toContain('après l’échec');
    expect(readFileSync(r.archive('2026'), 'utf8').match(/id: L3/g)).toHaveLength(1);
  });

  it("S4 — une exception sur un fichier d'année déjà existant pendant raf note sur un lot archivé : le fichier d'année reste tel quel", async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const before = snapshotFiles(r);
    failing.suffix = 'archive/2025.yaml';
    try {
      const res = await r.raf('note', 'L1', 'perdue ?');
      expect(res.code).not.toBe(0);
      expect(res.err).toContain('écriture du plan refusée');
    } finally {
      failing.suffix = '';
    }
    expect(snapshotFiles(r)).toEqual(before);
    expect((await r.raf('show', 'L1', '--notes')).out).not.toContain('perdue ?');
  });
});

describe("L396 — constat 4 : l'archive ne va jamais sous docs/", () => {
  it('S5 — raf archive refuse tant que le plan est à l’ancien emplacement, --dry-run compris, et renvoie à raf migrate ; après la migration, l’archive est sous .cadence/', async () => {
    const dir = gitRepo();
    const legacy = join(dir, PLAN_LEGACY);
    const p = Plan.create(legacy, 'demo', 'L', '2025-01-01');
    p.add('un', '2025-01-01');
    p.add('deux', '2025-01-01');
    p.setStatus('L1', 'done', '2025-06-10', { force: true });
    p.save();
    const out: string[] = [];
    const err: string[] = [];
    const io = { cwd: dir, env: { RAF_TODAY: '2026-10-28' }, out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date('2026-10-28T10:00:00') };
    const raf = async (...args: string[]) => {
      out.length = 0;
      err.length = 0;
      return { code: await run(args, io), out: out.join('\n'), err: err.join('\n') };
    };
    const before = readFileSync(legacy, 'utf8');
    for (const args of [['archive'], ['archive', '--dry-run']]) {
      const res = await raf(...args);
      expect(res.code, args.join(' ')).not.toBe(0);
      expect(res.err).toContain(`raf archive refusé : le plan est à l'ancien emplacement ${PLAN_LEGACY}`);
      expect(res.err).toContain('raf migrate');
    }
    expect(readFileSync(legacy, 'utf8')).toBe(before);
    expect(existsSync(join(dir, dirname(PLAN_LEGACY), 'archive'))).toBe(false);
    expect(existsSync(join(dir, '.cadence'))).toBe(false);

    expect((await raf('migrate')).code).toBe(0);
    expect(existsSync(legacy)).toBe(false);
    const moved = await raf('archive');
    expect(moved.code).toBe(0);
    expect(moved.out).toContain('archivé dans .cadence/archive/2025.yaml : L1');
    expect(fileIds(join(dir, '.cadence/raf.yaml'))).toEqual(['L2']);
    expect(existsSync(join(dir, dirname(PLAN_LEGACY), 'archive'))).toBe(false);
    expect((await raf('show', 'L1')).out).toContain('L1  done  un');
  });
});

describe('L396 — constats 3 et 7', () => {
  it('S6 — planFileSet compte les fichiers d’année : une session qui les touche touche le plan', async () => {
    const r = repoWithPlan();
    await r.raf('archive');
    const set = planFileSet(Plan.load(r.plan), r.dir);
    expect(set.has('.cadence/raf.yaml')).toBe(true);
    expect(set.has(relative(r.dir, r.archive('2025')))).toBe(true);
    expect(set.has(relative(r.dir, r.archive('2026')))).toBe(true);
  });

  it('S7 — mergeArchived : les archivés reprennent leur place par numéro, l’ordre du fichier actif ne bouge jamais', () => {
    const lot = (id: string) => ({ id }) as unknown as import('../src/plan.js').Lot;
    const ids = (lots: { id: string }[]) => lots.map((l) => l.id);
    expect(ids(mergeArchived([lot('L4'), lot('L1')], [lot('L2'), lot('L3'), lot('L5')]))).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    // Un plan réordonné à la main garde son ordre ; les archivés se placent avant le premier actif de numéro plus grand.
    expect(ids(mergeArchived([lot('L1'), lot('L4')], [lot('L3'), lot('L2'), lot('L5')]))).toEqual(['L1', 'L3', 'L2', 'L4', 'L5']);
    expect(ids(mergeArchived([lot('L9')], [lot('L1')]))).toEqual(['L1', 'L9']);
    expect(ids(mergeArchived([], [lot('L2'), lot('L1')]))).toEqual(['L2', 'L1']);
    expect(ids(mergeArchived([lot('L1')], []))).toEqual(['L1']);
  });
});
