import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDay, type Day } from './dates.js';
import { gitCommonDir, gitPath } from './git.js';

/** État local propre au worktree (notes de clôture). */
export function stateDir(cwd: string): string {
  const dir = gitPath(cwd, 'cadence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** État local commun à tous les worktrees (verrou et journal des livraisons) : une seule livraison par dépôt. */
export function sharedStateDir(cwd: string): string {
  const dir = join(gitCommonDir(cwd), 'cadence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Next {
  date: Day;
  lines: string[];
}

export function readNext(dir: string): Next | null {
  const file = join(dir, 'next.md');
  if (!existsSync(file)) return null;
  const [head, ...rest] = readFileSync(file, 'utf8').split('\n');
  const lines = rest.map((l) => l.replace(/^- /, '')).filter(Boolean);
  return { date: head.replace(/^# /, '').trim(), lines };
}

/** Remplace les notes pour la prochaine session. Ne les efface jamais : c'est `clearNext`, demandé exprès. */
export function writeNext(dir: string, date: Day, lines: string[]): void {
  if (lines.length === 0) throw new Error('writeNext : aucune ligne');
  writeFileSync(join(dir, 'next.md'), `# ${date}\n${lines.map((l) => `- ${l.replace(/\n/g, ' ')}`).join('\n')}\n`);
}

/** Efface les notes pour la prochaine session ; rend celles qui s'y trouvaient, null s'il n'y en avait pas. */
export function clearNext(dir: string): Next | null {
  const previous = readNext(dir);
  rmSync(join(dir, 'next.md'), { force: true });
  return previous;
}

interface SessionMark {
  kind: 'start' | 'close';
  /** Instant ISO (UTC) de l'ouverture ou de la clôture. */
  at: string;
}

/** Dernière ouverture ou clôture réussie du projet ; null si inconnue ou illisible (la clôture retombe alors sur le jour même). */
export function readSessionMark(dir: string): SessionMark | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    if ((raw.kind === 'start' || raw.kind === 'close') && typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at))) return { kind: raw.kind, at: raw.at };
  } catch {
    // absent ou illisible : pas de borne connue
  }
  return null;
}

export function writeSessionMark(dir: string, mark: SessionMark): void {
  writeFileSync(join(dir, 'session.json'), `${JSON.stringify(mark)}\n`);
}

interface Lock {
  pid: number;
  sha: string;
  started: string;
}

export function lockPath(dir: string): string {
  return join(dir, 'deliver.lock');
}

function readLockFile(file: string): (Lock & { unreadable?: boolean; ageMs: number }) | null {
  let text: string;
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text);
    return { pid: Number(raw.pid), sha: String(raw.sha), started: String(raw.started), ageMs };
  } catch {
    return { pid: 0, sha: '?', started: '?', unreadable: true, ageMs };
  }
}

export function readLock(dir: string): (Lock & { unreadable?: boolean; ageMs: number }) | null {
  return readLockFile(lockPath(dir));
}

/** Verrou tenu : processus vivant, ou fichier illisible mais tout récent (écriture en cours ailleurs). */
export function lockAlive(lock: { pid: number; unreadable?: boolean; ageMs: number }): boolean {
  return lock.unreadable ? lock.ageMs < 5_000 : pidAlive(lock.pid);
}

/** Pose un fichier de façon atomique (lien vers un fichier complet : il n'existe jamais à moitié écrit) ; false s'il existe déjà (EEXIST) ; toute autre erreur est relancée. `tag` distingue les fichiers temporaires d'un même processus. */
export function linkNewFile(file: string, content: string, tag: string | number): boolean {
  const tmp = `${file}.${tag}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    // Seul EEXIST veut dire « déjà là » ; EPERM, EMLINK… (pas de liens physiques ici) remontent au lieu de passer pour un verrou tenu.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Retire un verrou périmé seulement s'il est encore celui qu'on a lu : il est écarté par renommage, `same` relit
 * l'écart, et s'il a changé il est rendu à son nouveau porteur. Partagé par le verrou de livraison et celui de l'URL UX.
 */
export function removeStaleFile(file: string, same: (aside: string) => boolean): boolean {
  const aside = `${file}.stale.${process.pid}`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  if (same(aside)) {
    rmSync(aside, { force: true });
    return true;
  }
  // Un autre processus a pris le verrou entre-temps : le lui rendre.
  try {
    linkSync(aside, file);
  } catch {
    // Un troisième l'a déjà repris : le sien fait foi.
  }
  rmSync(aside, { force: true });
  return false;
}

/** Cause d'une pose de verrou impossible, en une ligne : « verrou <chemin> : <errno> » (le code, sinon le message). */
export function lockFault(file: string, e: unknown): string {
  return `verrou ${file} : ${(e as NodeJS.ErrnoException | null | undefined)?.code ?? (e instanceof Error ? e.message : String(e))}`;
}

/** Pose le verrou de façon atomique (lien vers un fichier complet) ; false s'il existe déjà. */
export function writeLock(dir: string, lock: Lock): boolean {
  return linkNewFile(lockPath(dir), JSON.stringify(lock), lock.pid);
}

/** Retire un verrou périmé seulement s'il est encore celui qu'on a lu ; sinon le laisse en place. */
export function removeStaleLock(dir: string, seen: Lock): boolean {
  return removeStaleFile(lockPath(dir), (aside) => {
    const now = readLockFile(aside);
    return !!now && now.pid === seen.pid && now.sha === seen.sha && now.started === seen.started;
  });
}

/** Retire le verrou s'il appartient à ce processus. */
export function releaseLock(dir: string, pid: number): void {
  const lock = readLock(dir);
  if (lock && lock.pid === pid) rmSync(lockPath(dir), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function appendDelivery(dir: string, day: Day, sha: string): void {
  appendFileSync(join(dir, 'deliveries.log'), `${day} ${sha}\n`);
}

/** Classe d'une livraison rouge : où elle a cassé. `refus` : le script a refusé avant d'agir (code 2). */
export const FAIL_CLASSES = ['refus', 'ci', 'deploiement', 'verification'] as const;
export type FailClass = (typeof FAIL_CLASSES)[number];

const TAIL_SEP = ' ⏎ ';
const TAIL_LINES = 5;
const LINE_MAX = 200;
const REASON_MAX = 300;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

const MASK = '***';
const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'pass', 'key', 'credential', 'credentials', 'auth', 'authorization', 'signature', 'sig', 'jwt', 'cookie']);
// Mots sensibles qui, collés à un autre (APIKEY, ACCESSTOKEN, GITHUBTOKEN), terminent encore un nom : pas « pass », « sig » ou « auth » (BYPASS, ...).
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'key', 'credential', 'credentials', 'signature', 'pwd'];
// Un nom de variable ou de paramètre d'URL est sensible quand l'un de ses mots (séparés par _ - . ou une majuscule) en est un, ou finit par l'un des suffixes.
const sensitiveName = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_.-]/)
    .some((w) => SECRET_WORDS.has(w.toLowerCase()) || SECRET_SUFFIXES.some((x) => w.toLowerCase().endsWith(x)));
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,})\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const ASSIGNMENT = /([A-Za-z][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s&"']+)/g;

/** Masque ce qui ressemble à un secret (jeton connu, Bearer, identifiants d'URL, VAR=valeur ou paramètre d'URL au nom sensible) : motifs probables, pas une garantie. */
export const maskSecrets = (line: string): string =>
  line
    .replace(BEARER, `$1 ${MASK}`)
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(TOKEN_SHAPES, MASK)
    .replace(ASSIGNMENT, (m, name: string) => (sensitiveName(name) ? `${name}=${MASK}` : m));

const clean = (line: string, max: number): string => {
  const t = maskSecrets(line.replace(ANSI, '').replace(CONTROL, ' ')).replaceAll('⏎', ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Ajoute une livraison rouge à `deliveries-failed.log` : une ligne « jour sha [classe] raison ⏎ ligne ⏎ ligne ».
 * La raison est la première ligne du message d'échec ; `tail` (sortie de la commande en échec) est borné à ses
 * 5 dernières lignes non vides de 200 caractères, sans séquence ANSI, secrets probables masqués (raison comprise).
 */
export function appendFailedDelivery(dir: string, day: Day, sha: string, reason: string, cls?: FailClass, tail: string[] = []): void {
  const kept = tail.flatMap((l) => clean(l, LINE_MAX) || []).slice(-TAIL_LINES);
  const head = `${day} ${sha} ${cls ? `[${cls}] ` : ''}${clean(reason.split('\n')[0]!, REASON_MAX)}`;
  appendFileSync(join(dir, 'deliveries-failed.log'), `${[head, ...kept].join(TAIL_SEP)}\n`);
}

export interface FailedDelivery {
  day: Day;
  sha: string;
  /** null : ligne d'avant la classe (L282) dont le libellé n'est pas reconnu, ou classe inconnue. */
  cls: FailClass | null;
  reason: string;
  tail: string[];
}

export function lastDelivery(dir: string): string | null {
  const file = join(dir, 'deliveries.log');
  if (!existsSync(file)) return null;
  const last = readFileSync(file, 'utf8').trim().split('\n').pop();
  return last?.split(' ')[1] ?? null;
}

/** Tous les jours de `deliveries.log` (une ligne « jour sha » par livraison verte), dans l'ordre du fichier ; null si le fichier est absent ou illisible. Lecture seule : ne crée rien. */
export function readDeliveries(dir: string): Day[] | null {
  try {
    return readFileSync(join(dir, 'deliveries.log'), 'utf8')
      .split('\n')
      .map((l) => l.split(' ')[0]!)
      .filter(isDay);
  } catch {
    return null;
  }
}

/** Classe d'une ligne écrite avant la classe [cls] (L282), déduite du libellé que `deliver` écrit lui-même ; null si le libellé n'est pas l'un des siens. */
function classFromReason(reason: string): FailClass | null {
  const script = /^script de livraison en échec \((?:code (\d+)|[^)]*)\)/.exec(reason);
  if (script) return script[1] === '2' ? 'refus' : 'deploiement';
  if (/^(?:déploiement en échec|CADENCE_DEPLOYED_FILE )/.test(reason)) return 'deploiement';
  if (/^(?:CI en échec|CI non terminée|gh run list en échec|aucun run CI pour ce sha)/.test(reason)) return 'ci';
  if (/^vérification en échec/.test(reason)) return 'verification';
  return null;
}

/** Les livraisons rouges de `deliveries-failed.log`, dans l'ordre du fichier ; une ligne illisible est ignorée, un fichier absent ou illisible donne aucune livraison rouge. Lecture seule : ne crée rien. */
export function readFailedEntries(dir: string): FailedDelivery[] {
  try {
    return readFileSync(join(dir, 'deliveries-failed.log'), 'utf8')
      .split('\n')
      .flatMap((line): FailedDelivery[] => {
        const [head = '', ...tail] = line.split(TAIL_SEP);
        const m = /^(\S+)(?: (\S+))?(?: (.*))?$/.exec(head);
        if (!m || !isDay(m[1]!)) return [];
        let reason = m[3] ?? '';
        const c = /^\[(\w+)\] ?/.exec(reason);
        const written = c && (FAIL_CLASSES as readonly string[]).includes(c[1]!) ? (c[1] as FailClass) : null;
        if (written) reason = reason.slice(c![0].length);
        // Sans [cls] écrit : le fichier n'est jamais réécrit, la classe se déduit du libellé à la lecture.
        const cls = written ?? (c ? null : classFromReason(reason));
        return [{ day: m[1] as Day, sha: m[2] ?? '', cls, reason, tail }];
      });
  } catch {
    return [];
  }
}

/** Les jours de `deliveries-failed.log` (une ligne par livraison rouge), dans l'ordre du fichier. */
export function readFailedDeliveries(dir: string): Day[] {
  return readFailedEntries(dir).map((e) => e.day);
}
