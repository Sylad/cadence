import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { commit, gitRepo, tempDir, NO_BACKGROUND_GIT } from './helpers.js';

// L465 — plan.idPattern : identifiants libres et sous-lots à plat dans un plan natif (M3).
const PLAN = '.cadence/raf.yaml';
const PATTERN = '[A-Z]{1,3}-?\\d+(?:\\.\\d+)*';
const CONFIG = `plan:\n  idPattern: '${PATTERN}'\n`;

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function project(yaml = CONFIG) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  cadence(dir, 'init', '--project', 'demo', '--no-hook');
  execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const plan = (dir: string) => readFileSync(join(dir, PLAN), 'utf8');
const planOf = (dir: string) => Plan.load(join(dir, PLAN), readPlanConfig(join(dir, 'cadence.yaml'))!.settings);

describe('R1 — plan.idPattern se lit et se valide', () => {
  const read = (yaml: string) => () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    return readPlanConfig(join(dir, 'cadence.yaml'));
  };
  it('R1 — le motif valide est lu tel quel', () => {
    expect(read(CONFIG)()?.settings.idPattern).toBe(PATTERN);
  });
  it('R1 — motif illisible, vide, non textuel, ancré ou qui accepte le vide : refusé en nommant plan.idPattern', () => {
    expect(read("plan:\n  idPattern: '[A-Z'\n")).toThrow(/plan\.idPattern/);
    expect(read("plan:\n  idPattern: ''\n")).toThrow(/plan\.idPattern/);
    expect(read('plan:\n  idPattern: 12\n')).toThrow(/plan\.idPattern/);
    expect(read("plan:\n  idPattern: '^X\\d+$'\n")).toThrow(/plan\.idPattern.*ancre/);
    expect(read("plan:\n  idPattern: 'X*'\n")).toThrow(/plan\.idPattern.*vide/);
  });
  it('R1 — un groupe nommé « id » ou « sub » du motif est refusé (il casserait la reconnaissance)', () => {
    expect(read("plan:\n  idPattern: '(?<id>X\\d+)'\n")).toThrow(/plan\.idPattern/);
  });
});

describe('R2 — la reconnaissance des ids dans un message suit plan.idPattern', () => {
  const refs = (text: string, yaml = CONFIG) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), yaml);
    writeFileSync(join(dir, 'raf.yaml'), 'version: 1\nprefix: L\nlots: []\n');
    return Plan.load(join(dir, 'raf.yaml'), (readPlanConfig(join(dir, 'cadence.yaml'))?.settings ?? {})).refs(text);
  };
  it('R2 — ids libres, point et chiffres inclus (AB-1.2, X3.4), et le préfixe L reste reconnu', () => {
    expect(refs('feat(AB-1.2): x, voir X3.4 et L7')).toEqual([{ lot: 'AB-1.2' }, { lot: 'X3.4' }, { lot: 'L7' }]);
  });
  it('R2 — sous-id LOT/slug : le lot est cité, jamais un faux lot ; LOT/t1 reste une sous-tâche', () => {
    expect(refs('fix(X7/t1-fusion): y')).toEqual([{ lot: 'X7' }]);
    expect(refs('fix(X7/t2): y')).toEqual([{ lot: 'X7', task: 't2' }]);
  });
  it('R2 — un id n\'est pas lu au milieu d\'un mot, d\'un chemin ou d\'un nombre à point : « UX3.4x », « a/X3 », « abcX3 » ne citent rien', () => {
    expect(refs('UX3.4x a/X3 abcX3 X3.x')).toEqual([]);
  });
  it('R2 — le point qui finit une phrase passe : « voir X3. »', () => {
    expect(refs('voir X3.')).toEqual([{ lot: 'X3' }]);
  });
  it('R2 — sans plan.idPattern, le comportement d\'avant est inchangé (seul <préfixe>\\d+)', () => {
    expect(refs('AB-1.2 X3 L7', '')).toEqual([{ lot: 'L7' }]);
  });
});

describe('R3 — raf add --id pose un identifiant libre', () => {
  it('R3 — l\'id donné est écrit tel quel, imprimé, et le lot garde dates, estimation et notes', () => {
    const dir = project();
    const ok = cadence(dir, 'add', 'Un lot libre', '--id', 'AB-1.2', '--estimate', '2');
    expect(ok.out).toBe('AB-1.2');
    cadence(dir, 'note', 'AB-1.2', 'une note');
    const lot = planOf(dir).lot('AB-1.2');
    expect(lot).toMatchObject({ id: 'AB-1.2', status: 'todo', estimate: 2, created: '2026-11-02' });
    expect(lot.notes.map((n) => n.text)).toEqual(['une note']);
  });
  it('R3 — un id qui ne suit pas le motif est refusé en le disant, le plan ne change pas', () => {
    const dir = project();
    const before = plan(dir);
    const r = cadence(dir, 'add', 'x', '--id', 'E-GL5.1');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/ne suit pas plan\.idPattern/);
    expect(plan(dir)).toBe(before);
  });
  it('R3 — id déjà pris (même archivé) : refusé, le plan ne change pas', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'X3');
    const before = plan(dir);
    const r = cadence(dir, 'add', 'b', '--id', 'X3');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/identifiant déjà pris/);
    expect(plan(dir)).toBe(before);
  });
  it('R3 — sans plan.idPattern, --id est refusé en le disant ; un id avec « / » est refusé', () => {
    const dir = project('');
    expect(cadence(dir, 'add', 'a', '--id', 'X3').err).toMatch(/plan\.idPattern/);
    const libre = project();
    expect(cadence(libre, 'add', 'a', '--id', 'X3/t1').err).toMatch(/ne suit pas plan\.idPattern|sous-tâche/);
    expect(cadence(libre, 'add', 'a', '--id', '').err).toMatch(/ne suit pas plan\.idPattern/);
  });
  it('R3 — sans --id, l\'id généré reste <préfixe><n+1> même quand le plan porte des ids libres', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'X30');
    expect(cadence(dir, 'add', 'b').out).toBe('L1');
  });
  it('R3 — --id avec --parent (sous-tâche) est refusé : une sous-tâche n\'a pas d\'id libre', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'X3');
    expect(cadence(dir, 'add', 'tâche', '--parent', 'X3', '--id', 'X4').err).toMatch(/--id/);
  });
});

describe('R4 — sous-lot à plat : parent: hors préfixe', () => {
  it('R4 — raf add --under pose parent:, lu par le plan natif ; dates et notes propres', () => {
    const dir = project();
    cadence(dir, 'add', 'Père', '--id', 'AB-1');
    expect(cadence(dir, 'add', 'Fils', '--id', 'AB-1.2', '--under', 'AB-1').out).toBe('AB-1.2');
    expect(plan(dir)).toMatch(/parent: AB-1\b/);
    const lots = planOf(dir).lots();
    expect(lots.find((l) => l.id === 'AB-1.2')).toMatchObject({ parent: 'AB-1', created: '2026-11-02' });
    expect(lots.find((l) => l.id === 'AB-1')?.parent).toBeUndefined();
  });
  it('R4 — parent inconnu, parent = soi-même, --under sur une sous-tâche : refusés, plan inchangé', () => {
    const dir = project();
    cadence(dir, 'add', 'Père', '--id', 'AB-1');
    const before = plan(dir);
    expect(cadence(dir, 'add', 'x', '--id', 'AB-2', '--under', 'ZZ-9').err).toMatch(/lot parent inconnu/);
    expect(cadence(dir, 'add', 'x', '--id', 'AB-2', '--under', 'AB-2').err).toMatch(/lot parent inconnu|lui-même/);
    expect(cadence(dir, 'add', 'x', '--under', 'AB-1', '--parent', 'AB-1').err).toMatch(/--under/);
    expect(plan(dir)).toBe(before);
  });
  it('R4 — un parent: écrit à la main qui n\'est pas un texte est ignoré et signalé dans les problèmes du lot', () => {
    const dir = project();
    cadence(dir, 'add', 'Père', '--id', 'AB-1');
    writeFileSync(join(dir, PLAN), plan(dir).replace(/^(\s*)- id: AB-1\n/m, '$&$1  parent: [1, 2]\n'));
    const lot = planOf(dir).lot('AB-1');
    expect(lot.parent).toBeUndefined();
    expect(lot.problems.join(' ')).toMatch(/parent/);
  });
  it('R4 — un lot parent « doing » compte le travail de son sous-lot à id libre (raf check, idle)', () => {
    const dir = project();
    cadence(dir, 'add', 'Père', '--id', 'AB-1');
    cadence(dir, 'add', 'Fils', '--id', 'AB-1.2', '--under', 'AB-1');
    cadence(dir, 'start', 'AB-1');
    cadence(dir, 'start', 'AB-1.2');
    cadence(dir, 'add', 'Autre père', '--id', 'AB-3');
    cadence(dir, 'add', 'Pas un fils', '--id', 'AB-3.1');
    cadence(dir, 'start', 'AB-3');
    cadence(dir, 'start', 'AB-3.1');
    writeFileSync(join(dir, PLAN), plan(dir).replaceAll('started: 2026-11-02', 'started: 2026-10-01'));
    execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
    execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'plan'], { cwd: dir });
    commit(dir, 'feat(AB-1.2): travail', '2026-11-02T08:00:00');
    commit(dir, 'feat(AB-3.1): travail', '2026-11-02T08:01:00');
    const out = cadence(dir, 'check').out;
    expect(out).not.toMatch(/AB-1 en cours sans commit/);
    // Le même travail sur un lot qui n'est pas déclaré sous-lot (pas de parent:) ne compte pas pour AB-3.
    expect(out).toMatch(/AB-3 en cours sans commit depuis \d+ j/);
  });
});

describe('R5 — le lien commits ↔ lots suit plan.idPattern, sur le vrai chemin', () => {
  it('R5 — raf commits voit le travail d\'un lot à id libre, y compris cité en sous-id LOT/slug', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'X7');
    cadence(dir, 'start', 'X7');
    execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
    execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'plan: X7 démarré'], { cwd: dir });
    commit(dir, 'feat(X7): un', '2026-11-02T10:00:00');
    commit(dir, 'fix(X7/t1-fusion): deux', '2026-11-02T10:01:00');
    commit(dir, 'chore: sans rapport avec UX7', '2026-11-02T10:02:00');
    const out = cadence(dir, 'commits', 'X7').out;
    expect(out).toMatch(/feat\(X7\): un/);
    expect(out).toMatch(/fix\(X7\/t1-fusion\): deux/);
    expect(out).not.toMatch(/UX7/);
  });
});

describe('R6 — raf estimate <id> <jours> change l\'estimation d\'un lot existant', () => {
  it('R6 — l\'estimation est remplacée, les autres champs gardés', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1', '--estimate', '1');
    expect(cadence(dir, 'estimate', 'AB-1', '2.5').code).toBe(0);
    expect(planOf(dir).lot('AB-1')).toMatchObject({ estimate: 2.5, title: 'a', created: '2026-11-02' });
  });
  it('R6 — valeur absente, nulle, négative, non numérique, lot inconnu, sous-tâche : refusés, plan inchangé', () => {
    const dir = project();
    cadence(dir, 'add', 'a', '--id', 'AB-1');
    cadence(dir, 'add', 't', '--parent', 'AB-1');
    const before = plan(dir);
    for (const args of [['AB-1'], ['AB-1', '0'], ['AB-1', '-2'], ['AB-1', 'beaucoup'], ['AB-1', '1', '2'], ['ZZ-9', '2'], ['AB-1/t1', '2']]) {
      const r = cadence(dir, 'estimate', ...args);
      expect(r.code, args.join(' ')).not.toBe(0);
    }
    expect(plan(dir)).toBe(before);
  });
});
