// Porte déportée (L403) : build et tests joués par ssh sur l'hôte `orchestrate.gate.host`, au sha poussé dans un dépôt nu, avec un cache de dépendances par empreinte des lockfiles.
// Ce module ne connaît ni nom de machine ni nom de dépôt : l'hôte vient de la config, le dossier de travail distant est dérivé du dossier du projet (`.cadence-gate/<projet>`).

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { onTermination } from './proc.js';
import { git, gitFailure, ignoredDeps, isCopiedDep } from './orchestrate/worktree.js';

/** Les lockfiles que l'empreinte couvre, à tout niveau du dépôt (R18). */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum'];

/** Au-delà de cet âge, un worktree ou un cache temporaire laissé sur l'hôte est un orphelin (aucune commande de la porte ne dure autant) : le prochain appel le retire (R17, R19). */
const ORPHAN_MIN = 360;

/** Délai de chaque commande de la porte : celui du rejeu de la ligne de base de la vague. */
export const GATE_TIMEOUT_MS = 30 * 60_000;

/** Délai de connexion de la sonde (R4) puis des autres appels ssh. */
const PROBE_CONNECT_S = 5;
const CONNECT_S = 10;

/** Un nom de commit sûr à insérer dans une commande : hexadécimal de 4 à 64 caractères (R18). */
export const isSha = (s: string): boolean => /^[0-9a-f]{4,64}$/i.test(s);

/** Une valeur entre apostrophes pour `sh`, apostrophes internes échappées (R18) : le sha, l'hôte et les chemins insérés dans une commande ssh passent par là. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Empreinte des lockfiles du sha (R3, R18) ; null quand le sha n'en porte aucun (pas de cache). `files` : leurs chemins dans le dépôt, triés. */
export function lockfileFingerprint(repo: string, sha: string): { fp: string; files: string[] } | null {
  const files = git(repo, 'ls-tree', '-r', '--name-only', '-z', sha)
    .split('\0')
    .filter((f) => f && LOCKFILES.includes(basename(f)) && !f.split('/').includes('node_modules'))
    .sort();
  if (!files.length) return null;
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0`);
    h.update(spawnSync('git', ['show', `${sha}:${f}`], { cwd: repo, maxBuffer: 1 << 28 }).stdout);
    h.update('\0');
  }
  return { fp: h.digest('hex'), files };
}

/** Empreinte des mêmes lockfiles dans le dossier `dir` du disque (R16) ; null si l'un manque. */
function diskFingerprint(dir: string, files: string[]): string | null {
  const h = createHash('sha256');
  for (const f of files) {
    if (!existsSync(join(dir, f))) return null;
    h.update(`${f}\0`);
    h.update(readFileSync(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

const archOf = (m: string): string => ({ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' })[m] ?? m;

/** Système et architecture de cette machine, écrits comme ceux de l'hôte (relevés par la sonde) : `linux-x64`, `darwin-arm64` (R16). */
const localPlatform = (): string => `${process.platform}-${process.arch}`;

/** ssh a perdu la connexion pendant une commande de la porte déportée (code 255, R6) : la porte est rejouée en local. */
export class ConnectionLost extends Error {}

export interface Ran {
  code: number;
  output: string;
  /** ssh a perdu la connexion (code 255) : la commande n'a pas rendu de verdict (R6). */
  lost?: boolean;
}

type Env = Record<string, string | undefined>;

interface SshCall {
  host: string;
  script: string;
  env: Env;
  connectS?: number;
  /** Terminal alloué (`-tt`) : l'arrêt de la connexion ferme le tty de la commande distante (R19). */
  tty?: boolean;
  timeoutMs?: number;
  /** Flux envoyé sur l'entrée de ssh (tar des dépendances). */
  stdin?: NodeJS.ReadableStream;
}

const sshArgs = (c: SshCall): string[] => ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${c.connectS ?? CONNECT_S}`, ...(c.tty ? ['-tt'] : []), '--', c.host, c.script];

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // groupe déjà vide
  }
}

/** Les groupes des ssh locaux en cours : un signal reçu par cadence les tue (R10), y compris pendant gate.install. */
const liveSsh = new Set<number>();

/** Un appel ssh non interactif (jamais de mot de passe : BatchMode). Le délai tue le ssh local et son groupe ; 255 est une connexion perdue (`lost`), 124 un délai. */
function ssh(c: SshCall): Promise<Ran> {
  return new Promise((resolveRan) => {
    const child = spawn('ssh', sshArgs(c), { env: c.env, stdio: [c.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
    child.once('error', (e) => resolveRan({ code: 127, output: e.message }));
    const pgid = child.pid;
    if (pgid === undefined) return;
    liveSsh.add(pgid);
    c.stdin?.pipe(child.stdin!).on('error', () => {});
    let output = '';
    for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => (output += d.toString()));
    // Un terminal écrit « \r\n » : la sortie de la porte est celle d'une commande locale.
    const text = () => output.replace(/\r\n/g, '\n');
    // Au délai le ssh local est tué et la porte n'attend pas la fermeture de ses tubes : ce qui tourne encore sur l'hôte est arrêté par le nettoyage (R19).
    const timer = c.timeoutMs
      ? setTimeout(() => {
          killGroup(pgid);
          liveSsh.delete(pgid);
          resolveRan({ code: 124, output: `${text()}\ndélai dépassé (${Math.round((c.timeoutMs ?? 0) / 60_000)} min)` });
        }, c.timeoutMs)
      : undefined;
    child.once('close', (code) => {
      clearTimeout(timer);
      killGroup(pgid);
      liveSsh.delete(pgid);
      resolveRan({ code: code ?? 1, output: text(), lost: code === 255 });
    });
  });
}

/** La dernière ligne utile d'une sortie d'échec : la cause dite à l'humain. */
const causeOf = (r: Ran): string => r.output.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `code ${r.code}`;

interface OpenOpts {
  host: string;
  /** `orchestrate.gate.install` : remplit un cache absent, sur l'hôte (R15). */
  install?: string;
  /** Dépôt local qui porte le sha. */
  repo: string;
  sha: string;
  /** Dossier du disque qui porte les dépendances non suivies (le dépôt vivant) : source de la copie d'un cache (R16). */
  depsFrom: string;
  /** `orchestrate.worktreeDeps` : les dossiers de dépendances ; absent, les `node_modules` de tout niveau et le `.venv`. */
  worktreeDeps?: string[];
  env: Env;
  /** Délai de l'installation d'un cache. */
  timeoutMs: number;
  /** CADENCE_TEST_WORKERS d'une commande de la porte, d'après les cœurs de l'hôte (R13). */
  workers: (hostCores: number) => number;
}

export interface RemoteGate {
  host: string;
  /** Comment le cache a servi, pour la première ligne de la porte (R10) : « cache utilisé (empreinte 1a2b3c4d) », « cache rempli … », « sans cache (aucun lockfile) ». */
  cache: string;
  /** Une commande de la porte, dans le worktree de l'hôte au sha. */
  run(command: string, timeoutMs: number): Promise<Ran>;
  /** Arrête ce qui tourne encore sur l'hôte et y retire le worktree (R10, R19) ; rend la cause si l'hôte n'a pas pu être nettoyé. Synchrone : appelable depuis un signal. */
  close(): string | null;
}

type Opened = { ok: true; gate: RemoteGate } | { ok: false; stage: 'host' | 'cache'; cause: string };

/**
 * Sonde l'hôte, y pousse le sha, prépare le cache de dépendances et le worktree (R3-R5, R15-R18). Un échec avant la première commande de la porte rend `ok: false`
 * avec son étape : l'appelant se replie sur la porte locale, jamais un rouge (R4, R5). Le sha doit être hexadécimal (R18) : refusé avant toute commande ssh.
 */
export async function openRemoteGate(o: OpenOpts): Promise<Opened> {
  if (!isSha(o.sha)) throw new Error(`sha invalide pour la porte déportée : ${o.sha}`);
  // Dès la préparation (gate.install dure jusqu'à 30 min) et jusqu'à `close`, Ctrl-C ou un signal arrête ce qui tourne sur l'hôte et en retire le worktree (R10, R19).
  // Inscrit avant la sonde de l'hôte (ssh jusqu'à 30 s) : un signal tue déjà ce ssh ; l'hôte n'est nettoyé qu'une fois son dossier de travail connu.
  let work: Work | undefined;
  let forget = onTermination(() => {
    // Le ssh local d'abord (sonde, gate.install, commande de la porte), puis l'hôte : un nettoyage qui échoue ne laisse pas le ssh tourner.
    for (const pgid of liveSsh) killGroup(pgid);
    if (work) cleanupHost(o, work);
  });
  try {
    const opened = await prepare(o, (w) => {
      work = w;
    });
    if (!opened.ok) forget();
    else {
      const close = opened.gate.close;
      opened.gate.close = () => {
        forget();
        return close();
      };
    }
    return opened;
  } catch (e) {
    forget();
    // Une erreur locale (sha absent du dépôt, git illisible) n'est pas un rouge : la porte se replie en local, avec la cause (R5).
    return { ok: false, stage: 'host', cause: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

/** Ce que les appels ssh d'une porte partagent : le dossier de travail de l'hôte (absolu : `git -C` change de dossier, un chemin relatif au répertoire de connexion y deviendrait relatif au dépôt nu) et l'identifiant de la porte. */
interface Work {
  id: string;
  root: string;
  head: string;
  bare: string;
  wt: string;
}

/** Sonde l'hôte (R4) : sa plateforme et ses cœurs, ou la cause de son silence. */
async function probeHost(o: OpenOpts): Promise<{ platform: string; cores: number } | string> {
  const probe = await ssh({ host: o.host, env: o.env, connectS: PROBE_CONNECT_S, timeoutMs: 30_000, script: 'uname -s; uname -m; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN' });
  if (probe.code !== 0) return causeOf(probe);
  // Une bannière de connexion (motd, .bashrc bavard) précède la sortie : les trois dernières lignes sont celles de la sonde.
  const [os = '', arch = '', cores = ''] = probe.output.trim().split('\n').map((l) => l.trim()).slice(-3);
  const nproc = Number.parseInt(cores, 10);
  return { platform: `${os.toLowerCase()}-${archOf(arch)}`, cores: Number.isFinite(nproc) && nproc >= 1 ? nproc : 1 };
}

/** Crée le dossier de travail de l'hôte (dépôt nu créé à part puis renommé : deux portes simultanées ne s'y disputent pas, orphelins retirés même si le renommage échoue, R17, R19) et y pousse le sha (R5) ; rend la cause d'un échec. */
async function pushSha(o: OpenOpts, w: Work): Promise<string | null> {
  const { host, env } = o;
  const { head, bare, root } = w;
  const init = await ssh({
    host,
    env,
    script: `${head}set -e; mkdir -p "$R/deps" "$R/wt"; [ -d ${bare} ] || { git init --bare -q ${bare}.init-$$ && mv ${bare}.init-$$ ${bare} 2>/dev/null || true; }; rm -rf ${bare}.init-$$ ${bare}/repo.git.init-$$; [ -d ${bare} ]; ` +
      `find "$R/wt" -mindepth 1 -maxdepth 1 -mmin +${ORPHAN_MIN} -exec rm -rf {} + 2>/dev/null || true; ` +
      `find "$R/deps" -mindepth 1 -maxdepth 1 -name '.tmp-*' -mmin +${ORPHAN_MIN} -exec rm -rf {} + 2>/dev/null || true; git -C ${bare} worktree prune 2>/dev/null || true`,
  });
  if (init.code !== 0) return `dépôt de travail impossible : ${causeOf(init)}`;
  const push = await new Promise<Ran>((res) => {
    const child = spawn('git', ['push', '-q', '--no-verify', `${host}:${root}/repo.git`, `${o.sha}:refs/cadence-gate/${o.sha}`], { cwd: o.repo, env: { ...env, GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o ConnectTimeout=${CONNECT_S}`, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const s of [child.stdout, child.stderr]) s.on('data', (d: Buffer) => (output += d.toString()));
    child.once('error', (e) => res({ code: 127, output: e.message }));
    child.once('close', (code) => res({ code: code ?? 1, output }));
  });
  if (push.code === 0) return null;
  // Deux pushes simultanés du même sha (vague en parallèle, verify --gate) se disputent la même référence : le perdant échoue alors que le sha est arrivé.
  const there = await ssh({ host, env, script: `${head}git -C ${bare} cat-file -e ${shq(`${o.sha}^{commit}`)}` });
  return there.code === 0 ? null : `push du sha impossible : ${causeOf(push)}`;
}

/** Arrête ce qui tourne encore de cette porte sur l'hôte et en retire les worktrees et le cache temporaire (R10, R19) ; rend la cause si l'hôte n'a pas pu être nettoyé. */
function cleanupHost(o: OpenOpts, w: Work): string | null {
  const { head, bare, id } = w;
  // Un fichier pid par commande distante (`<id>.<n>.pid`) et un pour l'installation (`<id>-i.pid`) : tous lus, le groupe de chacun tué.
  const script = `${head}for f in "$R/wt/${id}".*pid "$R/wt/${id}-i.pid"; do if [ -f "$f" ]; then p=$(cat "$f"); kill -s KILL -- "-$p" 2>/dev/null || true; rm -f "$f"; fi; done; ` +
    `for i in ${id} ${id}-i; do git -C ${bare} worktree remove --force "$R/wt/$i" 2>/dev/null || rm -rf "$R/wt/$i"; done; rm -rf "$R/deps/.tmp-${id}"; git -C ${bare} worktree prune 2>/dev/null || true`;
  const r = spawnSync('ssh', sshArgs({ host: o.host, env: o.env, script }), { env: o.env, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? null : `${(r.stderr || r.stdout || `code ${r.status}`).trim().split('\n').slice(-1)[0]}`;
}

/**
 * Le cache de dépendances du sha dans le worktree de l'hôte (R3) : copié s'il existe, sinon rempli (R15, R16) puis copié ; rend la ligne qui dit son état, ou `{ cause }`.
 * Sans lockfile au sha, il n'y a pas de cache.
 */
async function prepareCache(o: OpenOpts, w: Work, hostPlatform: string): Promise<string | { cause: string }> {
  const prints = lockfileFingerprint(o.repo, o.sha);
  if (!prints) return 'sans cache (aucun lockfile au sha)';
  const { head, wt } = w;
  const short = prints.fp.slice(0, 8);
  const keyInstall = `${prints.fp}-${hostPlatform}`;
  const copyDeps = (): Promise<Ran> =>
    ssh({
      host: o.host,
      env: o.env,
      script: `${head}set -e; for k in ${shq(keyInstall)} ${shq(prints.fp)}; do if [ -d "$R/deps/$k" ]; then ` +
        `while IFS= read -r p; do mkdir -p ${wt}/"$(dirname "$p")"; cp -R "$R/deps/$k/$p" ${wt}/"$p"; done < "$R/deps/$k/.paths"; echo "HIT $k"; exit 0; fi; done; echo MISS`,
    });
  let r = await copyDeps();
  if (r.code !== 0) return { cause: `lecture du cache impossible : ${causeOf(r)}` };
  if (!r.output.includes('MISS')) return `cache utilisé (empreinte ${short})`;
  const filled = o.install ? await fillByInstall(o, keyInstall, w.id, head, w.bare) : await fillByCopy(o, prints, hostPlatform, w.id, head);
  if (typeof filled === 'string') return { cause: filled };
  r = await copyDeps();
  if (r.code !== 0 || !r.output.includes('HIT')) return { cause: `cache introuvable après remplissage : ${causeOf(r)}` };
  return `cache rempli ${o.install ? 'par gate.install' : 'par copie des dépendances locales'} (empreinte ${short})`;
}

async function prepare(o: OpenOpts, onWork: (w: Work) => void): Promise<Opened> {
  const { host, env } = o;
  const probe = await probeHost(o);
  if (typeof probe === 'string') return { ok: false, stage: 'host', cause: probe };
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const root = `.cadence-gate/${basename(resolve(o.repo))}`;
  const w: Work = { id, root, head: `R="$PWD"/${shq(root)}; `, bare: '"$R/repo.git"', wt: `"$R/wt/${id}"` };
  onWork(w);
  const pushed = await pushSha(o, w);
  if (pushed) return { ok: false, stage: 'host', cause: pushed };
  const fail = (cause: string, stage: 'host' | 'cache'): Opened => {
    cleanupHost(o, w);
    return { ok: false, stage, cause };
  };
  const add = await ssh({ host, env, script: `${w.head}set -e; git -C ${w.bare} worktree add -q --detach ${w.wt} ${shq(o.sha)}` });
  if (add.code !== 0) return fail(`worktree impossible : ${causeOf(add)}`, 'host');
  const cache = await prepareCache(o, w, probe.platform);
  if (typeof cache !== 'string') return fail(cache.cause, 'cache');
  const workers = o.workers(probe.cores);
  let runs = 0;
  const gate: RemoteGate = {
    host,
    cache,
    run: (command, timeoutMs) => {
      const pid = `"$R/wt/${id}.${++runs}.pid"`;
      return ssh({ host, env, tty: true, timeoutMs, script: `${w.head}echo $$ > ${pid}; cd ${w.wt} && export CADENCE_TEST_WORKERS=${workers} && exec sh -c ${shq(command)}` });
    },
    close: () => cleanupHost(o, w),
  };
  return { ok: true, gate };
}

/** Remplit le cache `key` en jouant `gate.install` sur l'hôte, dans un worktree au sha (R15) ; rend la cause d'un échec. */
async function fillByInstall(o: OpenOpts, key: string, id: string, head: string, bare: string): Promise<null | string> {
  const iw = `"$R/wt/${id}-i"`;
  const tmp = `"$R/deps/.tmp-${id}"`;
  const dirs = o.worktreeDeps
    ? `for p in ${o.worktreeDeps.map(shq).join(' ')}; do [ -e "$p" ] && echo "$p"; done`
    : `find . -name .git -prune -o \\( -name node_modules -o -name .venv \\) -type d -print -prune`;
  const script =
    `${head}echo $$ > "$R/wt/${id}-i.pid"; set -e; git -C ${bare} worktree add -q --detach ${iw} ${shq(o.sha)}; cd ${iw}; sh -c ${shq(o.install!)}; ` +
    `mkdir -p ${tmp}; : > ${tmp}/.paths; (${dirs}) | while IFS= read -r p; do p="\${p#./}"; mkdir -p ${tmp}/"$(dirname "$p")"; cp -R "$p" ${tmp}/"$p"; echo "$p" >> ${tmp}/.paths; done; ` +
    `cd "$R"; git -C ${bare} worktree remove --force ${iw} || true; mv ${tmp} "$R/deps/${key}" 2>/dev/null || true; rm -rf "$R/deps/${key}/.tmp-${id}" ${tmp}; [ -d "$R/deps/${key}" ]`;
  const r = await ssh({ host: o.host, env: o.env, tty: true, timeoutMs: o.timeoutMs, script });
  return r.code === 0 ? null : `gate.install en échec sur ${o.host} (code ${r.code}) : ${causeOf(r)}`;
}

/** Remplit le cache par copie des dépendances locales, seulement si elles méritent l'empreinte du sha et viennent de la même plateforme que l'hôte (R16) ; rend la cause d'un refus ou d'un échec. */
async function fillByCopy(o: OpenOpts, prints: { fp: string; files: string[] }, hostPlatform: string, id: string, head: string): Promise<null | string> {
  if (localPlatform() !== hostPlatform) return `gate.install absent et plateforme locale ${localPlatform()} différente de celle de l'hôte ${hostPlatform} : dépendances locales non copiées`;
  if (diskFingerprint(o.depsFrom, prints.files) !== prints.fp) return 'gate.install absent et lockfile local différent de celui du sha : dépendances locales non copiées';
  let paths: string[];
  try {
    paths = o.worktreeDeps ? o.worktreeDeps.filter((n) => existsSync(join(o.depsFrom, n))) : ignoredDeps(o.depsFrom).filter(isCopiedDep);
  } catch (e) {
    return `dépendances locales illisibles (${gitFailure(e)})`;
  }
  if (!paths.length) return 'gate.install absent et aucune dépendance locale à copier';
  const tmp = `"$R/deps/.tmp-${id}"`;
  const tar = spawn('tar', ['-cf', '-', '-C', o.depsFrom, ...paths], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tarDone = new Promise<number>((res) => {
    tar.once('error', () => res(127));
    tar.once('close', (c) => res(c ?? 1));
  });
  const up = await ssh({ host: o.host, env: o.env, timeoutMs: o.timeoutMs, stdin: tar.stdout!, script: `${head}set -e; mkdir -p ${tmp}; tar -xf - -C ${tmp}` });
  const tarCode = await tarDone;
  if (up.code !== 0 || tarCode !== 0) return `copie des dépendances locales impossible : ${tarCode !== 0 ? `tar code ${tarCode}` : causeOf(up)}`;
  const key = prints.fp;
  const publish = await ssh({
    host: o.host,
    env: o.env,
    script: `${head}set -e; printf '%s\\n' ${paths.map(shq).join(' ')} > ${tmp}/.paths; mv ${tmp} "$R/deps/${key}" 2>/dev/null || true; rm -rf "$R/deps/${key}/.tmp-${id}" ${tmp}; [ -d "$R/deps/${key}" ]`,
  });
  return publish.code === 0 ? null : `publication du cache impossible : ${causeOf(publish)}`;
}
