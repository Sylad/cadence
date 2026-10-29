import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { porteDuMod, typesDuMod } from '../scripts/porte-mod.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
afterAll(cleanupTempDirs);

/** Un mod de test : son dossier et le dossier des mods que Claude Code a chargés (~/.claude/mods). */
function decor({ typesDuMod: chargé = true, typesLocaux = false } = {}) {
  const racine = tempDir();
  const dir = join(racine, 'plugins', 'cadence-hud');
  const mods = join(racine, 'mods');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cadence-hud' }));
  if (chargé) {
    mkdirSync(join(mods, 'cadence-hud', '.claude-plugin', 'types', 'claude-code'), { recursive: true });
    writeFileSync(join(mods, 'cadence-hud', '.claude-plugin', 'types', 'tsconfig.json'), '{}');
    writeFileSync(join(mods, 'cadence-hud', '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), '');
  }
  if (typesLocaux) {
    mkdirSync(join(dir, '.claude-plugin', 'types'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'types', 'tsconfig.json'), '{"local":true}');
  }
  return { dir, mods };
}

/** Un lanceur qui note les commandes et rend le code voulu pour chacune. */
function lanceur(codes: Record<string, number> = {}) {
  const appels: string[] = [];
  const run = (commande: string, args: string[]) => {
    const nom = [commande, ...args].join(' ');
    appels.push(nom);
    const code = Object.entries(codes).find(([k]) => nom.includes(k))?.[1] ?? 0;
    return { status: code, output: `sortie de ${nom}\n` };
  };
  return { run, appels };
}

describe('porte du mod cadence-hud (L417)', () => {
  it('R1 — la porte joue claude plugin test puis tsc -p sur le dossier du mod', () => {
    const { dir, mods } = decor();
    const { run, appels } = lanceur();
    const r = porteDuMod({ dir, mods, run });
    expect(r.ok).toBe(true);
    expect(appels).toHaveLength(2);
    expect(appels[0]).toBe(`claude plugin test ${dir}`);
    expect(appels[1]).toMatch(/tsc(\.js)? -p .*cadence-hud --noEmit$/);
  });

  it('R2 — les types générés absents du mod sont pris dans la copie que Claude Code a chargée', () => {
    const { dir, mods } = decor();
    expect(typesDuMod({ dir, mods })).toBe('copiés');
    expect(existsSync(join(dir, '.claude-plugin', 'types', 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'))).toBe(true);
  });

  it('R2 — des types déjà là ne sont pas écrasés', () => {
    const { dir, mods } = decor({ typesLocaux: true });
    expect(typesDuMod({ dir, mods })).toBe('présents');
  });

  it('R3 — sans types générés nulle part, la porte est rouge et le dit, jamais un tsc sauté', () => {
    const { dir, mods } = decor({ typesDuMod: false });
    const { run, appels } = lanceur();
    const r = porteDuMod({ dir, mods, run });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/types générés/);
    expect(appels.some((a) => a.includes('tsc'))).toBe(false);
  });

  it('R4 — un claude plugin test rouge rend la porte rouge, et tsc est joué quand même', () => {
    const { dir, mods } = decor();
    const { run, appels } = lanceur({ 'plugin test': 1 });
    const r = porteDuMod({ dir, mods, run });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('sortie de claude plugin test');
    expect(appels).toHaveLength(2);
  });

  it('R4 — des erreurs de typage rendent la porte rouge avec leur sortie', () => {
    const { dir, mods } = decor();
    const { run } = lanceur({ tsc: 2 });
    const r = porteDuMod({ dir, mods, run });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('tsc');
  });

  // La porte réelle : vitest exclut plugins/**, c'est ce test qui fait jouer le mod à la vague (cadence.yaml : orchestrate.test).
  const claudeDisponible = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!claudeDisponible)('R5 — le mod cadence-hud passe ses tests et son typage', () => {
    const r = porteDuMod({ dir: join(REPO, 'plugins', 'cadence-hud') });
    expect(r.output.split('\n').filter((l) => /error TS|\(fail\)/.test(l))).toEqual([]);
    expect(r.ok).toBe(true);
  }, 120_000);
});
