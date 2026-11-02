import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { readOrchestrateConfig } from '../config.js';
import { isObject } from '../yaml-keys.js';
import type { GateTest } from './gate-parts.js';

/** Une commande de test que la CI du dépôt joue (L499) et que la porte (`orchestrate.test`, `orchestrate.build`) ne joue pas. */
export interface CiGap {
  command: string;
  /** Le fichier de workflow où elle est lue, sous `.github/workflows/`. */
  workflow: string;
}

const WORKFLOWS = '.github/workflows';
/** Profondeur à laquelle un script npm qui en appelle un autre est suivi (garde contre `a` → `b` → `a`). */
const SCRIPT_DEPTH = 3;
/** Les lanceurs de tests reconnus, au début d'une commande (après `npx`, les variables d'environnement et les scripts npm dépliés). */
const TEST_RUNNER = /^(npm (run )?test\b|(vitest|jest|mocha|playwright test|cypress run|pytest|python3? -m pytest|tox|rspec|phpunit|mvn (-\S+ )*(test|verify)|gradlew? test|go test|cargo test|dotnet test|ng (test|e2e))\b)/;
/** Un script npm de test que package.json ne définit pas (ou illisible) : le nom suffit. */
const TEST_SCRIPT = /^npm run (test|e2e)\S*/;
const SEGMENT = /&&|\|\||\||;/;

function packageScripts(repo: string, dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as { scripts?: unknown };
    return isObject(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    return {}; // pas de package.json, ou illisible : les commandes npm restent telles quelles
  }
}

/** Les commandes simples d'un texte shell : lignes (continuations `\` jointes, commentaires et vides écartés) puis `&&`, `||`, `|` et `;`. */
function segments(text: string): string[] {
  const lines = text.replace(/\s*\\\n\s*/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.flatMap((l) => l.split(SEGMENT).map((s) => s.trim()).filter(Boolean));
}

/** Les commandes feuilles de `text`, `npm test` / `npm run x` remplacés par le script de package.json de `dir` quand il existe. */
function leaves(repo: string, dir: string, text: string, depth = SCRIPT_DEPTH): string[] {
  const scripts = packageScripts(repo, dir);
  return segments(text).flatMap((s) => {
    const m = /^(?:npm|pnpm|yarn)(?: run)? ([\w:.-]+)\s*(?:--(?:\s.*)?)?$/.exec(s);
    const body = m && depth > 0 ? scripts[m[1]!] : undefined;
    return body === undefined ? [s] : leaves(repo, dir, body, depth - 1);
  });
}

/** La clé de comparaison : sans variables d'environnement ni `npx`, et coupée au premier argument qui commence par `-` (les options ne font pas une autre commande). */
function key(command: string): string {
  const words = command.replace(/^(\w+=\S*\s+)+/, '').replace(/^npx(\s+(--no-install|-y|--yes))?\s+/, '').split(/\s+/);
  const end = words.findIndex((w) => w.startsWith('-'));
  return (end < 0 ? words : words.slice(0, end)).join(' ');
}

const isTest = (command: string): boolean => TEST_RUNNER.test(key(command)) || TEST_SCRIPT.test(key(command));

/** Les commandes `run:` d'un workflow avec leur dossier de travail (étape, sinon défaut du job) ; vide si le fichier ne se lit pas ou n'a pas la forme attendue. */
function workflowRuns(file: string): { run: string; dir: string }[] {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const jobs = isObject(doc) && isObject(doc.jobs) ? Object.values(doc.jobs) : [];
  return jobs.filter(isObject).flatMap((job) => {
    const defaults = isObject(job.defaults) && isObject(job.defaults.run) ? job.defaults.run['working-directory'] : undefined;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    return steps.filter(isObject).flatMap((step) => {
      if (typeof step.run !== 'string') return [];
      const dir = step['working-directory'] ?? defaults;
      return [{ run: step.run, dir: typeof dir === 'string' ? posix.normalize(dir) : '.' }];
    });
  });
}

/** Les commandes que la porte joue : `orchestrate.test` (chaque partie dans son dossier) et `orchestrate.build`. */
function gateKeys(repo: string, test: GateTest | undefined, build: string | undefined): Set<string> {
  const parts = typeof test === 'string' || test === undefined ? [{ dir: '.', run: test }] : test.map((p) => ({ dir: posix.normalize(p.dir), run: p.run }));
  return new Set([...parts, { dir: '.', run: build }].flatMap((p) => (p.run ? leaves(repo, p.dir, p.run).map(key) : [])));
}

/**
 * Les commandes de test des workflows CI du dépôt que la porte ne joue pas (L499), dans l'ordre des fichiers, chacune une fois ; vide sans workflows,
 * sans `orchestrate.test` ni `orchestrate.build` (rien à comparer : `noTestGate` le dit déjà) ou avec un cadence.yaml illisible (il a sa propre erreur).
 * Une commande est une commande de test (lanceur reconnu, `npm test` et `npm run <script>` dépliés par le package.json de son dossier) ; deux commandes sont la même
 * si elles ne diffèrent que par les variables d'environnement, `npx` et les options (`--coverage`) : un fichier ou un projet nommé reste une autre commande.
 */
export function ciParityGaps(repo: string): CiGap[] {
  let test: GateTest | undefined;
  let build: string | undefined;
  try {
    ({ test, build } = readOrchestrateConfig(join(repo, 'cadence.yaml')));
  } catch {
    return [];
  }
  const dir = join(repo, WORKFLOWS);
  if ((!test && !build) || !existsSync(dir)) return [];
  const played = gateKeys(repo, test, build);
  const seen = new Set<string>();
  const gaps: CiGap[] = [];
  for (const workflow of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    for (const { run, dir: cwd } of workflowRuns(join(dir, workflow))) {
      for (const command of leaves(repo, cwd, run)) {
        if (!isTest(command) || played.has(key(command)) || seen.has(key(command))) continue;
        seen.add(key(command));
        gaps.push({ command, workflow });
      }
    }
  }
  return gaps;
}

/** La phrase du signalement, sans le nom du projet. */
export function ciParityText(g: CiGap): string {
  return `parité porte ↔ CI : la CI (${g.workflow}) joue « ${g.command} », que orchestrate.test et orchestrate.build ne jouent pas — une porte verte ne dit rien de ce test, il ne rougira qu'à la CI`;
}


/** Écrit une ligne par écart (L499) ; `prefix` précède chacune (indentation et nom du dépôt du dry-run). */
export function reportCiParity(repo: string, out: (line: string) => void, prefix = ''): void {
  ciParityGaps(repo).forEach((g) => out(`${prefix}${ciParityText(g)}`));
}

/** Le champ `ciGaps` d'une ligne du tour : vide quand la porte couvre la CI. */
export function ciGapsField(repo: string): { ciGaps?: CiGap[] } {
  const ciGaps = ciParityGaps(repo);
  return ciGaps.length ? { ciGaps } : {};
}
