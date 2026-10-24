import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { docSyncSet } from './docsync.js';
import { PLAN_DEFAULT, PLAN_LEGACY, readMigrateConfig } from './config.js';
import { gitRoot, isTracked } from './git.js';
import { RafError } from './plan.js';

/** L'historique n'est pas un lecteur : journaux de commits, journaux ndjson et fichiers d'exécution de `.cadence/`. */
const HISTORY = ['**/CHANGELOG*', '**/*.ndjson', '.cadence/**'];

/** Une référence à l'ancien emplacement que `raf migrate` sait réécrire : le chemin complet, pas suivi d'un nom plus long. */
const REWRITABLE = /docs\/plan\/raf\.yaml(?![\w-]|\.\w)/g;
/** Le chemin construit morceau par morceau : `'docs', 'plan'` (join) ou `'docs' / 'plan'` (pathlib). */
const BUILT = /['"`]docs['"`]\s*[,/]\s*['"`]plan['"`]/;
/** Toute autre façon de désigner docs/plan : un autre fichier du dossier, un dossier, un chemin construit morceau par morceau. */
const OTHER = new RegExp(`docs/plan(?!/raf\\.yaml(?![\\w-]|\\.\\w))|${BUILT.source}`);

const MAX_BYTES = 2 * 1024 * 1024;

export interface Reader {
  file: string;
  /** Nombre de références réécrites. */
  count: number;
}

export interface Unhandled {
  file: string;
  /** Numéro de ligne (1-based) ; absent pour un fichier qu'on ne sait pas lire. */
  line?: number;
  text: string;
}

export interface Migration {
  /** `git mv`, `mv`, ou null quand le plan n'est pas à l'ancien emplacement. */
  move: 'git mv' | 'mv' | null;
  readers: Reader[];
  /** Fichiers épargnés par `migrate.keep` qui citent bien l'ancien chemin. */
  kept: string[];
  unhandled: Unhandled[];
}

/** Les fichiers à lire : ceux que git suit, ou tout le dossier (sans .git ni node_modules) hors d'un dépôt. */
function candidates(root: string): string[] {
  if (gitRoot(root) === root) {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })
      .split('\0')
      .filter((f) => f !== '' && existsSync(join(root, f)));
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile()) files.push(relative(root, join(dir, e.name)).split('\\').join('/'));
    }
  };
  walk(root);
  return files;
}

/** Ce que la migration ferait, sans rien modifier. Rejouable : un plan déjà déplacé ne laisse que les lecteurs restants. */
export function planMigration(root: string): Migration {
  const hasLegacy = existsSync(join(root, PLAN_LEGACY));
  const hasDefault = existsSync(join(root, PLAN_DEFAULT));
  if (hasLegacy && hasDefault) throw new RafError(`${PLAN_LEGACY} et ${PLAN_DEFAULT} existent tous deux : migration refusée, fusionner ou supprimer l'un des deux d'abord`);
  if (!hasLegacy && !hasDefault) throw new RafError(`aucun plan à migrer : ni ${PLAN_LEGACY} ni ${PLAN_DEFAULT} sous ${root}`);
  const config = readMigrateConfig(join(root, 'cadence.yaml'));
  const isKept = docSyncSet(config.keep);
  const isHistory = docSyncSet(HISTORY);
  const result: Migration = { move: hasLegacy ? (gitRoot(root) && isTracked(root, PLAN_LEGACY) ? 'git mv' : 'mv') : null, readers: [], kept: [], unhandled: [] };
  for (const file of candidates(root).sort()) {
    if (file === PLAN_LEGACY || file === PLAN_DEFAULT || isHistory(file)) continue;
    const path = join(root, file);
    // ni lien symbolique (sa cible est lue sous son propre nom), ni dossier (sous-module), ni fichier hors du commun
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const buffer = readFileSync(path);
    const text = buffer.toString('utf8');
    if (!text.includes('docs/plan') && !BUILT.test(text)) continue;
    if (isKept(file)) {
      result.kept.push(file);
      continue;
    }
    if (buffer.includes(0)) {
      result.unhandled.push({ file, text: 'fichier binaire : le chemin ne peut pas y être réécrit' });
      continue;
    }
    if (!Buffer.from(text, 'utf8').equals(buffer)) {
      result.unhandled.push({ file, text: 'fichier non UTF-8 : le réécrire en altérerait les octets' });
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (OTHER.test(l)) result.unhandled.push({ file, line: i + 1, text: l.trim().slice(0, 160) });
    });
    const count = text.match(REWRITABLE)?.length ?? 0;
    if (count > 0) result.readers.push({ file, count });
  }
  return result;
}

/** La sortie lisible de la migration (aussi pour --dry-run) : le déplacement, chaque fichier touché, ce qui est épargné. */
export function describeMigration(m: Migration, dryRun: boolean): string[] {
  const out: string[] = [];
  if (dryRun) out.push('raf migrate --dry-run : rien n\'est modifié');
  if (!m.move && m.readers.length === 0) out.push(`rien à migrer : le plan est déjà à ${PLAN_DEFAULT} et aucun lecteur ne cite ${PLAN_LEGACY}`);
  out.push(m.move ? `plan : ${m.move} ${PLAN_LEGACY} ${PLAN_DEFAULT}` : `plan : déjà à ${PLAN_DEFAULT}`);
  if (m.readers.length === 0) out.push('lecteurs : rien à mettre à jour');
  else {
    const refs = m.readers.reduce((n, r) => n + r.count, 0);
    out.push(`lecteurs mis à jour : ${m.readers.length} fichiers, ${refs} références`);
    for (const r of m.readers) out.push(`  ${r.file} (${r.count})`);
  }
  if (m.kept.length > 0) {
    out.push(`laissés tels quels (migrate.keep) : ${m.kept.length} fichiers`);
    for (const f of m.kept) out.push(`  ${f}`);
  }
  return out;
}

/** Le refus : un lecteur reste non traité. */
export function unhandledError(m: Migration): RafError {
  const rows = m.unhandled.map((u) => `  ${u.file}${u.line === undefined ? '' : `:${u.line}`}  ${u.text}`);
  return new RafError(`migration refusée, aucun fichier modifié : ${m.unhandled.length} lecteur(s) non traité(s) (à corriger à la main, ou à déclarer sous migrate.keep dans cadence.yaml s'ils ne lisent pas le plan) :\n${rows.join('\n')}`);
}

/** Déplace le plan puis réécrit les lecteurs. L'appelant a vérifié qu'aucun lecteur n'est non traité. */
export function applyMigration(root: string, m: Migration): void {
  if (m.move) {
    mkdirSync(join(root, dirname(PLAN_DEFAULT)), { recursive: true });
    if (m.move === 'git mv') execFileSync('git', ['mv', '--', PLAN_LEGACY, PLAN_DEFAULT], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    else renameSync(join(root, PLAN_LEGACY), join(root, PLAN_DEFAULT));
  }
  for (const r of m.readers) {
    const path = join(root, r.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(REWRITABLE, PLAN_DEFAULT));
  }
}
