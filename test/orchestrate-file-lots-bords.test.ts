import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestrate, type OrchestrateDeps, type OrchestrateIo } from '../src/orchestrate/command.js';
import { cadenceHome } from '../src/orchestrate/registry.js';
import { Plan } from '../src/plan.js';
import { processStart } from '../src/proc.js';
import { AGENTS_DIR } from '../src/skills.js';
import { tempDir } from './helpers.js';

const savedHome = process.env.CADENCE_HOME;
beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});
afterEach(() => {
  process.env.CADENCE_HOME = savedHome;
});

function parentWith(projects: Record<string, string[]>): string {
  const parent = tempDir();
  for (const [name, titles] of Object.entries(projects)) {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    const plan = Plan.create(join(dir, '.cadence/raf.yaml'), name, 'L', '2026-09-01');
    for (const t of titles) plan.add(t, '2026-10-01', { estimate: 1 });
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
const seed = (content: string) => {
  mkdirSync(cadenceHome(), { recursive: true });
  writeFileSync(queueFile(), content);
};

describe('L498 — bords de la file approuvée', () => {
  it('R2 — clé mal formée (sans lot, sans projet, avec @modèle, avec espace) : refus nommant la clé, rien écrit', async () => {
    const parent = parentWith({ a: ['un'] });
    for (const key of ['a:', ':L1', 'a', 'a:L1@opus', 'a:L 1']) {
      const r = await run(parent, 'queue', 'add', key);
      expect(r.code, key).toBe(1);
      expect(r.err.join('\n'), key).toContain(key);
      expect(existsSync(queueFile()), key).toBe(false);
    }
  });

  it('C1 — un projet hors du dossier de lancement (../b:L1) est un projet inconnu : refus, rien écrit', async () => {
    const parent = parentWith({ a: ['un'], b: ['deux'] });
    const r = await run(join(parent, 'a'), 'queue', 'add', '../b:L1');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('../b:L1');
    expect(existsSync(queueFile())).toBe(false);
  });

  it('R3 — a b a dans une même commande : a garde la position 1, avertissement avec la position', async () => {
    const parent = parentWith({ a: ['un'], b: ['deux'] });
    const r = await run(parent, 'queue', 'add', 'a:L1', 'b:L1', 'a:L1');
    expect(r.code).toBe(0);
    expect(r.out.map((l) => l.split(' — ')[0])).toEqual(['1. a:L1', '2. b:L1']);
    expect(r.err).toEqual(['queue add : a:L1 : déjà en file (position 1)']);
  });

  it('R4 — drop en bloc : une clé absente parmi des clés présentes refuse tout, la file garde ses lots', async () => {
    const parent = parentWith({ a: ['un'], b: ['deux'] });
    await run(parent, 'queue', 'add', 'a:L1', 'b:L1');
    const before = readFileSync(queueFile(), 'utf8');
    const r = await run(parent, 'queue', 'drop', 'a:L1', 'b:L9');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['queue drop : b:L9 : absent de la file']);
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
  });

  it('R4 — drop d\'un lot réservé par une vague vivante : refus, file inchangée', async () => {
    const parent = parentWith({ a: ['un'] });
    seed(JSON.stringify({ entries: [{ key: 'a:L1', dir: parent, state: 'reserved', wave: 'w-vivante', pid: process.pid, start: processStart(process.pid) ?? undefined }] }));
    const before = readFileSync(queueFile(), 'utf8');
    const r = await run(parent, 'queue', 'drop', 'a:L1');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('a:L1');
    expect(readFileSync(queueFile(), 'utf8')).toBe(before);
  });

  it('R14 — réservation au pid repris par un autre processus (heure de démarrage différente) : lue comme orpheline, drop accepté', async () => {
    const parent = parentWith({ a: ['un'] });
    seed(JSON.stringify({ entries: [{ key: 'a:L1', dir: parent, state: 'reserved', wave: 'w-morte', pid: process.pid, start: 'jamais-demarre' }] }));
    const s = await run(parent, 'queue', 'show');
    expect(s.out.join('\n')).toMatch(/orpheline/);
    const d = await run(parent, 'queue', 'drop', 'a:L1');
    expect(d.code).toBe(0);
  });

  it('R14 — réservation sans pid : lue comme orpheline (drop accepté)', async () => {
    const parent = parentWith({ a: ['un'] });
    seed(JSON.stringify({ entries: [{ key: 'a:L1', dir: parent, state: 'reserved', wave: 'w-morte' }] }));
    const d = await run(parent, 'queue', 'drop', 'a:L1');
    expect(d.code).toBe(0);
    expect(JSON.parse(readFileSync(queueFile(), 'utf8')).entries).toEqual([]);
  });

  it('R16 — queue.json de zéro octet, tableau nu, entries non liste, état inconnu : add, drop et show refusent (code 1), octets inchangés', async () => {
    const parent = parentWith({ a: ['un'] });
    for (const content of ['', '[]', 'null', '{"entries":"x"}', '{"entries":[null]}', JSON.stringify({ entries: [{ key: 'a:L1', dir: parent, state: 'bizarre' }] })]) {
      seed(content);
      for (const sub of [['add', 'a:L1'], ['drop', 'a:L1'], ['show']]) {
        const r = await run(parent, 'queue', ...sub);
        expect(r.code, `${content} ${sub[0]}`).toBe(1);
        expect(r.err.join('\n'), `${content} ${sub[0]}`).toContain('file illisible');
        expect(readFileSync(queueFile(), 'utf8'), `${content} ${sub[0]}`).toBe(content);
      }
    }
  });

  it('R16 — un refus (clé inconnue) ne laisse ni verrou ni fichier temporaire', async () => {
    const parent = parentWith({ a: ['un'] });
    await run(parent, 'queue', 'add', 'a:L1');
    await run(parent, 'queue', 'drop', 'a:L9');
    await run(parent, 'queue', 'add', 'a:L1');
    expect(existsSync(`${queueFile()}.lock`)).toBe(false);
    expect(existsSync(`${queueFile()}.tmp`)).toBe(false);
  });

  it('R16 — --queue sur un queue.json corrompu : refus (code 2), rien tiré, fichier inchangé octet pour octet', async () => {
    const parent = parentWith({ a: ['un'] });
    seed('{ pas du json');
    const r = await run(parent, '--queue');
    expect(r.code).toBe(2);
    expect(readFileSync(queueFile(), 'utf8')).toBe('{ pas du json');
  });

  it('R1 — deux dossiers de lancement : chacun ne voit que sa file, un drop de l\'un ne touche pas l\'autre', async () => {
    const p1 = parentWith({ a: ['un'] });
    const p2 = parentWith({ a: ['un'] });
    await run(p1, 'queue', 'add', 'a:L1');
    await run(p2, 'queue', 'add', 'a:L1');
    expect((await run(p1, 'queue', 'drop', 'a:L1')).code).toBe(0);
    expect((await run(p2, 'queue', 'show')).out[0]).toMatch(/^1\. a:L1/);
    expect((await run(p1, 'queue', 'show')).out[0]).toMatch(/file approuvée vide/);
  });

  it('R17 — un drapeau avant le mot (--dry-run queue show) : queue reste le premier jeton positionnel, aiguillé vers la file', async () => {
    const parent = parentWith({ a: ['un'] });
    const r = await run(parent, '--dry-run', 'queue', 'show');
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/file approuvée vide/);
  });

  it('R17 — queue SHOW (casse) : sous-mot inconnu refusé (code 1)', async () => {
    const parent = parentWith({ a: ['un'] });
    const r = await run(parent, 'queue', 'SHOW');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('SHOW');
  });
});
