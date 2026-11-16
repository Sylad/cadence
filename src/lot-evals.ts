// L755 (D-26) : un lot qui touche un skill, un agent ou leur doc rejoue les cas d'éval du plugin qui les concernent avant d'être clos,
// pas seulement à la publication. Le 16-11, L744 avait passé deux revues et n'a été vu rouge par l'éval (livrer-sh-sans-bloc)
// qu'à la publication de 2.0.12, 7 h plus tard. La clé `evals` de cadence.yaml dit quels cas couvrent quels fichiers ;
// `cadence eval <lot>` rejoue les cas que touche le lot et note leur verdict par sha ; `raf done` refuse le lot tant qu'un de
// ces cas n'a pas de verdict vert pour le contenu actuel de ses fichiers.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docSyncSet } from './docsync.js';
import { changedFiles, git, tryGit } from './git.js';
import { RafError } from './plan.js';
import { sharedStateDir } from './state.js';
import { isObject, list, readYamlKey } from './yaml-keys.js';

/** Une entrée de la clé `evals` : les cas d'éval du plugin que rejoue un lot dont un fichier correspond à `paths`. */
interface EvalEntry {
  /** Motifs des fichiers couverts (mêmes motifs que `docs.sync` et `bounds`, `!motif` pour exclure). */
  paths: string[];
  /** Noms des cas (dossiers de `evals/`). */
  cases: string[];
}

const KEYS = ['paths', 'cases'];
/** Le dossier des cas, celui que lit `claude plugin eval` par défaut. */
const EVALS_DIR = 'evals';
/** Le registre des verdicts, dans le dossier d'état partagé des worktrees (un lot évalué dans son worktree est clos dans l'arbre principal). */
const RECORDS = 'evals-lots.json';

/** La clé `evals:` de `file` : liste vide quand le fichier ou la clé manquent ; `RafError` sur une forme refusée. */
export function readEvalEntries(file: string): EvalEntry[] {
  const raw = readYamlKey(file, 'evals');
  if (raw == null) return [];
  const bad = (what: string) => new RafError(`${file} : evals${what}`);
  if (!Array.isArray(raw)) throw bad(' : liste attendue (evals: [{ paths: [skills/deliver/**], cases: [deliver-sha] }])');
  return raw.map((entry, i) => {
    if (!isObject(entry)) throw bad(`[${i}] : objet attendu`);
    for (const k of Object.keys(entry)) if (!KEYS.includes(k)) throw bad(`[${i}].${k} inconnu (attendu : ${KEYS.join(', ')})`);
    const paths = list(entry.paths).map((p) => p.trim());
    if (!paths.length || paths.some((p) => !p)) throw bad(`[${i}].paths : au moins un motif de chemin non vide attendu`);
    const cases = list(entry.cases).map((c) => c.trim());
    if (!cases.length || cases.some((c) => !/^[\w.-]+$/.test(c))) throw bad(`[${i}].cases : au moins un nom de cas (dossier de ${EVALS_DIR}/) attendu`);
    return { paths, cases };
  });
}

/** Les entrées, plus une par cas cité pour son propre dossier (`evals/<cas>/**`) : changer la question ou un grader rejoue le cas. */
const withCaseDirs = (entries: EvalEntry[]): EvalEntry[] => [
  ...entries,
  ...[...new Set(entries.flatMap((e) => e.cases))].map((c) => ({ paths: [`${EVALS_DIR}/${c}/**`], cases: [c] })),
];

/** Les cas des entrées dont un fichier de `files` correspond aux `paths`, sans doublon, dans l'ordre des entrées. */
export function casesFor(entries: EvalEntry[], files: string[]): string[] {
  return [...new Set(withCaseDirs(entries).filter((e) => files.some(docSyncSet(e.paths))).flatMap((e) => e.cases))];
}

/** Les motifs de toutes les entrées qui citent `name` : ce dont dépend le verdict du cas. */
export function pathsOf(entries: EvalEntry[], name: string): string[] {
  return [...new Set(withCaseDirs(entries).filter((e) => e.cases.includes(name)).flatMap((e) => e.paths))];
}

/** Un verdict de `cadence eval` : un cas joué au sha `sha` (arbre propre pour ses fichiers), vert quand `code` vaut 0. */
interface EvalRecord {
  case: string;
  lot: string;
  sha: string;
  code: number;
  /** Le score « with » du cas (celui du rejeu quand il a eu lieu), null sans résultat lisible. */
  score: number | null;
  date: string;
  /** Le dossier des résultats, relatif au dépôt. */
  dir: string;
}

const recordsFile = (root: string): string => join(sharedStateDir(root), RECORDS);

export function readEvalRecords(root: string): EvalRecord[] {
  const f = recordsFile(root);
  if (!existsSync(f)) return [];
  try {
    const doc = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    return Array.isArray(doc) ? (doc as EvalRecord[]) : [];
  } catch {
    return []; // registre illisible : aucun verdict ne vaut, `cadence eval` le réécrit
  }
}

function addEvalRecords(root: string, records: EvalRecord[]): void {
  writeFileSync(recordsFile(root), `${JSON.stringify([...readEvalRecords(root), ...records], null, 2)}\n`);
}

/** Les fichiers de `paths` qui diffèrent entre `sha` et HEAD ; null quand git ne connaît pas `sha`. */
function differing(root: string, sha: string, paths: string[]): string[] | null {
  const out = tryGit(root, ['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', sha, 'HEAD']);
  return out === null ? null : out.split('\0').filter(Boolean).filter(docSyncSet(paths));
}

/** Un cas qu'un lot doit rejouer, et pourquoi le dernier verdict ne vaut pas. */
interface EvalGap {
  case: string;
  why: string;
}

/**
 * Les cas que touche `files` et qui n'ont pas de verdict vert pour le contenu actuel (HEAD) de leurs fichiers : un verdict vaut quand
 * aucun fichier couvert par le cas n'a changé entre son sha et HEAD (un commit de plan, un rebase ou un cherry-pick n'y change rien).
 */
function evalGaps(root: string, entries: EvalEntry[], files: string[]): EvalGap[] {
  const records = readEvalRecords(root);
  return casesFor(entries, files).flatMap((name) => {
    const mine = records.filter((r) => r.case === name).reverse();
    if (!mine.length) return [{ case: name, why: 'jamais rejoué' }];
    const paths = pathsOf(entries, name);
    for (const r of mine) {
      const diff = differing(root, r.sha, paths);
      if (diff === null || diff.length) continue;
      if (r.code === 0) return [];
      return [{ case: name, why: `rouge au dernier rejeu (${r.sha.slice(0, 7)}, ${r.dir})` }];
    }
    return [{ case: name, why: `fichiers changés depuis le dernier verdict (${mine[0]!.sha.slice(0, 7)})` }];
  });
}

/** Les fichiers des commits de travail d'un lot, sans doublon. */
export function filesOfCommits(root: string, shas: string[]): string[] {
  return [...new Set(shas.flatMap((s) => changedFiles(root, s)))];
}

/** La phrase de refus de `raf done`, ou null quand le lot n'a aucun cas à rejouer. */
export function evalRefusal(root: string, entries: EvalEntry[], lotId: string, files: string[]): string | null {
  const gaps = evalGaps(root, entries, files);
  if (!gaps.length) return null;
  const touched = files.filter((f) => withCaseDirs(entries).some((e) => docSyncSet(e.paths)(f)));
  return `${lotId} : touche ${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ` (+${touched.length - 3})` : ''}, que couvrent des cas d'éval du plugin (clé evals de cadence.yaml) sans verdict vert pour leur contenu actuel : ${gaps.map((g) => `${g.case} (${g.why})`).join(', ')} — cadence eval ${lotId} les rejoue (facturé, ~0,40 $ et ~1 min par cas), puis relancer raf done`;
}

/** L'enveloppe de rejeu de l'éval (L740), quand le dépôt l'a. */
const EVAL_REPLAY = 'scripts/eval-plugin.mjs';

/**
 * La commande qui rejoue un cas, bras « with » seul (le bras sans plugin ne dit rien d'une régression du plugin et double le coût), trois runs en parallèle :
 * celle de la publication (`npm run eval:plugin`, enveloppée par scripts/eval-plugin.mjs quand le dépôt l'a) quand package.json la déclare, `claude plugin eval .` sinon.
 */
export function evalCommand(root: string, name: string, outDir: string): string[] {
  const pkg = join(root, 'package.json');
  const scripts = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, unknown> }).scripts : undefined;
  const opts = ['--trust-plugin', '--case', name, '--ablation', 'none', '-j', '3', '--output-dir', outDir];
  if (typeof scripts?.['eval:plugin'] !== 'string') return ['claude', 'plugin', 'eval', '.', '--no-publish', ...opts];
  const npm = ['npm', 'run', 'eval:plugin', '--', ...opts];
  return existsSync(join(root, EVAL_REPLAY)) ? ['node', EVAL_REPLAY, ...npm] : npm;
}

/** Le score « with » du cas dans un dossier de résultats : celui du rejeu (rejeu.json, L740) s'il a eu lieu, sinon celui du premier passage. */
function scoreIn(dir: string, name: string): number | null {
  const read = (f: string): unknown => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null);
  try {
    const rejeu = read('rejeu.json') as { rejoues?: { name: string; rejeu: number | null }[] } | null;
    const r = rejeu?.rejoues?.find((x) => x.name === name);
    if (r && typeof r.rejeu === 'number') return r.rejeu;
    const agg = read('aggregate-result.json') as { cases?: { name: string; aggregates?: { score?: number } }[] } | null;
    const s = agg?.cases?.find((c) => c.name === name)?.aggregates?.score;
    return typeof s === 'number' ? s : null;
  } catch {
    return null;
  }
}

interface EvalRunDeps {
  /** Lance la commande dans `cwd`, sortie à l'écran ; rend son code. */
  run: (argv: string[], cwd: string) => number;
  now: Date;
  out: (line: string) => void;
}

export const spawnEval = (env: Record<string, string | undefined>) => (argv: string[], cwd: string): number =>
  spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: 'inherit', env: env as NodeJS.ProcessEnv }).status ?? 1;

/**
 * `cadence eval <lot>` : rejoue les cas que touchent les fichiers du lot, un par un, et note chaque verdict au sha de HEAD.
 * Refuse quand un fichier couvert par un de ces cas n'est pas commité (le verdict ne dirait rien du contenu noté). Code 0 tous verts, 1 sinon.
 * `dryRun` : dit les cas et les commandes sans rien lancer.
 */
export function runLotEvals(lot: { root: string; entries: EvalEntry[]; id: string; files: string[] }, deps: EvalRunDeps, dryRun = false): number {
  const { root, entries, id: lotId, files } = lot;
  const cases = casesFor(entries, files);
  if (!cases.length) {
    deps.out(`${lotId} : aucun cas d'éval du plugin ne couvre ses fichiers (clé evals de cadence.yaml) — rien à rejouer`);
    return 0;
  }
  const missing = cases.filter((c) => !existsSync(join(root, EVALS_DIR, c, 'prompt.md')));
  if (missing.length) throw new RafError(`cadence eval : cas introuvable(s) sous ${EVALS_DIR}/ : ${missing.join(', ')} (clé evals de cadence.yaml)`);
  // git brut, pas tryGit : rogner la sortie ôterait l'espace de tête de « ␠M chemin » et décalerait le nom.
  const dirty = git(root, ['-c', 'core.quotepath=off', 'status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean).map((l) => l.slice(3));
  const sha = tryGit(root, ['rev-parse', 'HEAD']);
  if (!sha) throw new RafError('cadence eval : le dépôt n\'a aucun commit');
  const stamp = deps.now.toISOString().replace(/[:.]/g, '-');
  const records: EvalRecord[] = [];
  for (const name of cases) {
    const unsaved = dirty.filter(docSyncSet(pathsOf(entries, name)));
    if (unsaved.length) throw new RafError(`cadence eval : ${unsaved.join(', ')} non commité(s) — le verdict de ${name} vaut pour un sha, commiter d'abord`);
    const dir = join(EVALS_DIR, 'results', `${lotId.replace(/\//g, '-')}-${name}-${stamp}`);
    const argv = evalCommand(root, name, dir);
    deps.out(`${lotId} · ${name} : ${argv.join(' ')}`);
    if (dryRun) continue;
    mkdirSync(join(root, dir), { recursive: true });
    const code = deps.run(argv, root);
    const score = scoreIn(join(root, dir), name);
    records.push({ case: name, lot: lotId, sha, code, score, date: deps.now.toISOString(), dir });
    deps.out(`${lotId} · ${name} : ${code === 0 ? 'vert' : `rouge (code ${code})`}${score === null ? '' : `, score ${score.toFixed(2).replace('.', ',')}`} — ${dir}`);
  }
  if (dryRun) return 0;
  addEvalRecords(root, records);
  const red = records.filter((r) => r.code !== 0);
  deps.out(red.length ? `${lotId} : ${red.map((r) => r.case).join(', ')} rouge(s) — lire le rapport, corriger le lot, relancer cadence eval ${lotId}` : `${lotId} : ${records.length} cas vert(s) au sha ${sha.slice(0, 7)}, raf done peut clore le lot`);
  return red.length ? 1 : 0;
}
