import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { gitRepo } from './helpers.js';

// L464 × L463 — un plan qui déclare à la fois des états détaillés (`plan.states`) et des champs d'extension (`plan.extras`) se lit, s'écrit et se garde.
const PLAN = '.cadence/raf.yaml';
const CONFIG = `plan:
  states: { a_faire: todo, en_cours: doing, bloque: doing, termine: done, abandonne: dropped }
  transitions:
    a_faire: [en_cours, bloque, abandonne]
    en_cours: [bloque, termine, abandonne]
    bloque: [en_cours, abandonne]
  doneState: termine
  blockedState: bloque
  extras:
    theme: { enum: [infra, ui, data] }
    owner: { default: claude }
`;

function raf(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-11-02' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-11-02T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function project() {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), CONFIG);
  raf(dir, 'init', '--project', 'demo', '--no-hook');
  return dir;
}
const planText = (dir: string) => readFileSync(join(dir, PLAN), 'utf8');

describe('L463 + L464 — états détaillés et champs d\'extension dans le même plan', () => {
  it('cadence.yaml : les deux clés se lisent ensemble', () => {
    const dir = project();
    const settings = readPlanConfig(join(dir, 'cadence.yaml'))?.settings;
    expect(settings?.states?.states).toMatchObject({ a_faire: 'todo', termine: 'done' });
    expect(settings?.extras).toEqual({ theme: { enum: ['infra', 'ui', 'data'] }, owner: { default: 'claude' } });
  });
  it('raf add --set écrit le champ, raf start/status/done posent l\'état : les deux sont gardés dans le fichier', () => {
    const dir = project();
    expect(raf(dir, 'add', 'Un lot', '--set', 'theme=ui').code).toBe(0);
    expect(raf(dir, 'start', 'L1').code).toBe(0);
    expect(raf(dir, 'status', 'L1', 'bloque').code).toBe(0);
    expect(planText(dir)).toMatch(/state: bloque/);
    expect(planText(dir)).toMatch(/theme: ui/);
    expect(raf(dir, 'status', 'L1', '--back').code).toBe(0);
    expect(raf(dir, 'done', 'L1', '--force').code).toBe(0);
    const text = planText(dir);
    expect(text).toMatch(/status: done\n\s+state: termine/);
    expect(text).toMatch(/theme: ui/);
  });
  it('raf show imprime l\'état et les champs ; raf list --json exporte state et extras ; raf check rapporte les deux familles', () => {
    const dir = project();
    raf(dir, 'add', 'Un lot', '--set', 'theme=data');
    raf(dir, 'start', 'L1');
    const show = raf(dir, 'show', 'L1').out;
    expect(show).toMatch(/^état : en_cours$/m);
    expect(show).toMatch(/^theme : data$/m);
    expect(show).toMatch(/^owner : claude$/m);
    const lot = JSON.parse(raf(dir, 'list', '--json').out)[0];
    expect(lot).toMatchObject({ id: 'L1', state: 'en_cours', extras: { theme: 'data', owner: 'claude' } });
    writeFileSync(join(dir, PLAN), planText(dir).replace('state: en_cours', 'state: nulle_part').replace('theme: data', 'theme: zzz'));
    const check = raf(dir, 'check').out;
    expect(check).toMatch(/nulle_part/);
    expect(check).toMatch(/theme « zzz » hors de enum/);
  });
  it('plan.extras ne peut pas prendre le nom des clés d\'état (state, state_before)', () => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'cadence.yaml'), 'plan:\n  extras:\n    state: {}\n');
    expect(() => readPlanConfig(join(dir, 'cadence.yaml'))).toThrow(/plan\.extras\.state.*champ de raf/);
  });
});
