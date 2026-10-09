import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Effort } from '../config.js';
import { RafError } from '../plan.js';
import { killMarked, SESSION_MARK_VAR, TreeTracker } from '../proc.js';
import { isQuotaMessage, lacksStructuredOutput, parseSession, salvageUsage, sumTokens, tokensOf, type SessionResult, type Tokens } from './result.js';

export type StepKind = 'implement' | 'fix' | 'review' | 'ux' | 'review-small' | 'precheck';
export type Model = 'sonnet' | 'opus' | 'haiku';

export interface StepSpec {
  kind: StepKind;
  /** Identifiant de la session (uuid), passé à `claude --session-id` : son journal se retrouve sans deviner. */
  sessionId: string;
  brief: string;
  model: Model;
  /** Niveau d'effort de la passe (`--effort`, L137). Absent ou `default` : pas de drapeau. */
  effort?: Effort;
  /** Schéma JSON de la sortie structurée de l'étape. */
  schema: object;
  /** Agent du paquet (revues seulement). */
  agent?: string;
  cwd: string;
  wave: string;
  permissionMode: string;
  addDirs: string[];
  timeoutMs: number;
  /** Dossier `bin` d'un Node (`.nvmrc` du projet) : mis en tête du PATH de la session, jamais de l'orchestrateur. */
  nodeBin?: string;
  /** `<vague>/tool/bin` : `raf` et `cadence` de l'instantané, en tête du PATH de la session (avant le Node du projet). */
  toolBin?: string;
  /** Fichier de configuration MCP de l'étape (écrit par l'orchestrateur) : passé avec `--strict-mcp-config`, seuls ses serveurs sont chargés. */
  mcpConfig?: string;
  /** Le serveur Playwright est chargé pour cette étape : un agent aux outils restreints reçoit alors ses outils MCP. */
  playwright?: boolean;
}

export type McpServers = Record<string, { command: string; args: string[] }>;

/**
 * Serveurs MCP d'une étape : Playwright pour `ux` et, sur un lot `visible`, pour `implement` et `fix` (fix-minors compris) ;
 * et `review-small` d'un petit lot visible (sa seule revue d'ergonomie) ; rien pour `review`, ni pour un lot sans écran.
 * Sorties dans `outputDir`, hors du dépôt.
 */
export function mcpServersFor(kind: StepKind, visible: boolean, outputDir: string, small = false): McpServers {
  if (!(kind === 'ux' || (visible && (kind === 'implement' || kind === 'fix' || (kind === 'review-small' && small))))) return {};
  return { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--output-dir', outputDir] } };
}

/** Dossier de sortie du Playwright MCP d'un lot : `<lotDir>/playwright`, chemin absolu. */
export function playwrightDir(lotDir: string): string {
  return join(resolve(lotDir), 'playwright');
}

/** Écrit `<lotDir>/mcp-<étape>.json` (et, si Playwright est chargé, le dossier `playwright/`) ; rend le chemin absolu du fichier. */
export function writeMcpConfig(lotDir: string, kind: StepKind, visible: boolean, small = false): string {
  const dir = resolve(lotDir);
  const out = playwrightDir(dir);
  const servers = mcpServersFor(kind, visible, out, small);
  if (servers.playwright) mkdirSync(out, { recursive: true });
  const file = join(dir, `mcp-${kind}.json`);
  writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return file;
}

export interface AgentDef {
  description: string;
  prompt: string;
  tools?: string[];
}

export interface LaunchOutcome {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface LaunchOpts {
  cwd: string;
  /** Variables ajoutées à l'environnement du processus. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Appelé avec le pid dès le démarrage (pour l'état). */
  onSpawn?: (pid: number) => void;
}

/** Le lanceur : injecté dans les tests, `realClaude` en vrai. Jamais `--resume` d'une session de travail, sauf la relance de mise en forme. */
export type ClaudeFn = (args: string[], opts: LaunchOpts) => Promise<LaunchOutcome>;

/** Outils interdits à toute session : pas de sous-agent, pas de push, de livraison ni de verdict. */
export const DISALLOWED = ['Agent', 'Bash(git push:*)', 'Bash(cadence deliver:*)', 'Bash(raf done:*)', 'Bash(raf review:*)', 'Bash(raf ux:*)'];

/** Outils MCP du serveur Playwright, par le préfixe du serveur (sonde réelle du 07-10 : `mcp__playwright` expose tous les `browser_*`). */
export const PLAYWRIGHT_TOOLS = 'mcp__playwright';

/** Agents passés à `--agents` : l'agent d'une étape qui charge Playwright, s'il a une liste d'outils, y gagne les outils du serveur (sinon il ne peut pas l'appeler). */
function agentsFor(spec: StepSpec, agents: Record<string, AgentDef>): Record<string, AgentDef> {
  const a = spec.agent ? agents[spec.agent] : undefined;
  if (!spec.playwright || !spec.agent || !a?.tools) return agents;
  return { ...agents, [spec.agent]: { ...a, tools: [...a.tools, ...(a.tools.includes(PLAYWRIGHT_TOOLS) ? [] : [PLAYWRIGHT_TOOLS])] } };
}

function effortArgs(spec: StepSpec): string[] {
  return spec.effort && spec.effort !== 'default' ? ['--effort', spec.effort] : [];
}

export function buildArgs(spec: StepSpec, agents: Record<string, AgentDef>): string[] {
  const args = ['-p', spec.brief, '--output-format', 'json', '--json-schema', JSON.stringify(spec.schema), '--model', spec.model, ...effortArgs(spec)];
  if (spec.agent) {
    if (!agents[spec.agent]) throw new RafError(`agent introuvable dans le paquet : ${spec.agent}`);
    args.push('--agents', JSON.stringify(agentsFor(spec, agents)), '--agent', spec.agent);
  }
  args.push('--session-id', spec.sessionId, '--permission-mode', spec.permissionMode);
  for (const d of spec.addDirs) args.push('--add-dir', d);
  args.push('--disallowedTools', ...DISALLOWED);
  if (spec.mcpConfig) args.push('--strict-mcp-config', '--mcp-config', spec.mcpConfig);
  return args;
}

/** Définitions d'agents du paquet (`agents/*.md`) au format de --agents. */
export function readAgents(dir: string): Record<string, AgentDef> {
  const out: Record<string, AgentDef> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) continue;
    const meta = parse(m[1]) as { name?: string; description?: string; tools?: string };
    if (!meta?.name || !meta.description) continue;
    out[meta.name] = {
      description: meta.description,
      prompt: m[2].trim(),
      // Outils restreints : StructuredOutput ajouté, sinon --json-schema reste sans effet (la session finit en texte).
      ...(meta.tools ? { tools: [...String(meta.tools).split(',').map((t) => t.trim()).filter(Boolean), 'StructuredOutput'] } : {}),
    };
  }
  return out;
}

export type SessionOutcome =
  | { kind: 'ok'; result: SessionResult; /** Sortie brute de la première session, quand une relance de mise en forme a eu lieu. */ firstStdout?: string }
  | { kind: 'quota'; message: string; result?: SessionResult; tokens?: Tokens; sessionId?: string; firstStdout?: string }
  | { kind: 'failed'; cause: string; stdout: string; stderr: string; tokens?: Tokens; sessionId?: string; firstStdout?: string };

/** Consigne de la relance de mise en forme : rendre le rapport déjà établi au format demandé, rien d'autre. */
export const FORMAT_RETRY_PROMPT = 'Return your report now in the required format (the JSON structure of the schema), exactly as you concluded it. Do not do any further work, do not add anything else.';

/** Arguments de la relance : même session (--resume), mêmes schéma, modèle, agent (outils restreints), mode de permission, dossiers et interdits. */
export function buildRetryArgs(spec: StepSpec, sessionId: string, agents: Record<string, AgentDef>): string[] {
  const args = ['-p', FORMAT_RETRY_PROMPT, '--output-format', 'json', '--json-schema', JSON.stringify(spec.schema), '--model', spec.model, ...effortArgs(spec)];
  if (spec.agent) {
    if (!agents[spec.agent]) throw new RafError(`agent introuvable dans le paquet : ${spec.agent}`);
    args.push('--agents', JSON.stringify(agentsFor(spec, agents)), '--agent', spec.agent);
  }
  args.push('--resume', sessionId, '--permission-mode', spec.permissionMode);
  for (const d of spec.addDirs) args.push('--add-dir', d);
  args.push('--disallowedTools', ...DISALLOWED);
  if (spec.mcpConfig) args.push('--strict-mcp-config', '--mcp-config', spec.mcpConfig);
  return args;
}

/**
 * Lance une session et range son issue : ok, quota atteint, ou échec nommé (jamais de nouvel essai ici), à une
 * exception près : une session réussie qui finit en texte sans `structured_output` est relancée UNE fois, par
 * `--resume` de la même session, pour qu'elle rende son rapport au format demandé. Les jetons de la relance
 * s'ajoutent à ceux de la session ; toujours rien après elle, c'est l'échec habituel.
 */
export async function runSession(
  spec: StepSpec,
  deps: { claude: ClaudeFn; agents: Record<string, AgentDef>; onSpawn?: (pid: number) => void },
): Promise<SessionOutcome> {
  const launch = (args: string[]) =>
    deps.claude(args, { cwd: spec.cwd, env: { CADENCE_ORCHESTRATED: spec.wave, ...(spec.nodeBin || spec.toolBin ? { PATH: [spec.toolBin, spec.nodeBin, process.env.PATH ?? ''].filter(Boolean).join(delimiter) } : {}) }, timeoutMs: spec.timeoutMs, onSpawn: deps.onSpawn });
  const out = await launch(buildArgs(spec, deps.agents));
  const first = classify(out);
  const missing = first.kind === 'failed' && !out.timedOut && out.code === 0 ? lacksStructuredOutput(out.stdout) : null;
  if (!missing) return first;
  const spentFirst = first.kind === 'failed' ? first.tokens : undefined;
  const second = classify(await launch(buildRetryArgs(spec, missing.sessionId, deps.agents)));
  const total = (t?: Tokens): Tokens | undefined => (spentFirst && t ? sumTokens(spentFirst, t) : (t ?? spentFirst));
  if (second.kind === 'ok') return { kind: 'ok', result: { ...second.result, tokens: total(second.result.tokens)!, formattingRetry: true }, firstStdout: out.stdout };
  const tokens = total(second.tokens);
  return { ...second, firstStdout: out.stdout, ...(tokens ? { tokens } : {}), sessionId: second.sessionId ?? missing.sessionId };
}

function classify(out: LaunchOutcome): SessionOutcome {
  // Une session en échec a consommé des tokens : ceux de sa sortie, quand elle en donne, vont au budget.
  const salvaged = salvageUsage(out.stdout);
  const spent = salvaged ? { tokens: salvaged.tokens, sessionId: salvaged.sessionId } : {};
  const failed = (cause: string): SessionOutcome => ({ kind: 'failed', cause, stdout: out.stdout, stderr: out.stderr, ...spent });
  if (out.timedOut) return failed('délai dépassé');
  let result: SessionResult;
  try {
    result = parseSession(out.stdout, { structured: true });
  } catch (e) {
    // Une session arrêtée par le quota peut sortir sans structure : le message reste lisible dans stdout. Une session
    // RÉUSSIE sans structure n'est jamais un quota, même si son texte en parle (une revue du code de quota) : relance.
    if (!lacksStructuredOutput(out.stdout) && isQuotaMessage(out.stdout)) return { kind: 'quota', message: out.stdout.trim().slice(0, 300), ...spent };
    return failed(out.code !== 0 ? `code ${out.code} — ${(e as Error).message}` : (e as Error).message);
  }
  if (result.isError) {
    if (isQuotaMessage(result.result)) return { kind: 'quota', message: result.result, result, ...spent };
    return failed(`${result.subtype || 'erreur'} : ${result.result.slice(0, 300)}${out.code !== 0 ? ` (code ${out.code})` : ''}`);
  }
  if (out.code !== 0) return failed(`code ${out.code}`);
  return { kind: 'ok', result };
}

const live = new Set<number>();
const trees = new Set<TreeTracker>();
const marks = new Set<string>();

/** Suit un groupe de processus lancé par l'orchestrateur (commande du projet) : tué avec les sessions au signal. */
export function trackGroup(pid: number): () => void {
  live.add(pid);
  return () => live.delete(pid);
}

/** Tue les groupes de processus des sessions en cours (Ctrl-C, SIGTERM de l'orchestrateur). */
export function killSessions(): void {
  for (const pid of live) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // déjà mort
    }
  }
  live.clear();
  for (const t of trees) t.kill();
  trees.clear();
  for (const m of marks) killMarked(m);
  marks.clear();
}

/** Vrai lanceur : `claude` (ou CADENCE_CLAUDE_BIN) dans son propre groupe de processus, tué en bloc au délai. */
export function realClaude(bin: string, base: NodeJS.ProcessEnv = process.env): ClaudeFn {
  return (args, opts) =>
    new Promise((resolve) => {
      // Marque héritée par tous les descendants, même orphelins rattachés à init (un shell qui sort aussitôt après
      // `nohup srv &` échappe à tout relevé de l'arbre) : à la fin de la session, tout ce qui la porte est tué.
      const mark = randomUUID();
      marks.add(mark);
      const child = spawn(bin, args, { cwd: opts.cwd, env: { ...base, ...opts.env, [SESSION_MARK_VAR]: mark }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const pid = child.pid;
      if (pid === undefined) {
        marks.delete(mark);
        child.once('error', (e) => resolve({ code: 127, stdout: '', stderr: String(e.message), timedOut: false }));
        return;
      }
      live.add(pid);
      // Le groupe ne suffit pas : un serveur de dev lancé par la session (setsid, nohup, npm qui se détache) a son propre
      // groupe et survivait à la session (L83). L'arbre est suivi pendant toute la session ; la marque rattrape ce
      // qui a quitté l'arbre entre deux relevés.
      const tree = new TreeTracker(pid);
      trees.add(tree);
      opts.onSpawn?.(pid);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout!.on('data', (d: Buffer) => out.push(d));
      child.stderr!.on('data', (d: Buffer) => err.push(d));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        tree.kill();
        killMarked(mark);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // déjà mort
        }
      }, Math.max(1_000, opts.timeoutMs));
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        live.delete(pid);
        // Aucun descendant ne survit à la session, dans son groupe ou hors de lui.
        tree.rootExited();
        tree.kill();
        trees.delete(tree);
        killMarked(mark);
        marks.delete(mark);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // groupe vide
        }
        resolve({ code: code ?? (signal ? 137 : 1), stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
      });
    });
}

/** Dossier des journaux de sessions d'un répertoire : `<home>/projects/<chemin aplati>`. */
export function projectLogDir(claudeHome: string, cwd: string): string {
  return join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Pic de contexte d'une session relu dans son journal (entrée + écriture + lecture de cache d'un tour) ; null si absent. */
export function peakContext(claudeHome: string, cwd: string, sessionId: string): number | null {
  const file = join(projectLogDir(claudeHome, cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return null;
  let peak = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const u = JSON.parse(line)?.message?.usage;
      if (!u) continue;
      const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (n > peak) peak = n;
    } catch {
      // ligne partielle
    }
  }
  return peak;
}

/**
 * Consommation d'une session relue dans son journal, par son identifiant (`--session-id`) : somme des tours (un
 * message écrit sur plusieurs lignes n'est compté qu'une fois). Une session tuée (délai, signal) n'a rien rendu sur
 * sa sortie. Jamais de session devinée par date : un autre journal du même dossier n'est pas le sien. Null si rien n'est lisible.
 */
export function journalTokens(claudeHome: string, cwd: string, sessionId: string): { tokens: Tokens; sessionId: string } | null {
  const dir = projectLogDir(claudeHome, cwd);
  const id = sessionId;
  const file = join(dir, `${id}.jsonl`);
  if (!existsSync(file)) return null;
  const byMessage = new Map<string, number[]>();
  let anon = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const m = JSON.parse(line)?.message;
      const u = m?.usage;
      if (!u) continue;
      byMessage.set(typeof m.id === 'string' ? m.id : `anon-${anon++}`, [u.input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.output_tokens ?? 0]);
    } catch {
      // ligne partielle
    }
  }
  if (byMessage.size === 0) return null;
  const sum = [0, 0, 0, 0];
  for (const v of byMessage.values()) v.forEach((n, i) => (sum[i] += n));
  return { tokens: tokensOf(sum[0], sum[1], sum[2], sum[3]), sessionId: id };
}
