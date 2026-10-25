#!/usr/bin/env node
// Mise en service (L195) : le `raf` et le `cadence` du PATH vivent dans une copie séparée du dépôt de travail
// (un worktree git détaché, construit là), mise à jour par le lead après revue, jamais par une session de vague.
//   node scripts/mise-en-service.mjs <sha> [--root dossier] [--bin-dir dossier] [--repo dépôt]
// <root>/releases/<sha12> : un worktree détaché par version mise en service ; <root>/service : lien vers la version en cours ;
// <bin-dir>/raf et <bin-dir>/cadence : liens vers <root>/service/bin/*.js.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (repo, ...args) => {
  try {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Posé à la fin d'une installation réussie : sans lui, le dossier de la version n'est pas servi. */
const COMPLETE = '.mise-en-service-ok';

/** Versions gardées en plus de celle qui est servie : les 3 mises en service juste avant elle (retour en arrière). */
const KEPT_BEFORE = 3;

export const defaultRoot = () => join(homedir(), '.local', 'share', 'cadence');
export const defaultBinDir = () => join(homedir(), '.local', 'bin');

/** Statut des lots du plan du dépôt, tel que HEAD le porte (plan: de cadence.yaml, sinon .cadence/raf.yaml, sinon docs/plan/raf.yaml hérité). */
function planStatuses(repo) {
  let planFile = '.cadence/raf.yaml';
  try {
    git(repo, 'cat-file', '-e', `HEAD:${planFile}`);
  } catch {
    planFile = 'docs/plan/raf.yaml';
  }
  if (existsSync(join(repo, 'cadence.yaml'))) {
    const cfg = parse(readFileSync(join(repo, 'cadence.yaml'), 'utf8')) ?? {};
    if (typeof cfg.plan === 'string') planFile = cfg.plan;
  }
  const plan = parse(git(repo, 'show', `HEAD:${planFile}`)) ?? {};
  return new Map((plan.lots ?? []).map((l) => [String(l.id), String(l.status)]));
}

/** Sha actuellement en service (nom du dossier de la version), ou undefined. */
function servedSha(root) {
  try {
    const target = readlinkSync(join(root, 'service'));
    return target.split('/').pop();
  } catch {
    return undefined;
  }
}

/** Refuse (lève) un sha qui n'est pas le code accepté ; retourne le sha complet. */
export function checkAccepted(repo, rev) {
  let sha;
  try {
    sha = git(repo, 'rev-parse', '--verify', `${rev}^{commit}`);
  } catch {
    throw new Error(`mise en service refusée : « ${rev} » n'est pas un commit du dépôt`);
  }
  if (!gitOk(repo, 'merge-base', '--is-ancestor', sha, 'HEAD')) {
    throw new Error(`mise en service refusée : ${sha.slice(0, 7)} n'est pas un ancêtre de HEAD (code non accepté)`);
  }
  return sha;
}

/** Les lots cités par les commits (scope « type(L123): ») entre le sha déjà en service et <sha> doivent être rendus (done) ; un lot abandonné (dropped) passe si chacun de ses commits est annulé par un git revert présent sous <sha>. */
export function checkLotsDone(repo, sha, served) {
  const status = planStatuses(repo);
  const range = served && gitOk(repo, 'merge-base', '--is-ancestor', served, sha) ? [`${served}..${sha}`] : ['-1', sha];
  const open = new Set();
  const droppedCommits = new Map(); // lot abandonné -> shas de ses commits
  const SEP = '\u0001';
  const log = git(repo, 'log', `--format=%H${SEP}%s`, ...range);
  for (const line of log.split('\n')) {
    const [commit, subject] = line.split(SEP);
    if (!subject || /^plan:/.test(subject)) continue;
    // la portée « type(L1, L2/t3): » décide seule ; sans portée citant un lot, tout le sujet est lu (« fix: L3/t1 »)
    const scope = /^[a-z]+\(([^)]*)\)!?:/.exec(subject)?.[1] ?? '';
    const text = /(?<![\w-])L\d+(?![\w.]*\w)/.test(scope) ? scope : subject;
    for (const id of text.match(/(?<![\w-])L\d+(?![\w.]*\w)/g) ?? []) {
      if (status.get(id) === 'dropped') droppedCommits.set(id, [...(droppedCommits.get(id) ?? []), commit]);
      else if (status.get(id) !== 'done') open.add(`${id} (${status.get(id) ?? 'absent du plan'})`);
    }
  }
  if (droppedCommits.size) {
    const reverted = new Set();
    const bodies = git(repo, 'log', `--format=%B${SEP}`, sha);
    for (const m of bodies.matchAll(/This reverts commit ([0-9a-f]{40})/g)) reverted.add(m[1]);
    for (const [id, commits] of droppedCommits) {
      // un commit « Revert … » est lui-même annulant : seul compte le travail du lot, non annulé
      const isRevert = (c) => /^Revert "/.test(git(repo, 'log', '-1', '--format=%s', c));
      if (commits.some((c) => !isRevert(c) && !reverted.has(c))) open.add(`${id} (dropped)`);
    }
  }
  if (open.size) {
    throw new Error(`mise en service refusée : lot non accepté au-dessous de ${sha.slice(0, 7)} — ${[...open].join(', ')} (raf done d'abord, après la revue)`);
  }
}

function replaceLink(target, link) {
  mkdirSync(dirname(link), { recursive: true });
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link); // atomique : jamais de lien manquant en cours de route
}

/**
 * Construit <sha> dans <root>/releases/<sha12> puis bascule <root>/service et les liens du bin-dir.
 * `install(dir)` (défaut : npm ci sans scripts puis tsc) est injectable pour les tests.
 */
export function mettreEnService({ repo, rev, root = defaultRoot(), binDir = defaultBinDir(), install = installAndBuild, inUse = copiesUtilisees }) {
  const sha = checkAccepted(repo, rev);
  const served = servedSha(root);
  const servedFull = served && existsSync(join(root, 'releases', served)) ? git(join(root, 'releases', served), 'rev-parse', 'HEAD') : undefined;
  checkLotsDone(repo, sha, servedFull);

  const releases = join(root, 'releases');
  const dir = join(releases, sha.slice(0, 12));
  mkdirSync(releases, { recursive: true });
  // un dossier sans marqueur est une installation interrompue (Ctrl-C, kill) : on le refait, on ne le sert jamais
  if (!existsSync(join(dir, COMPLETE))) {
    if (existsSync(dir)) {
      gitOk(repo, 'worktree', 'remove', '--force', dir);
      rmSync(dir, { recursive: true, force: true });
      gitOk(repo, 'worktree', 'prune');
    }
    git(repo, 'worktree', 'add', '--detach', dir, sha);
    try {
      install(dir);
      writeFileSync(join(dir, COMPLETE), `${sha}\n`);
    } catch (e) {
      gitOk(repo, 'worktree', 'remove', '--force', dir);
      throw new Error(`mise en service interrompue, rien n'a changé : ${e instanceof Error ? e.message : e}`);
    }
  }
  // le marqueur date la dernière mise en service de la version (pas son installation) : l'ordre de mise en service décide de la rétention
  const now = new Date();
  utimesSync(join(dir, COMPLETE), now, now);
  replaceLink(dir, join(root, 'service'));
  for (const [name, js] of [['raf', 'raf.js'], ['cadence', 'cadence.js']]) replaceLink(join(root, 'service', 'bin', js), join(binDir, name));
  const purge = purger({ repo, releases, current: sha.slice(0, 12), inUse });
  return { sha, dir, fingerprint: fingerprint(dir), purge };
}

/** Dossiers des copies dont un processus vivant utilise le dossier : son cwd, son binaire ou un argument de sa ligne de commande (`node …/bin/raf.js`). */
export function copiesUtilisees(releases) {
  const used = new Set();
  const note = (path) => {
    const rel = path.startsWith(`${releases}/`) ? path.slice(releases.length + 1).split('/')[0] : undefined;
    if (rel) used.add(rel);
  };
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return used; // pas de /proc (hors Linux) : rien à détecter
  }
  for (const pid of pids) {
    for (const link of ['cwd', 'exe']) {
      try {
        note(readlinkSync(join('/proc', pid, link)));
      } catch {
        /* processus disparu ou illisible */
      }
    }
    try {
      for (const arg of readFileSync(join('/proc', pid, 'cmdline'), 'utf8').split('\0')) note(arg);
    } catch {
      /* idem */
    }
  }
  return used;
}

/** Place occupée par un dossier (blocs alloués, liens non suivis). */
function diskUsage(path) {
  const st = lstatSync(path);
  let total = st.blocks * 512;
  if (st.isDirectory()) for (const name of readdirSync(path)) total += diskUsage(join(path, name));
  return total;
}

/**
 * Garde la version servie et les KEPT_BEFORE mises en service avant elle (ordre du marqueur), retire les autres
 * (git worktree remove + prune) sauf celles qu'un processus vivant utilise. Les dossiers sans marqueur (installation
 * interrompue) ne comptent pas parmi les versions gardées.
 */
function purger({ repo, releases, current, inUse }) {
  const dated = [];
  const incomplete = [];
  for (const name of readdirSync(releases)) {
    if (!lstatSync(join(releases, name)).isDirectory()) continue;
    try {
      dated.push({ name, at: statSync(join(releases, name, COMPLETE)).mtimeMs });
    } catch {
      incomplete.push(name);
    }
  }
  dated.sort((x, y) => (x.name === current ? -1 : y.name === current ? 1 : y.at - x.at || x.name.localeCompare(y.name)));
  const candidates = [...dated.slice(1 + KEPT_BEFORE).map((v) => v.name), ...incomplete];
  const used = candidates.length ? inUse(releases) : new Set();
  const purge = { removed: 0, kept: 0, freedBytes: 0 };
  for (const name of candidates) {
    if (used.has(name)) {
      purge.kept++;
      continue;
    }
    const path = join(releases, name);
    purge.freedBytes += diskUsage(path);
    gitOk(repo, 'worktree', 'remove', '--force', path);
    rmSync(path, { recursive: true, force: true });
    purge.removed++;
  }
  gitOk(repo, 'worktree', 'prune');
  return purge;
}

/** La phrase de la sortie : ce que la purge a retiré et la place rendue. */
export function direPurge({ removed, kept, freedBytes }) {
  const unit = freedBytes >= 1024 ** 3 ? [1024 ** 3, 'Go'] : [1024 ** 2, 'Mo'];
  const size = `${(freedBytes / unit[0]).toFixed(1).replace('.', ',')} ${unit[1]}`;
  const tail = kept ? ` ; ${kept} gardée${kept > 1 ? 's' : ''}, un processus l'utilise encore` : '';
  if (!removed) return `purge : aucune copie retirée${tail}`;
  return `purge : ${removed} ${removed > 1 ? 'copies retirées' : 'copie retirée'}, ${size} libérés${tail}`;
}

function installAndBuild(dir) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'inherit' });
  run('npm', ['ci', '--ignore-scripts']);
  run('npx', ['tsc', '-p', 'tsconfig.build.json']);
}

/** Empreinte du code en service : tout ce que raf/cadence chargent (bin, dist, package.json), hors node_modules. */
export function fingerprint(dir) {
  const hash = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else hash.update(p.slice(dir.length)).update(readFileSync(p));
    }
  };
  for (const part of ['bin', 'dist']) if (existsSync(join(dir, part))) walk(join(dir, part));
  hash.update(readFileSync(join(dir, 'package.json')));
  return hash.digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const root = opt('--root');
  const binDir = opt('--bin-dir');
  const repo = opt('--repo') ?? process.cwd();
  const [rev] = args;
  if (!rev) {
    console.error('usage : node scripts/mise-en-service.mjs <sha> [--root dossier] [--bin-dir dossier] [--repo dépôt]');
    process.exit(2);
  }
  try {
    const r = mettreEnService({ repo, rev, ...(root && { root: resolve(root) }), ...(binDir && { binDir: resolve(binDir) }) });
    console.log(`en service : ${r.sha.slice(0, 7)} dans ${r.dir}\nempreinte : ${r.fingerprint}\n${direPurge(r.purge)}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
