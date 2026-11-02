import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { check } from '../src/check.js';
import { linkCommits } from '../src/link.js';
import { readPlanConfig } from '../src/config.js';
import { Plan } from '../src/plan.js';
import { gitRepo } from './helpers.js';
import { docText } from './docs-text.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-11-02' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-11-02T09:30:00'),
  });
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

const loadConfig = (config: string) => {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), config);
  return () => readPlanConfig(join(dir, 'cadence.yaml'), dir);
};

describe('plan.states — la déclaration (cadence.yaml)', () => {
  it('lit les états dans l\'ordre déclaré, leurs transitions, doneState et blockedState', () => {
    const states = loadConfig(PLAN_YAML)()?.settings.states;
    expect(Object.keys(states?.states ?? {})).toEqual(['a_faire', 'en_cours', 'bloque', 'termine', 'livre', 'abandonne']);
    expect(states?.states.bloque).toBe('doing');
    expect(states?.transitions?.termine).toEqual(['livre']);
    expect(states?.done).toBe('termine');
    expect(states?.blocked).toBe('bloque');
  });

  it('refuse un statut de base inconnu', () => {
    expect(loadConfig('plan:\n  states: { a: todo, b: doing, c: fini }\n')).toThrow(/plan\.states\.c : statut de base « fini » inconnu/);
  });

  it('refuse un jeu d\'états sans todo, doing ou done', () => {
    expect(loadConfig('plan:\n  states: { a: todo, b: doing }\n')).toThrow(/plan\.states doit déclarer au moins un état todo, un doing et un done/);
  });

  it('refuse une transition vers ou depuis un état non déclaré', () => {
    const base = 'plan:\n  states: { a: todo, b: doing, c: done }\n';
    expect(loadConfig(`${base}  transitions: { a: [z] }\n`)).toThrow(/plan\.transitions\.a : « z » n'est pas un état déclaré/);
    expect(loadConfig(`${base}  transitions: { z: [a] }\n`)).toThrow(/plan\.transitions : « z » n'est pas un état déclaré/);
  });

  it('refuse doneState qui n\'est pas un état done et blockedState qui est clos', () => {
    const base = 'plan:\n  states: { a: todo, b: doing, c: done }\n';
    expect(loadConfig(`${base}  doneState: b\n`)).toThrow(/plan\.doneState : « b » n'est pas un état done/);
    expect(loadConfig(`${base}  blockedState: c\n`)).toThrow(/plan\.blockedState : « c » doit être un état todo ou doing/);
  });

  it('refuse transitions/doneState/blockedState sans states, et states avec un plan lu dans un autre format', () => {
    expect(loadConfig('plan:\n  doneState: x\n')).toThrow(/plan\.doneState demande plan\.states/);
    expect(loadConfig('plan:\n  states: { a: todo, b: doing, c: done }\n  lots: taches\n')).toThrow(/plan\.states ne va pas avec un plan tenu par un autre outil/);
  });

  it('refuse un état qui est un objet vide ou une liste (mauvais type)', () => {
    expect(loadConfig('plan:\n  states: [a, b]\n')).toThrow(/plan\.states doit être un objet/);
  });
});

describe('raf status', () => {
  it('pose state: juste après status:, dérive le statut de base et note le message', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', 'bloque', 'attend la passerelle').code).toBe(0);
    const lignes = yaml(dir).split('\n').map((l) => l.trim());
    expect(lignes[lignes.indexOf('status: doing') + 1]).toBe('state: bloque');
    expect(lignes).toContain('state_before: en_cours');
    expect(yaml(dir)).toContain('état bloque : attend la passerelle');
    expect(raf(dir, 'show', 'L1').out).toContain('état : bloque');
  });

  it('refuse sans plan.states', () => {
    const dir = projet('');
    const r = raf(dir, 'status', 'L1', 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/aucun état déclaré/);
  });

  it('refuse un état inconnu en citant les états déclarés, un lot inconnu, une sous-tâche, et deux fois le même état', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', 'nimporte').err).toMatch(/état inconnu : nimporte \(déclarés : a_faire, en_cours/);
    expect(raf(dir, 'status', 'L9', 'bloque').err).toMatch(/lot inconnu : L9/);
    raf(dir, 'add', 'tâche', '--parent', 'L1');
    expect(raf(dir, 'status', 'L1/t1', 'bloque').err).toMatch(/se pose sur un lot, pas une sous-tâche/);
    expect(raf(dir, 'status', 'L1', 'en_cours').err).toMatch(/L1 est déjà en_cours/);
    expect(raf(dir, 'status', 'L1').err).toMatch(/usage : raf status/);
  });

  it('garde les transitions : refus qui nomme les états permis, rien n\'est écrit', () => {
    const dir = projet();
    const avant = yaml(dir);
    const r = raf(dir, 'status', 'L1', 'termine');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/a_faire → termine n'est pas permis \(depuis a_faire : en_cours, bloque, abandonne\)/);
    expect(yaml(dir)).toBe(avant);
  });

  it('un état absent de plan.transitions est terminal quand des transitions sont déclarées', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    raf(dir, 'status', 'L1', 'livre');
    expect(raf(dir, 'status', 'L1', 'termine').err).toMatch(/livre → termine n'est pas permis \(état terminal\)/);
  });

  it('sans plan.transitions, tout état de même statut de base est permis', () => {
    const dir = projet('plan:\n  states: { a: todo, b: doing, c: doing, d: done }\n');
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', 'c').code).toBe(0);
    expect(raf(dir, 'status', 'L1', 'b').code).toBe(0);
  });

  it('todo → état doing démarre le lot (started posé) ; les autres changements de statut de base renvoient à leur commande', () => {
    const dir = projet('plan:\n  states: { a: todo, b: doing, c: done, x: dropped }\n');
    expect(raf(dir, 'status', 'L1', 'c').err).toMatch(/raf done L1/);
    expect(raf(dir, 'status', 'L1', 'x').err).toMatch(/raf drop L1/);
    expect(raf(dir, 'status', 'L1', 'b').code).toBe(0);
    expect(yaml(dir)).toMatch(/status: doing\n\s+state: b/);
    expect(yaml(dir)).toContain('started: 2026-11-02');
    expect(raf(dir, 'status', 'L1', 'a').err).toMatch(/raf todo L1/);
    raf(dir, 'done', 'L1');
    expect(raf(dir, 'status', 'L1', 'b').err).toMatch(/raf todo L1/);
  });

  it('sans argument, liste les états avec leur statut de base, leur nombre de lots et leurs transitions', () => {
    const dir = projet();
    raf(dir, 'add', 'Deuxième');
    raf(dir, 'start', 'L2');
    const r = raf(dir, 'status');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/a_faire\s+todo\s+1 lot.*→ en_cours, bloque, abandonne/);
    expect(r.out).toMatch(/en_cours\s+doing\s+1 lot/);
    expect(r.out).toMatch(/livre\s+done\s+0 lot/);
  });
});

describe('états gardés par start / done / drop / todo', () => {
  it('start pose le premier état doing, done l\'état doneState, drop l\'état dropped, todo le premier état todo', () => {
    const dir = projet();
    raf(dir, 'add', 'Second');
    raf(dir, 'start', 'L1');
    expect(yaml(dir)).toMatch(/- id: L1\n\s+title: Premier lot\n\s+status: doing\n\s+state: en_cours/);
    raf(dir, 'done', 'L1');
    expect(yaml(dir)).toMatch(/status: done\n\s+state: termine/);
    raf(dir, 'drop', 'L2');
    expect(yaml(dir)).toMatch(/status: dropped\n\s+state: abandonne/);
    raf(dir, 'todo', 'L1');
    expect(yaml(dir)).toMatch(/- id: L1\n\s+title: Premier lot\n\s+status: todo\n\s+state: a_faire/);
  });

  it('done est refusé depuis un état dont la transition ne le permet pas, --force passe', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque', 'attend');
    const r = raf(dir, 'done', 'L1');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/bloque → termine n'est pas permis/);
    expect(raf(dir, 'done', 'L1', '--force').code).toBe(0);
    expect(yaml(dir)).toMatch(/status: done\n\s+state: termine\n/);
    expect(yaml(dir)).not.toContain('state_before');
  });

  it('un lot sans clé state: (écrit avant la déclaration) part de l\'état par défaut de son statut', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace(/\n\s+state: en_cours/, ''));
    expect(raf(dir, 'status', 'L1', 'bloque').code).toBe(0);
    expect(yaml(dir)).toContain('state_before: en_cours');
  });

  it('sans plan.states, start/done n\'écrivent pas state:', () => {
    const dir = projet('');
    raf(dir, 'start', 'L1');
    raf(dir, 'done', 'L1');
    expect(yaml(dir)).not.toContain('state');
  });
});

describe('état bloqué', () => {
  it('--back revient à l\'état d\'avant et retire state_before', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque', 'attend');
    expect(raf(dir, 'status', 'L1', '--back', 'débloqué').code).toBe(0);
    expect(yaml(dir)).toMatch(/status: doing\n\s+state: en_cours\n/);
    expect(yaml(dir)).not.toContain('state_before');
    expect(yaml(dir)).toContain('état en_cours : débloqué');
  });

  it('--back hors de l\'état bloqué, ou sans état d\'avant lisible, est refusé', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', '--back').err).toMatch(/L1 n'est pas bloqué/);
    raf(dir, 'status', 'L1', 'bloque');
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace(/\n\s+state_before: en_cours/, ''));
    expect(raf(dir, 'status', 'L1', '--back').err).toMatch(/état d'avant introuvable/);
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace(/(state: bloque)/, '$1\n    state_before: disparu'));
    expect(raf(dir, 'status', 'L1', '--back').err).toMatch(/état d'avant « disparu » n'est plus déclaré/);
  });

  it('quitter l\'état bloqué par un autre état retire state_before', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    raf(dir, 'status', 'L1', 'bloque');
    expect(yaml(dir)).toContain('state_before: en_cours');
    raf(dir, 'status', 'L1', 'en_cours');
    expect(yaml(dir)).not.toContain('state_before');
    raf(dir, 'status', 'L1', 'bloque');
    raf(dir, 'drop', 'L1');
    expect(yaml(dir)).toMatch(/status: dropped\n\s+state: abandonne\n/);
    expect(yaml(dir)).not.toContain('state_before');
  });

  it('--back sans plan.blockedState est refusé', () => {
    const dir = projet('plan:\n  states: { a: todo, b: doing, c: done }\n');
    raf(dir, 'start', 'L1');
    expect(raf(dir, 'status', 'L1', '--back').err).toMatch(/aucun état bloqué déclaré/);
  });
});

describe('raf check — état écrit à la main', () => {
  it('signale un état non déclaré et un état dont le statut de base contredit status:', () => {
    const dir = projet();
    raf(dir, 'start', 'L1');
    const plan = () => Plan.load(join(dir, '.cadence/raf.yaml'), readPlanConfig(join(dir, 'cadence.yaml'), dir)?.settings);
    const problemes = () => {
      const p = plan();
      return check(p.lots(), linkCommits(p.lots(), [], p.refs), '2026-11-02').filter((i) => i.kind === 'bad-field').map((i) => i.message).join('\n');
    };
    expect(problemes()).toBe('');
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace('state: en_cours', 'state: fantome'));
    expect(problemes()).toMatch(/L1 : état « fantome » non déclaré/);
    writeFileSync(join(dir, '.cadence/raf.yaml'), yaml(dir).replace('state: fantome', 'state: termine'));
    expect(problemes()).toMatch(/L1 : état « termine » \(done\) contredit status: doing/);
  });
});

describe('documentation', () => {
  it('la documentation décrit raf status et plan.states', () => {
    const doc = docText();
    expect(doc).toContain('raf status');
    expect(doc).toContain('plan.states');
    expect(doc).toContain('doneState');
    expect(doc).toContain('blockedState');
  });
});
