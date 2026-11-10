// Dépôt tenu (L695, D-9) : pendant qu'un programme (cadence run, porte jouée dans l'arbre principal) va intégrer ou lire une branche, le lead n'y commite pas.
// Le programme pose un fichier dans <git-common-dir>/cadence/tenu/ ; le pre-commit refuse un commit sur cette branche, et `raf add|note|done` mettent
// leur écriture dans .cadence/plan-en-attente.yaml, que le programme fait appliquer (`raf attente appliquer`) une fois le dépôt rendu.
// Le format du fichier est partagé avec v2/src/run/run.ts, qui l'écrit lui-même (v2 ne lit pas src/) : { pid, start?, kind, label, branch, since }.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { gitCommonDir, tryGit } from './git.js';
import { holderAlive } from './orchestrate/lock.js';
import { processStart } from './proc.js';
import { sharedStateDir } from './state.js';

export const HELD_DIR = 'tenu';
export const PENDING_PLAN = '.cadence/plan-en-attente.yaml';

interface Holder { pid: number; start?: string; kind: string; label: string; branch: string; since: string }
interface PendingWrite { date: string; tenu: string; argv: string[] }

const heldDir = (root: string) => join(sharedStateDir(root), HELD_DIR);

/** La branche où un commit fait dans `cwd` atterrirait ; null en tête détachée ou hors dépôt. */
const branchOf = (cwd: string): string | null => tryGit(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])?.trim() || null;

/** Tient la branche courante de `root` pour ce processus ; rend la fonction qui la libère. */
export function holdRepo(root: string, kind: string, label: string): () => void {
  const branch = branchOf(root);
  if (!branch) return () => {};
  const file = join(heldDir(root), `${kind}-${process.pid}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, start: processStart(process.pid) ?? undefined, kind, label, branch, since: new Date().toISOString() } satisfies Holder));
  return () => rmSync(file, { force: true });
}

/** Les programmes vivants qui tiennent le dépôt ; un fichier d'un processus mort est retiré au passage. */
export function repoHolders(root: string): Holder[] {
  const dir = join(gitCommonDir(root), 'cadence', HELD_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    let h: Holder;
    try {
      h = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Holder;
    } catch {
      return [];
    }
    if (holderAlive(Number(h.pid), h.start)) return [h];
    rmSync(join(dir, f), { force: true });
    return [];
  });
}

/** Le programme qui tient la branche où `cwd` écrit, ou null. */
export function holderHere(cwd: string): Holder | null {
  const branch = branchOf(cwd);
  return branch ? (repoHolders(cwd).find((h) => h.branch === branch) ?? null) : null;
}

const since = (h: Holder) => h.since.slice(11, 16);

/** Qui applique l'attente : cadence run en rendant le dépôt ; après une porte, le prochain add|note|done ou `raf attente appliquer`. */
const applier = (h: Holder) => (h.kind === 'run' ? 'appliqué par le run quand il rend le dépôt' : 'appliqué au premier raf add|note|done après sa fin, ou par raf attente appliquer');

/** Le refus du pre-commit quand la branche du commit est tenue, avec le geste à faire ; null si elle est libre. */
export function commitRefusal(cwd: string): string | null {
  const h = holderHere(cwd);
  if (!h) return null;
  return `commit refusé : la branche ${h.branch} est tenue par ${h.label} (pid ${h.pid}, depuis ${since(h)}) — un commit ici lui ferait échouer son intégration en avance rapide ou rendrait sa porte non probante. `
    + `À faire : pour le plan, \`raf add|note|done\` écrivent dans ${PENDING_PLAN}, ${applier(h)} (\`raf attente\` le montre) ; `
    + `pour un autre changement, attendre sa fin (cadence run --liste) puis commiter, ou le commiter sur une autre branche ; --no-verify pour passer outre`;
}

/** Le fichier d'attente du dépôt ; jamais suivi par git (ajouté à info/exclude à la première écriture). */
const pendingFile = (root: string) => join(root, PENDING_PLAN);

export function readPending(root: string): PendingWrite[] {
  const f = pendingFile(root);
  if (!existsSync(f)) return [];
  return (parse(readFileSync(f, 'utf8')) as PendingWrite[] | null) ?? [];
}

/** Met une écriture de `raf` en attente ; rend la ligne qui le dit. */
export function deferPlanWrite(root: string, h: Holder, argv: string[], now: Date): string {
  const f = pendingFile(root);
  const all = [...readPending(root), { date: now.toISOString(), tenu: h.label, argv }];
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `# Écritures du plan mises en attente pendant que le dépôt était tenu (L695) : \`raf attente appliquer\` les joue dans l'ordre.\n${stringify(all)}`);
  const exclude = join(gitCommonDir(root), 'info', 'exclude');
  const line = `/${PENDING_PLAN}`;
  if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes(line)) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${existsSync(exclude) && !readFileSync(exclude, 'utf8').endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  return `mis en attente : raf ${argv.join(' ')} — la branche ${h.branch} est tenue par ${h.label} (pid ${h.pid}) ; écrit dans ${PENDING_PLAN}, ${applier(h)} (${all.length} en attente)`;
}

/** Joue les écritures en attente dans l'ordre ; la première qui échoue et les suivantes restent en attente. */
export function applyPending(root: string, raf: (argv: string[]) => number, out: (l: string) => void): number {
  const all = readPending(root);
  let done = 0;
  for (const w of all) {
    if (raf(w.argv) !== 0) break;
    done++;
  }
  const left = all.slice(done);
  if (left.length === 0) rmSync(pendingFile(root), { force: true });
  else writeFileSync(pendingFile(root), stringify(left));
  out(`plan en attente : ${done} écriture(s) appliquée(s)${left.length ? `, ${left.length} restée(s) en attente (échec de raf ${left[0]!.argv.join(' ')})` : ''}${done ? ' — le plan est modifié, à commiter' : ''}`);
  return left.length ? 1 : 0;
}
