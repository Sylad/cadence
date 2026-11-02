import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { gitRepo, tempDir, NO_BACKGROUND_GIT } from './helpers.js';

// Sonde L465 — bords de plan.idPattern, raf add --id/--under, raf estimate.
const CONFIG = (p: string) => `plan:\n  idPattern: '${p}'\n`;
const DEFAULT = '[A-Z]{1,3}-?\\d+(?:\\.\\d+)*';

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function project(pattern = DEFAULT) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG(pattern));
  cadence(dir, 'init', '--project', 'demo', '--no-hook');
  execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const planText = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');
const refs = (text: string, pattern = DEFAULT) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG(pattern));
  writeFileSync(join(dir, 'raf.yaml'), 'version: 1\nprefix: L\nlots: []\n');
  return Plan.load(join(dir, 'raf.yaml'), readPlanConfig(join(dir, 'cadence.yaml'))!.settings).refs(text);
};

describe('motif avec rétro-référence numérotée', () => {
  it('un motif ([A-Z])\\1\\d+ : AA1 est cité, AB1 ne l\'est pas (cohérent avec le contrôle de raf add --id)', () => {
    const p = '([A-Z])\\1\\d+';
    expect(refs('voir AA1', p)).toEqual([{ lot: 'AA1' }]);
    expect(refs('voir AB1', p)).toEqual([]);
  });
});

describe('ids libres : bords des références', () => {
  it('message vide : aucune référence', () => {
    expect(refs('')).toEqual([]);
  });
  it('une même référence deux fois est rendue deux fois, sans fusion silencieuse ni plantage', () => {
    expect(refs('AB-1 AB-1')).toEqual([{ lot: 'AB-1' }, { lot: 'AB-1' }]);
  });
  it('AB-1.2/t1 est la sous-tâche t1 du lot AB-1.2', () => {
    expect(refs('fix(AB-1.2/t1): z')).toEqual([{ lot: 'AB-1.2', task: 't1' }]);
  });
  it('un id suivi d\'un tiret et d\'un mot n\'est pas cité (AB-1-suite)', () => {
    expect(refs('AB-1-suite')).toEqual([]);
  });
  it('un id entre parenthèses, virgules et deux-points est cité', () => {
    expect(refs('(AB-1), X3: x;L2')).toEqual([{ lot: 'AB-1' }, { lot: 'X3' }, { lot: 'L2' }]);
  });
  it('un motif à alternance de premier niveau n\'avale pas le sous-id', () => {
    expect(refs('Q9/t1 et ZED', 'Q\\d+|ZED')).toEqual([{ lot: 'Q9', task: 't1' }, { lot: 'ZED' }]);
  });
});

describe('raf add --id / --under : bords', () => {
  it('--id doublon : refusé, plan inchangé', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    const before = planText(dir);
    const r = cadence(dir, 'add', 'b', '--id', 'AB-1');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/déjà pris/);
    expect(planText(dir)).toBe(before);
  });
  it('--id avec espaces ou retour à la ligne : refusé', () => {
    const dir = project();
    expect(cadence(dir, 'add', 'a', '--id', ' AB-1').code).not.toBe(0);
    expect(cadence(dir, 'add', 'a', '--id', 'AB-1\n').code).not.toBe(0);
  });
  it('--under inconnu : « lot parent inconnu », plan inchangé', () => {
    const dir = project();
    const before = planText(dir);
    const r = cadence(dir, 'add', 'a', '--id', 'AB-2', '--under', 'AB-1');
    expect(r.err).toMatch(/lot parent inconnu : AB-1/);
    expect(planText(dir)).toBe(before);
  });
  it('--under vide : refusé', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    expect(cadence(dir, 'add', 'b', '--id', 'AB-2', '--under', '').code).not.toBe(0);
  });
  it('--under vers une sous-tâche (AB-1/t1) : refusé', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    cadence(dir, 'add', 't', '--parent', 'AB-1');
    expect(cadence(dir, 'add', 'b', '--id', 'AB-2', '--under', 'AB-1/t1').code).not.toBe(0);
  });
  it('--under sans --id : id généré L<n>, parent écrit, lot relu', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    const r = cadence(dir, 'add', 'b', '--under', 'AB-1');
    expect(r.out).toBe('L1');
    const p = Plan.load(join(dir, '.cadence/raf.yaml'), readPlanConfig(join(dir, 'cadence.yaml'))!.settings);
    expect(p.lot('L1')?.parent).toBe('AB-1');
  });
  it('--id L7 (le préfixe) puis un ajout sans --id : L8, pas de doublon', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'L7');
    expect(cadence(dir, 'add', 'b').out).toBe('L8');
  });
  it('--id avec --parent : refusé en le disant, rien d\'écrit', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    const before = planText(dir);
    expect(cadence(dir, 'add', 'b', '--id', 'AB-2', '--parent', 'AB-1').code).not.toBe(0);
    expect(planText(dir)).toBe(before);
  });
  it('sous-tâche d\'un lot à id pointé : AB-1.2/t1 créée et lisible', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1.2');
    expect(cadence(dir, 'add', 't', '--parent', 'AB-1.2').out).toBe('AB-1.2/t1');
  });
  it('--id sur un lot déjà archivé : refusé (un id n\'est jamais réutilisé)', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    cadence(dir, 'done', 'AB-1');
    const r = cadence(dir, 'archive', '--all');
    const again = cadence(dir, 'add', 'b', '--id', 'AB-1');
    expect(again.code, r.err + again.err).not.toBe(0);
  });
});

describe('raf estimate : bords', () => {
  it('Infinity, NaN, 1e400, vide : refusés', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    for (const v of ['Infinity', 'NaN', '1e400', '', '  ']) expect(cadence(dir, 'estimate', 'AB-1', v).code, v).not.toBe(0);
  });
  it('lot déjà terminé : estimation remplacée', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    cadence(dir, 'done', 'AB-1');
    expect(cadence(dir, 'estimate', 'AB-1', '3').code).toBe(0);
  });
  it('deux fois la même valeur : idempotent, plan identique', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    cadence(dir, 'estimate', 'AB-1', '3');
    const once = planText(dir);
    cadence(dir, 'estimate', 'AB-1', '3');
    expect(planText(dir)).toBe(once);
  });
  it('hexadécimal 0x10 : refusé (pas une durée en jours écrite)', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    expect(cadence(dir, 'estimate', 'AB-1', '0x10').code).not.toBe(0);
  });
});

describe('parent: écrit à la main', () => {
  it('parent non textuel (liste) : lot lu, problème signalé, pas de parent', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    writeFileSync(join(dir, '.cadence/raf.yaml'), planText(dir).replace('title: a', 'title: a\n    parent: [x, y]'));
    const p = Plan.load(join(dir, '.cadence/raf.yaml'), readPlanConfig(join(dir, 'cadence.yaml'))!.settings);
    expect(p.lot('AB-1')?.parent).toBeUndefined();
  });
});
