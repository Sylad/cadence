import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { RafError } from '../src/plan.js';
import { coversFile, hasPaths, normalizePath, readResources, resourcesTouching } from '../src/resources.js';
import { gitRepo, tempDir } from './helpers.js';

// L558 — ressources par chemins (docs/specs/ressources-par-chemins/fiche.yaml) : lecture de `resources:` en table, normalisation et validation des chemins, messages de A1.

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-04' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-04T09:30:00') });
  return { code: code as number, out: out.join('\n'), err: err.join('\n') };
}

/** Un dossier parent avec son cadence.yaml et un `root` de projet dessous ; rend le fichier déclarant et le root. */
function declared(yaml: string): { file: string; root: string } {
  const parent = tempDir();
  const root = join(parent, 'projet', '.cadence');
  mkdirSync(root, { recursive: true });
  const file = join(parent, 'cadence.yaml');
  writeFileSync(file, yaml);
  return { file, root };
}

const TABLE = 'resources:\n  cycle-ts:\n    paths: [src/orchestrate/cycle.ts, src/orchestrate/cycle/]\n  banc: {}\n';

describe('R1 — sans ressource à chemins, tout est comme avant', () => {
  it('R1 — resources en liste de noms : readResources, raf check, readyFree et resourceLock rendent le résultat d\'avant', () => {
    const { file, root } = declared('resources: [banc, passerelle, banc]\n');
    const r = readResources(root);
    expect(r).toMatchObject({ file, names: ['banc', 'passerelle'] });
    expect([...r.paths.values()].every((p) => p.length === 0)).toBe(true);
    expect(hasPaths(r)).toBe(false);
    // raf check : le contrôle d'avant, mot pour mot
    const parent = tempDir();
    const dir = gitRepo(parent);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    writeFileSync(join(parent, 'cadence.yaml'), 'resources: [banc]\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    expect(raf(dir, 'check').code).toBe(0);
    raf(dir, 'add', 'B', '--uses', 'gpu');
    const c = raf(dir, 'check');
    expect(c.code).toBe(1);
    expect(c.out).toContain(`✗ L2 utilise la ressource « gpu », non déclarée dans ${join(parent, 'cadence.yaml')} (resources:)`);
  });

  it('R1 — resources: bob : le message d\'avant', () => {
    const { file, root } = declared('resources: bob\n');
    expect(() => readResources(root)).toThrow(`${file} : resources doit être une liste de noms de ressources`);
  });
});

describe('R2 — une ressource en table', () => {
  it('R2 — table avec paths : names contient la clé et paths ses chemins', () => {
    const { root } = declared(TABLE);
    const r = readResources(root);
    expect(r.names).toEqual(['cycle-ts', 'banc']);
    expect(r.paths.get('cycle-ts')).toEqual(['src/orchestrate/cycle.ts', 'src/orchestrate/cycle']);
    expect(hasPaths(r)).toBe(true);
  });

  it('R2 — « banc: {} » et « banc: » : ressource sans chemin', () => {
    const { root } = declared('resources:\n  banc: {}\n  gpu:\n');
    const r = readResources(root);
    expect(r.names).toEqual(['banc', 'gpu']);
    expect(r.paths.get('banc')).toEqual([]);
    expect(r.paths.get('gpu')).toEqual([]);
    expect(hasPaths(r)).toBe(false);
  });

  it('R2 — un lot « uses: [cycle-ts] » n\'est pas signalé par raf check quand cycle-ts est une clé de la table', () => {
    const parent = tempDir();
    const dir = gitRepo(parent);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    writeFileSync(join(parent, 'cadence.yaml'), TABLE);
    raf(dir, 'add', 'A', '--uses', 'cycle-ts,banc');
    expect(raf(dir, 'check').code).toBe(0);
    raf(dir, 'add', 'B', '--uses', 'gpu');
    const c = raf(dir, 'check');
    expect(c.code).toBe(1);
    expect(c.out).toContain('✗ L2 utilise la ressource « gpu », non déclarée dans');
  });

  it('R2 — liste mêlée [banc, { cycle-ts: … }] : erreur de lecture', () => {
    const { file, root } = declared('resources:\n  - banc\n  - cycle-ts: { paths: [src/x.ts] }\n');
    expect(() => readResources(root)).toThrow(`${file} : resources mêle des noms et des tables : écrire soit une liste de noms, soit une table nom: { paths: [...] }`);
  });
});

describe('R3 — normalisation et couverture d\'un chemin', () => {
  it('R3 — « ./src/x.ts » et « src//x.ts » valent « src/x.ts »', () => {
    expect(normalizePath('./src/x.ts')).toBe('src/x.ts');
    expect(normalizePath('src//x.ts')).toBe('src/x.ts');
    const { root } = declared('resources:\n  a: { paths: [./src/x.ts] }\n  b: { paths: [src//x.ts] }\n');
    const r = readResources(root);
    expect(r.paths.get('a')).toEqual(['src/x.ts']);
    expect(r.paths.get('b')).toEqual(['src/x.ts']);
  });

  it('R3 — « src/./x » vaut « src/x »', () => {
    expect(normalizePath('src/./x')).toBe('src/x');
  });

  it('R3 — « src/./ » vaut « src »', () => {
    expect(normalizePath('src/./')).toBe('src');
  });

  it('R3 — « src/orchestrate/cycle/ » couvre src/orchestrate/cycle/sh.ts', () => {
    expect(normalizePath('src/orchestrate/cycle/')).toBe('src/orchestrate/cycle');
    expect(coversFile('src/orchestrate/cycle', 'src/orchestrate/cycle/sh.ts')).toBe(true);
    expect(coversFile('src/orchestrate/cycle', 'src/orchestrate/cycle.ts')).toBe(false);
  });

  it('R3 — « src/a » ne couvre pas src/ab.ts', () => {
    expect(coversFile('src/a', 'src/ab.ts')).toBe(false);
    expect(coversFile('src/a', 'src/a/b.ts')).toBe(true);
    expect(coversFile('src/a', 'src/a')).toBe(true);
  });

  it('R3 — « src/x.ts/ » vaut « src/x.ts » et couvre le fichier', () => {
    expect(normalizePath('src/x.ts/')).toBe('src/x.ts');
    expect(coversFile('src/x.ts', 'src/x.ts')).toBe(true);
  });

  it('R3 — deux fois le même chemin dans une ressource : un seul gardé', () => {
    const { root } = declared('resources:\n  a: { paths: [src/x.ts, ./src/x.ts, src/y.ts, src/x.ts/] }\n');
    expect(readResources(root).paths.get('a')).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('R3 — resourcesTouching : une ressource par fichier couvert, avec le chemin et le fichier', () => {
    const { root } = declared(TABLE);
    const r = readResources(root);
    expect(resourcesTouching(r, ['README.md'])).toEqual(new Map());
    expect(resourcesTouching(r, ['README.md', 'src/orchestrate/cycle/sh.ts'])).toEqual(new Map([['cycle-ts', { path: 'src/orchestrate/cycle', file: 'src/orchestrate/cycle/sh.ts' }]]));
  });
});

describe('R4 — une table mal formée est une erreur de lecture', () => {
  const bad = (yaml: string) => {
    const { file, root } = declared(yaml);
    let caught: unknown;
    try {
      readResources(root);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RafError);
    return { file, message: (caught as Error).message };
  };
  const invalidPath = (p: string) => `resources.a : chemin invalide « ${p} » (relatif au dépôt, sans « .. », « \\ » ni joker)`;

  it('R4 — paths: src/x.ts (texte, pas liste) : erreur nommant le fichier et la ressource', () => {
    const { file, message } = bad('resources:\n  a: { paths: src/x.ts }\n');
    expect(message).toBe(`${file} : resources.a : paths doit être une liste de chemins`);
    expect(bad('resources:\n  a: { paths: [src/x.ts, 3] }\n').message).toContain('resources.a : paths doit être une liste de chemins');
    expect(bad('resources:\n  a: { paths: }\n').message).toContain('resources.a : paths doit être une liste de chemins');
  });

  it('R4 — chemin « /etc/x » : erreur', () => {
    expect(bad('resources:\n  a: { paths: [/etc/x] }\n').message).toContain(invalidPath('/etc/x'));
  });

  it('R4 — chemin « ../x » : erreur', () => {
    expect(bad('resources:\n  a: { paths: [../x] }\n').message).toContain(invalidPath('../x'));
    expect(bad('resources:\n  a: { paths: [src/../x] }\n').message).toContain(invalidPath('src/../x'));
  });

  it('R4 — chemin « src\\x » : erreur', () => {
    expect(bad('resources:\n  a: { paths: ["src\\\\x"] }\n').message).toContain(invalidPath('src\\x'));
  });

  it('R4 — chemin « src/*.ts » : erreur', () => {
    for (const p of ['src/*.ts', 'src/?.ts', 'src/[a].ts']) expect(bad(`resources:\n  a: { paths: ["${p}"] }\n`).message).toContain(invalidPath(p));
  });

  it('R4 — chemin vide : erreur', () => {
    expect(bad('resources:\n  a: { paths: [""] }\n').message).toContain(invalidPath(''));
  });

  it('R4 — chemin « . » : erreur (vide après normalisation)', () => {
    expect(bad('resources:\n  a: { paths: ["."] }\n').message).toContain(invalidPath('.'));
    expect(bad('resources:\n  a: { paths: ["././"] }\n').message).toContain(invalidPath('././'));
  });

  it('R4 — chemin « ./ » : erreur (vide après normalisation)', () => {
    expect(bad('resources:\n  a: { paths: ["./"] }\n').message).toContain(invalidPath('./'));
  });

  it('R4 — chemin « src\\ » (antislash final) : erreur', () => {
    expect(bad('resources:\n  a: { paths: ["src\\\\"] }\n').message).toContain(invalidPath('src\\'));
  });

  it('R4 — même chemin sous deux ressources : lu sans erreur, les deux ressources portent le chemin', () => {
    const { root } = declared('resources:\n  a: { paths: [src/x.ts] }\n  b: { paths: [src/] }\n');
    const r = readResources(root);
    expect(r.paths.get('a')).toEqual(['src/x.ts']);
    expect(r.paths.get('b')).toEqual(['src']);
    expect([...resourcesTouching(r, ['src/x.ts']).keys()]).toEqual(['a', 'b']);
  });

  it('R4 — nom de table « Cycle TS » : erreur au texte exact de A1', () => {
    const { file, message } = bad('resources:\n  Cycle TS: { paths: [src/x.ts] }\n');
    expect(message).toBe(`${file} : resources.Cycle TS : nom de ressource invalide (lettres minuscules, chiffres, - et _)`);
  });

  it('R4 — liste mêlée : erreur au texte exact de A1 (test R2)', () => {
    const { file, message } = bad('resources:\n  - { cycle-ts: { paths: [src/x.ts] } }\n  - banc\n');
    expect(message).toBe(`${file} : resources mêle des noms et des tables : écrire soit une liste de noms, soit une table nom: { paths: [...] }`);
  });

  it('R4 — clé « path: » (faute de frappe) : erreur « clé inconnue »', () => {
    const { file, message } = bad('resources:\n  a: { path: [src/x.ts] }\n');
    expect(message).toBe(`${file} : resources.a : clé inconnue « path » (seule paths est connue)`);
  });

  it('R4 — entrée qui n\'est ni vide ni une table (a: 3) : erreur nommant la ressource', () => {
    expect(bad('resources:\n  a: 3\n').message).toContain('resources.a : paths doit être une liste de chemins');
  });

  it('R4 — raf check relaie le message de la table mal formée, code 1', () => {
    const parent = tempDir();
    const dir = gitRepo(parent);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    writeFileSync(join(parent, 'cadence.yaml'), 'resources:\n  a: { paths: ["../x"] }\n');
    raf(dir, 'add', 'A', '--uses', 'a');
    const c = raf(dir, 'check');
    expect(c.code).toBe(1);
    expect(c.out).toContain(`${join(parent, 'cadence.yaml')} : resources.a : chemin invalide « ../x » (relatif au dépôt, sans « .. », « \\ » ni joker)`);
  });
});
