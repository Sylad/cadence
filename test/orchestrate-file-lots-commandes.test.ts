import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, parseOrchestrateArgs, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { cadenceHome } from '../src/orchestrate/registry.js';
import { Plan } from '../src/plan.js';
import { AGENTS_DIR } from '../src/skills.js';
import { tempDir } from './helpers.js';

const savedHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = savedHome;
});

/** Projets sous un dossier parent ; `done` : lots terminés (indices 1-based). */
function parentWith(projects: Record<string, { title: string; done?: boolean }[]>): string {
  const parent = tempDir();
  for (const [name, lots] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (const l of lots) {
      const id = plan.add(l.title, '2026-10-01', { estimate: 1 });
      if (l.done) plan.setStatus(id, 'done', '2026-10-02');
    }
    plan.save();
  }
  return parent;
}

const deps: OrchestrateDeps = { claude: async () => { throw new Error('aucune session ne doit partir'); }, claudeInfo: () => ({ version: '2.1.289', jsonSchema: true }), agentsDir: AGENTS_DIR, queueLockMs: 150 };

async function run(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: OrchestrateIo = { cwd, env: { RAF_TODAY: '2026-11-06' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-06T10:00:00') };
  const code = await orchestrate(argv, io, deps);
  return { code, out, err };
}

const queueFile = () => join(cadenceHome(), 'queue.json');

describe('L498 — file approuvée : orchestrate queue add / show / drop', () => {
  it('R1 — trois lots ajoutés dans l\'ordre B, A, C : la file les rend B, A, C', async () => {
    const parent = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }], c: [{ title: 'c un' }] });
    const r = await run(parent, 'queue', 'add', 'b:L1', 'a:L1', 'c:L1');
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['1. b:L1 — b un', '2. a:L1 — a un', '3. c:L1 — c un']);
    const s = await run(parent, 'queue', 'show');
    expect(s.out.map((l) => l.split(' — ')[0])).toEqual(['1. b:L1', '2. a:L1', '3. c:L1']);
    // un second ajout se place à la suite
    const more = await run(parent, 'queue', 'add', 'a:L2').then(() => run(parent, 'queue', 'show'));
    expect(more.out).toHaveLength(3);
  });

  it('R2 — liste vide : refus, file inchangée', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'add');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue add : aucun lot donné (attendu : <projet:lot>…)']);
    expect(existsSync(queueFile())).toBe(false);
  });

  it('R2 — clé de lot inconnu : refus nommant la clé, file inchangée (même quand une autre clé est valide)', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'add', 'a:L1', 'a:L9');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue add : a:L9 : lot ou projet inconnu']);
    expect(existsSync(queueFile())).toBe(false);
  });

  it('R2 — projet inconnu : refus nommant la clé', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'add', 'zzz:L1');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue add : zzz:L1 : lot ou projet inconnu']);
  });

  it('R2 — lot terminé : refus nommant la clé', async () => {
    const parent = parentWith({ a: [{ title: 'fini', done: true }] });
    const r = await run(parent, 'queue', 'add', 'a:L1');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue add : a:L1 : lot déjà terminé']);
    expect(existsSync(queueFile())).toBe(false);
  });

  it.each(['L1', 'a:', ':L1', 'a b:L1', 'a:L1@haiku'])('R2 — clé mal formée « %s » : refus nommant la clé', async (key) => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'add', key);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`queue add : ${key} : clé mal formée (attendu : <projet:lot>)`]);
    expect(existsSync(queueFile())).toBe(false);
  });

  it('R2 — même clé deux fois dans une commande (add A A) : une seule occurrence, avertissement, rien de dupliqué', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'add', 'a:L1', 'a:L1');
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['1. a:L1 — un']);
    expect(r.err).toEqual(['queue add : a:L1 : déjà en file (position 1)']);
  });

  it('R3 — clé déjà en file : une seule occurrence, position inchangée, avertissement', async () => {
    const parent = parentWith({ a: [{ title: 'a un' }, { title: 'a deux' }], b: [{ title: 'b un' }] });
    await run(parent, 'queue', 'add', 'a:L1', 'b:L1');
    const r = await run(parent, 'queue', 'add', 'b:L1', 'a:L2');
    expect(r.code).toBe(0);
    expect(r.err).toEqual(['queue add : b:L1 : déjà en file (position 2)']);
    expect(r.out).toEqual(['1. a:L1 — a un', '2. b:L1 — b un', '3. a:L2 — a deux']);
  });

  it('R4 — file vide : show dit comment approuver des lots', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    await run(parent, 'queue', 'add', 'a:L1');
    await run(parent, 'queue', 'drop', 'a:L1');
    const s = await run(parent, 'queue', 'show');
    expect(s.code).toBe(0);
    expect(s.out).toEqual(['file approuvée vide : approuver des lots avec orchestrate queue add <projet:lot>']);
  });

  it('R16 — queue.json absent : show dit file vide, sans créer le fichier', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const s = await run(parent, 'queue', 'show');
    expect(s.code).toBe(0);
    expect(s.out).toEqual(['file approuvée vide : approuver des lots avec orchestrate queue add <projet:lot>']);
    expect(existsSync(queueFile())).toBe(false);
  });

  it('R4 — show dit l\'état de chaque lot : en attente, ou sauté avec sa cause', async () => {
    const parent = parentWith({ a: [{ title: 'un' }, { title: 'deux' }] });
    const plan = Plan.load(join(parent, 'a/.cadence/raf.yaml'));
    plan.add('trois', '2026-10-01', { estimate: 1, after: ['L2'] });
    plan.save();
    await run(parent, 'queue', 'add', 'a:L1', 'a:L3');
    const s = await run(parent, 'queue', 'show');
    expect(s.out).toEqual(['1. a:L1 — un — en attente', '2. a:L3 — trois — sauté : after non clos (L2)']);
  });

  it('R4 — drop retire les clés données, l\'ordre des autres ne change pas, rend la file restante', async () => {
    const parent = parentWith({ a: [{ title: 'a un' }], b: [{ title: 'b un' }], c: [{ title: 'c un' }] });
    await run(parent, 'queue', 'add', 'a:L1', 'b:L1', 'c:L1');
    const r = await run(parent, 'queue', 'drop', 'b:L1');
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['1. a:L1 — a un', '2. c:L1 — c un']);
  });

  it('R4 — drop d\'une clé absente : refus nommant la clé', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    await run(parent, 'queue', 'add', 'a:L1');
    const before = readFileSync(queueFile(), 'utf8');
    const r = await run(parent, 'queue', 'drop', 'a:L1', 'a:L2');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue drop : a:L2 : absent de la file']);
    expect(readFileSync(queueFile(), 'utf8')).toBe(before); // refus en bloc : a:L1 reste
  });

  it('R4 — drop d\'un lot déjà tiré : refus, file inchangée', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    await run(parent, 'queue', 'add', 'a:L1');
    const file = JSON.parse(readFileSync(queueFile(), 'utf8'));
    file.entries[0] = { ...file.entries[0], state: 'drawn', wave: '2026-11-06-1000' };
    writeFileSync(queueFile(), JSON.stringify(file));
    const before = readFileSync(queueFile(), 'utf8');
    const r = await run(parent, 'queue', 'drop', 'a:L1');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue drop : a:L1 : déjà tiré par la vague 2026-11-06-1000']);
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
    const s = await run(parent, 'queue', 'show');
    expect(s.out).toEqual(['1. a:L1 — un — tiré par la vague 2026-11-06-1000']);
  });

  it('R16 — queue.json corrompu : add et drop refusés, show le dit, fichier inchangé octet pour octet', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    mkdirSync(cadenceHome(), { recursive: true });
    writeFileSync(queueFile(), '{ pas du json');
    const msg = `queue : file illisible (${queueFile()}) : corriger ou supprimer le fichier à la main`;
    for (const argv of [['queue', 'add', 'a:L1'], ['queue', 'drop', 'a:L1'], ['queue', 'show']]) {
      const r = await run(parent, ...argv);
      expect(r.code).toBe(1);
      expect(r.err).toEqual([msg]);
    }
    expect(readFileSync(queueFile(), 'utf8')).toBe('{ pas du json');
  });

  it('R16 — verrou tenu au-delà du délai : add et drop refusés, file inchangée', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    await run(parent, 'queue', 'add', 'a:L1');
    const before = readFileSync(queueFile(), 'utf8');
    writeFileSync(`${queueFile()}.lock`, JSON.stringify({ pid: process.pid })); // porteur vivant : ce processus
    for (const argv of [['queue', 'add', 'a:L1'], ['queue', 'drop', 'a:L1']]) {
      const r = await run(parent, ...argv);
      expect(r.code).toBe(1);
      expect(r.err).toEqual(['queue : file verrouillée depuis plus de 10 s : réessayer']);
    }
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
  });

  it('R16 — verrou d\'un porteur mort : repris, la commande passe', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    mkdirSync(cadenceHome(), { recursive: true });
    writeFileSync(`${queueFile()}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const r = await run(parent, 'queue', 'add', 'a:L1');
    expect(r.code).toBe(0);
  });

  it('R17 — orchestrate queue show : aiguillé vers la file, pas lu comme un lot', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'show');
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/file approuvée vide/);
  });

  it('R17 — orchestrate queue:L1 : lu comme le lot L1 du projet queue', () => {
    expect(parseOrchestrateArgs(['queue:L1']).lots).toEqual([{ project: 'queue', lot: 'L1', model: undefined }]);
  });

  it('R17 — orchestrate queue frobnicate : refus du sous-mot inconnu', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue', 'frobnicate');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue : sous-commande inconnue : frobnicate (add, show ou drop)']);
  });

  it('R17 — orchestrate queue seul (lot nu nommé queue) : refus nommant la forme queue:<lot>', async () => {
    const parent = parentWith({ a: [{ title: 'un' }] });
    const r = await run(parent, 'queue');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue : sous-commande attendue (add, show ou drop) ; le lot d\'un projet nommé queue se donne sous la forme queue:<lot>']);
  });

  it('R17 — un projet nommé queue : sa clé queue:L1 se met en file', async () => {
    const parent = parentWith({ queue: [{ title: 'lot du projet queue' }] });
    const r = await run(parent, 'queue', 'add', 'queue:L1');
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['1. queue:L1 — lot du projet queue']);
  });
});
