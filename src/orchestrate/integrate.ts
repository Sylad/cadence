import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir } from '../git.js';
import { sharedStateDir } from '../state.js';
import { activeLock, releaseLock, takeLock, type OLock } from './lock.js';
import { mergeUnreleased } from './changelog-merge.js';
import { mutexFor } from './mutex.js';
import { git, gitFailure, tryGit } from './worktree.js';

/** Verrou d'intégration d'un dépôt (L279, R10) : dans l'état commun aux worktrees, au format du verrou d'orchestration, sous un autre nom. */
export const INTEGRATION_LOCK = 'orchestrate-integration.lock';
/** Attente du verrou d'intégration (R25) : une intégration dure un rebase et la relance des tests. */
export const INTEGRATE_WAIT_MS = 10 * 60_000;
export const INTEGRATE_POLL_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Grant = { ok: true; release: () => void } | { ok: false; holder: { wave: string; pid: number } };

/**
 * Prend la main sur le dépôt pour une intégration ou une écriture de plan du programme (R10, R21, R26) : d'abord la file en mémoire du dépôt (les lots d'une
 * vague partagent un pid, `takeLock` rendrait chacun déjà porteur), puis le verrou fichier, qui ne départage que les autres processus. L'attente est bornée
 * par `waitMs` (R25) ; au-delà, le porteur est rendu et rien n'est pris. Une attente ne retient aucun créneau de session : ce verrou n'a rien à voir avec eux.
 */
export async function takeRepoWrite(repo: string, who: { wave: string }, o: { waitMs?: number; pollMs?: number } = {}): Promise<Grant> {
  const waitMs = o.waitMs ?? INTEGRATE_WAIT_MS;
  const pollMs = o.pollMs ?? INTEGRATE_POLL_MS;
  const file = join(sharedStateDir(repo), INTEGRATION_LOCK);
  const deadline = Date.now() + waitMs;
  const turn = await mutexFor(`integrate:${gitCommonDir(repo)}`).acquire(waitMs);
  if (!turn) {
    // Un autre lot de ce processus tient la main : c'est lui le porteur (il a posé le verrou fichier).
    const holder = activeLock(file);
    return { ok: false, holder: { wave: holder?.wave ?? who.wave, pid: holder?.pid ?? process.pid } };
  }
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

export type Rebase = { kind: 'forwarded' } | { kind: 'rebased'; before: string; after: string; changelog: number } | { kind: 'conflict'; files: string[]; detail: string };

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
 * Rebase le worktree `work` sur la branche `base` (R6). Une branche qui descend déjà du sommet de `base` n'a rien à rebaser (fast-forward pur : aucun sha ne
 * change). Un conflit d'ajout pur dans le CHANGELOG est résolu par union à chaque commit qui le porte (L314, `changelog` les compte). Tout autre conflit — ou
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
      if (turn >= 200 || !resolveChangelog(work, start)) {
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
  return { kind: 'rebased', before, after: git(work, 'rev-parse', 'HEAD'), changelog };
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
