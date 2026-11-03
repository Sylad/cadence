import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { parseDeliverConfig } from '../src/deliver.js';
import { Plan } from '../src/plan.js';
import { tempDir } from './helpers.js';

const DELIVER = 'deliver:\n  ci: none\n  verify:\n    - command: "true"\n';
const blocks = (yaml: string) => parseDeliverConfig(`${DELIVER}  blocks:\n${yaml}`, 'cadence.yaml').blocks;
const refused = (yaml: string) => {
  try {
    blocks(yaml);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe('R23 — deliver.blocks : forme', () => {
  it('R23 — deliver.blocks liste au lieu d\'un objet : refus', () => {
    expect(() => parseDeliverConfig(`${DELIVER}  blocks: [src/api]\n`, 'cadence.yaml')).toThrow('cadence.yaml : deliver.blocks : un objet { nom: [chemins] } attendu');
  });
  it('R23 — nom de bloc vide : refus', () => {
    expect(refused('    "": [src/api]\n')).toBe('cadence.yaml : deliver.blocks : nom de bloc vide');
  });
  it('R23 — liste de chemins vide : refus', () => {
    expect(refused('    api: []\n')).toBe('cadence.yaml : deliver.blocks.api : au moins un chemin attendu');
  });
  it('R23 — un chemin qui n\'est pas un texte : refus', () => {
    expect(refused('    api: [3]\n')).toBe('cadence.yaml : deliver.blocks.api : un chemin est un texte');
  });
  it('R23 — un bloc nommé « __proto__ » est une clé du bloc, pas le prototype', () => {
    const b = blocks('    "__proto__": [src/x]\n')!;
    expect(Object.keys(b)).toEqual(['__proto__']);
  });
  it('R23 — sans deliver.blocks : aucun bloc', () => {
    expect(parseDeliverConfig(DELIVER, 'cadence.yaml').blocks).toBeUndefined();
  });
});

describe('R24 — chemins de bloc', () => {
  it('R24 — chemin absolu « /etc » : refus', () => {
    expect(refused('    api: ["/etc"]\n')).toBe('cadence.yaml : deliver.blocks.api : « /etc » est hors du dépôt');
  });
  it('R24 — « // » : refus hors du dépôt', () => {
    expect(refused('    api: ["//"]\n')).toBe('cadence.yaml : deliver.blocks.api : « // » est hors du dépôt');
  });
  it('R24 — « ./ » et « . » : refus « désigne tout le dépôt »', () => {
    expect(refused('    api: ["./"]\n')).toBe('cadence.yaml : deliver.blocks.api : « ./ » désigne tout le dépôt (un bloc se déclare par un sous-chemin)');
    expect(refused('    api: ["."]\n')).toContain('« . » désigne tout le dépôt');
  });
  it('R24 — « src/.. » : refus tout le dépôt', () => {
    expect(refused('    api: ["src/.."]\n')).toContain('désigne tout le dépôt');
  });
  it('R24 — « ../x » et « src/../.. » : refus hors du dépôt', () => {
    expect(refused('    api: ["../x"]\n')).toContain('« ../x » est hors du dépôt');
    expect(refused('    api: ["src/../.."]\n')).toContain('est hors du dépôt');
  });
  it('R24 — chaîne vide : refus', () => {
    expect(refused('    api: [""]\n')).toBe('cadence.yaml : deliver.blocks.api : un chemin vide');
  });
  it('R24 — « src\\api/ » : accepté, normalisé en « src/api »', () => {
    expect(blocks('    api: ["src\\\\api/", "./web/x"]\n')).toEqual({ api: ['src/api', 'web/x'] });
  });
});

describe('R25 — plan.deliveredState', () => {
  const read = (plan: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), `plan:\n${plan}`);
    return () => readPlanConfig(join(dir, 'cadence.yaml'), dir)?.settings.states;
  };
  const STATES = '  states: { a_faire: todo, en_cours: doing, termine: done, livre: done, bloque: doing }\n';
  it('R25 — deliveredState sans plan.states : refusé', () => {
    expect(read('  deliveredState: livre\n')).toThrow('cadence.yaml : plan.deliveredState demande plan.states');
  });
  it('R25 — deliveredState non déclaré : refusé', () => {
    expect(read(`${STATES}  deliveredState: inconnu\n`)).toThrow('plan.deliveredState : « inconnu » n\'est pas un état done');
  });
  it('R25 — deliveredState d\'état doing : refusé', () => {
    expect(read(`${STATES}  deliveredState: bloque\n`)).toThrow('cadence.yaml : plan.deliveredState : « bloque » n\'est pas un état done');
  });
  it('R25 — deliveredState nombre : refusé', () => {
    expect(read(`${STATES}  deliveredState: 3\n`)).toThrow('cadence.yaml : plan.deliveredState : un nom d\'état attendu');
  });
  it('R25 — deliveredState valide : lu', () => {
    expect(read(`${STATES}  doneState: termine\n  deliveredState: livre\n`)()?.delivered).toBe('livre');
  });
});

describe('R26 — KEYS', () => {
  it('R26 — plan.deliveredState n\'est pas refusé comme clé inconnue', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  states: { a: todo, b: doing, c: done }\n  deliveredState: c\n');
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'), dir)).not.toThrow();
  });
  it('R26 — une clé voisine inconnue reste refusée', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  deliveredStates: c\n');
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'), dir)).toThrow('deliveredStates inconnu');
  });
});

/** Plan natif d'un lot livré L1 (terminé le 2026-10-02, livré le 2026-10-05). */
function livre(): { dir: string; planFile: string } {
  const dir = tempDir();
  const planFile = join(dir, '.cadence/raf.yaml');
  mkdirSync(dirname(planFile), { recursive: true });
  const plan = Plan.create(planFile, 'demo', 'L', '2026-10-01');
  plan.add('Alertes', '2026-10-01');
  plan.setStatus('L1', 'done', '2026-10-02');
  plan.save();
  writeFileSync(planFile, readFileSync(planFile, 'utf8').replace(/finished: 2026-10-02\n/, 'finished: 2026-10-02\n    delivered: { date: 2026-10-05, sha: 0123456789abcdef0123456789abcdef01234567 }\n'));
  return { dir, planFile };
}
const cli = (dir: string, ...argv: string[]) => {
  const out: string[] = [];
  const code = run(argv, { cwd: dir, env: { RAF_TODAY: '2026-10-06' }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date('2026-10-06T10:00:00') });
  return { code, out };
};

describe('R27 — delivered: conservé et déplacé', () => {
  it('R27 — lu dans le plan natif', () => {
    const { planFile } = livre();
    expect(Plan.load(planFile).lot('L1').delivered).toEqual({ date: '2026-10-05', sha: '0123456789abcdef0123456789abcdef01234567' });
  });
  it('R27 — raf note sur un lot livré : delivered conservé', () => {
    const { dir, planFile } = livre();
    expect(cli(dir, 'note', 'L1', 'un mot').code).toBe(0);
    expect(readFileSync(planFile, 'utf8')).toContain('delivered:');
    expect(Plan.load(planFile).lot('L1').delivered?.date).toBe('2026-10-05');
  });
  it('R27 — raf archive d\'un lot livré : delivered dans l\'archive', () => {
    const { dir, planFile } = livre();
    expect(cli(dir, 'archive').code).toBe(0);
    expect(readFileSync(join(dir, '.cadence/archive/2026.yaml'), 'utf8')).toContain('delivered:');
    expect(Plan.load(planFile).lot('L1').delivered?.sha).toMatch(/^0123456/);
  });
  it('R27 — un delivered mal formé est ignoré, pas fatal', () => {
    const { planFile } = livre();
    writeFileSync(planFile, readFileSync(planFile, 'utf8').replace(/delivered: \{[^}]*\}/, 'delivered: oui'));
    expect(Plan.load(planFile).lot('L1').delivered).toBeUndefined();
  });
});

describe('R28 — raf show', () => {
  it('R28 — lot livré : ligne « livré : » affichée', () => {
    const { dir } = livre();
    expect(cli(dir, 'show', 'L1').out).toContain('livré : 2026-10-05 0123456');
  });
  it('R28 — lot non livré : aucune ligne « livré : »', () => {
    const { dir, planFile } = livre();
    writeFileSync(planFile, readFileSync(planFile, 'utf8').replace(/ +delivered: \{[^}]*\}\n/, ''));
    expect(cli(dir, 'show', 'L1').out.some((l) => l.startsWith('livré'))).toBe(false);
  });
});
