import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
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
const TEST_RUNNER = /^((npm|pnpm|yarn) (run )?test(?![\w-])|(vitest|jest|mocha|playwright test|cypress run|pytest|python3? -m pytest|tox|rspec|phpunit|mvn (test|verify)|gradlew? test|go test|cargo test|dotnet test|ng (test|e2e))(?![\w-]))/;
/** Un script npm de test que package.json ne définit pas (ou illisible) : le nom suffit. */
const TEST_SCRIPT = /^(npm|pnpm|yarn) run (test|e2e)\S*/;
/** Les enveloppes d'un lanceur (écran virtuel, délai…), retirées avant la reconnaissance. */
const WRAPPER = /^(xvfb-run|timeout|time|env|nice)(\s+-\S+)*(\s+\d+[smhd]?)?\s+/;
/** Les variables d'environnement en tête de commande, valeur entre guillemets comprise. */
const ENV_PREFIX = /^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/;
/** Une redirection : vers un descripteur (`2>&1`, `>&2`, sans groupe) ou vers un fichier (`>out.log`, `&>`, `<in`), dont le groupe est vide quand la cible est le mot suivant (`> out.log`). */
const REDIRECTION = /^(?:\d*>>?&\d+|(?:&>>?|\d*>>?|\d*<)(\S*))$/;

/** `command` sans ses variables d'environnement de tête, ses enveloppes (`xvfb-run`, `timeout`…) ni `npx`, répétés jusqu'à épuisement (`timeout 60 CI=1 npx vitest`). */
function unwrap(command: string): string {
  let rest = command;
  for (let again = true; again; ) {
    const next = rest.replace(ENV_PREFIX, '').replace(WRAPPER, '').replace(/^npx(\s+(--no-install|-y|--yes))?\s+/, '');
    again = next !== rest;
    rest = next;
  }
  return rest;
}

function packageScripts(repo: string, dir: string): Record<string, string> {
  if (dir.startsWith('..') || isAbsolute(dir)) return {}; // hors du dépôt : rien à lire
  try {
    const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as { scripts?: unknown };
    return isObject(pkg.scripts) ? Object.fromEntries(Object.entries(pkg.scripts).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    return {}; // pas de package.json, ou illisible : les commandes npm restent telles quelles
  }
}

/** Le caractère `i` de `line` sépare deux commandes : `|`, `;` ou un `&` qui n'est pas celui d'une redirection (`2>&1`, `>&2`, `&> f`). */
function isSeparator(line: string, i: number): boolean {
  const c = line[i];
  if (c === '|' || c === ';') return true;
  return c === '&' && line[i - 1] !== '>' && line[i + 1] !== '>';
}

/** Découpe une ligne sur `&&`, `||`, `|` et `;` hors des guillemets (les redirections `2>&1` restent dans leur commande) ; chaque parenthèse (sous-shell, `$(…)`) devient un segment `(` ou `)`. */
function splitLine(line: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(' || c === ')') {
      parts.push(line.slice(from, i), c);
      from = i + 1;
    } else if (isSeparator(line, i)) {
      parts.push(line.slice(from, i));
      if ((c === '&' || c === '|') && line[i + 1] === c) i++;
      from = i + 1;
    }
  }
  parts.push(line.slice(from));
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Les commandes simples d'un texte shell : lignes (continuations `\` jointes, commentaires et vides écartés) puis `&&`, `||`, `|` et `;` hors guillemets. */
function segments(text: string): string[] {
  const lines = text.replace(/\s*\\\r?\n\s*/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.flatMap(splitLine);
}

/** Les commandes feuilles de `text`, `npm test` / `npm run x` (variables d'environnement et enveloppes devant comprises : `CI=true npm test`) remplacés par le script de package.json de `dir` (suivi à travers les `cd`, que la parenthèse fermante d'un sous-shell annule) quand il existe. */
function leaves(repo: string, dir: string, text: string, depth = SCRIPT_DEPTH): string[] {
  let cwd = dir;
  const outer: string[] = [];
  return segments(text).flatMap((s) => {
    if (s === '(') {
      outer.push(cwd);
      return [];
    }
    if (s === ')') {
      cwd = outer.pop() ?? cwd;
      return [];
    }
    const cd = /^cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))$/.exec(s);
    if (cd) {
      cwd = posix.normalize(posix.join(cwd, cd[1] ?? cd[2] ?? cd[3]!));
      return [];
    }
    const m = new RegExp(`^(?:npm|pnpm|yarn)(?: run)? ([\\w:.-]+)(?:\\s+${NPM_QUIET_OPTION})*\\s*(?:--(?:\\s.*)?)?$`).exec(unwrap(s));
    const body = m && depth > 0 ? packageScripts(repo, cwd)[m[1]!] : undefined;
    return body === undefined ? [s] : leaves(repo, cwd, body, depth - 1);
  });
}

/** Les options de npm qui peuvent suivre le nom du script sans changer ce qu'il joue (`npm test --silent`) ; `--workspace` ou `--prefix` visent un autre package.json et restent hors de la liste. */
const NPM_QUIET_OPTION = '(?:--silent|--if-present|--quiet|-s|-q)';

/** Les options qui désignent une autre suite ou un autre projet : elles restent dans la clé, avec leur valeur. */
const SUITE_OPTION = /^(-c|-p|--config|--project|--projects|--selectProjects)(=.*)?$/;

/** `words` sans ses redirections (`2>&1`, `> out.log` avec sa cible, `2>/dev/null`) : elles ne font pas une autre commande. */
function withoutRedirections(words: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const r = REDIRECTION.exec(words[i]!);
    if (!r) kept.push(words[i]!);
    else if (r[1] === '') i++; // la cible est le mot suivant
  }
  return kept;
}

/** La clé de comparaison : sans variables d'environnement, `npx` ni redirections, coupée au premier argument qui commence par `-` (les autres options ne font pas une autre commande), mais gardant les options de `SUITE_OPTION` où qu'elles soient. */
function key(command: string): string {
  const rest = unwrap(command);
  const words = withoutRedirections(rest.replace(/^python3?\s+-m\s+pytest\b/, 'pytest').replace(/^mvn(\s+-\S+)*\s+/, 'mvn ').split(/\s+/));
  const end = words.findIndex((w) => w.startsWith('-') && !SUITE_OPTION.test(w));
  const kept = end < 0 ? words : words.slice(0, end);
  const tail = end < 0 ? [] : words.slice(end);
  tail.forEach((w, i) => {
    if (!SUITE_OPTION.test(w)) return;
    kept.push(w);
    const value = tail[i + 1];
    if (!w.includes('=') && value !== undefined && !value.startsWith('-')) kept.push(value);
  });
  return kept.join(' ');
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
 * si elles ne diffèrent que par les variables d'environnement, `npx`, les redirections (`2>&1`, `> out.log`) et les options (`--coverage`) : un fichier nommé, une configuration (`-c`, `--config`) ou un projet (`--project`, `--selectProjects`, `-p`) reste une autre commande.
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
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return []; // .github/workflows n'est pas un dossier
  }
  for (const workflow of files.filter((f) => /\.ya?ml$/.test(f)).sort()) {
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
