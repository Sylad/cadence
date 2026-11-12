// L705 (D-7) : coupes du socle d'une session de cadence run, chiffrées par L694 (docs/mesures/socle-session-2026-11-11.md) et mesurées sur de vraies
// sessions le 12-11 (même page, « Coupes appliquées ») : C2, C3 et C4 sont des réglages passés par --settings, actifs dans chaque run ; C1 (worktree hors
// de l'arborescence du dépôt, sans le CLAUDE.md parent) est une option du dépôt (`run.worktreeOutside` de cadence.yaml), désactivée par défaut, car ce
// CLAUDE.md porte des consignes de sécurité (maritime-atlas : kubectl pointe sur la prod). Le banc ne prend aucune de ces coupes.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { dossierCadence } from './verrou.js';

/** Les plugins que la session garde : cadence (ses skills, son hook de bornes) et playwright (voir l'écran). */
export const PLUGINS_GARDES = ['cadence', 'playwright'];

/** Plugins activés (`enabledPlugins: { "<id>": true }`) chez l'utilisateur et dans le projet du worktree : la règle de src/orchestrate/launch.ts (L398). */
function pluginsActifs(worktree: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'), ids = new Set<string>();
  for (const f of [join(home, 'settings.json'), join(worktree, '.claude', 'settings.json'), join(worktree, '.claude', 'settings.local.json')]) {
    let r: { enabledPlugins?: Record<string, unknown> } | null;
    try { r = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    for (const [id, actif] of Object.entries(r?.enabledPlugins ?? {})) if (actif === true) ids.add(id);
  }
  return [...ids];
}

/**
 * Réglages ajoutés au `--settings` de chaque session du run (documentation officielle de Claude Code, lue le 12-11) :
 * C2 `enabledPlugins` à false pour les plugins activés sauf ceux de PLUGINS_GARDES ; C3 `disableClaudeAiConnectors` (connecteurs du compte claude.ai,
 * code.claude.com/docs/en/mcp « Disable claude.ai connectors » ; les serveurs des plugins restent) ; C4 `autoMemoryEnabled` à false (mémoire auto,
 * code.claude.com/docs/en/memory). Les autres réglages de l'utilisateur et du projet s'appliquent comme avant.
 */
export function reglagesRun(worktree: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const coupes = pluginsActifs(worktree, env).filter((id) => !PLUGINS_GARDES.includes(id.split('@')[0]));
  return { ...(coupes.length ? { enabledPlugins: Object.fromEntries(coupes.map((id) => [id, false])) } : {}), disableClaudeAiConnectors: true, autoMemoryEnabled: false };
}

/** C1 : `run.worktreeOutside: true` dans le cadence.yaml du dépôt (une autre valeur que true ou false est refusée avant toute création) met le worktree sous
 * CADENCE_HOME/run-worktrees (défaut ~/.cadence/orchestrate), loin de tout CLAUDE.md de projet ; sinon sous `runs` (../.cadence-run). Crée son dossier parent. */
export function cheminWorktree(repo: string, runs: string, nom: string): string {
  const f = join(repo, 'cadence.yaml');
  const v = (existsSync(f) ? (parse(readFileSync(f, 'utf8')) as { run?: { worktreeOutside?: unknown } } | null)?.run : undefined)?.worktreeOutside;
  if (v !== undefined && typeof v !== 'boolean') throw new Error(`cadence.yaml : run.worktreeOutside : true ou false attendu (reçu « ${String(v)} »)`);
  const w = join(v ? join(dossierCadence(), 'run-worktrees') : runs, nom);
  mkdirSync(dirname(w), { recursive: true });
  return w;
}
