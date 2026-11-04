import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { readPlanConfig } from '../src/config.js';
import { failureMessage } from '../src/plan-onwrite.js';
import { gitRepo, tempDir, NO_BACKGROUND_GIT } from './helpers.js';

// Sondes L471 — plan.onWrite.onFailure : bords de la lecture, du message et de la restauration en `warn`.
const PLAN = '.cadence/raf.yaml';
const OUT = 'public/plan.json';

function cadence(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: { RAF_TODAY: '2026-10-26' }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date('2026-10-26T09:00:00') }) as number;
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function project(yaml: string) {
  const dir = gitRepo();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  cadence(dir, 'init', '--project', 'demo', '--no-hook');
  execFileSync('git', [...NO_BACKGROUND_GIT, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...NO_BACKGROUND_GIT, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const warnCfg = (command: string, files = `[${OUT}]`) => `plan:\n  onWrite: { command: '${command}', files: ${files}, onFailure: warn }\n`;
const readCfg = (yaml: string) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'cadence.yaml'), yaml);
  return () => readPlanConfig(join(dir, 'cadence.yaml'));
};

describe('probe L471 — onFailure : valeurs de bord', () => {
  it('onFailure casse différente (WARN) — refusée, pas devinée', () => {
    expect(readCfg('plan:\n  onWrite: { command: make, onFailure: WARN }\n')).toThrow(/plan\.onWrite\.onFailure/);
  });
  it('onFailure nombre, liste, valeur avec espace — refusés', () => {
    expect(readCfg('plan:\n  onWrite: { command: make, onFailure: 0 }\n')).toThrow(/plan\.onWrite\.onFailure/);
    expect(readCfg('plan:\n  onWrite: { command: make, onFailure: [warn] }\n')).toThrow(/plan\.onWrite\.onFailure/);
    expect(readCfg("plan:\n  onWrite: { command: make, onFailure: 'warn ' }\n")).toThrow(/plan\.onWrite\.onFailure/);
  });
  it('onFailure écrit sans valeur (null) — « toute autre valeur est refusée » : refusé, pas silencieusement refuse', () => {
    expect(readCfg('plan:\n  onWrite: { command: make, onFailure: ~ }\n')).toThrow(/plan\.onWrite\.onFailure/);
  });
  it('onWrite sans files mais avec onFailure warn — files vide, onFailure warn', () => {
    const s = readCfg("plan:\n  onWrite: { command: make, onFailure: warn }\n")()?.settings.onWrite;
    expect(s?.files).toEqual([]);
    expect(s?.onFailure).toBe('warn');
  });
});

describe('probe L471 — failureMessage', () => {
  it('sorties vides — pas de « : » final', () => {
    expect(failureMessage('make', { status: 3, signal: null, stderr: '', stdout: '' }, 1000)).toBe('plan.onWrite en échec (make, code 3)');
    expect(failureMessage('make', { status: 3, signal: null, stderr: null, stdout: null }, 1000)).toBe('plan.onWrite en échec (make, code 3)');
  });
  it('tué par signal — le signal est nommé', () => {
    expect(failureMessage('make', { status: null, signal: 'SIGKILL', stderr: '', stdout: '' }, 1000)).toContain('code SIGKILL');
  });
  it('ETIMEDOUT — délai en secondes', () => {
    const error = Object.assign(new Error('spawnSync sh ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(failureMessage('make', { error, status: null, signal: 'SIGTERM', stderr: '', stdout: '' }, 120_000)).toContain('délai de 120 s dépassé');
  });
  it('pile Node — la raison est la ligne Error:, pas la ligne de pile', () => {
    const stderr = 'file.js:3\n  throw new Error("x")\nError: titre non conforme\n    at foo (a.js:1)\n\nNode.js v20.1.0';
    expect(failureMessage('node g.js', { status: 1, signal: null, stderr, stdout: '' }, 1000)).toBe('plan.onWrite en échec (node g.js, code 1) : titre non conforme'.replace('titre', 'Error: titre').replace('Error: titre', 'Error: titre'));
  });
  it('motif seulement sur la sortie standard — repris', () => {
    expect(failureMessage('make', { status: 1, signal: null, stderr: '', stdout: 'hors-ligne\n' }, 1000)).toContain(': hors-ligne');
  });
});

describe('probe L471 — warn : restauration et effets de bord', () => {
  it('warn : un fichier déclaré que la commande en échec a SUPPRIMÉ est remis', () => {
    const dir = project(warnCfg(`rm -f ${OUT}; exit 1`));
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, OUT), 'ancien\n');
    expect(cadence(dir, 'add', 'x').code).toBe(0);
    expect(readFileSync(join(dir, OUT), 'utf8')).toBe('ancien\n');
  });
  it('warn : un fichier NON déclaré écrit par la commande en échec n\'est pas cité comme « absent de files »', () => {
    const dir = project(warnCfg(`echo x > surprise.txt; exit 1`));
    const r = cadence(dir, 'add', 'x');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('absent de plan.onWrite.files');
  });
  it('warn : chemin déclaré « ./public/../public/plan.json » — normalisé, restauré comme le chemin simple', () => {
    const dir = project(warnCfg(`mkdir -p public; echo demi > ${OUT}; exit 1`, `['./public/../${OUT}']`));
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, OUT), 'ancien\n');
    expect(cadence(dir, 'add', 'x').code).toBe(0);
    expect(readFileSync(join(dir, OUT), 'utf8')).toBe('ancien\n');
  });
  it('warn : le fichier du plan déclaré par erreur dans files — le plan reste écrit (promesse « plan écrit quand même »)', () => {
    const dir = project(warnCfg('exit 1', `[${PLAN}]`));
    expect(cadence(dir, 'add', 'conservé').code).toBe(0);
    expect(readFileSync(join(dir, PLAN), 'utf8')).toContain('conservé');
  });
  it('warn : échec puis succès — le succès ne répète pas l\'avertissement et produit le fichier', () => {
    const dir = project(warnCfg(`test -f marche || exit 1; mkdir -p public; echo ok > ${OUT}`));
    expect(cadence(dir, 'add', 'a').err).toContain('plan écrit quand même');
    writeFileSync(join(dir, 'marche'), '');
    const r = cadence(dir, 'add', 'b');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('plan écrit quand même');
    expect(existsSync(join(dir, OUT))).toBe(true);
  });
  it('warn : le message exact finit par la mention de la copie publiée non à jour, une seule ligne d\'avertissement', () => {
    const dir = project(warnCfg('exit 4'));
    const r = cadence(dir, 'add', 'a');
    expect(r.err).toContain("plan écrit quand même (plan.onWrite.onFailure: warn), la copie publiée n'est pas à jour");
    expect(r.err.split('\n').filter((l) => l.includes('plan.onWrite en échec'))).toHaveLength(1);
  });
  it('warn : la commande qui réécrit le plan puis échoue — le plan écrit par la commande reste lisible (pas d\'« autre session » ensuite)', () => {
    const dir = project(warnCfg(`echo "# touche" >> ${PLAN}; exit 1`));
    expect(cadence(dir, 'add', 'a').code).toBe(0);
    expect(cadence(dir, 'add', 'b').code).toBe(0);
  });
  it('refuse : après un refus, la commande suivante qui réussit écrit bien (pas d\'état résiduel)', () => {
    const dir = project(`plan:\n  onWrite: { command: 'test -f marche', files: [] }\n`);
    expect(cadence(dir, 'add', 'a').code).toBe(2);
    writeFileSync(join(dir, 'marche'), '');
    expect(cadence(dir, 'add', 'b').code).toBe(0);
    expect(readFileSync(join(dir, PLAN), 'utf8')).toContain('b');
  });
});
