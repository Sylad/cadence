import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir } from '../git.js';
import { sharedStateDir } from '../state.js';
import { activeLock, releaseLock, takeLock, type OLock } from './lock.js';
import { mergeUnreleased, moveToUnreleased, settleLotEntries, unreleasedSections } from './changelog-merge.js';
import { mutexFor } from './mutex.js';
import { Plan } from '../plan.js';
import { parseDocument } from 'yaml';
import { git, gitFailure, tryGit } from './worktree.js';

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
 * Une attente ne retient aucun créneau de session : ce verrou n'a rien à voir avec eux.
 */
export async function takeRepoWrite(repo: string, who: { wave: string }, o: { waitMs?: number; pollMs?: number } = {}): Promise<Grant> {
  const waitMs = o.waitMs ?? INTEGRATE_WAIT_MS;
  const pollMs = o.pollMs ?? INTEGRATE_POLL_MS;
  const file = join(sharedStateDir(repo), INTEGRATION_LOCK);
  const turn = (await mutexFor(`integrate:${gitCommonDir(repo)}`).acquire())!;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock: OLock = { pid: process.pid, wave: who.wave, started: new Date().toISOString() };
    const got = takeLock(file, lock);
    if (got.ok) {
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
      return { ok: false, holder: { wave: got.held.wave, pid: got.held.pid } };
    }
    await sleep(pollMs);
  }
}

/** Branche courante du dépôt (`main`), null en HEAD détaché (R24). */
export const repoBranch = (repo: string): string | null => tryGit(repo, 'symbolic-ref', '--short', '-q', 'HEAD') || null;

/** Point de départ de `rev` par rapport à la branche `base` : le dernier ancêtre commun. */
export const mergeBase = (cwd: string, rev: string, base: string): string => git(cwd, 'merge-base', rev, `refs/heads/${base}`);

export type Rebase = { kind: 'forwarded' } | { kind: 'rebased'; before: string; after: string; changelog: number; moved: number; settled: boolean } | { kind: 'conflict'; files: string[]; detail: string };

const CHANGELOG = 'CHANGELOG.md';
const REBASE_ENV = { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: REBASE_ENV });

/**
 * Résout le conflit en cours quand c'est le CHANGELOG seul et de l'ajout pur sous `[Unreleased]` (L314) : écrit l'union, l'ajoute à l'index. Faux, sans rien
 * toucher, pour tout autre conflit (un autre fichier avec lui, une entrée de base modifiée, une étape de base absente). `start` : le CHANGELOG au point de
 * départ de la branche (L323), pour qu'un commit puisse réécrire l'entrée qu'un commit précédent du lot a ajoutée.
 */
function resolveChangelog(work: string, start: string | undefined): boolean {
  const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
  if (files.length !== 1 || files[0] !== CHANGELOG) return false;
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

/**
 * Résout le conflit en cours quand c'est le plan seul et que le commit du lot rejoué n'y ajoute que des revues de lot (L370 : le `raf review` du lead dans
 * le worktree) : le plan de la branche du dépôt est gardé, et chaque revue ajoutée est réécrite dessus par l'API du plan. Faux, sans rien toucher, si le
 * commit change autre chose que des revues — un autre champ d'un lot, un lot ajouté ou retiré, ou la tête du plan hors `lots` (`acknowledged:` après un
 * `raf ignore`, `reviewSince`, un réglage) : repris tel quel, le plan du dépôt perdrait ce changement sans message —, ou si la branche du dépôt a elle-même
 * changé une de ces revues.
 */
function resolvePlan(work: string): boolean {
  const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
  if (files.length !== 1) return false;
  const file = files[0];
  try {
    const stage = (n: number) => {
      const text = run(work, 'show', `:${n}:${file}`);
      writeFileSync(join(work, file), text);
      const head = parseDocument(text).toJSON() as Record<string, unknown> | null;
      return { lots: Plan.load(join(work, file)).lots(), head: JSON.stringify({ ...(head ?? {}), lots: undefined }) };
    };
    const [b, o, t] = [stage(1), stage(2), stage(3)];
    const [base, ours, theirs] = [b.lots, o.lots, t.lots];
    if (t.head !== b.head) return false;
    const bare = (l: { review?: unknown }) => JSON.stringify({ ...l, review: undefined });
    const review = (l: { review?: unknown } | undefined) => JSON.stringify(l?.review ?? null);
    const added = theirs.filter((t) => review(t) !== review(base.find((b) => b.id === t.id)));
    if (!added.length || theirs.length !== base.length || theirs.some((t) => bare(t) !== bare(base.find((b) => b.id === t.id) ?? { review: 1 }))) return false;
    if (added.some((t) => review(ours.find((o) => o.id === t.id)) !== review(base.find((b) => b.id === t.id)))) return false;
    writeFileSync(join(work, file), run(work, 'show', `:2:${file}`));
    const plan = Plan.load(join(work, file));
    for (const t of added) plan.recordReview(t.id, t.review!.verdict, t.review!.date, t.review!.commit ?? null, t.review!.repos, t.review!.reporte);
    plan.save();
    run(work, 'add', '--', file);
    return true;
  } catch {
    return false; // le fichier écrasé est restauré par le `rebase --abort` de l'appelant
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
 * Rebase le worktree `work` sur la branche `base` (R6). Une branche qui descend déjà du sommet de `base` n'a rien à rebaser (fast-forward pur : aucun sha ne
 * change). Un conflit d'ajout pur dans le CHANGELOG est résolu par union à chaque commit qui le porte (L314, `changelog` les compte), un conflit du plan quand le commit n'y ajoute que des revues de lot (L370). Tout autre conflit — ou
 * tout autre échec du rebase — est abandonné (`rebase --abort`) : la branche du lot et son arbre restent tels qu'avant, la branche du dépôt n'a pas été
 * touchée, personne ne résout le conflit à l'aveugle.
 */
export function rebaseOnto(work: string, base: string): Rebase {
  const before = git(work, 'rev-parse', 'HEAD');
  if (tryGit(work, 'merge-base', '--is-ancestor', `refs/heads/${base}`, 'HEAD') !== null) return { kind: 'forwarded' };
  let changelog = 0;
  const start = tryGit(work, 'show', `${mergeBase(work, 'HEAD', base)}:${CHANGELOG}`) ?? undefined;
  try {
    run(work, 'rebase', `refs/heads/${base}`);
  } catch (first) {
    let failure = first;
    // Chaque tour règle le commit sur lequel le rebase s'est arrêté ; un lot ne porte pas des centaines de commits, la borne évite seulement une boucle sans fin.
    for (let turn = 0; ; turn++) {
      if (turn >= 200 || !(resolveChangelog(work, start) || resolvePlan(work))) {
        const files = (tryGit(work, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
        tryGit(work, 'rebase', '--abort');
        return { kind: 'conflict', files, detail: gitFailure(failure) };
      }
      changelog++;
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
  return { kind: 'rebased', before, after: git(work, 'rev-parse', 'HEAD'), changelog, moved, settled };
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
