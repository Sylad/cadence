import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, testPackage } from './helpers.js';
import { COMMAND_TABLES, run } from '../src/cli.js';

async function aide(arg: string): Promise<string> {
  const out: string[] = [];
  const code = await run([arg], { cwd: tempDir(), env: {}, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date() });
  expect(code).toBe(0);
  return out.join('\n');
}

const bin = join(testPackage(), 'bin/cadence.js');
const binAide = (...args: string[]) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' }).trimEnd();

/** Les sous-commandes que le code dispatche (src/cli/*.ts, claude-hook.ts, ref/command.ts) : chacune doit figurer dans l'aide. */
const SOUS_COMMANDES: Record<string, string[]> = {
  session: ['start', 'close', 'next', 'context'],
  spec: ['check', 'qa', 'reseal', 'green'],
  local: ['start', 'done', 'abort'],
  'claude-hook': ['retour', 'attente', 'pipe'],
  skills: ['install'],
  ref: ['add', 'measure', 'analyse', 'check', 'eval', 'diff', 'coverage', 'corpus'],
  lead: ['tour', 'hold', 'release', 'priority'],
  deliver: ['--block', '--dry-run'],
  verify: ['--gate'],
  orchestrate: ['--goal', '--no-fill', '--waits', '--continue'],
};

describe('une seule aide (L597)', () => {
  it('R1 — cadence sans outil, cadence --help et cadence help impriment exactement l\'aide de run([\'help\'])', async () => {
    const attendu = (await aide('help')).trimEnd();
    expect(binAide()).toBe(attendu);
    expect(binAide('--help')).toBe(attendu);
    expect(binAide('help')).toBe(attendu);
  });

  it('R2 — bin/cadence.js ne tient plus de texte d\'aide', () => {
    const source = readFileSync(join(import.meta.dirname, '../bin/cadence.js'), 'utf8');
    expect(source).not.toContain('cadence raf …');
    expect(source).not.toContain('plan « reste à faire »');
  });

  it('R3 — chaque commande de la table de dispatch figure dans l\'aide', async () => {
    const texte = await aide('help');
    const manquantes = COMMAND_TABLES.filter((c) => !new RegExp(`(?:raf|cadence|\\|) ${c}\\b`).test(texte));
    expect(manquantes).toEqual([]);
  });

  it('R4 — chaque sous-commande du code figure dans l\'aide, sur une ligne de sa commande', async () => {
    const lignes = (await aide('help')).split('\n');
    const manquantes: string[] = [];
    for (const [cmd, subs] of Object.entries(SOUS_COMMANDES)) {
      for (const s of subs) {
        const motif = new RegExp(`cadence ${cmd}\\b.*(?<![\\w-])${s.replace(/[-]/g, '\\-')}(?![\\w-])`);
        if (!lignes.some((l) => motif.test(l))) manquantes.push(`${cmd} ${s}`);
      }
    }
    expect(manquantes).toEqual([]);
  });

  it('R5 — cadence spec green est dans l\'aide, avec son effet', async () => {
    expect(await aide('help')).toMatch(/cadence spec green <lot>.*vert: true/);
  });

  it('R6 — cadence skills install ne promet pas une liste figée de skills', async () => {
    expect(await aide('help')).not.toContain('session-start, session-close, deliver et l\'agent ux-reviewer');
  });

  it('R7 — aucune ligne d\'aide n\'est écrite deux fois', async () => {
    const lignes = (await aide('help')).split('\n').filter((l) => l.trim() !== '');
    const doubles = lignes.filter((l, i) => lignes.indexOf(l) !== i);
    expect(doubles).toEqual([]);
  });

  it('R8 — un outil inconnu garde le code 2, nommé sur la sortie d\'erreur, sans aide sur la sortie standard', () => {
    const r = spawnSync(process.execPath, [bin, 'bogus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('outil inconnu : bogus');
  });
});
