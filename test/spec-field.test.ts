import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { Plan } from '../src/plan.js';
import { gitRepo, tempDir } from './helpers.js';

const T = '2026-10-11';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: T }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(`${T}T09:30:00`) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const yaml = (dir: string) => readFileSync(join(dir, 'docs/plan/raf.yaml'), 'utf8');

describe('champ spec des lots (L186, spec etape-spec-back B1)', () => {
  it('Plan.add --spec écrit spec: true et le relit ; sans option, aucune clé', () => {
    const p = Plan.create(join(tempDir(), 'docs/plan/raf.yaml'), 'demo');
    p.add('Avec', T, { spec: true });
    p.add('Sans', T);
    p.save();
    const text = readFileSync(p.path, 'utf8');
    expect(text.match(/spec: true/g)).toHaveLength(1);
    expect(Plan.load(p.path).lot('L1')).toMatchObject({ spec: true, problems: [] });
    expect(Plan.load(p.path).lot('L2').spec).toBeUndefined();
  });

  it('raf add --spec pose la clé ; raf show l\'affiche ; refusé sur une sous-tâche', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    expect(raf(dir, 'add', 'A', '--spec').code).toBe(0);
    expect(yaml(dir)).toContain('spec: true');
    expect(raf(dir, 'show', 'L1').out).toContain('spec : true');
    const before = yaml(dir);
    const r = raf(dir, 'add', 'sub', '--parent', 'L1', '--spec');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/pas sur une sous-tâche/);
    expect(yaml(dir)).toBe(before);
  });

  it('raf spec on|off pose puis retire la clé, et on répété ne la duplique pas', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--visible');
    expect(raf(dir, 'spec', 'L1', 'on').code).toBe(0);
    expect(yaml(dir)).toMatch(/visible: true\n\s+spec: true\n/);
    expect(raf(dir, 'spec', 'L1', 'on').code).toBe(0);
    expect(yaml(dir).match(/spec: true/g)).toHaveLength(1);
    expect(raf(dir, 'spec', 'L1', 'off').code).toBe(0);
    expect(yaml(dir)).not.toContain('spec:');
    expect(yaml(dir)).toContain('visible: true');
    expect(raf(dir, 'spec', 'L1', 'off').code).toBe(0);
  });

  it('raf spec refuse une valeur inconnue, une sous-tâche, un lot inconnu, un usage incomplet', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A');
    raf(dir, 'add', 'T', '--parent', 'L1');
    const before = yaml(dir);
    expect(raf(dir, 'spec', 'L1', 'oui').code).not.toBe(0);
    expect(raf(dir, 'spec', 'L1/T1', 'on').code).not.toBe(0);
    expect(raf(dir, 'spec', 'L9', 'on').code).not.toBe(0);
    expect(raf(dir, 'spec', 'L1').code).not.toBe(0);
    expect(raf(dir, 'spec', 'L1', 'on', 'off').code).not.toBe(0);
    expect(yaml(dir)).toBe(before);
  });

  it('l\'écran implique la spec : off refusé avec screen:, on dit que c\'est déjà le cas', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--visible', '--screen', 'page');
    const before = yaml(dir);
    const off = raf(dir, 'spec', 'L1', 'off');
    expect(off.code).not.toBe(0);
    expect(off.err).toContain('retirer d\'abord screen:');
    const on = raf(dir, 'spec', 'L1', 'on');
    expect(on.code).toBe(0);
    expect(on.out).toContain('déjà');
    expect(yaml(dir)).toBe(before);
  });

  it('raf check : spec qui n\'est ni true ni false est une erreur ; false et true passent ; spec avec screen accepté', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    raf(dir, 'add', 'A', '--visible', '--screen', 'page');
    const file = join(dir, 'docs/plan/raf.yaml');
    const base = yaml(dir);
    writeFileSync(file, base.replace('screen: page', 'screen: page\n    spec: true'));
    expect(raf(dir, 'check').out).not.toMatch(/L1 : spec/);
    writeFileSync(file, base.replace('screen: page', 'screen: page\n    spec: false'));
    expect(raf(dir, 'check').out).not.toMatch(/L1 : spec/);
    for (const bad of ['oui', '"true"', '1']) {
      writeFileSync(file, base.replace('screen: page', `screen: page\n    spec: ${bad}`));
      const r = raf(dir, 'check');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/✗ L1 : spec : true ou false attendu/);
    }
  });

  it('plan externe : plan.fields.spec est lu, show l\'affiche, check refuse un non-booléen', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  path: taches.yaml\n  lots: taches\n  fields: { title: titre, status: etat, spec: fiche }\n  statuses: { todo: prevu }\n');
    writeFileSync(join(dir, 'taches.yaml'), `taches:
  - { id: X1, titre: Ok, etat: prevu, fiche: true }
  - { id: X2, titre: Mauvais, etat: prevu, fiche: peut-etre }
`);
    expect(raf(dir, 'show', 'X1').out).toContain('spec : true');
    const r = raf(dir, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/X2 : spec : true ou false attendu/);
    expect(r.out).not.toMatch(/X1 : spec/);
  });

  it('raf spec sans argument ou à un argument cite aussi cadence spec check|qa, code 2', () => {
    const dir = gitRepo();
    raf(dir, 'init', '--project', 'demo');
    for (const argv of [['spec'], ['spec', 'fiche.yaml']]) {
      const r = raf(dir, ...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toContain('cadence spec check|qa');
    }
  });
});
