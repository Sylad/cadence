import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { RafError } from '../plan.js';
import { isQuotaMessage, parseSession, salvageUsage, tokensOf, type SessionResult, type Tokens } from './result.js';

export type StepKind = 'implement' | 'fix' | 'review' | 'ux' | 'review-small';
export type Model = 'sonnet' | 'opus' | 'haiku';

export interface StepSpec {
  kind: StepKind;
  brief: string;
  model: Model;
  /** Schéma JSON de la sortie structurée de l'étape. */
  schema: object;
  /** Agent du paquet (revues seulement). */
  agent?: string;
  cwd: string;
  wave: string;
  permissionMode: string;
  addDirs: string[];
  timeoutMs: number;
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

/** Le lanceur : injecté dans les tests, `realClaude` en vrai. Jamais `--resume` d'une session de travail. */
export type ClaudeFn = (args: string[], opts: LaunchOpts) => Promise<LaunchOutcome>;

/** Outils interdits à toute session : pas de sous-agent, pas de push, de livraison ni de verdict. */
export const DISALLOWED = ['Agent', 'Bash(git push:*)', 'Bash(cadence deliver:*)', 'Bash(raf done:*)', 'Bash(raf review:*)', 'Bash(raf ux:*)'];

export function buildArgs(spec: StepSpec, agents: Record<string, AgentDef>): string[] {
  const args = ['-p', spec.brief, '--output-format', 'json', '--json-schema', JSON.stringify(spec.schema), '--model', spec.model];
  if (spec.agent) {
    if (!agents[spec.agent]) throw new RafError(`agent introuvable dans le paquet : ${spec.agent}`);
    args.push('--agents', JSON.stringify(agents), '--agent', spec.agent);
  }
  args.push('--permission-mode', spec.permissionMode);
  for (const d of spec.addDirs) args.push('--add-dir', d);
  args.push('--disallowedTools', ...DISALLOWED);
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
      ...(meta.tools ? { tools: String(meta.tools).split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    };
  }
  return out;
}

export type SessionOutcome =
  | { kind: 'ok'; result: SessionResult }
  | { kind: 'quota'; message: string; result?: SessionResult; tokens?: Tokens; sessionId?: string }
  | { kind: 'failed'; cause: string; stdout: string; stderr: string; tokens?: Tokens; sessionId?: string };

/** Lance une session et range son issue : ok, quota atteint, ou échec nommé (jamais de nouvel essai ici). */
export async function runSession(
  spec: StepSpec,
  deps: { claude: ClaudeFn; agents: Record<string, AgentDef>; onSpawn?: (pid: number) => void },
): Promise<SessionOutcome> {
  const args = buildArgs(spec, deps.agents);
  const out = await deps.claude(args, {
    cwd: spec.cwd,
    env: { CADENCE_ORCHESTRATED: spec.wave },
    timeoutMs: spec.timeoutMs,
    onSpawn: deps.onSpawn,
  });
  // Une session en échec a consommé des tokens : ceux de sa sortie, quand elle en donne, vont au budget.
  const salvaged = salvageUsage(out.stdout);
  const spent = salvaged ? { tokens: salvaged.tokens, sessionId: salvaged.sessionId } : {};
  const failed = (cause: string): SessionOutcome => ({ kind: 'failed', cause, stdout: out.stdout, stderr: out.stderr, ...spent });
  if (out.timedOut) return failed('délai dépassé');
  let result: SessionResult;
  try {
    result = parseSession(out.stdout, { structured: true });
  } catch (e) {
    // Une session arrêtée par le quota peut sortir sans structure : le message reste lisible dans stdout.
    if (isQuotaMessage(out.stdout)) return { kind: 'quota', message: out.stdout.trim().slice(0, 300), ...spent };
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
}

/** Vrai lanceur : `claude` (ou CADENCE_CLAUDE_BIN) dans son propre groupe de processus, tué en bloc au délai. */
export function realClaude(bin: string, base: NodeJS.ProcessEnv = process.env): ClaudeFn {
  return (args, opts) =>
    new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: opts.cwd, env: { ...base, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      const pid = child.pid;
      if (pid === undefined) {
        child.once('error', (e) => resolve({ code: 127, stdout: '', stderr: String(e.message), timedOut: false }));
        return;
      }
      live.add(pid);
      opts.onSpawn?.(pid);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout!.on('data', (d: Buffer) => out.push(d));
      child.stderr!.on('data', (d: Buffer) => err.push(d));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // déjà mort
        }
      }, Math.max(1_000, opts.timeoutMs));
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        live.delete(pid);
        // Un enfant resté dans le groupe ne survit pas à la session.
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
 * Consommation d'une session relue dans son journal : somme des tours (un message écrit sur plusieurs lignes n'est
 * compté qu'une fois). Par identifiant de session, sinon la session la plus récente du dossier depuis `since` (ms) —
 * une session tuée (délai) n'a rien rendu sur sa sortie. Null si rien n'est lisible.
 */
export function journalTokens(claudeHome: string, cwd: string, find: { sessionId?: string; since?: number }): { tokens: Tokens; sessionId: string } | null {
  const dir = projectLogDir(claudeHome, cwd);
  let id = find.sessionId;
  if (!id) {
    if (!existsSync(dir) || find.since === undefined) return null;
    const recent = readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .filter((f) => f.t >= find.since!)
      .sort((a, b) => b.t - a.t)[0];
    if (!recent) return null;
    id = recent.n.slice(0, -'.jsonl'.length);
  }
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
