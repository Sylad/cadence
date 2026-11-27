import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { processStart } from '../src/proc.js';
import { reap, writeRun } from './creneaux-libres-commun-l598.js';
import { tempDir } from './helpers.js';

// L931 (D-44) : « un orchestrateur minimaliste qui retourne un projet + lot disponible en fonction de ce qu'il tourne ».
// cadence suivant, sans modèle et sans rien lancer : ordre priority:, créneaux libres, dépôts tenus sautés, lot en cours sans run avant un neuf.

let home: string;
beforeEach(() => {
  home = tempDir();
  process.env.CADENCE_HOME = home;
});
afterEach(reap);

const T0 = new Date('2026-11-27T10:00:00Z');

async function cad(dir: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-27', HOME: home, ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => T0 });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Un projet git `name` sous `parent`, avec ses lots (titre, `doing` pour un lot démarré) ; rend son dossier. */
async function project(parent: string, name: string, lots: { title: string; doing?: true }[]): Promise<string> {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  await cad(dir, {}, 'init', '--project', name, '--no-hook');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
  for (const l of lots) {
    const id = plan.add(l.title, '2026-11-27', { estimate: 1 });
    if (l.doing) plan.setStatus(id, 'doing', '2026-11-27');
  }
  plan.save();
  return dir;
}

const parentWith = (yaml?: string): string => {
  const p = tempDir();
  if (yaml) writeFileSync(join(p, 'cadence.yaml'), yaml);
  return p;
};

const suivant = async (parent: string, env: Record<string, string> = {}) => {
  const r = await cad(parent, { CADENCE_MAX_SESSIONS: '3', ...env }, 'suivant', '--json');
  return { code: r.code, s: JSON.parse(r.out) as { next: { project: string; lot: string; kind: string } | null; reason?: string; slots: { free: number; cap: number }; skipped: { project: string; reason: string }[] } };
};

describe('L931 — cadence suivant', () => {
  it('R1 — ordre : le premier projet de priority: qui a un lot tirable, pas l\'alphabétique', async () => {
    const p = parentWith('priority:\n  - beta\n  - alpha\n');
    await project(p, 'alpha', [{ title: 'Lot alpha' }]);
    await project(p, 'beta', [{ title: 'Lot beta' }]);
    const { code, s } = await suivant(p);
    expect(code).toBe(0);
    expect(s.next).toMatchObject({ project: 'beta', lot: 'L1', kind: 'neuf' });
    expect(s.slots).toEqual({ free: 3, cap: 3 });
  });

  it('R2 — priority: absente : l\'ordre du tour (alphabétique)', async () => {
    const p = parentWith();
    await project(p, 'beta', [{ title: 'Lot beta' }]);
    await project(p, 'alpha', [{ title: 'Lot alpha' }]);
    expect((await suivant(p)).s.next).toMatchObject({ project: 'alpha', lot: 'L1' });
  });

  it('R3 — un dépôt tenu par un cadence run vivant est sauté et nommé ; le suivant dans l\'ordre est rendu', async () => {
    const p = parentWith('priority:\n  - proj\n  - beta\n');
    await project(p, 'proj', [{ title: 'Lot tenu' }, { title: 'Autre lot du dépôt' }]);
    await project(p, 'beta', [{ title: 'Lot beta' }]);
    writeRun(home, p, 'r1', { lot: 'L1' }); // un run par dépôt : L2 du même dépôt n'est pas proposé
    const { code, s } = await suivant(p);
    expect(code).toBe(0);
    expect(s.next).toMatchObject({ project: 'beta', lot: 'L1' });
    expect(s.skipped).toEqual([{ project: 'proj', reason: 'dépôt tenu : cadence run r1 (L1) vivant' }]);
    expect(s.slots.free).toBe(2); // le run prend un créneau
  });

  it('R3 — un dépôt dont une porte tient la branche (verify --gate, publication) est sauté', async () => {
    const p = parentWith('priority:\n  - alpha\n  - beta\n');
    const alpha = await project(p, 'alpha', [{ title: 'Lot alpha' }]);
    await project(p, 'beta', [{ title: 'Lot beta' }]);
    const tenu = join(alpha, '.git', 'cadence', 'tenu');
    mkdirSync(tenu, { recursive: true });
    writeFileSync(join(tenu, `porte-${process.pid}.json`), JSON.stringify({ pid: process.pid, start: processStart(process.pid) ?? undefined, kind: 'porte', label: 'cadence verify --gate abc1234', branch: 'main', since: '2026-11-27T09:30:00.000Z' }));
    const { s } = await suivant(p);
    expect(s.next).toMatchObject({ project: 'beta' });
    expect(s.skipped[0]).toEqual({ project: 'alpha', reason: 'dépôt tenu : tenu par cadence verify --gate abc1234 depuis 09:30' });
  });

  it('R4 — créneaux pleins : rien, code 1, la raison dite', async () => {
    const p = parentWith();
    await project(p, 'alpha', [{ title: 'Lot alpha' }]);
    writeRun(home, p, 'r1');
    const r = await cad(p, { CADENCE_MAX_SESSIONS: '1' }, 'suivant');
    expect(r.code).toBe(1);
    expect(r.out).toBe('rien : créneaux pleins, 0 libre sur 1 · créneaux libres 0 sur 1');
  });

  it('R5 — un lot en cours sans run vivant passe avant un lot neuf, même d\'un projet plus prioritaire', async () => {
    const p = parentWith('priority:\n  - alpha\n  - beta\n');
    await project(p, 'alpha', [{ title: 'Lot neuf alpha' }]);
    await project(p, 'beta', [{ title: 'Lot commencé', doing: true }, { title: 'Lot neuf beta' }]);
    const { s } = await suivant(p);
    expect(s.next).toMatchObject({ project: 'beta', lot: 'L1', kind: 'en cours' });
    const texte = (await cad(p, { CADENCE_MAX_SESSIONS: '3' }, 'suivant')).out;
    expect(texte.split('\n')[0]).toBe('beta:L1 · Lot commencé · en cours sans run vivant : à reprendre · créneaux libres 3 sur 3');
  });

  it('R5 — un lot en cours qu\'un run vivant sert n\'est pas à reprendre : son dépôt est tenu, le neuf d\'ailleurs passe', async () => {
    const p = parentWith('priority:\n  - proj\n  - beta\n');
    await project(p, 'proj', [{ title: 'Lot servi', doing: true }]);
    await project(p, 'beta', [{ title: 'Lot neuf beta' }]);
    writeRun(home, p, 'r1', { lot: 'L1' });
    expect((await suivant(p)).s.next).toMatchObject({ project: 'beta', lot: 'L1', kind: 'neuf' });
  });

  it('R6 — continue.exclude et « à décider » écartent un lot : le suivant du plan est rendu', async () => {
    const p = parentWith();
    const alpha = await project(p, 'alpha', [{ title: 'Lot exclu' }, { title: 'Choix à décider avec Sylvain' }, { title: 'Lot tirable' }]);
    writeFileSync(join(alpha, 'cadence.yaml'), 'orchestrate:\n  continue:\n    exclude: [L1]\n');
    expect((await suivant(p)).s.next).toMatchObject({ project: 'alpha', lot: 'L3' });
  });

  it('R7 — aucun lot tirable : rien, code 1', async () => {
    const p = parentWith();
    await project(p, 'alpha', []);
    const { code, s } = await suivant(p);
    expect(code).toBe(1);
    expect(s.next).toBeNull();
    expect(s.reason).toBe('aucun lot tirable aux ressources libres');
  });

  it('R8 — lead tour donne la ligne « prochain dans l\'ordre », du même calcul', async () => {
    const p = parentWith('priority:\n  - beta\n  - alpha\n');
    await project(p, 'alpha', [{ title: 'Lot alpha' }]);
    await project(p, 'beta', [{ title: 'Lot beta' }]);
    const out = (await cad(p, { CADENCE_MAX_SESSIONS: '3' }, 'lead', 'tour')).out;
    expect(out).toContain("prochain dans l'ordre : beta:L1 Lot beta");
    writeRun(home, p, 'r1');
    const plein = (await cad(p, { CADENCE_MAX_SESSIONS: '1' }, 'lead', 'tour')).out;
    expect(plein).toContain("prochain dans l'ordre : rien (créneaux pleins, 0 libre sur 1)");
  });

  it('usage : un argument de trop est refusé (code 2)', async () => {
    expect((await cad(parentWith(), {}, 'suivant', 'a', 'b')).code).toBe(2);
  });
});
