#!/usr/bin/env node
// Porte du mod cadence-hud (L417) : vitest exclut plugins/** (le mod se teste avec `claude plugin test`), et sa suite ne vérifie pas le typage.
// 43 erreurs de `tsc -p plugins/cadence-hud` (L402, 28-10) et un faux rouge du mod sous charge (29-10) sont passés sans que la porte les voie.
//   node scripts/porte-mod.mjs [dossier-du-mod]
// Joue `claude plugin test <mod>` puis `tsc -p <mod> --noEmit`, les deux même si le premier est rouge ; sort en 1 si l'un l'est.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Lance une commande, sortie recueillie ; un binaire introuvable est un échec, pas une exception. */
function lancer(commande, args) {
  const r = spawnSync(commande, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `${r.error.message}\n` : ''}` };
}

/**
 * Les types que le tsconfig du mod étend (`.claude-plugin/types`) sont écrits par Claude Code quand il charge le mod : un worktree neuf n'en a pas.
 * Absents, ils sont pris dans la copie du mod que Claude Code a chargée (`<mods>/<nom>/.claude-plugin/types`, git les ignore) ; nulle part : on rend `null`.
 * @returns {'présents' | 'copiés' | null}
 */
export function typesDuMod({ dir, mods = join(homedir(), '.claude', 'mods') }) {
  const cible = join(dir, '.claude-plugin', 'types');
  if (existsSync(join(cible, 'tsconfig.json'))) return 'présents';
  const nom = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  const source = join(mods, nom, '.claude-plugin', 'types');
  if (!existsSync(join(source, 'tsconfig.json'))) return null;
  cpSync(source, cible, { recursive: true });
  return 'copiés';
}

/** @returns {{ ok: boolean, output: string }} */
export function porteDuMod({ dir, mods, run = lancer }) {
  const sorties = [];
  let ok = true;
  const jouer = (commande, args) => {
    const r = run(commande, args);
    sorties.push(`$ ${[commande, ...args].join(' ')}\n${r.output}`);
    if (r.status !== 0) {
      ok = false;
      sorties.push(`→ code ${r.status}\n`);
    }
  };
  jouer('claude', ['plugin', 'test', dir]);
  if (typesDuMod({ dir, mods }) === null) {
    ok = false;
    sorties.push(`porte du mod : types générés absents de ${dir}/.claude-plugin/types et du mod chargé par Claude Code — chargez le mod une fois (claude --plugin-dir) : le typage ne se saute pas\n`);
  } else {
    jouer(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', dir, '--noEmit']);
  }
  return { ok, output: sorties.join('') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = porteDuMod({ dir: resolve(process.argv[2] ?? join(REPO, 'plugins', 'cadence-hud')) });
  process.stdout.write(r.output);
  process.exit(r.ok ? 0 : 1);
}
