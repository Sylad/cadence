import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readOrchestrateConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { gitRepo, tempDir } from './helpers.js';
import { docText } from './docs-text.js';

const T = '2026-10-10';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: T }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${T}T09:30:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('champ screen des lots (L169, spec etape-spec S1)', () => {
  it('Plan.add écrit screen juste après visible, et le relit', () => {
    const p = Plan.create(join(tempDir(), '.cadence/raf.yaml'), 'demo');
    p.add('Page match', T, { visible: true, screen: 'page' });
    p.save();
    expect(readFileSync(p.path, 'utf8')).toMatch(/visible: true\n\s+screen: page\n/);
    expect(Plan.load(p.path).lot('L1')).toMatchObject({ visible: true, screen: 'page', problems: [] });
  });

  it('Plan.add refuse un screen inconnu et un screen sans visible', () => {
    const p = Plan.create(join(tempDir(), '.cadence/raf.yaml'), 'demo');
    expect(() => p.add('A', T, { visible: true, screen: 'ecran' as never })).toThrow(/page, component, journey/);
    expect(() => p.add('A', T, { screen: 'page' })).toThrow(/screen.*visible/);
  });

  it('raf add --screen pose le champ ; sans --visible il est refusé et rien n\'est écrit', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    expect(raf(dir, 'add', 'Page', '--visible', '--screen', 'journey').out).toBe('L1');
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toContain('screen: journey');
    const r = raf(dir, 'add', 'Autre', '--screen', 'page');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--screen.*--visible/);
    expect(raf(dir, 'add', 'Autre', '--visible', '--screen', 'nope').code).not.toBe(0);
    expect(raf(dir, 'list').out).not.toContain('Autre');
  });

  it('raf show affiche le screen du lot, rien sans lui', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'Avec', '--visible', '--screen', 'component');
    raf(dir, 'add', 'Sans', '--visible');
    expect(raf(dir, 'show', 'L1').out).toContain('screen : component');
    expect(raf(dir, 'show', 'L2').out).not.toContain('screen');
  });

  it('raf check : screen sans visible, ou de valeur inconnue, est une erreur', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--visible', '--public', 'Une page');
    const file = join(dir, '.cadence/raf.yaml');
    const base = readFileSync(file, 'utf8');
    writeFileSync(file, base.replace('visible: true', 'visible: true\n    screen: page'));
    expect(raf(dir, 'check').out).not.toMatch(/L1 : screen/);
    writeFileSync(file, base.replace('    visible: true\n', '    screen: page\n'));
    const r1 = raf(dir, 'check');
    expect(r1.code).toBe(1);
    expect(r1.out).toMatch(/✗ L1 : screen « page » sans visible/);
    writeFileSync(file, base.replace('visible: true', 'visible: true\n    screen: ecran'));
    const r2 = raf(dir, 'check');
    expect(r2.code).toBe(1);
    expect(r2.out).toMatch(/✗ L1 : screen « ecran » inconnu \(page, component, journey\)/);
  });
});

describe('screen dans un plan externe et sur une sous-tâche (L169)', () => {
  it('plan.fields.screen est lu ; show l\'affiche, check refuse les écrans invalides', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, visible: vis, screen: ecran }\n  statuses: { todo: prevu }\n');
    writeFileSync(join(dir, 'taches.yaml'), `taches:
  - { id: X1, titre: Ok, etat: prevu, vis: true, ecran: page }
  - { id: X2, titre: Sans, etat: prevu, ecran: component }
  - { id: X3, titre: Inconnu, etat: prevu, vis: true, ecran: modal }
`);
    expect(raf(dir, 'show', 'X1').out).toContain('screen : page');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/X2 : screen « component » sans visible/);
    expect(r.out).toMatch(/X3 : screen « modal » inconnu/);
    expect(r.out).not.toMatch(/X1 : screen/);
  });

  it('raf add --screen --parent est refusé et n\'écrit rien', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'Lot', '--visible');
    const before = readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
    const r = raf(dir, 'add', 'sub', '--parent', 'L1', '--screen', 'page');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/pas sur une sous-tâche/);
    expect(readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8')).toBe(before);
  });
});

describe('orchestrate.spec (L169, spec etape-spec S1)', () => {
  const read = (yaml: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    return readOrchestrateConfig(join(dir, 'cadence.yaml'));
  };
  it('défaut : docs/specs, pas de commande de rendu', () => {
    expect(read('orchestrate: {}\n').spec).toEqual({ dir: 'docs/specs' });
    expect(readOrchestrateConfig(join(tempDir(), 'absent.yaml')).spec).toEqual({ dir: 'docs/specs' });
  });
  it('lit dir et render', () => {
    expect(read('orchestrate:\n  spec: { dir: docs/ecrans/, render: npx playwright test }\n').spec).toEqual({ dir: 'docs/ecrans', render: 'npx playwright test' });
  });
  it('refuse une clé inconnue, un dir absolu ou sortant, un render vide', () => {
    expect(read('orchestrate:\n  spec: { dir: ./docs/./specs/ }\n').spec.dir).toBe('docs/specs');
    expect(() => read('orchestrate:\n  spec: { dossier: x }\n')).toThrow(/spec\.dossier inconnu \(attendu : dir, render\)/);
    expect(() => read('orchestrate:\n  spec: { dir: /tmp/x }\n')).toThrow(/spec\.dir : chemin relatif/);
    expect(() => read('orchestrate:\n  spec: { dir: ../x }\n')).toThrow(/spec\.dir : chemin relatif/);
    expect(() => read('orchestrate:\n  spec: { dir: "" }\n')).toThrow(/spec\.dir/);
    expect(() => read('orchestrate:\n  spec: { render: " " }\n')).toThrow(/spec\.render : commande non vide/);
    expect(() => read('orchestrate:\n  spec: docs/specs\n')).toThrow(/spec doit être un objet/);
  });
});

describe('README (L169)', () => {
  const readme = docText();
  it('documente --screen et orchestrate.spec', () => {
    expect(readme).toMatch(/\[--visible \[--screen page\\\|component\\\|journey\]\]/);
    expect(readme).toMatch(/^\s+spec: \{ dir: docs\/specs/m);
  });
  it('liste screen parmi les champs mappables d\'un plan externe', () => {
    expect(readme).toMatch(/- Fields: [^\n]*\n?[^\n]*`visible`, `screen`, `spec`, `public`/);
  });
});

describe('orchestrate.accept (L173, spec etape-spec S5)', () => {
  const read = (yaml: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    return readOrchestrateConfig(join(dir, 'cadence.yaml'));
  };
  it('défaut : pas de commande dédiée, effort medium', () => {
    expect(read('orchestrate: {}\n').accept).toBeUndefined();
    expect(read('orchestrate: {}\n').effort.accept).toBe('medium');
  });
  it('lit la commande dédiée et l’effort de l’étape', () => {
    const c = read('orchestrate:\n  accept: npx vitest run -c vitest.acceptation.config.ts\n  effort: { accept: high }\n');
    expect(c.accept).toBe('npx vitest run -c vitest.acceptation.config.ts');
    expect(c.effort.accept).toBe('high');
  });
  it('refuse une commande vide', () => {
    expect(() => read('orchestrate:\n  accept: " "\n')).toThrow(/accept : commande non vide/);
  });
});
