import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Effort } from '../config.js';
import { RafError } from '../plan.js';
import { sandboxEnv } from './sandbox.js';
import { SlotAbandoned } from './registry.js';
import { killMarked, SESSION_MARK_VAR, TreeTracker } from '../proc.js';
import { isQuotaMessage, lacksStructuredOutput, parseSession, salvageUsage, sumTokens, tokensOf, type SessionResult, type Tokens } from './result.js';

/** Les étapes qui sont une session de claude. */
export type SessionKind = 'implement' | 'fix' | 'review' | 'ux' | 'review-small' | 'precheck' | 'spec' | 'accept' | 'maquette' | 'fiche';
/** Les étapes d'un lot : ses sessions, plus l'intégration à la branche du dépôt (L279, R14), que le programme joue seul : elle ne passe par aucune table de sessions (schéma, gabarit, modèle). */
export type StepKind = SessionKind | 'integrate';
export type Model = 'sonnet' | 'opus' | 'haiku';
/** Modèle d'une étape : celui de Claude, ou `local` (claude-local → Ollama, L146). */
export type StepModel = Model | 'local';

export interface StepSpec {
  /** Une étape d'une vague, ou `ref` : la lecture de `cadence ref analyse`, lancée hors vague par la même mécanique de session. */
  kind: SessionKind | 'ref';
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
  /** Clé du lot (`projet:lot`), pour le journal de l'attente d'un créneau. */
  lot?: string;
  permissionMode: string;
  addDirs: string[];
  timeoutMs: number;
  /** Prolongation à l'échéance d'une étape d'écriture qui commite (L298), transmise au lanceur. */
  extend?: LaunchOpts['extend'];
  /** Dossier `bin` d'un Node (`.nvmrc` du projet) : mis en tête du PATH de la session, jamais de l'orchestrateur. */
  nodeBin?: string;
  /** `<vague>/tool/bin` : `raf` et `cadence` de l'instantané, en tête du PATH de la session (avant le Node du projet). */
  toolBin?: string;
  /** Fichier de configuration MCP de l'étape (écrit par l'orchestrateur) : passé avec `--strict-mcp-config`, seuls ses serveurs sont chargés. */
  mcpConfig?: string;
  /** Le serveur Playwright est chargé pour cette étape : un agent aux outils restreints reçoit alors ses outils MCP. */
  playwright?: boolean;
  /** Étape lancée par `claude-local` (modèle Ollama de Big-Blue, hors quota) : arguments de `buildLocalArgs`, jamais de relance `--resume` (L146). */
  local?: boolean;
  /** Dossier temporaire de la session (L242) : exporté en `TMPDIR`, hors du dépôt, pour que ses journaux et dumps n'y salissent pas l'arbre de travail. */
  tmpDir?: string;
  /** La session n'a pas accès à la production (L168) : `prodAccess` du projet lève la restriction (défaut : coupé). */
  prodAccess?: boolean;
}

export type McpServers = Record<string, { command: string; args: string[] }>;

/**
 * Serveurs MCP d'une étape : Playwright pour `ux` et `maquette` (revue des captures et du HTML local, L172) et, sur un lot `visible`, pour `spec` quand il a un écran `screen:` (rendu 1440/390 de la maquette, L171), `implement` et `fix` (fix-minors compris) ;
 * et `review-small` d'un petit lot visible (sa seule revue d'ergonomie) ; rien pour `review`, ni pour un lot sans écran.
 * Sorties dans `outputDir`, hors du dépôt.
 */
export function mcpServersFor(kind: SessionKind, visible: boolean, outputDir: string, small = false, screen = true): McpServers {
  if (!(kind === 'ux' || kind === 'maquette' || (visible && ((kind === 'spec' && screen) || kind === 'implement' || kind === 'fix' || (kind === 'review-small' && small))))) return {};
  // La maquette est un fichier local : sans cette option le serveur bloque toute URL file:// (« Access to "file:" protocol is blocked »).
  const files = kind === 'maquette' || kind === 'spec' ? ['--allow-unrestricted-file-access'] : [];
  return { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', ...files, '--output-dir', outputDir] } };
}

/** Dossier de sortie du Playwright MCP d'un lot : `<lotDir>/playwright`, chemin absolu. */
export function playwrightDir(lotDir: string): string {
  return join(resolve(lotDir), 'playwright');
}

/** Écrit `<lotDir>/mcp-<étape>.json` (et, si Playwright est chargé, le dossier `playwright/`) ; rend le chemin absolu du fichier. */
export function writeMcpConfig(lotDir: string, kind: SessionKind, visible: boolean, small = false, screen = true): string {
  const dir = resolve(lotDir);
  const out = playwrightDir(dir);
  const servers = mcpServersFor(kind, visible, out, small, screen);
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
  /** Lancer `claude-local` plutôt que `claude` (L146). */
  local?: boolean;
  /** Variables retirées de l'environnement hérité (accès à la production, L168). */
  unset?: string[];
  /** Clé du lot (`projet:lot`) qui lance la session : l'attente d'un créneau s'inscrit au journal sous ce lot. */
  lot?: string;
  /**
   * Prolongation à l'échéance (L298) : `progressed()` dit si la session a commité depuis la dernière échéance (ou son départ) ;
   * si oui, elle reçoit `ms` de plus, `max` fois au plus. Absent : l'échéance coupe.
   */
  extend?: { progressed: () => boolean; ms: number; max: number };
}

/** Le lanceur : injecté dans les tests, `realClaude` en vrai. Jamais `--resume` d'une session de travail, sauf la relance de mise en forme. */
export type ClaudeFn = (args: string[], opts: LaunchOpts) => Promise<LaunchOutcome>;

/** Outils interdits à toute session : pas de sous-agent, pas de push, de livraison, de verdict ni de rescellé d'un test d'acceptation (le chemin du lead, L200) ; pas de `Monitor` (tâche de fond que `-p` attend, L285). */
export const DISALLOWED = ['Agent', 'Monitor', 'Bash(git push:*)', 'Bash(cadence deliver:*)', 'Bash(raf done:*)', 'Bash(raf review:*)', 'Bash(raf ux:*)', 'Bash(cadence spec reseal:*)', 'Bash(raf spec reseal:*)'];

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

/** Retire `run_in_background` de Bash et des sous-agents : `claude -p` attend toute tâche de fond avant de sortir (jusqu'à 10 min d'inactivité), la session finie ne rendait pas la main (L285). */
export const NO_BACKGROUND_ENV = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };

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

/**
 * Arguments de `claude-local` (L146) : le prompt vient en premier, le script ajoute lui-même `--bare`, `--model` et le
 * serveur Ollama. Le harnais `--bare` ne charge pas `--agents` : le prompt de l'agent est joint au brief et ses outils
 * passent par `--tools`. Pas de `--effort`, pas de MCP (aucune étape locale n'en charge).
 */
export function buildLocalArgs(spec: StepSpec, agents: Record<string, AgentDef>): string[] {
  const a = spec.agent ? agents[spec.agent] : undefined;
  if (spec.agent && !a) throw new RafError(`agent introuvable dans le paquet : ${spec.agent}`);
  const args = [a ? `${a.prompt}\n\n${spec.brief}` : spec.brief, '--output-format', 'json', '--json-schema', JSON.stringify(spec.schema)];
  if (a?.tools) args.push('--tools', a.tools.join(','));
  args.push('--session-id', spec.sessionId, '--permission-mode', spec.permissionMode);
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
      // Outils restreints : StructuredOutput ajouté, sinon --json-schema reste sans effet (la session finit en texte).
      ...(meta.tools ? { tools: [...String(meta.tools).split(',').map((t) => t.trim()).filter(Boolean), 'StructuredOutput'] } : {}),
    };
  }
  return out;
}

/** Une session coupée (signal, sortie vide) que `runSession` a relancée en session neuve : son identifiant (ses jetons sont à compter), la cause, sa sortie d'erreur. */
export interface Relaunched {
  sessionId: string;
  cause: string;
  stderr: string;
}

export type SessionOutcome =
  | { kind: 'ok'; result: SessionResult; /** Sortie brute de la première session, quand une relance de mise en forme a eu lieu. */ firstStdout?: string; relaunched?: Relaunched }
  | { kind: 'quota'; message: string; result?: SessionResult; tokens?: Tokens; sessionId?: string; firstStdout?: string; relaunched?: Relaunched }
  | { kind: 'failed'; cause: string; stdout: string; stderr: string; tokens?: Tokens; sessionId?: string; firstStdout?: string; relaunched?: Relaunched; /** Vrai quand la session a été coupée (signal, sortie vide), y compris après sa relance : ni un quota, ni un échec ordinaire. */ cut?: boolean };

/** Étapes relancées à neuf après une coupure : celles en lecture seule, et `ref`, qui n'écrit que sa lecture (`lectures/a.json` ou `b.json`, le troisième regard n'écrit rien), que le programme valide ensuite (une étape d'écriture ordinaire a pu laisser un travail à moitié fait). */
const READ_ONLY: ReadonlySet<StepSpec['kind']> = new Set(['review', 'review-small', 'ux', 'precheck', 'maquette', 'fiche', 'ref']);

/** Session tuée par un signal (code 128 + n : 143 SIGTERM, 137 SIGKILL…) sans rien écrire : la coupure, ni un quota (un message) ni un échec (une sortie). */
const isCut = (out: LaunchOutcome): boolean => !out.timedOut && out.code > 128 && out.stdout.trim() === '';

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
 * Seconde exception (L256) : une étape en lecture coupée par un signal sans rien écrire (code 143, sortie vide) est
 * relancée UNE fois à l'identique en session NEUVE (autre `--session-id`, jamais `--resume` : la coupée n'a rien à reprendre) ;
 * coupée de nouveau, elle rend un échec marqué `cut`. `onRelaunch` reçoit l'identifiant de la session neuve juste avant son lancement. Le quota, le délai et un code ordinaire ne sont jamais relancés.
 */
export async function runSession(
  spec: StepSpec,
  deps: { claude: ClaudeFn; agents: Record<string, AgentDef>; onSpawn?: (pid: number) => void; onRelaunch?: (sessionId: string) => void },
): Promise<SessionOutcome> {
  const sandbox = sandboxEnv(!!spec.prodAccess);
  const launch = (args: string[]) =>
    deps.claude(args, { local: spec.local, cwd: spec.cwd, unset: sandbox.unset, env: { CADENCE_ORCHESTRATED: spec.wave, ...NO_BACKGROUND_ENV, ...sandbox.set, ...(spec.tmpDir ? { TMPDIR: spec.tmpDir } : {}), ...(spec.nodeBin || spec.toolBin ? { PATH: [spec.toolBin, spec.nodeBin, process.env.PATH ?? ''].filter(Boolean).join(delimiter) } : {}) }, timeoutMs: spec.timeoutMs, extend: spec.extend, onSpawn: deps.onSpawn, lot: spec.lot });
  const epoch = killEpoch;
  const out = await launch(spec.local ? buildLocalArgs(spec, deps.agents) : buildArgs(spec, deps.agents));
  const first = classify(out);
  if (spec.local) return first; // pas de relance de mise en forme : l'appelant se replie sur Sonnet
  // Une session tuée par `killSessions` (arrêt de la vague) n'est pas une coupure à relancer : la neuve survivrait à l'orchestrateur.
  if (first.kind === 'failed' && READ_ONLY.has(spec.kind) && isCut(out) && killEpoch === epoch) {
    const relaunched: Relaunched = { sessionId: spec.sessionId, cause: `code ${out.code}, sortie vide`, stderr: out.stderr };
    const fresh = randomUUID();
    deps.onRelaunch?.(fresh); // l'appelant l'enregistre AVANT le lancement : un signal pendant la relance retrouve la session neuve
    // Relance qui doit attendre un créneau et voit une demande d'arrêt (L332) : la session coupée ne se perd pas avec l'abandon.
    const again = await launch(buildArgs({ ...spec, sessionId: fresh }, deps.agents)).catch((e: unknown) => {
      if (e instanceof SlotAbandoned) e.after = { relaunched };
      throw e;
    });
    const next = classify(again);
    if (next.kind === 'ok') return { ...next, relaunched };
    const tail = { ...next, sessionId: next.sessionId ?? fresh, relaunched };
    return tail.kind === 'failed' && isCut(again) ? { ...tail, cut: true, cause: `coupée (${relaunched.cause}), relancée une fois en session neuve, coupée de nouveau` } : tail;
  }
  const missing = first.kind === 'failed' && !out.timedOut && out.code === 0 ? lacksStructuredOutput(out.stdout) : null;
  if (!missing) return first;
  const spentFirst = first.kind === 'failed' ? first.tokens : undefined;
  const second = classify(
    await launch(buildRetryArgs(spec, missing.sessionId, deps.agents)).catch((e: unknown) => {
      if (e instanceof SlotAbandoned) e.after = { formatting: { stdout: out.stdout, stderr: out.stderr, ...(spentFirst ? { tokens: spentFirst } : {}), sessionId: missing.sessionId } };
      throw e;
    }),
  );
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
/** Compte les arrêts de la vague (`killSessions`) : une session qui finit après un arrêt n'est pas relancée. */
let killEpoch = 0;

/** Suit un groupe de processus lancé par l'orchestrateur (commande du projet) : tué avec les sessions au signal. */
export function trackGroup(pid: number): () => void {
  live.add(pid);
  return () => live.delete(pid);
}

/** Tue les groupes de processus des sessions en cours (Ctrl-C, SIGTERM de l'orchestrateur). */
export function killSessions(): void {
  killEpoch++;
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
export function realClaude(bin: string, base: NodeJS.ProcessEnv = process.env, localBin = 'claude-local'): ClaudeFn {
  return (args, opts) =>
    new Promise((resolve) => {
      // Marque héritée par tous les descendants, même orphelins rattachés à init (un shell qui sort aussitôt après
      // `nohup srv &` échappe à tout relevé de l'arbre) : à la fin de la session, tout ce qui la porte est tué.
      const mark = randomUUID();
      marks.add(mark);
      const inherited = { ...base };
      for (const v of opts.unset ?? []) delete inherited[v];
      const child = spawn(opts.local ? localBin : bin, args, { cwd: opts.cwd, env: { ...inherited, ...opts.env, [SESSION_MARK_VAR]: mark }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
      let extended = 0;
      const deadline = (): void => {
        if (opts.extend && extended < opts.extend.max && opts.extend.progressed()) {
          extended++;
          timer = setTimeout(deadline, Math.max(1_000, opts.extend.ms));
          return;
        }
        timedOut = true;
        tree.kill();
        killMarked(mark);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // déjà mort
        }
      };
      let timer = setTimeout(deadline, Math.max(1_000, opts.timeoutMs));
      // Aucun descendant ne survit à la session, dans son groupe ou hors de lui. Dès que la racine sort (`exit`), pas
      // à `close` : un descendant qui tient stdout/stderr ouverts retarderait `close` jusqu'au délai (« délai dépassé »
      // pour une session pourtant sortie en code 0).
      const reap = (): void => {
        tree.rootExited();
        tree.kill();
        trees.delete(tree);
        killMarked(mark);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // groupe vide
        }
      };
      child.once('exit', reap);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        live.delete(pid);
        reap();
        marks.delete(mark);
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
