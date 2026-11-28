// L705 (D-7) : coupes du socle d'une session de cadence run, chiffrées par L694 (docs/mesures/socle-session-2026-11-11.md) et mesurées sur de vraies
// sessions le 12-11 (même page, « Coupes appliquées ») : C2, C3 et C4 sont des réglages passés par --settings, actifs dans chaque run ; C1 (worktree hors
// de l'arborescence du dépôt, sans le CLAUDE.md parent) est une option du dépôt (`run.worktreeOutside` de cadence.yaml), désactivée par défaut, car ce
// CLAUDE.md porte des consignes de sécurité (maritime-atlas : kubectl pointe sur la prod). Le banc ne prend aucune de ces coupes.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { lireSessionRun, type SessionRun } from '../../scripts/regeneration.mjs';
import { dossierCadence } from './verrou.js';

/** Les plugins que la session garde : cadence (ses skills, son hook de bornes) et playwright (voir l'écran). */
export const PLUGINS_GARDES = ['cadence', 'playwright'];

/** Dossier de configuration de Claude Code : `$CLAUDE_CONFIG_DIR`, sinon `~/.claude`. */
const dossierClaude = (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');

/** Plugins activés (`enabledPlugins: { "<id>": true }`) chez l'utilisateur et dans le projet du worktree : la règle de src/orchestrate/launch.ts (L398). */
function pluginsActifs(worktree: string, env: NodeJS.ProcessEnv): string[] {
  const home = dossierClaude(env), ids = new Set<string>();
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
export function reglagesRun(worktree: string, env: NodeJS.ProcessEnv = process.env, bras?: string, cites = ''): Record<string, unknown> {
  const actifs = pluginsActifs(worktree, env), coupes = actifs.filter((id) => !PLUGINS_GARDES.includes(id.split('@')[0]));
  return { ...(coupes.length ? { enabledPlugins: Object.fromEntries(coupes.map((id) => [id, false])) } : {}), disableClaudeAiConnectors: true, autoMemoryEnabled: false,
    ...coupesSession(worktree, env, actifs.filter((id) => !coupes.includes(id)), cites), ...premierPlan(bras) };
}

/**
 * L936 (D-45) : outils intégrés de Claude Code qui servent au lead ou à une session interactive, jamais à une session `claude -p` de cadence run
 * (publier une page, piloter un workflow ou une équipe d'agents, se réveiller plus tard, proposer un plugin, changer de worktree…). Leurs schémas
 * pesaient 20,5 k jetons au premier appel (mesure du 28-11, docs/mesures/socle-run-2026-11-28.md) ; ajoutés aux `--disallowedTools` du run, ils
 * disparaissent du contexte. Restent Bash, Read, Edit, Write, Agent, Skill, ToolSearch (outils différés de playwright), WebSearch, NotebookEdit…
 */
export const OUTILS_DU_LEAD = ['Artifact', 'ArtifactComments', 'ArtifactData', 'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync',
  'EnterWorktree', 'ExitWorktree', 'ListAgents', 'SendMessage', 'ListPlugins', 'ListSkills', 'SearchPlugins', 'SearchSkills', 'SuggestPluginInstall', 'SuggestSkills',
  'SendUserFile', 'PushNotification', 'RemoteTrigger', 'ReportFindings', 'Monitor'];

/** Options `run.session` du cadence.yaml du worktree (scripts/regeneration.mjs, le code de la validation de cadence.yaml) ; sans fichier : les défauts. */
export function optionsSession(worktree: string): SessionRun {
  const f = join(worktree, 'cadence.yaml');
  return lireSessionRun(existsSync(f) ? (parse(readFileSync(f, 'utf8')) as { run?: unknown } | null)?.run : undefined, f);
}

const lu = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
/** Le nom d'un agent ou d'un skill : le `name:` de son en-tête YAML, sinon `defaut` (nom du fichier ou du dossier). */
function nomDeclare(fichier: string, defaut: string): string {
  const lignes = lu(fichier).split(/\r?\n/), fin = lignes.indexOf('---', 1);
  if (lignes[0] !== '---' || fin < 0) return defaut;
  const l = lignes.slice(1, fin).find((x) => x.startsWith('name:'));
  return l?.slice(5).trim().replace(/^["']|["']$/g, '') || defaut;
}
const echappe = (t: string) => t.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
const agentsDe = (d: string, prefixe = '') => (existsSync(d) ? readdirSync(d) : []).filter((f) => f.endsWith('.md')).map((f) => prefixe + nomDeclare(join(d, f), basename(f, '.md')));
const skillsDe = (d: string, prefixe = '') => (existsSync(d) ? readdirSync(d) : []).filter((f) => existsSync(join(d, f, 'SKILL.md'))).map((f) => prefixe + nomDeclare(join(d, f, 'SKILL.md'), f));

/** Dossiers d'installation des plugins gardés (`installed_plugins.json` du dossier de Claude Code), avec le préfixe de leurs agents et skills (« cadence: »). */
function plugins(env: NodeJS.ProcessEnv, gardes: string[]): { dossier: string; prefixe: string }[] {
  let r: { plugins?: Record<string, { installPath?: string }[]> } | null = null;
  try { r = JSON.parse(readFileSync(join(dossierClaude(env), 'plugins', 'installed_plugins.json'), 'utf8')); } catch { return []; }
  return gardes.flatMap((id) => { const p = r?.plugins?.[id]?.find((x) => x.installPath)?.installPath; return p ? [{ dossier: p, prefixe: `${id.split('@')[0]}:` }] : []; });
}

/** CLAUDE.md que Claude Code charge depuis les dossiers au-dessus du worktree (`<dossier>/CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`), ceux qui existent. */
function claudeMdParents(worktree: string, utilisateur: string): string[] {
  const r: string[] = [];
  for (let d = dirname(resolve(worktree)); ; d = dirname(d)) {
    for (const f of [join(d, 'CLAUDE.md'), join(d, 'CLAUDE.local.md'), join(d, '.claude', 'CLAUDE.md')]) if (f !== utilisateur && existsSync(f)) r.push(f);
    if (dirname(d) === d) return r;
  }
}

/**
 * L936 (D-45) : ce que le socle d'une session du run ne garde pas de la configuration de l'utilisateur, selon `run.session` (mesure du 28-11 :
 * docs/mesures/socle-run-2026-11-28.md). Rien n'y est propre à un dossier : tout se lit sur la machine et dans le cadence.yaml du dépôt.
 * - `claudeMdExcludes` : le CLAUDE.md des dossiers au-dessus du dépôt (destiné au lead), sauf `parentClaudeMd: true` ; celui de l'utilisateur si `userClaudeMd: false` ;
 * - `permissions.deny` `Agent(<nom>)` : agents de l'utilisateur (`<config>/agents`) et des plugins gardés, sauf `keepAgents` ; ceux du projet et les intégrés restent ;
 * - `skillOverrides` `off` : skills de l'utilisateur (`<config>/skills`), sauf `keepSkills` et ceux que `cites` (demande et brief) ou un CLAUDE.md gardé
 *   nomment ; ceux du projet, des plugins (Claude Code 2.1.325 ne les coupe pas ainsi, mesuré le 28-11 : la liste les garde) et les intégrés restent ;
 * - `deniedMcpServers` : serveurs MCP de l'utilisateur (`mcpServers` de `.claude.json`), sauf `keepMcpServers` ; ceux du projet et des plugins restent.
 */
export function coupesSession(worktree: string, env: NodeJS.ProcessEnv, pluginsGardes: string[], cites = ''): Record<string, unknown> {
  const o = optionsSession(worktree), conf = dossierClaude(env), utilisateur = join(conf, 'CLAUDE.md');
  const exclus = [...(o.parentClaudeMd ? [] : claudeMdParents(worktree, utilisateur)), ...(!o.userClaudeMd && existsSync(utilisateur) ? [utilisateur] : [])];
  const gardesMd = [...(o.userClaudeMd ? [utilisateur] : []), ...(o.parentClaudeMd ? claudeMdParents(worktree, utilisateur) : []),
    ...['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')].map((f) => join(worktree, f))];
  const texte = [cites, ...gardesMd.map(lu)].join('\n'), dePlugins = plugins(env, pluginsGardes);
  const cite = (nom: string) => new RegExp(`(^|[^\\w:-])${echappe(nom)}($|[^\\w-])`).test(texte);
  const agents = [...agentsDe(join(conf, 'agents')), ...dePlugins.flatMap((p) => agentsDe(join(p.dossier, 'agents'), p.prefixe))].filter((n) => !o.keepAgents.includes(n));
  const skills = skillsDe(join(conf, 'skills')).filter((n) => !o.keepSkills.includes(n) && !cite(n));
  let mcp: string[] = [];
  try { mcp = Object.keys((JSON.parse(readFileSync(env.CLAUDE_CONFIG_DIR ? join(conf, '.claude.json') : join(env.HOME || homedir(), '.claude.json'), 'utf8')) as { mcpServers?: object }).mcpServers ?? {}); } catch { /* sans fichier : aucun */ }
  mcp = mcp.filter((n) => !o.keepMcpServers.includes(n));
  return { ...(exclus.length ? { claudeMdExcludes: exclus } : {}), ...(agents.length ? { permissions: { deny: [...new Set(agents)].map((n) => `Agent(${n})`) } } : {}),
    ...(skills.length ? { skillOverrides: Object.fromEntries(skills.map((n) => [n, 'off'])) } : {}), ...(mcp.length ? { deniedMcpServers: mcp.map((serverName) => ({ serverName })) } : {}) };
}

/** Une commande de la porte (`orchestrate.test`, `orchestrate.build`) a 30 min au plus ; c'est aussi le plafond du timeout d'un Bash de la session (L763). */
export const PORTE_MS = 30 * 60_000;
/** Dossier des hooks (v2/hooks), depuis src/ comme depuis dist/. */
export const HOOKS = join(import.meta.dirname, '..', 'hooks');

/**
 * L763 (issue #63) : une session claude -p n'est jamais réveillée par la fin d'une commande lancée en arrière-plan (deux runs bloqués le 17-11, 21 et
 * 55 min). Le hook PreToolUse `premier-plan.mjs` refuse Bash avec run_in_background et dit de jouer au premier plan ; `BASH_MAX_TIMEOUT_MS` (variable de
 * Claude Code, posée par la clé `env` des réglages) relève le plafond du timeout d'un Bash à celui d'une commande de la porte. Les hooks du bras (`bras` :
 * son fichier de réglages, `{{HOOKS}}` remplacé comme le fait ecrireReglages) sont gardés : une clé du socle remplace celle du bras, elle ne s'y ajoute pas.
 */
function premierPlan(bras?: string): { hooks: Record<string, unknown[]>; env: Record<string, string> } {
  const duBras = (bras ? (JSON.parse(readFileSync(bras, 'utf8').replaceAll('{{HOOKS}}', JSON.stringify(HOOKS).slice(1, -1))) as { hooks?: Record<string, unknown[]> }).hooks : undefined) ?? {};
  const hook = { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${join(HOOKS, 'premier-plan.mjs')}"`, timeout: 10 }] };
  return { hooks: { ...duBras, PreToolUse: [...(duBras.PreToolUse ?? []), hook] }, env: { BASH_MAX_TIMEOUT_MS: String(PORTE_MS) } };
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
