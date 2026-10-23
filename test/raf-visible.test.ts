import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { check } from '../src/check.js';
import { linkCommits } from '../src/link.js';
import { Plan } from '../src/plan.js';
import { gitRepo } from './helpers.js';
import { docText } from './docs-text.js';

function raf(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, {
    cwd: dir,
    env: { RAF_TODAY: '2026-10-23' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-10-23T09:30:00'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const yaml = (dir: string) => readFileSync(join(dir, '.cadence/raf.yaml'), 'utf8');

function projet() {
  const dir = gitRepo();
  raf(dir, 'init', '--project', 'demo');
  return dir;
}

describe('raf visible', () => {
  it('on pose visible: true sur un lot existant, après quickwin', () => {
    const dir = projet();
    raf(dir, 'add', 'Revue UX — accueil', '--estimate', '0.5', '--quickwin');
    expect(raf(dir, 'visible', 'L1', 'on').code).toBe(0);
    const lignes = yaml(dir).split('\n').map((l) => l.trim());
    expect(lignes).toContain('visible: true');
    expect(lignes.indexOf('visible: true')).toBeGreaterThan(lignes.indexOf('quickwin: true'));
  });

  it('on sur un lot déjà visible ne change rien (idempotent)', () => {
    const dir = projet();
    raf(dir, 'add', 'A', '--visible');
    const avant = yaml(dir);
    expect(raf(dir, 'visible', 'L1', 'on').code).toBe(0);
    expect(yaml(dir)).toBe(avant);
  });

  it('off retire visible: ; sans effet sur un lot qui ne l\'a pas', () => {
    const dir = projet();
    raf(dir, 'add', 'A', '--visible');
    raf(dir, 'add', 'B');
    expect(raf(dir, 'visible', 'L1', 'off').code).toBe(0);
    expect(yaml(dir)).not.toContain('visible:');
    const avant = yaml(dir);
    expect(raf(dir, 'visible', 'L2', 'off').code).toBe(0);
    expect(yaml(dir)).toBe(avant);
  });

  it('off est refusé sur un lot qui a screen: (raf screen none d\'abord) ; le plan reste intact', () => {
    const dir = projet();
    raf(dir, 'add', 'A', '--visible', '--screen', 'page');
    const avant = yaml(dir);
    const r = raf(dir, 'visible', 'L1', 'off');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('raf screen L1 none');
    expect(yaml(dir)).toBe(avant);
  });

  it('refuse une sous-tâche, un lot inconnu, un usage incomplet ou une valeur autre que on/off', () => {
    const dir = projet();
    raf(dir, 'add', 'A');
    raf(dir, 'add', 'T', '--parent', 'L1');
    const avant = yaml(dir);
    expect(raf(dir, 'visible', 'L1/T1', 'on').code).not.toBe(0);
    expect(raf(dir, 'visible', 'L9', 'on').code).not.toBe(0);
    expect(raf(dir, 'visible', 'L1').code).not.toBe(0);
    expect(raf(dir, 'visible', 'L1', 'oui').code).not.toBe(0);
    expect(raf(dir, 'visible', 'L1', 'on', 'off').code).not.toBe(0);
    expect(yaml(dir)).toBe(avant);
  });

  it('répare l\'écart ux-review-not-visible de raf check, et le message de L271 nomme la commande', () => {
    const dir = projet();
    raf(dir, 'add', 'Revue UX — accueil');
    const ecarts = () => {
      const plan = Plan.load(join(dir, '.cadence/raf.yaml'));
      const lots = plan.lots();
      return check(lots, linkCommits(lots, [], plan.refs), '2026-10-23').filter((i) => i.kind === 'ux-review-not-visible');
    };
    const avant = ecarts();
    expect(avant).toHaveLength(1);
    expect(avant[0].message).toContain('raf visible L1 on');
    raf(dir, 'visible', 'L1', 'on');
    expect(ecarts()).toEqual([]);
  });

  it('documentation : aide, README/docs raf, CHANGELOG', () => {
    expect(readFileSync('src/cli.ts', 'utf8')).toMatch(/raf visible <id> on\|off/);
    expect(docText()).toMatch(/\| `raf visible <id> on\\\|off`/);
    expect(readFileSync('CHANGELOG.md', 'utf8')).toContain('raf visible');
  });
});
