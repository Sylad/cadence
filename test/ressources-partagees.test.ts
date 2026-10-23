import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { gitRepo, tempDir } from './helpers.js';

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
  return { code: code as number, out: out.join('\n'), err: err.join('\n') };
}

/** Le plan lu, les listes en flow ramenées à `[a, b]` (la bibliothèque YAML écrit `[ a, b ]`, comme after:). */
const yaml = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8').replace(/\[ /g, '[').replace(/ \]/g, ']');
const INVALID = (n: string) => `ressource invalide : ${n} (lettres minuscules, chiffres, - et _)`;

/** Un projet git initialisé, dans un dossier parent jetable ; `cadence.yaml` du parent écrit si `parentYaml` est donné. */
function project(parentYaml?: string): { parent: string; dir: string } {
  const parent = tempDir();
  const dir = gitRepo(parent);
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  if (parentYaml !== undefined) writeFileSync(join(parent, 'cadence.yaml'), parentYaml);
  return { parent, dir };
}

describe('R1 — la clé uses: d\'un lot', () => {
  it('R1 — raf add --uses banc,passerelle écrit uses: [banc, passerelle]', () => {
    const { dir } = project();
    raf(dir, 'add', 'A');
    expect(raf(dir, 'add', 'B', '--after', 'L1', '--uses', 'banc,passerelle')).toMatchObject({ code: 0, out: 'L2' });
    const text = yaml(dir);
    expect(text).toContain('uses: [banc, passerelle]');
    // après after:, avant created:
    expect(text.indexOf('after: [L1]')).toBeLessThan(text.indexOf('uses: [banc, passerelle]'));
    expect(text.indexOf('uses: [banc, passerelle]')).toBeLessThan(text.indexOf('created:', text.indexOf('uses:')));
  });

  it('R1 — un lot sans uses: : plan et sortie de raf show inchangés', () => {
    const { dir } = project();
    raf(dir, 'add', 'A', '--after', '');
    expect(yaml(dir)).not.toContain('uses');
    expect(raf(dir, 'show', 'L1').out).not.toContain('uses');
  });

  it('R1 — raf show affiche les ressources du lot', () => {
    const { dir } = project();
    raf(dir, 'add', 'A', '--uses', 'banc,passerelle');
    expect(raf(dir, 'show', 'L1').out.split('\n')).toContain('uses : banc, passerelle');
  });
});

describe('R2 — les noms de ressources', () => {
  it('R2 — nom avec espace ou majuscule : refus, aucun lot créé', () => {
    const { dir } = project();
    const before = yaml(dir);
    for (const bad of ['Banc', 'banc x']) {
      const r = raf(dir, 'add', 'A', '--uses', bad);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(INVALID(bad));
    }
    expect(yaml(dir)).toBe(before);
    const u = raf(dir, 'add', 'B');
    expect(raf(dir, 'uses', u.out, 'Banc').err).toContain(INVALID('Banc'));
    expect(yaml(dir)).not.toContain('uses');
  });

  it('R2 — --uses vide : refus', () => {
    const { dir } = project();
    const before = yaml(dir);
    const r = raf(dir, 'add', 'A', '--uses', '');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('ressource invalide');
    expect(yaml(dir)).toBe(before);
  });

  it('R2 — banc,banc : une seule entrée', () => {
    const { dir } = project();
    raf(dir, 'add', 'A', '--uses', 'banc, passerelle ,banc');
    expect(yaml(dir)).toContain('uses: [banc, passerelle]');
  });
});

describe('R3 — formes illisibles', () => {
  it('R3 — resources: banc (chaîne) : erreur nommant le fichier', () => {
    const { parent, dir } = project('resources: banc\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${join(parent, 'cadence.yaml')} : resources doit être une liste de noms de ressources`);
  });

  it('R3 — cadence.yaml parent illisible : erreur nommant le fichier', () => {
    const { parent, dir } = project('resources: [banc\n  : :\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(join(parent, 'cadence.yaml'));
    expect(r.out).toContain('illisible');
  });

  it('R3 — uses: 3 dans le plan : écart bad-field', () => {
    const { dir } = project();
    raf(dir, 'add', 'A');
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace('    created:', '    uses: 3\n    created:'));
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ L1 : uses doit être une liste de noms de ressources');
  });

  it('R3 — resources: [Banc X] (nom invalide) : erreur nommant le fichier', () => {
    const { parent, dir } = project('resources: [Banc X]\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${join(parent, 'cadence.yaml')} : resources doit être une liste de noms de ressources`);
  });
});

describe('R4 — où sont les ressources déclarées', () => {
  it('R4 — resources: [banc] dans le parent : banc déclaré', () => {
    const { dir } = project('resources: [banc]\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    expect(raf(dir, 'check').code).toBe(0);
  });

  it('R4 — parent sans cadence.yaml : banc non déclaré', () => {
    const { parent, dir } = project();
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`✗ L1 utilise la ressource « banc », non déclarée dans ${join(parent, 'cadence.yaml')} (resources:)`);
  });

  it('R4 — resources: [] : banc non déclaré', () => {
    const { dir } = project('resources: []\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    expect(raf(dir, 'check').code).toBe(1);
  });

  it('R4 — projet à profondeur 2, resources: [banc] dans le dossier grand-parent : banc déclaré, aucun écart faux', () => {
    const top = tempDir();
    const group = join(top, 'groupe');
    mkdirSync(group);
    writeFileSync(join(top, 'cadence.yaml'), 'depth: 2\nresources: [banc]\n');
    writeFileSync(join(group, 'cadence.yaml'), 'priority: [demo]\n');
    const dir = gitRepo(group);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.out).not.toContain('banc');
    expect(r.code).toBe(0);
  });

  it('R4 — le parent direct porte resources: [] et le grand-parent [banc] : banc non déclaré (le plus proche l\'emporte)', () => {
    const top = tempDir();
    const group = join(top, 'groupe');
    mkdirSync(group);
    writeFileSync(join(top, 'cadence.yaml'), 'resources: [banc]\n');
    writeFileSync(join(group, 'cadence.yaml'), 'resources: []\n');
    const dir = gitRepo(group);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`non déclarée dans ${join(group, 'cadence.yaml')}`);
  });

  it('R4 — resources: sans valeur dans le parent direct, [banc] au grand-parent : la clé présente l\'emporte, banc non déclaré', () => {
    const top = tempDir();
    const group = join(top, 'groupe');
    mkdirSync(group);
    writeFileSync(join(top, 'cadence.yaml'), 'resources: [banc]\n');
    writeFileSync(join(group, 'cadence.yaml'), 'resources:\n');
    const dir = gitRepo(group);
    raf(dir, 'init', '--project', 'demo', '--no-hook');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`non déclarée dans ${join(group, 'cadence.yaml')}`);
  });

  it('R4 — resources: [banc, banc] : banc déclaré, sans erreur', () => {
    const { dir } = project('resources: [banc, banc]\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('resources');
  });
});

describe('R5 — uses: se pose sur un lot', () => {
  it('R5 — add --parent L1 --uses banc : refus avec le message', () => {
    const { dir } = project();
    raf(dir, 'add', 'A');
    const before = yaml(dir);
    const r = raf(dir, 'add', 'tâche', '--parent', 'L1', '--uses', 'banc');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('uses se pose sur un lot, pas sur une sous-tâche : L1');
    expect(yaml(dir)).toBe(before);
  });

  it('R5 — raf uses L1/t1 banc : refus', () => {
    const { dir } = project();
    raf(dir, 'add', 'A');
    raf(dir, 'add', 'tâche', '--parent', 'L1');
    const before = yaml(dir);
    const r = raf(dir, 'uses', 'L1/t1', 'banc');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('uses se pose sur un lot, pas sur une sous-tâche : L1/t1');
    expect(yaml(dir)).toBe(before);
  });

  it('R5 — raf uses L99 banc : « lot inconnu : L99 »', () => {
    const { dir } = project();
    raf(dir, 'add', 'A');
    const r = raf(dir, 'uses', 'L99', 'banc');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('lot inconnu : L99');
  });

  it('R5 — plan en lecture seule : refus, fichier intact', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat }\n  statuses: { todo: prevu, doing: en_cours, done: fini }\n');
    const file = join(dir, 'taches.yaml');
    writeFileSync(file, 'taches:\n- id: A1\n  titre: x\n  etat: prevu\n');
    const r = raf(dir, 'uses', 'A1', 'banc');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('plan en lecture seule');
    expect(readFileSync(file, 'utf8')).toBe('taches:\n- id: A1\n  titre: x\n  etat: prevu\n');
  });
});

describe('R6 — poser un nom non déclaré', () => {
  it('R6 — raf add --uses inconnu : lot créé, code 0', () => {
    const { dir } = project('resources: [banc]\n');
    expect(raf(dir, 'add', 'A', '--uses', 'inconnu')).toMatchObject({ code: 0, out: 'L1' });
    expect(yaml(dir)).toContain('uses: [inconnu]');
  });

  it('R6 — raf uses L1 inconnu : accepté', () => {
    const { dir } = project('resources: [banc]\n');
    raf(dir, 'add', 'A');
    expect(raf(dir, 'uses', 'L1', 'inconnu')).toMatchObject({ code: 0, out: '' });
    expect(yaml(dir)).toContain('uses: [inconnu]');
  });
});

describe('R7 — raf uses remplace ou retire', () => {
  it('R7 — raf uses L1 a b puis raf uses L1 c : uses: [c]', () => {
    const { dir } = project();
    raf(dir, 'add', 'A');
    raf(dir, 'uses', 'L1', 'a', 'b', 'a');
    expect(yaml(dir)).toContain('uses: [a, b]');
    raf(dir, 'uses', 'L1', 'c');
    expect(yaml(dir)).toContain('uses: [c]');
    expect(yaml(dir)).not.toContain('uses: [a');
  });

  it('R7 — raf uses L1 sans nom : clé retirée', () => {
    const { dir } = project();
    raf(dir, 'add', 'A', '--uses', 'banc');
    expect(raf(dir, 'uses', 'L1')).toMatchObject({ code: 0, out: '' });
    expect(yaml(dir)).not.toContain('uses');
  });

  it('R7 — les autres clés du lot sont intactes', () => {
    const { dir } = project();
    raf(dir, 'add', 'A', '--quickwin', '--estimate', '2');
    raf(dir, 'add', 'B', '--after', 'L1');
    raf(dir, 'start', 'L2');
    raf(dir, 'drop', 'L2');
    const without = yaml(dir);
    raf(dir, 'uses', 'L2', 'banc');
    const withUses = yaml(dir);
    expect(withUses.indexOf('after: [L1]')).toBeLessThan(withUses.indexOf('uses: [banc]'));
    expect(withUses.indexOf('uses: [banc]')).toBeLessThan(withUses.indexOf('created:', withUses.indexOf('uses:')));
    // retirer la clé rend exactement le plan d'avant : rien d'autre n'a bougé, le lot dropped s'est laissé modifier
    raf(dir, 'uses', 'L2');
    expect(yaml(dir)).toBe(without);
  });
});

describe('R8 — seuls les lots ouverts sont contrôlés', () => {
  it('R8 — lot done avec ressource non déclarée : pas d\'écart', () => {
    const { dir } = project('resources: []\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    const r = raf(dir, 'check');
    expect(r.out).not.toContain('banc');
  });

  it('R8 — lot doing avec ressource non déclarée : écart', () => {
    const { dir } = project('resources: []\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    raf(dir, 'start', 'L1');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('utilise la ressource « banc »');
  });
});

describe('R9 — sans uses:, raf check est celui d\'avant', () => {
  it('R9 — plan sans uses: et parent illisible : raf check inchangé', () => {
    const clean = project();
    const broken = project('resources: [banc\n  : :\n');
    for (const p of [clean, broken]) raf(p.dir, 'add', 'A');
    const a = raf(clean.dir, 'check');
    const b = raf(broken.dir, 'check');
    expect(b).toEqual(a);
    expect(b.code).toBe(0);
  });

  it('R9 — un lot terminé seul à porter uses: ne lit pas non plus le parent', () => {
    const { dir } = project('resources: [banc\n  : :\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    expect(raf(dir, 'check').code).toBe(0);
  });
});

describe('R10 — l\'écart de raf check', () => {
  it('R10 — uses: [banc] non déclaré : écart avec le lot, le nom et le fichier, code 1', () => {
    const { parent, dir } = project('resources: [autre]\n');
    raf(dir, 'add', 'A', '--uses', 'banc');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`✗ L1 utilise la ressource « banc », non déclarée dans ${join(parent, 'cadence.yaml')} (resources:)`);
  });

  it('R10 — deux noms dont un déclaré : un seul écart', () => {
    const { dir } = project('resources: [banc]\n');
    raf(dir, 'add', 'A', '--uses', 'banc,passerelle');
    const r = raf(dir, 'check');
    expect(r.out.split('\n').filter((l) => l.includes('utilise la ressource'))).toHaveLength(1);
    expect(r.out).toContain('« passerelle »');
  });

  it('R10 — tous déclarés : code 0', () => {
    const { dir } = project('resources: [banc, passerelle]\n');
    raf(dir, 'add', 'A', '--uses', 'banc,passerelle');
    const r = raf(dir, 'check');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('utilise la ressource');
  });
});

describe('R11 — documentation', () => {
  const root = join(import.meta.dirname, '..');
  const read = (f: string) => readFileSync(join(root, f), 'utf8');

  it('R11 — docs/raf.md cite uses, raf uses et resources:', () => {
    const doc = read('docs/raf.md');
    expect(doc).toContain('raf uses');
    expect(doc).toContain('--uses');
    expect(doc).toContain('`uses`');
    expect(doc).toContain('resources:');
    expect(doc).toContain('utilise la ressource');
  });

  it('R11 — docs/raf.md : --uses hors de la ligne --every, uses de raf show après spec', () => {
    const lines = read('docs/raf.md').split('\n');
    const every = lines.find((l) => l.startsWith('| `raf add "title" --every'))!;
    expect(every).not.toContain('--uses');
    const show = lines.find((l) => l.startsWith('| `raf show <id>'))!;
    expect(show.indexOf('public title')).toBeLessThan(show.indexOf('`uses : banc, passerelle`'));
  });

  it('R11 — le CHANGELOG cite L251', () => {
    const unreleased = read('CHANGELOG.md').split(/^## \[1\./m)[0]!;
    expect(unreleased).toContain('L251');
    expect(unreleased).toContain('uses');
  });

  it('R11 — raf aide liste raf uses', () => {
    const help = raf(tempDir(), 'help').out;
    expect(help).toContain('raf uses <lot> [<ressource>…]');
    expect(help).toContain('--uses');
  });
});
