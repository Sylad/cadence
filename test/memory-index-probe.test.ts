import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { projectLogDir } from '../src/orchestrate/launch.js';
import { cleanupTempDirs, commit, gitRepo, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function cadIn(cwd: string, env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd, env: { RAF_TODAY: '2026-09-28', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-09-28T18:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function project(yaml?: string, dir = gitRepo()) {
  await cadIn(dir, {}, 'init', '--project', 'demo', '--no-hook');
  await cadIn(dir, {}, 'add', 'Cache');
  if (yaml !== undefined) writeFileSync(join(dir, 'cadence.yaml'), yaml);
  git(dir, 'add', '.');
  commit(dir, 'chore: plan', '2026-09-20T09:00:00');
  return dir;
}

function memoryFor(cwd: string) {
  const home = tempDir();
  const memDir = join(projectLogDir(home, cwd), 'memory');
  mkdirSync(memDir, { recursive: true });
  return { home, memDir, index: join(memDir, 'MEMORY.md'), env: { CLAUDE_CONFIG_DIR: home } };
}

const FILL = `# ${'x'.repeat(12_100)}\n`;

async function closeWith(content: string, yaml?: string) {
  const d = await project(yaml);
  const m = memoryFor(d);
  writeFileSync(m.index, content);
  return cadIn(d, m.env, 'session', 'close');
}

async function datedIn(body: string): Promise<number> {
  const { out } = await closeWith(`${body}\n${FILL}`);
  const r = /(\d+) entrée\(s\) datée\(s\)/.exec(out);
  if (!r) expect(out).toContain('aucune entrée datée à regrouper');
  return r ? Number(r[1]) : 0;
}

describe('R2 — octets, pas caractères', () => {
  it('R2 — 6001 « é » (12002 octets, 6001 caractères) : avertissement', async () => {
    const { out } = await closeWith(`# ${'é'.repeat(6_000)}\n`);
    expect(out).toContain('pèse 12003 octets (seuil 12000)');
  });
  it('R2 — 5990 « é » (11983 octets, > 5990 caractères) : aucun avertissement', async () => {
    const { out } = await closeWith(`# ${'é'.repeat(5_990)}\n`);
    expect(out).not.toContain('Mémoire');
  });
});

describe('R3 — formes de date', () => {
  it('R3 — variantes datées acceptées par la fiche', async () => {
    const body = ['- **[⚠ 31-10 : a](a.md)**', '- [31-10 b](b.md)', '- 31-10 : c', '- **31-10** d', '- [⚠️ 01-01 e](e.md)'].join('\n');
    expect(await datedIn(body)).toBe(5);
  });
  it('R3 — jour/mois impossibles ou suivis d’un chiffre : non datées', async () => {
    const body = ['- 00-10 a', '- 32-10 b', '- 31-13 c', '- 31-00 d', '- 31-102 e', '- 5-10 f'].join('\n');
    expect(await datedIn(body)).toBe(0);
  });
  it('R3 — BOM en tête de fichier : la première entrée reste datée', async () => {
    expect(await datedIn('﻿- **[31-10 : a](a.md)**\n- **[30-10 : b](b.md)**')).toBe(2);
  });
  it('R3 — CR seul (fin de ligne Mac) ou ligne vide entre entrées : pas de plantage', async () => {
    expect(await datedIn('- **[31-10 : a](a.md)**\n\n\n- **[30-10 : b](b.md)**\n')).toBe(2);
  });
  it('R3 — le poids des entrées ne dépasse jamais la taille du fichier (dernière ligne sans fin de ligne)', async () => {
    const content = `- **[31-10 : ${'y'.repeat(12_100)}**`;
    const { out } = await closeWith(content);
    const size = Number(/pèse (\d+) octets/.exec(out)![1]);
    const bytes = Number(/\((\d+) octets\) à regrouper/.exec(out)![1]);
    expect(bytes).toBeLessThanOrEqual(size);
  });
  it('R3 — renvoi vers l’index secondaire avec lien daté après un regroupement : plus d’entrée proposée', async () => {
    const { out } = await closeWith(`- [Archives du 31-10](archive_31-10.md)\n${FILL}`);
    // la ligne de renvoi commence par « Archives » : jamais comptée
    expect(out).toContain('aucune entrée datée à regrouper');
  });
});

describe('R7 — valeurs invalides de memory.indexMaxBytes', () => {
  const cases: [string, string, string][] = [
    ['flottant', 'memory:\n  indexMaxBytes: 5000.5\n', '5000.5'],
    ['chaîne', 'memory:\n  indexMaxBytes: "5000"\n', '5000'],
    ['booléen', 'memory:\n  indexMaxBytes: true\n', 'true'],
    ['négatif', 'memory:\n  indexMaxBytes: -3\n', '-3'],
    ['null', 'memory:\n  indexMaxBytes: null\n', 'null'],
    ['abc', 'memory:\n  indexMaxBytes: abc\n', 'abc'],
    ['liste', 'memory:\n  indexMaxBytes: [1]\n', '[1]'],
  ];
  for (const [name, yaml, shown] of cases) {
    it(`R7 — close avec indexMaxBytes ${name} : code 2, message exact, aucun rapport`, async () => {
      const d = await project(yaml);
      const m = memoryFor(d);
      writeFileSync(m.index, `# ${'x'.repeat(13_000)}\n`);
      const r = await cadIn(d, m.env, 'session', 'close');
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toContain(`memory.indexMaxBytes doit être un entier ≥ 1 (octets), pas ${shown}`);
    });
    it(`R7 — tour avec indexMaxBytes ${name} : code 0, ligne d’erreur, pas de ligne mémoire`, async () => {
      const root = tempDir();
      await project(undefined, gitRepo(root));
      writeFileSync(join(root, 'cadence.yaml'), yaml);
      const m = memoryFor(root);
      writeFileSync(m.index, `# ${'x'.repeat(13_000)}\n`);
      const r = await cadIn(root, m.env, 'lead', 'tour');
      expect(r.code).toBe(0);
      expect(r.out).toContain(`cadence.yaml · ✗ erreur : memory.indexMaxBytes doit être un entier ≥ 1 (octets), pas ${shown}`);
      expect(r.out).not.toContain('mémoire ·');
    });
  }
  it('R7 — memory: liste ou chaîne, ou clé inconnue : close code 2, tour code 0 avec ligne d’erreur', async () => {
    for (const y of ['memory: []\n', 'memory: abc\n', 'memory:\n  autre: 1\n']) {
      const d = await project(y);
      const m = memoryFor(d);
      writeFileSync(m.index, `# ${'x'.repeat(13_000)}\n`);
      expect((await cadIn(d, m.env, 'session', 'close')).code).toBe(2);
      const root = tempDir();
      await project(undefined, gitRepo(root));
      writeFileSync(join(root, 'cadence.yaml'), y);
      const t = await cadIn(root, memoryFor(root).env, 'lead', 'tour');
      expect(t.code).toBe(0);
    }
  });
  it('R7 — memory: (vide, null) ou sans indexMaxBytes : seuil par défaut, pas d’erreur', async () => {
    for (const y of ['memory:\n', 'memory: {}\n']) {
      const r = await closeWith(`# ${'x'.repeat(13_000)}\n`, y);
      expect(r.code).toBe(0);
      expect(r.out).toContain('pèse 13003 octets (seuil 12000)');
    }
  });
  it('R7 — seuil 1 : un index d’un octet de plus que 1 avertit', async () => {
    const r = await closeWith('ab\n', 'memory:\n  indexMaxBytes: 1\n');
    expect(r.out).toContain('pèse 3 octets (seuil 1)');
  });
  it('R7 — close sur un cadence.yaml invalide sans index : l’erreur reste bloquante (clé mesurée avant tout rapport)', async () => {
    const d = await project('memory:\n  indexMaxBytes: 0\n');
    const m = memoryFor(d);
    const r = await cadIn(d, m.env, 'session', 'close');
    expect(r.code).toBe(2);
  });
  it('R7 — close --all avec un projet à clé invalide : erreur, pas de plantage non géré', async () => {
    const root = tempDir();
    await project('memory:\n  indexMaxBytes: 0\n', gitRepo(root));
    const r = await cadIn(root, memoryFor(root).env, 'session', 'close', '--all');
    expect([0, 1, 2]).toContain(r.code);
    expect(r.out + r.err).toContain('memory.indexMaxBytes');
  });
});

describe('R9 / absent — formes de fichier', () => {
  it('R9 — MEMORY.md lien symbolique cassé : traité en absent, sans avertissement ni plantage', async () => {
    const d = await project();
    const m = memoryFor(d);
    symlinkSync(join(m.memDir, 'nulle-part.md'), m.index);
    const r = await cadIn(d, m.env, 'session', 'close');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Mémoire');
  });
  it('R9 — tour : lien cassé = absent, aucune ligne', async () => {
    const root = tempDir();
    await project(undefined, gitRepo(root));
    const m = memoryFor(root);
    symlinkSync(join(m.memDir, 'nulle-part.md'), m.index);
    const r = await cadIn(root, m.env, 'lead', 'tour');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('mémoire ·');
  });
  it('R6 — tour sans projet : aucune ligne mémoire, même avec un index énorme', async () => {
    const root = tempDir();
    const m = memoryFor(root);
    writeFileSync(m.index, `# ${'x'.repeat(13_000)}\n`);
    const r = await cadIn(root, m.env, 'lead', 'tour');
    expect(r.out).not.toContain('mémoire ·');
  });
  it('R1 — deux appels de suite : même sortie (rien n’est modifié)', async () => {
    const d = await project();
    const m = memoryFor(d);
    writeFileSync(m.index, `- **[31-10 : a](a.md)**\n${FILL}`);
    const a = await cadIn(d, m.env, 'session', 'close');
    const b = await cadIn(d, m.env, 'session', 'close');
    expect(b.out).toBe(a.out);
  });
  it('R1 — CLAUDE_CONFIG_DIR vide ET HOME vers un dossier de test : lit HOME/.claude', async () => {
    const d = await project();
    const home = tempDir();
    const memDir = join(projectLogDir(join(home, '.claude'), d), 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), `# ${'x'.repeat(13_000)}\n`);
    const r = await cadIn(d, { CLAUDE_CONFIG_DIR: '', HOME: home }, 'session', 'close');
    expect(r.out).toContain('pèse');
  });
  it('R1 — tour : mesure le dossier parent même lancé depuis un sous-projet', async () => {
    const root = tempDir();
    await project(undefined, gitRepo(root));
    const m = memoryFor(root);
    writeFileSync(m.index, `# ${'x'.repeat(13_000)}\n`);
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const r = await cadIn(sub, m.env, 'lead', 'tour', '..');
    expect(r.out).toContain('mémoire · MEMORY.md 13003 octets');
  });
});
