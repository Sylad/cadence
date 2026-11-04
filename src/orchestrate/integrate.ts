import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir } from '../git.js';
import { sharedStateDir } from '../state.js';
import { activeLock, releaseLock, takeLock, type OLock } from './lock.js';
import { mergeUnreleased, moveToUnreleased, settleLotEntries, unreleasedSections } from './changelog-merge.js';
import { mutexFor } from './mutex.js';
import { isMap, isNode, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { git, gitFailure, tryGit } from './worktree.js';
import { BASELINE, comparerMigration, serialiser, type Mesure } from '../../scripts/qualite.mjs';

/** Verrou d'intégration d'un dépôt (L279, R10) : dans l'état commun aux worktrees, au format du verrou d'orchestration, sous un autre nom. */
export const INTEGRATION_LOCK = 'orchestrate-integration.lock';
/** Attente du verrou d'intégration (R25) : une intégration dure un rebase et la relance des tests. */
export const INTEGRATE_WAIT_MS = 10 * 60_000;
export const INTEGRATE_POLL_MS = 1_000;
/** Rebases rejoués quand la branche du dépôt avance pendant l'intégration (L364) : au-delà, le lot est rendu. */
export const MAX_REPLAYS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Grant = { ok: true; release: () => void } | { ok: false; holder: { wave: string; pid: number } };

/**
 * Prend la main sur le dépôt pour une intégration ou une écriture de plan du programme (R10, R21, R26) : d'abord la file en mémoire du dépôt (les lots d'une
 * vague partagent un pid, `takeLock` rendrait chacun déjà porteur), puis le verrou fichier, qui ne départage que les autres processus. La file en mémoire
 * s'attend sans borne (L425) : son porteur est un lot de ce processus, qui libère toujours, et une intégration (rebase rejoué + porte) dure plus que la borne.
 * L'attente du verrou fichier d'un autre processus est bornée par `waitMs` (R25), comptée à partir du tour ; au-delà, le porteur est rendu et rien n'est pris.
 * Une attente ne retient aucun créneau de session : ce verrou n'a rien à voir avec eux. L591 : `onWait` est appelé une fois quand le tour n'est pas immédiat (file en mémoire tenue, ou
 * verrou fichier d'un autre processus), pour que l'appelant rende son créneau ; `onTurn` quand l'attente finit, par le tour ou par le refus. Aucun des deux si le tour est immédiat.
 */
export async function takeRepoWrite(repo: string, who: { wave: string }, o: { waitMs?: number; pollMs?: number; onWait?: () => void; onTurn?: () => void } = {}): Promise<Grant> {
  const waitMs = o.waitMs ?? INTEGRATE_WAIT_MS;
  const pollMs = o.pollMs ?? INTEGRATE_POLL_MS;
  const file = join(sharedStateDir(repo), INTEGRATION_LOCK);
  const queue = mutexFor(`integrate:${gitCommonDir(repo)}`);
  let waiting = false;
  const wait = () => {
    if (waiting) return;
    waiting = true;
    o.onWait?.();
  };
  const settle = () => {
    if (waiting) o.onTurn?.();
  };
  if (queue.busy) wait();
  const turn = (await queue.acquire())!;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock: OLock = { pid: process.pid, wave: who.wave, started: new Date().toISOString() };
    const got = takeLock(file, lock);
    if (got.ok) {
      settle();
      return {
        ok: true,
        release: () => {
          releaseLock(file, process.pid);
          turn();
        },
      };
    }
    if (Date.now() >= deadline) {
      turn();
      settle();
      return { ok: false, holder: { wave: got.held.wave, pid: got.held.pid } };
    }
    wait();
    await sleep(pollMs);
  }
}

/** Branche courante du dépôt (`main`), null en HEAD détaché (R24). */
export const repoBranch = (repo: string): string | null => tryGit(repo, 'symbolic-ref', '--short', '-q', 'HEAD') || null;

/** Point de départ de `rev` par rapport à la branche `base` : le dernier ancêtre commun. */
export const mergeBase = (cwd: string, rev: string, base: string): string => git(cwd, 'merge-base', rev, `refs/heads/${base}`);

export type Rebase = { kind: 'forwarded' } | { kind: 'rebased'; before: string; after: string; changelog: number; baseline: number; moved: number; settled: boolean; silent: boolean } | { kind: 'conflict'; files: string[]; detail: string };

const CHANGELOG = 'CHANGELOG.md';
const REBASE_ENV = { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: REBASE_ENV });

/** Un fichier que le programme sait résoudre à côté de l'autre : sans `merge=union` (L568), un commit qui touche le CHANGELOG et la base les met en conflit ensemble. */
const pairConflict = (file: string): boolean => file === CHANGELOG || file === BASELINE;

/**
 * Résout le conflit en cours quand le CHANGELOG (seul, ou avec la base du cliquet, que `resolveBaseline` résout ensuite) est de l'ajout pur sous `[Unreleased]` (L314) : écrit l'union, l'ajoute à l'index. Faux, sans rien
 * toucher, pour tout autre conflit (un autre fichier avec lui, une entrée de base modifiée, une étape de base absente). `start` : le CHANGELOG au point de
 * départ de la branche (L323), pour qu'un commit puisse réécrire l'entrée qu'un commit précédent du lot a ajoutée.
 */
function resolveChangelog(work: string, start: string | undefined): boolean {
  const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
  if (!files.includes(CHANGELOG) || !files.every(pairConflict)) return false;
  try {
    // Pendant un rebase, l'étape 2 est la branche du dépôt (« ours »), l'étape 3 le commit du lot rejoué (« theirs »).
    const merged = mergeUnreleased(run(work, 'show', `:1:${CHANGELOG}`), run(work, 'show', `:2:${CHANGELOG}`), run(work, 'show', `:3:${CHANGELOG}`), start);
    if (merged === null) return false;
    writeFileSync(join(work, CHANGELOG), merged);
    run(work, 'add', '--', CHANGELOG);
    return true;
  } catch {
    return false;
  }
}

/** Champs d'un lot que le lot écrit lui-même (L569) : sa revue, ses notes, ses tâches, son état. Tout autre champ (estimation, titre, extension déclarée…) est une décision du lead. */
const LOT_WRITES = ['review', 'ux', 'notes', 'tasks', 'status', 'state', 'state_before', 'started', 'finished'];

/** Les lots d'un plan lu à une étape du conflit : leur carte YAML, par identifiant, plus la tête du plan (tout sauf `lots`). */
function planStage(work: string, file: string, n: number) {
  const doc = parseDocument(run(work, 'show', `:${n}:${file}`));
  const lots = doc.get('lots');
  if (doc.errors.length || !isSeq(lots)) throw new Error(`${file} (étape ${n}) : plan illisible`);
  const byId = new Map<string, YAMLMap>();
  for (const item of lots.items) {
    if (!isMap(item) || byId.has(String(item.get('id')))) throw new Error(`${file} (étape ${n}) : lot sans identifiant ou en double`);
    byId.set(String(item.get('id')), item);
  }
  return { doc, byId, head: JSON.stringify({ ...(doc.toJSON() as Record<string, unknown>), lots: undefined }) };
}

const keyName = (p: { key: unknown }) => String((p.key as { value?: unknown }).value ?? p.key);
const jsonOf = (n: unknown) => JSON.stringify(isNode(n) ? n.toJSON() : (n ?? null));

/** Les notes que `t` ajoute à celles de `b`, ou null quand il en a réécrit ou retiré une. */
function addedNotes(t: YAMLSeq, b: YAMLSeq | undefined): unknown[] | null {
  const base = b?.items ?? [];
  if (t.items.length < base.length || jsonOf(t.items.slice(0, base.length)) !== jsonOf(base)) return null;
  return t.items.slice(base.length);
}

/** L'écriture qui reprend le champ `key` du lot `t` sur `o`, `null` sans écriture à faire, `false` en conflit : les `notes` ajoutées des deux côtés s'ajoutent. */
function fieldWrite(key: string, [t, b, o]: [YAMLMap, YAMLMap, YAMLMap]): (() => void) | null | false {
  const [tv, bv, ov] = [jsonOf(t.get(key, true)), jsonOf(b.get(key, true)), jsonOf(o.get(key, true))];
  if (tv === bv || tv === ov) return null; // le commit n'y a pas touché, ou la branche du dépôt a déjà la même valeur
  if (!LOT_WRITES.includes(key)) return false;
  const [ts, os, bs] = [t.get(key, true), o.get(key, true), b.get(key, true)];
  if (ov === bv) return () => (t.has(key) ? o.set(key, ts) : o.delete(key));
  const added = key === 'notes' && isSeq(ts) && isSeq(os) ? addedNotes(ts, isSeq(bs) ? bs : undefined) : null;
  return added && isSeq(os) ? () => os.items.push(...added) : false;
}

/**
 * Les écritures à rejouer sur le lot `o` de la branche du dépôt pour reprendre celles du lot `t` depuis son départ `b`, ou null s'il y a conflit : un champ
 * hors `LOT_WRITES` changé par le commit, ou un champ du lot changé aussi par la branche du dépôt à une autre valeur (hors `notes`, qui s'ajoutent).
 */
function lotWrites(t: YAMLMap, b: YAMLMap, o: YAMLMap): Array<() => void> | null {
  const writes: Array<() => void> = [];
  for (const key of new Set([...t.items, ...b.items].map(keyName))) {
    const w = fieldWrite(key, [t, b, o]);
    if (w === false) return null;
    if (w) writes.push(w);
  }
  return writes;
}

/**
 * Résout le conflit en cours quand c'est le plan seul (L370, L569) : la version de la branche du dépôt, plus les écritures du commit rejoué sur les champs que
 * le lot écrit lui-même (`LOT_WRITES` : revue, notes, tâches, état). Champ par champ, depuis le plan au point de départ du commit : un champ que le commit a
 * changé est repris sur la branche du dépôt, sauf si elle l'a changé aussi à une autre valeur — les `notes`, ajoutées des deux côtés, se mettent bout à bout.
 * Faux, sans rien toucher, si le commit change autre chose (un champ hors `LOT_WRITES`, un lot ajouté ou retiré, la tête du plan hors `lots` — `acknowledged:`
 * après un `raf ignore`, `reviewSince`, un réglage —, que reprendre le plan du dépôt perdrait sans message), ou si un lot manque à la branche du dépôt.
 */
function resolvePlan(work: string): boolean {
  const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
  if (files.length !== 1) return false;
  const file = files[0];
  try {
    const [base, ours, theirs] = [planStage(work, file, 1), planStage(work, file, 2), planStage(work, file, 3)];
    if (theirs.head !== base.head || theirs.byId.size !== base.byId.size) return false;
    const writes: Array<() => void> = [];
    for (const [id, t] of theirs.byId) {
      const [b, o] = [base.byId.get(id), ours.byId.get(id)];
      const mine = b && o ? lotWrites(t, b, o) : null;
      if (!mine) return false;
      writes.push(...mine);
    }
    if (!writes.length) return false; // aucune écriture du lot à reprendre : le conflit vient d'ailleurs
    for (const w of writes) w();
    writeFileSync(join(work, file), ours.doc.toString());
    run(work, 'add', '--', file);
    return true;
  } catch {
    return false; // le fichier est laissé en conflit : le `rebase --abort` de l'appelant le restaure
  }
}

/** Une ligne de base lue dans `text` : une carte plate clé → nombre, sinon une erreur (JSON invalide, valeur non numérique). `label` nomme la version dans l'erreur. */
function parseBaseline(text: string, label: string): Mesure {
  const map: unknown = JSON.parse(text);
  if (typeof map !== 'object' || map === null || Array.isArray(map) || Object.values(map).some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${BASELINE} (${label}) n'est pas une carte clé → nombre`);
  return map as Mesure;
}

/** La ligne de base lue à l'étape `n` du conflit en cours : une erreur si l'étape est absente ou illisible. */
const baselineStage = (work: string, n: number): Mesure => parseBaseline(run(work, 'show', `:${n}:${BASELINE}`), `étape ${n}`);

/** La base de chaque clé : la valeur de la branche du dépôt plus la différence signée du lot (son départ moins lui), bornée à 0, une clé à 0 retirée (L538). */
function recompose(start: Mesure, ours: Mesure, theirs: Mesure): Mesure {
  const merged: Mesure = {};
  for (const k of new Set([...Object.keys(start), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = (ours[k] ?? 0) + (theirs[k] ?? 0) - (start[k] ?? 0);
    if (value > 0) merged[k] = value;
  }
  return merged;
}

/**
 * Résout le conflit en cours quand c'est `qualite-baseline.json` (seul, ou avec le CHANGELOG que `resolveChangelog` résout d'abord, L568) (L538) : chaque clé vaut la valeur de la branche du dépôt plus la différence signée du
 * commit rejoué (son départ moins lui), bornée à 0, une clé à 0 retirée — la base de main moins les baisses propres au commit. Le commit est d'abord contrôlé
 * comme la porte (`comparerMigration`, départ du commit contre commit ; un fichier « existe » s'il est dans le parent du commit rejoué, `REBASE_HEAD^`) :
 * un commit qui fait monter la base n'est pas résolu. Faux, sans rien toucher, pour tout autre conflit, une des trois étapes absente ou illisible.
 */
function resolveBaseline(work: string): boolean {
  const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
  if (!files.includes(BASELINE) || !files.every(pairConflict)) return false;
  try {
    // Pendant un rebase, l'étape 1 est le parent du commit rejoué, l'étape 2 la branche du dépôt (« ours »), l'étape 3 le commit du lot (« theirs »).
    const [start, ours, theirs] = [baselineStage(work, 1), baselineStage(work, 2), baselineStage(work, 3)];
    const parent = run(work, 'rev-parse', '--verify', 'REBASE_HEAD^').trim(); // sans parent lisible, aucun fichier ne compterait comme existant : le contrôle serait levé
    const existe = (chemin: string) => tryGit(work, 'cat-file', '-e', `${parent}:${chemin}`) !== null;
    if (comparerMigration(start, theirs, existe).length) return false;
    const merged = recompose(start, ours, theirs);
    writeFileSync(join(work, BASELINE), serialiser(merged));
    run(work, 'add', '--', BASELINE);
    return true;
  } catch {
    return false; // le fichier est laissé en conflit : le `rebase --abort` de l'appelant le restaure
  }
}

/**
 * Après un rebase réussi : les entrées que le lot a ajoutées sous `[Unreleased]` et qu'une publication de la branche a laissées sous la version publiée
 * (git les y range sans conflit quand le bloc a été renommé) sont remises sous le `[Unreleased]` de la branche, dans un commit à part (L362). Rend leur nombre.
 */
function moveOwnEntries(work: string, base: string, before: string, start: string | undefined): number {
  if (start === undefined) return 0;
  const [tip, main] = [tryGit(work, 'show', `${before}:${CHANGELOG}`), tryGit(work, 'show', `refs/heads/${base}:${CHANGELOG}`)];
  if (tip === null || main === null || !existsSync(join(work, CHANGELOG))) return 0;
  const fixed = moveToUnreleased(readFileSync(join(work, CHANGELOG), 'utf8'), tip, start, main);
  if (!fixed) return 0;
  writeFileSync(join(work, CHANGELOG), fixed.text);
  run(work, 'add', '--', CHANGELOG);
  run(work, 'commit', '--no-verify', '-q', '-m', 'docs: CHANGELOG — les entrées du lot replacées sous [Unreleased] (une publication a eu lieu pendant la branche)');
  return fixed.moved;
}

/** Lignes d'entrée de `text` sous `[Unreleased]` (une entrée sur plusieurs lignes : le bloc entier), ou aucune sans bloc `[Unreleased]` lisible. */
const entriesOf = (text: string): string[] => [...(unreleasedSections(text)?.values() ?? [])].flat();

/**
 * Après un rebase réussi : une seule entrée par lot, celle du sommet de sa branche (L369). Les entrées que les commits successifs du lot ont écrites sous
 * `[Unreleased]` puis réécrites (absentes du sommet et du point de départ) sont retirées du résultat, celles du sommet qui y manquent remises, dans un commit
 * à part. Rend vrai quand ce commit a eu lieu.
 */
export function settleOwnEntries(work: string, base: string, before: string, start: string | undefined): boolean {
  if (start === undefined || !existsSync(join(work, CHANGELOG))) return false;
  const [tip, main] = [tryGit(work, 'show', `${before}:${CHANGELOG}`), tryGit(work, 'show', `refs/heads/${base}:${CHANGELOG}`)];
  if (tip === null || main === null) return false;
  const known = new Set(entriesOf(start));
  const commits = (tryGit(work, 'rev-list', `${mergeBase(work, before, base)}..${before}`) ?? '').split('\n').filter(Boolean);
  const written = commits.flatMap((c) => entriesOf(tryGit(work, 'show', `${c}:${CHANGELOG}`) ?? '')).filter((e) => !known.has(e));
  const fixed = settleLotEntries(readFileSync(join(work, CHANGELOG), 'utf8'), tip, start, main, [...new Set(written)]);
  if (fixed === null) return false;
  writeFileSync(join(work, CHANGELOG), fixed);
  run(work, 'add', '--', CHANGELOG);
  run(work, 'commit', '--no-verify', '-q', '-m', 'docs: CHANGELOG — une entrée finale par lot, celle du sommet de sa branche (les versions intermédiaires écartées)');
  return true;
}

/**
 * Après un rebase réussi (L541) : la base que git a fusionnée sans conflit peut être plus ancienne que celle de main (une clé baissée des deux côtés à la même
 * valeur, une clé que main a retirée) et resserrer des fichiers sous main. Quand le lot a changé `qualite-baseline.json` (le sommet de sa branche contre le
 * point de départ), la base est recomposée comme au conflit (`recompose`, L538) et écrite dans un commit à part si elle diffère du résultat de git. Le lot est
 * contrôlé comme la porte (`comparerMigration`, départ contre sommet du lot) : un lot qui monte la base n'est pas recomposé. Faux sans rien toucher quand le lot
 * n'a pas changé la base, quand une des trois versions manque ou est illisible, ou quand le résultat est déjà la recomposition. Rend vrai quand le commit a eu lieu.
 */
function settleBaseline(work: string, base: string, before: string): boolean {
  try {
    const point = mergeBase(work, before, base);
    const [start, theirs, ours] = [`${point}:${BASELINE}`, `${before}:${BASELINE}`, `refs/heads/${base}:${BASELINE}`].map((rev) => parseBaseline(run(work, 'show', rev), rev));
    if (serialiser(start) === serialiser(theirs)) return false;
    if (comparerMigration(start, theirs, (chemin) => tryGit(work, 'cat-file', '-e', `${point}:${chemin}`) !== null).length) return false;
    const text = serialiser(recompose(start, ours, theirs));
    if (!existsSync(join(work, BASELINE)) || readFileSync(join(work, BASELINE), 'utf8') === text) return false;
    writeFileSync(join(work, BASELINE), text);
    run(work, 'add', '--', BASELINE);
    run(work, 'commit', '--no-verify', '-q', '-m', 'fix(base): qualite-baseline.json — base de main plus les baisses du lot (fusion sans conflit de git corrigée)');
    return true;
  } catch {
    return false; // une version absente ou illisible : la base de git est gardée, la porte la contrôlera
  }
}

/**
 * Rebase le worktree `work` sur la branche `base` (R6). Une branche qui descend déjà du sommet de `base` n'a rien à rebaser (fast-forward pur : aucun sha ne
 * change). Un conflit d'ajout pur dans le CHANGELOG est résolu par union à chaque commit qui le porte (L314, `changelog` les compte), un conflit du plan quand le commit n'y ajoute que des revues de lot (L370), un conflit de `qualite-baseline.json` seul par la base de la branche moins les baisses du commit (L538, `baseline` les compte). Tout autre conflit — ou
 * tout autre échec du rebase — est abandonné (`rebase --abort`) : la branche du lot et son arbre restent tels qu'avant, la branche du dépôt n'a pas été
 * touchée, personne ne résout le conflit à l'aveugle.
 */
export function rebaseOnto(work: string, base: string): Rebase {
  const before = git(work, 'rev-parse', 'HEAD');
  if (tryGit(work, 'merge-base', '--is-ancestor', `refs/heads/${base}`, 'HEAD') !== null) return { kind: 'forwarded' };
  let changelog = 0;
  let baseline = 0;
  const start = tryGit(work, 'show', `${mergeBase(work, 'HEAD', base)}:${CHANGELOG}`) ?? undefined;
  try {
    run(work, 'rebase', `refs/heads/${base}`);
  } catch (first) {
    let failure = first;
    // Chaque tour règle le commit sur lequel le rebase s'est arrêté ; un lot ne porte pas des centaines de commits, la borne évite seulement une boucle sans fin.
    for (let turn = 0; ; turn++) {
      const doc = resolveChangelog(work, start);
      const base = resolveBaseline(work);
      if (turn >= 200 || !(doc || base || resolvePlan(work))) {
        const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
        tryGit(work, 'rebase', '--abort');
        return { kind: 'conflict', files, detail: gitFailure(failure) };
      }
      baseline += Number(base);
      changelog += Number(doc);
      try {
        run(work, 'rebase', '--continue');
        break;
      } catch (e) {
        failure = e;
      }
    }
  }
  const moved = moveOwnEntries(work, base, before, start);
  const settled = settleOwnEntries(work, base, before, start);
  const silent = settleBaseline(work, base, before);
  return { kind: 'rebased', before, after: git(work, 'rev-parse', 'HEAD'), changelog, baseline, moved, settled, silent };
}

/** Les lignes de journal d'un rebase réussi : une par résolution que le programme a faite à la place de git (CHANGELOG, base du cliquet), vide si git a tout fait seul. */
export function rebaseNotes(r: Extract<Rebase, { kind: 'rebased' }>, key: string): string[] {
  return [
    r.changelog > 0 && `${key} CHANGELOG.md : conflit d'ajout pur résolu par union sous [Unreleased] (${r.changelog} commit(s))`,
    r.baseline > 0 && `${key} ${BASELINE} : base recalculée sur main + baisses du lot (${r.baseline} commit(s))`,
    r.moved > 0 && `${key} CHANGELOG.md : ${r.moved} entrée(s) du lot replacée(s) sous [Unreleased], une publication a eu lieu pendant la branche`,
    r.silent && `${key} ${BASELINE} : base recomposée sur main + baisses du lot (fusion sans conflit de git corrigée)`,
    r.settled && `${key} CHANGELOG.md : une entrée finale par lot, les versions intermédiaires du lot écartées`,
  ].filter((n): n is string => typeof n === 'string');
}

/**
 * Patch-id stable (`git patch-id --stable`) du diff cumulé de `from` à `to` (R9) : le même diff reste le même quand le contexte se déplace, il change quand
 * une ligne du lot change. Vide quand il n'y a pas de diff.
 */
export function patchId(cwd: string, from: string, to: string): string {
  const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', from, to], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
  if (!diff) return '';
  return execFileSync('git', ['patch-id', '--stable'], { cwd, input: diff, encoding: 'utf8' }).trim().split(/\s+/)[0] ?? '';
}

/** Avance la branche courante du dépôt du lead jusqu'à la branche du lot, en fast-forward seulement (R8, R24) : l'arbre du lead ne reçoit que les fichiers du lot. */
export function advance(repo: string, branch: string): void {
  git(repo, 'merge', '--ff-only', '--quiet', `refs/heads/${branch}`);
}

/** Vrai quand la branche du dépôt n'est plus un ancêtre de celle du lot : elle a avancé depuis le rebase, l'avance rapide est impossible (L364). */
export const baseMoved = (repo: string, branch: string, base: string): boolean =>
  tryGit(repo, 'merge-base', '--is-ancestor', `refs/heads/${base}`, `refs/heads/${branch}`) === null;
