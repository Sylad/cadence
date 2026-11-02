import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { gitRepo } from './helpers.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:30:00') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const PLAN_YAML = `plan:
  states: { a_faire: todo, en_cours: doing, bloque: doing, termine: done, livre: done, abandonne: dropped }
  transitions:
    a_faire: [en_cours, bloque, abandonne]
    en_cours: [bloque, termine, abandonne]
    bloque: [en_cours, abandonne]
    termine: [livre]
  doneState: termine
  blockedState: bloque
`;

const yaml = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');

function projet(config = PLAN_YAML) {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo');
  writeFileSync(join(dir, 'cadence.yaml'), config);
  raf(dir, 'add', 'Premier lot');
  return dir;
}

describe('bords de raf status — arguments', () => {
  it('raf status --back sans id — argument absent — attendu : erreur d\'usage, pas la liste des états', () => {
    const dir = projet();
    const r = raf(dir, 'status', '--back');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/usage : raf status/);
  });

  it('message blanc — message d\'espaces — attendu : aucune note écrite', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', 'bloque', '   ').code).toBe(0);
    expect(yaml(dir)).not.toContain('état bloque');
  });

  it('deux fois bloque — même appel répété — attendu : refus « déjà », state_before d\'origine conservé', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque');
    const avant = yaml(dir);
    expect(raf(dir, 'status', 'L1', 'bloque').err).toMatch(/déjà bloque/);
    expect(yaml(dir)).toBe(avant);
    expect(yaml(dir)).toContain('state_before: en_cours');
  });

  it('noms d\'états numériques — clés YAML 1, 2, 3 — attendu : raf status L1 2 fonctionne', () => {
    const dir = projet('plan:\n  states: { 1: todo, 2: doing, 3: done }\n');
    const r = raf(dir, 'status', 'L1', '2');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(raf(dir, 'show', 'L1').out).toContain('état : 2');
  });

  it('noms d\'états proto — constructor / toString comme état — attendu : refus « inconnu », pas de crash', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    for (const nom of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = raf(dir, 'status', 'L1', nom);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/état inconnu/);
    }
  });

  it('un état déclaré nommé constructor — nom de prototype déclaré — attendu : utilisable comme les autres', () => {
    const dir = projet('plan:\n  states: { constructor: todo, b: doing, c: done }\n');
    raf(dir, 'start', 'L1');
    expect(yaml(dir)).toMatch(/state: b/);
    expect(raf(dir, 'status').out).toMatch(/constructor\s+todo/);
  });
});

describe('bords de raf status — bloqué et retour', () => {
  it('a_faire → bloque puis --back — retour vers un état todo — attendu : le lot revient a_faire, todo, sans refus', () => {
    const dir = projet();
    raf(dir, 'status', 'L1', 'bloque');
    expect(yaml(dir)).toContain('state_before: a_faire');
    const r = raf(dir, 'status', 'L1', '--back');
    expect(r.code).toBe(0);
    expect(yaml(dir)).toMatch(/status: todo/);
    expect(yaml(dir)).toContain('state: a_faire');
    expect(yaml(dir)).not.toContain('state_before');
    expect(yaml(dir)).not.toContain('started');
  });

  function commitCitant(dir: string) {
    writeFileSync(join(dir, 'f.txt'), 'x');
    execFileSync('git', ['add', 'f.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'feat(L1): travail'], { cwd: dir });
  }

  it('a_faire → bloque, un commit cite le lot, puis --back — retour vers todo refusé comme raf todo — attendu : exit 2, lot inchangé, raf check vert', () => {
    const dir = projet();
    raf(dir, 'status', 'L1', 'bloque');
    commitCitant(dir);
    const avant = yaml(dir);
    const r = raf(dir, 'status', 'L1', '--back');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/1 commit\(s\) qui le citent/);
    expect(r.err).toMatch(/raf status L1 <état>/);
    expect(yaml(dir)).toBe(avant);
    expect(raf(dir, 'check').code).toBe(0);
  });

  it('un lot doing avec un commit vers un état todo (sans transitions) — attendu : refusé, status doing gardé, raf check vert', () => {
    const dir = projet('plan:\n  states: { a_faire: todo, en_cours: doing, bloque: todo, termine: done, abandonne: dropped }\n');
    raf(dir, 'start', 'L1');
    commitCitant(dir);
    expect(raf(dir, 'todo', 'L1').code).not.toBe(0);
    const r = raf(dir, 'status', 'L1', 'a_faire');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/commit\(s\) qui le citent/);
    expect(yaml(dir)).toMatch(/status: doing/);
    expect(yaml(dir)).toContain('state: en_cours');
    expect(raf(dir, 'check').code).toBe(0);
  });

  it('un lot doing avec un commit vers un blockedState de base todo — attendu : refusé, pas de state_before écrit', () => {
    const dir = projet(PLAN_YAML.replace('bloque: doing', 'bloque: todo'));
    raf(dir, 'start', 'L1');
    commitCitant(dir);
    expect(raf(dir, 'status', 'L1', 'bloque').code).not.toBe(0);
    expect(yaml(dir)).toMatch(/status: doing/);
    expect(yaml(dir)).not.toContain('state_before');
  });

  it('un lot doing passe à un blockedState de base todo — attendu : accepté, le lot repasse todo', () => {
    const dir = projet(PLAN_YAML.replace('bloque: doing', 'bloque: todo'));
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', 'bloque').code).toBe(0);
    expect(yaml(dir)).toMatch(/status: todo/);
    expect(yaml(dir)).toContain('state_before: en_cours');
  });

  it('raf done --force depuis bloque — sortie par done — attendu : state: termine, state_before retiré', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque');
    expect(raf(dir, 'done', 'L1').code).not.toBe(0);
    expect(raf(dir, 'done', 'L1', '--force').code).toBe(0);
    expect(yaml(dir)).toContain('state: termine');
    expect(yaml(dir)).not.toContain('state_before');
  });

  it('raf drop depuis bloque — abandon — attendu : state: abandonne, state_before retiré', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque');
    expect(raf(dir, 'drop', 'L1').code).toBe(0);
    expect(yaml(dir)).toContain('state: abandonne');
    expect(yaml(dir)).not.toContain('state_before');
  });

  it('raf todo sur un lot bloqué sans commit — remise en attente — attendu : state: a_faire, state_before retiré', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque');
    expect(raf(dir, 'todo', 'L1').code).toBe(0);
    expect(yaml(dir)).toContain('state: a_faire');
    expect(yaml(dir)).not.toContain('state_before');
  });

  it('state_before main-écrit sur un état non déclaré — --back — attendu : refus nommé, plan inchangé', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque');
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace('state_before: en_cours', 'state_before: fantome'));
    const avant = yaml(dir);
    expect(raf(dir, 'status', 'L1', '--back').err).toMatch(/fantome/);
    expect(yaml(dir)).toBe(avant);
  });

  it('reopen depuis livre — raf todo sur un lot done — attendu : state: a_faire malgré transitions terminales', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    raf(dir, 'status', 'L1', 'livre');
    expect(raf(dir, 'todo', 'L1').code).toBe(0);
    expect(yaml(dir)).toContain('state: a_faire');
  });
});

describe('bords de raf start / done avec états', () => {
  it('raf start d\'un lot déjà doing — répétition — attendu : « est déjà doing », pas un refus de transition', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'start', 'L1').err).toMatch(/est déjà doing/);
  });

  it('raf done deux fois — répétition — attendu : refus « est déjà done » sans toucher à state', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    const avant = yaml(dir);
    expect(raf(dir, 'done', 'L1').code).not.toBe(0);
    expect(yaml(dir)).toBe(avant);
  });

  it('sous-tâche — start/done d\'une sous-tâche — attendu : aucune clé state: écrite sur la tâche', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'add', 'tâche', '--parent', 'L1');
    raf(dir, 'start', 'L1/t1');
    raf(dir, 'done', 'L1/t1');
    const tasks = yaml(dir).split('tasks:')[1] ?? '';
    expect(tasks).not.toMatch(/state/);
  });

  it('doneState absent — plusieurs états done — attendu : raf done pose le premier déclaré', () => {
    const dir = projet('plan:\n  states: { a: todo, b: doing, z: done, y: done }\n');
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    expect(yaml(dir)).toContain('state: z');
  });

  it('raf done depuis todo gardé — a_faire → termine — attendu : refus avec --force indiqué, rien d\'écrit', () => {
    const dir = projet();
    const avant = yaml(dir);
    const r = raf(dir, 'done', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--force/);
    expect(yaml(dir)).toBe(avant);
  });
});

describe('bords de la déclaration', () => {
  const charge = (config: string) => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), config);
    return () => readPlanConfig(join(dir, 'cadence.yaml'), dir);
  };
  const base = 'plan:\n  states: { a: todo, b: doing, c: done }\n';

  it('states vide — objet {} — attendu : refus (au moins un todo, un doing, un done)', () => {
    expect(charge('plan:\n  states: {}\n')).toThrow(/au moins un état todo/);
  });

  it('transitions en liste — mauvais type — attendu : refus nommé', () => {
    expect(charge(`${base}  transitions: [a, b]\n`)).toThrow(/transitions doit être un objet/);
  });

  it('transitions avec valeur nulle ou chaîne — a: ~ et a: b — attendu : a terminal, a: b lu comme [b]', () => {
    const t = charge(`${base}  transitions: { a: ~, b: c }\n`)()?.settings.states?.transitions;
    expect(t?.a).toEqual([]);
    expect(t?.b).toEqual(['c']);
  });

  it('states à valeur non textuelle — a: [todo] — attendu : refus « inconnu »', () => {
    expect(charge('plan:\n  states: { a: [todo], b: doing, c: done }\n')).toThrow(/statut de base/);
  });

  it('doneState/blockedState de mauvais type — objet ou liste — attendu : refus, pas de [object Object] accepté', () => {
    expect(charge(`${base}  doneState: [c]\n`)).toThrow();
    expect(charge(`${base}  blockedState: { x: 1 }\n`)).toThrow();
  });

  it('blockedState un état dropped — dropped refusé — attendu : refus nommé', () => {
    expect(charge('plan:\n  states: { a: todo, b: doing, c: done, d: dropped }\n  blockedState: d\n')).toThrow(/blockedState/);
  });
});

describe('bords de raf check', () => {
  it('state: non textuel écrit à la main — state: 5 — attendu : raf check le signale', () => {
    const dir = projet();
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace('status: todo', 'status: todo\n    state: 5'));
    const r = raf(dir, 'check');
    expect(r.out + r.err).toMatch(/state|état/);
    expect(r.code).not.toBe(0);
  });

  it('lot avec état non déclaré — raf status liste — attendu : pas de crash', () => {
    const dir = projet();
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace('status: todo', 'status: todo\n    state: fantome'));
    expect(raf(dir, 'status').code).toBe(0);
  });

  it('plan.states retiré après usage — state: resté dans le plan — attendu : raf check silencieux sur cet état', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    writeFileSync(join(dir, 'cadence.yaml'), '');
    const r = raf(dir, 'check');
    expect(r.out + r.err).not.toMatch(/non déclaré/);
  });
});
