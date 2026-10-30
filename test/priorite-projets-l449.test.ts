import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { leadTour } from '../src/lead.js';
import { tempDir } from './helpers.js';

/** Un dossier de projets : chacun porte un plan (de quoi être vu par `lead tour`), le cadence.yaml du dossier est écrit tel quel. */
function folder(names: string[], yaml?: string): string {
  const parent = tempDir();
  for (const n of names) {
    mkdirSync(join(parent, n, '.cadence'), { recursive: true });
    writeFileSync(join(parent, n, '.cadence', 'raf.yaml'), 'project: x\nlots: []\n');
  }
  if (yaml !== undefined) writeFileSync(join(parent, 'cadence.yaml'), yaml);
  return parent;
}

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-10-30' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-30T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const shown = (parent: string) => leadTour(parent, '2026-10-30').map((r) => r.project);
const yamlOf = (parent: string) => readFileSync(join(parent, 'cadence.yaml'), 'utf8');

describe('cadence lead priority — réordonner les projets (L449)', () => {
  it('R1 — place un projet avant un autre : la liste priority: est réécrite et l’ordre du tour suit', () => {
    const parent = folder(['alpha', 'beta', 'gamma'], 'priority: [alpha, beta, gamma]\n');
    const r = cadence(parent, 'lead', 'priority', 'gamma', '--before', 'alpha');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/gamma placé avant alpha/);
    expect(shown(parent)).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('R1 — place un projet après un autre', () => {
    const parent = folder(['alpha', 'beta', 'gamma'], 'priority:\n  - alpha\n  - beta\n  - gamma\n');
    expect(cadence(parent, 'lead', 'priority', 'alpha', '--after', 'beta').code).toBe(0);
    expect(shown(parent)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('R2 — les commentaires du fichier sont gardés, la liste en bloc reste en bloc et la liste en ligne en ligne', () => {
    const block = folder(['alpha', 'beta'], '# en-tête\ndepth: 1 # un niveau\n\n# l’ordre du tour\npriority:\n  - alpha # le premier\n  - beta\n\norchestrate:\n  test: npx vitest run # la suite\n');
    cadence(block, 'lead', 'priority', 'beta', '--before', 'alpha');
    const text = yamlOf(block);
    expect(text).toContain('# en-tête\ndepth: 1 # un niveau\n\n# l’ordre du tour\npriority:');
    expect(text).toContain('orchestrate:\n  test: npx vitest run # la suite\n');
    expect(text).toMatch(/priority:\n {2}- beta\n {2}- alpha/);
    // le commentaire de la ligne d'un nom suit ce nom quand il change de place
    expect(text).toMatch(/- beta\n {2}- alpha # le premier/);
    const flow = folder(['alpha', 'beta'], '# ordre\npriority: [alpha, beta] # inline\n');
    cadence(flow, 'lead', 'priority', 'beta', '--before', 'alpha');
    expect(yamlOf(flow)).toMatch(/^# ordre\npriority: \[ ?beta, alpha ?\]/);
  });

  it('R3 — sans cadence.yaml le fichier est créé ; sans clé priority: elle est ajoutée au bout, le reste intact ; tous les projets sont nommés', () => {
    const none = folder(['alpha', 'beta', 'gamma']);
    expect(cadence(none, 'lead', 'priority', 'gamma', '--before', 'alpha').code).toBe(0);
    expect(shown(none)).toEqual(['gamma', 'alpha', 'beta']);
    const without = folder(['alpha', 'beta'], '# réglages\ndepth: 1\n');
    cadence(without, 'lead', 'priority', 'beta', '--before', 'alpha');
    expect(yamlOf(without)).toMatch(/^# réglages\ndepth: 1\npriority:\n {2}- beta\n {2}- alpha\n$/);
  });

  it('R4 — un nom qui couvre un projet par préfixe (maritime → maritime-atlas) devient un nom explicite, l’ordre des autres est gardé ; un nom sans projet reste en fin de liste', () => {
    const parent = folder(['maritime-atlas', 'ol', 'zeta'], 'priority: [maritime, ol, absent]\n');
    expect(cadence(parent, 'lead', 'priority', 'zeta', '--before', 'maritime-atlas').code).toBe(0);
    expect(shown(parent)).toEqual(['zeta', 'maritime-atlas', 'ol']);
    expect(yamlOf(parent)).toMatch(/zeta[\s\S]*maritime-atlas[\s\S]*ol[\s\S]*absent/);
  });

  it('R5 — déjà à cette place : rien n’est écrit, la réponse le dit', () => {
    const text = 'priority: [alpha,   beta]   # tel quel\n';
    const parent = folder(['alpha', 'beta'], text);
    const r = cadence(parent, 'lead', 'priority', 'alpha', '--before', 'beta');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/déjà/);
    expect(yamlOf(parent)).toBe(text);
  });

  it('R6 — un cadence.yaml illisible est refusé avec sa raison et reste intact', () => {
    const bad = 'priority: [alpha, beta\n  depth: : 2\n';
    const parent = folder(['alpha', 'beta'], bad);
    const r = cadence(parent, 'lead', 'priority', 'beta', '--before', 'alpha');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/illisible/);
    expect(yamlOf(parent)).toBe(bad);
  });

  it('R6 — une clé priority: qui n’est pas une liste de noms est refusée, fichier intact', () => {
    const bad = 'priority: alpha\n';
    const parent = folder(['alpha', 'beta'], bad);
    const r = cadence(parent, 'lead', 'priority', 'beta', '--before', 'alpha');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/priority doit être une liste/);
    expect(yamlOf(parent)).toBe(bad);
  });

  it('R7 — projet ou cible inconnus, le même des deux côtés, ni --before ni --after, les deux : refus sans écrire', () => {
    const text = 'priority: [alpha, beta]\n';
    const parent = folder(['alpha', 'beta'], text);
    expect(cadence(parent, 'lead', 'priority', 'nope', '--before', 'alpha').err).toMatch(/projet inconnu : nope/);
    expect(cadence(parent, 'lead', 'priority', 'alpha', '--before', 'nope').err).toMatch(/projet inconnu : nope/);
    expect(cadence(parent, 'lead', 'priority', 'alpha', '--before', 'alpha').err).toMatch(/même projet/);
    expect(cadence(parent, 'lead', 'priority', 'alpha').err).toMatch(/usage/);
    expect(cadence(parent, 'lead', 'priority', 'alpha', '--before', 'beta', '--after', 'beta').err).toMatch(/usage/);
    expect(yamlOf(parent)).toBe(text);
  });

  it('R7 — un dossier introuvable est refusé', () => {
    const r = cadence(tempDir(), 'lead', 'priority', 'a', '--before', 'b', join(tempDir(), 'absent'));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/introuvable/);
  });

  it('R8 — le dossier peut être donné en dernier argument', () => {
    const parent = folder(['alpha', 'beta']);
    expect(cadence(tempDir(), 'lead', 'priority', 'beta', '--before', 'alpha', parent).code).toBe(0);
    expect(shown(parent)).toEqual(['beta', 'alpha']);
  });
});

describe('cadence lead priority — noms en préfixe et profondeur (L449)', () => {
  it('R4 — un projet dont le nom commence un autre (shop, shop-web) ne peut pas en être séparé : refus qui dit pourquoi, fichier intact, rien de faux annoncé', () => {
    const yaml = 'priority: [shop, shop-web, x]\n';
    const parent = folder(['shop', 'shop-web', 'x'], yaml);
    const r = cadence(parent, 'lead', 'priority', 'shop-web', '--after', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/shop-web ne peut pas être placé après x.*shop/);
    expect(r.out).not.toMatch(/placé/);
    expect(yamlOf(parent)).toBe(yaml);
    expect(shown(parent)).toEqual(['shop', 'shop-web', 'x']);
  });

  it('R4 — le même cas sans préfixe en jeu reste possible : x peut passer devant shop-web', () => {
    const parent = folder(['shop', 'shop-web', 'x'], 'priority: [shop, shop-web, x]\n');
    expect(cadence(parent, 'lead', 'priority', 'x', '--before', 'shop').code).toBe(0);
    expect(shown(parent)).toEqual(['x', 'shop', 'shop-web']);
  });

  it('R8 — deux projets de même nom de dossier (--depth 2) : refus, fichier intact', () => {
    const parent = tempDir();
    for (const d of ['g/p', 'h/p', 'z']) {
      mkdirSync(join(parent, d, '.cadence'), { recursive: true });
      writeFileSync(join(parent, d, '.cadence', 'raf.yaml'), 'project: x\nlots: []\n');
    }
    const r = cadence(parent, 'lead', 'priority', 'z', '--before', 'g/p', '--depth', '2');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/deux projets s'appellent p/);
  });

  it('R8 — projets imbriqués (--depth 2) : nommés groupe/projet, écrits par leur dossier dans priority:', () => {
    const parent = tempDir();
    for (const d of ['g/x', 'h/y', 'z']) {
      mkdirSync(join(parent, d, '.cadence'), { recursive: true });
      writeFileSync(join(parent, d, '.cadence', 'raf.yaml'), 'project: x\nlots: []\n');
    }
    writeFileSync(join(parent, 'cadence.yaml'), 'priority: [x, y, z]\n');
    const r = cadence(parent, 'lead', 'priority', 'h/y', '--before', 'g/x', '--depth', '2');
    expect(r.code).toBe(0);
    expect(yamlOf(parent)).toMatch(/priority: \[\s*y, x, z\s*\]/);
  });

  it('R8 — --depth invalide (0, abc) est refusé', () => {
    const parent = folder(['alpha', 'beta']);
    for (const d of ['0', 'abc']) {
      const r = cadence(parent, 'lead', 'priority', 'alpha', '--before', 'beta', '--depth', d);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/--depth invalide/);
    }
  });
});
