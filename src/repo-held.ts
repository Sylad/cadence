// Dépôt tenu (L695, D-9) : pendant qu'un programme (cadence run, porte jouée dans l'arbre principal) va intégrer ou lire une branche, le lead n'y commite pas.
// Le programme pose un fichier dans <git-common-dir>/cadence/tenu/ ; le pre-commit refuse un commit sur cette branche, et `raf add|note|start|done|review|ux|demande`
// (L722 : review, ux et le registre des demandes aussi ; L779 : start) mettent leur écriture dans .cadence/plan-en-attente.yaml, que le programme fait appliquer
// (`raf attente appliquer`) une fois le dépôt rendu.
// Le format du fichier est partagé avec v2/src/run/run.ts, qui l'écrit lui-même (v2 ne lit pas src/) : { pid, start?, kind, label, branch, since }.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { nommerFichiers, PLAN_EN_ATTENTE } from '../scripts/arbre-non-commite.mjs';
import { gitCommonDir, PROGRAM_COMMIT_VAR, tryGit } from './git.js';
import { holderAlive } from './orchestrate/lock.js';
import { RafError } from './plan.js';
import { withPlanLock } from './plan-lock.js';
import { processStart } from './proc.js';
import { sharedStateDir } from './state.js';

export const HELD_DIR = 'tenu';
export const PENDING_PLAN = PLAN_EN_ATTENTE;
const PENDING_LOCK = 'plan-en-attente.lock';
/** Les écritures mises en attente sur une branche tenue, telles que les messages les nomment. */
const DEFERRED_WRITES = 'raf add|note|start|done|review|ux|demande';

/** `worktree` (L796) : le worktree d'un cadence run ; le run ne tient alors que les fichiers qu'il y touche. Sans lui (porte dans l'arbre principal), toute la branche. */
interface Holder { pid: number; start?: string; kind: string; label: string; branch: string; since: string; worktree?: string }
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

/** Qui applique l'attente : cadence run en rendant le dépôt ; après une porte, le prochain add|note|start|done|review|ux|demande ou `raf attente appliquer`. */
const applier = (h: Holder) => (h.kind === 'run' ? 'appliqué par le run quand il rend le dépôt' : `appliqué au premier ${DEFERRED_WRITES} après sa fin, ou par raf attente appliquer`);

/**
 * L796 (issue #70) : les fichiers qu'un cadence run touche, lus dans son worktree au moment du commit du lead : ceux qu'il change depuis la branche tenue
 * (depuis leur ancêtre commun : après un rebase, pas ceux des commits de la branche), commités ou non, et ses fichiers non suivis ; null si illisible.
 * Git est appelé sans les variables GIT_* du hook (GIT_INDEX_FILE désigne l'index de l'arbre principal).
 */
function runFiles(h: Holder): Set<string> | null {
  if (!h.worktree || !existsSync(h.worktree)) return null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const g = (...a: string[]) => { const r = spawnSync('git', a, { cwd: h.worktree, env, encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
  const base = g('merge-base', h.branch, 'HEAD')?.trim();
  const diff = base ? g('diff', '--name-only', '--no-renames', '-z', base) : null, others = g('ls-files', '--others', '--exclude-standard', '-z');
  return diff === null || others === null ? null : new Set(`${diff}\0${others}`.split('\0').filter(Boolean));
}

/** Les fichiers du commit en cours (index du hook : `GIT_INDEX_FILE` d'un `commit -a` compris) ; null si illisible. */
function stagedFiles(cwd: string, env: NodeJS.ProcessEnv): string[] | null {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
}

/**
 * Le refus du pre-commit quand la branche du commit est tenue, avec le geste à faire ; null si elle est libre ou si le commit est celui d'un programme (`commitAsProgram`).
 * L796 : tenue par un cadence run qui a dit son worktree, seul un commit qui touche un fichier du run est refusé ; un commit disjoint passe, le run se rebase
 * dessus à l'intégration. Fichiers du run ou du commit illisibles : toute la branche, comme avant.
 */
export function commitRefusal(cwd: string, env: NodeJS.ProcessEnv = {}): string | null {
  if (env[PROGRAM_COMMIT_VAR]) return null;
  const h = holderHere(cwd);
  if (!h) return null;
  const run = h.kind === 'run' ? runFiles(h) : null, staged = run ? stagedFiles(cwd, env) : null;
  const communs = run && staged ? staged.filter((f) => run.has(f)) : null;
  if (communs && !communs.length) return null;
  const tenue = `commit refusé : la branche ${h.branch} est tenue par ${h.label} (pid ${h.pid}, depuis ${since(h)})`;
  const quoi = communs ? ` sur les fichiers que le run touche aussi : ${nommerFichiers(communs)} — un commit de ces fichiers ici lui ferait échouer son intégration. `
    : ' — un commit ici lui ferait échouer son intégration en avance rapide ou rendrait sa porte non probante. ';
  return `${tenue}${quoi}À faire : pour le plan et le registre des demandes, \`${DEFERRED_WRITES}\` écrivent dans ${PENDING_PLAN}, ${applier(h)} (\`raf attente\` le montre) ; `
    + `${communs ? 'commiter à part les fichiers que le run ne touche pas (ils passent) ; pour ceux-là, ' : 'pour un autre changement, '}attendre sa fin (cadence run --liste) puis commiter, ou le commiter sur une autre branche ; --no-verify pour passer outre`;
}

/** Le fichier d'attente du dépôt ; jamais suivi par git (ajouté à info/exclude à la première écriture). */
const pendingFile = (root: string) => join(root, PENDING_PLAN);

export function readPending(root: string): PendingWrite[] {
  const f = pendingFile(root);
  if (!existsSync(f)) return [];
  return (parse(readFileSync(f, 'utf8')) as PendingWrite[] | null) ?? [];
}

/**
 * Ajout et application passent sous le même verrou (revue L695 r1, D-10) : un ajout fait pendant une application attend qu'elle finisse au lieu d'être
 * effacé par elle, et deux applications concurrentes ne jouent pas deux fois la même écriture (la seconde relit le fichier vidé par la première).
 */
function withPendingLock<T>(root: string, fn: () => T): T {
  mkdirSync(dirname(pendingFile(root)), { recursive: true });
  // Le verrou vit dans l'état commun du dépôt, hors de l'arbre : jamais vu par git status ni par une porte.
  const dir = sharedStateDir(root);
  mkdirSync(dir, { recursive: true });
  return withPlanLock(join(dir, PENDING_LOCK), (m) => new RafError(m.replace('plan tenu', 'plan en attente tenu')), fn);
}

const PENDING_HEADER = `# Écritures du plan et du registre des demandes mises en attente pendant que le dépôt était tenu (L695, L722) : \`raf attente appliquer\` les joue dans l'ordre.\n`;

/** Met une écriture de `raf` en attente ; rend la ligne qui le dit. */
export function deferPlanWrite(root: string, h: Holder, argv: string[], now: Date): string {
  const all = withPendingLock(root, () => {
    const next = [...readPending(root), { date: now.toISOString(), tenu: h.label, argv }];
    writeFileSync(pendingFile(root), `${PENDING_HEADER}${stringify(next)}`);
    return next;
  });
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
  const { done, left } = withPendingLock(root, () => {
    const all = readPending(root);
    let n = 0;
    for (const w of all) {
      if (raf(w.argv) !== 0) break;
      n++;
    }
    const rest = all.slice(n);
    if (rest.length === 0) rmSync(pendingFile(root), { force: true });
    else writeFileSync(pendingFile(root), `${PENDING_HEADER}${stringify(rest)}`);
    return { done: n, left: rest };
  });
  if (done === 0 && left.length === 0) {
    out('rien en attente (déjà appliqué)');
    return 0;
  }
  out(`plan en attente : ${done} écriture(s) appliquée(s)${left.length ? `, ${left.length} restée(s) en attente (échec de raf ${left[0]!.argv.join(' ')})` : ''}${done ? ' — le plan est modifié, à commiter' : ''}`);
  return left.length ? 1 : 0;
}

/** L722 : les fichiers que l'arbre de `root` n'a pas commités, hors plan en attente, et la ligne qui les nomme ; lecture partagée avec cadence run (v2). */
export { fichiersNonCommites as uncommittedFiles, nommerFichiers as namedFiles } from '../scripts/arbre-non-commite.mjs';
