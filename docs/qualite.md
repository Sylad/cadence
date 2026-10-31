# Code-quality guard rails

What Checkstyle, PMD and Sonar do for a Java project, cadence does for its own code with four tools and a **ratchet**.
This page is also a recipe that does not depend on cadence: the same guard rails for TypeScript, Python, Java and shell,
to apply to any project (each project does it in a lot of its own).

## The four tools and what each one is for

| Tool | Question it answers | What it measures | Starting threshold |
|---|---|---|---|
| [ESLint](https://eslint.org) + [typescript-eslint](https://typescript-eslint.io) | Is this unit too big or too tangled to read? | `max-lines` (file), `max-lines-per-function`, `max-depth`, `max-params`, `complexity` (cyclomatic) | 400 lines per file, 80 per function, depth 4, 5 parameters, complexity 15 |
| [eslint-plugin-sonarjs](https://github.com/SonarSource/SonarJS) | Is it hard to *follow*? | `sonarjs/cognitive-complexity` (nesting weighs more than a flat `switch`) | 15 |
| [knip](https://knip.dev) | Is something there that nobody uses? | unused files, exports, types, dependencies and binaries | none: any finding counts |
| [jscpd](https://github.com/kucherenko/jscpd) | Was this block copied? | duplicated blocks across files | 8 lines and 70 tokens |

Blank lines and comments do not count towards the length rules. The configuration is in `eslint.config.mjs`, `knip.json`
and `.jscpd.json`; the tests (`test/`) and the Claude Code plugin (`plugins/`) are not linted — the tests are knip entry
points, so what they import is not reported as dead. `jscpd` fails on a `path` that does not exist: keep the list in
`.jscpd.json` to the folders the project really has.

## The ratchet

Putting a threshold on existing code turns hundreds of findings red on day one, and the usual answers are bad: raise the
threshold until it means nothing, or sprinkle `eslint-disable`. The ratchet keeps the thresholds honest instead:

1. `node scripts/qualite.mjs --init` measures once and writes `qualite-baseline.json`, a flat map sorted by key,
   versioned with the code. A key is `tool|file|rule` (`eslint|src/cli.ts|max-lines`, `knip|src/audit.ts|exports`,
   `jscpd|src/config.ts`) and its value a count. Two metrics have a `…|total` or `…|lignes` twin that sums the figures:
   for ESLint, every key has a `…|total` (the sum of the figures measured, a file of 1397 lines records 1397, three
   functions of cognitive complexity 463, 20 and 18 record 501), and for jscpd every file has a `…|lignes` (the lines
   of the duplicated blocks that touch it). A function that grows without passing the worst of its file, or a new
   function that replaces a small one, makes the sum go up: the count alone would not see it.
2. `npm run qualite` measures again and compares key by key. A key that is **higher** than in the baseline, or absent from
   it (a new file, a rule never broken before), makes the command fail (exit 1) and names it with its old and new value.
   The existing code passes; nothing can get worse; a touched file can only go down.
3. A measure that went **down** passes, with a reminder. `npm run qualite:cliquet` (`--ecrire`) writes the gain into the
   baseline — and refuses, leaving the file untouched, if anything got worse. `--init` refuses to run when the baseline
   exists: the baseline never goes up, it is only ever lowered.
4. A tool that crashes or whose output cannot be read fails the command (exit 2); it never counts as « zero finding ».
   A missing baseline also exits 2, and says how to create it.

Counts, not line numbers, are compared: moving code inside a file does not move anything.

**Moving or splitting a file** (a 3000-line file cut into three modules, a function moved to its own file) is the one
legitimate way to get new paths in the baseline, and it has its own command: `node scripts/qualite.mjs --migrer --contre
main`. It measures, and rewrites the baseline only if (a) no key of a file that **existed at the start of the lot** went
up, and (b) the total of every measure over all files (sum of the `…|total`, `…|lignes` and knip counts per tool and
rule) did not go up. A new path starts free — its own `max-lines` finding is fine when the file it was cut from lost
more — but a defect cannot be moved into an existing file, nor added. The same rule is what `--contre` applies to the
baseline of the lot, so a migrated baseline passes the gate and the CI, and a hand-edited one does not. It needs
`--contre` (the files that « existed » are those of the start of the lot) and exits 2 without it.
The way out of a finding is to fix it and lock the gain. Two other ways would also lower the measure without fixing
anything, and the ratchet closes them:

- **A directive**: `eslint.config.mjs` sets `linterOptions.noInlineConfig`, so an `eslint-disable` comment disables
  nothing (ESLint reports it, and the ratchet counts that report under `analyse`). The directives that the tools cannot
  refuse (`jscpd:ignore-start`/`-end`, knip's `@public`/`@internal` tags) and any `eslint-disable` comment are counted per
  file under `directive|file|name`, so adding one makes the measure go up like a new finding. Only the files the tool
  concerned analyses are read (the files ESLint linted, the sources jscpd scanned, knip's `project` globs minus `ignore`):
  a directive in a file the tool does not read disables nothing and is not counted.
- **A threshold or an exclusion**: under `--contre`, every file the tools read must be byte-identical to the start of
  the lot — present, absent or changed the same way (exit 1 otherwise, naming each one as `nouveau`, `supprimé` or
  `modifié`). That is not only the three files this repository uses: ESLint 9 loads `eslint.config.js` **before**
  `eslint.config.mjs` (then `.cjs`, `.ts`, `.mts`, `.cts`), knip reads `knip.json`, `knip.jsonc`, `.knip.json`,
  `.knip.jsonc`, `knip.ts`, `knip.js`, `knip.config.ts`, `knip.config.js` and `package.json#knip`, jscpd reads
  `.jscpd.json` and `package.json#jscpd`, and knip as jscpd respect `.gitignore`. Of `package.json`, only the `knip` and
  `jscpd` keys are compared. Changing a threshold is a decision of the plan, delivered alone; a lot judged by those
  thresholds cannot move them. The lot that adopts the tools (no baseline at its start) introduces its configs freely.

**When the start of the lot has no baseline yet** (the lot that introduces the ratchet, while `main` moves under it):
the baseline measured at the start no longer matches the code once `main` is merged or the lot rebased, since `main`'s
own commits changed the figures, and the gate would hand back code the lot did not write. There is nothing to not
exceed in that case, so `node scripts/qualite.mjs --init --contre main` re-measures at the rebased tip and rewrites the
baseline (`--init` refuses as soon as `main` has a baseline: from then on `--ecrire` and `--migrer` are the only ways).
The refusal itself says so: when the start of the lot has no baseline, the list of measures that got worse ends with
that command.

The baseline is also the project's list of cleanups: each cleanup lot is measured by what it removes from it.

## Where it runs

- **The wave's gate**: `cadence.yaml` declares `orchestrate.build: npx tsc --noEmit && node scripts/qualite.mjs --contre main`. The
  build runs before the tests ([orchestrate.md](orchestrate.md)); a worse measure hands the lot back as a « build » finding,
  and the session is told the exact command.
- **The CI**: `.github/workflows/tests.yml` runs `npm run qualite -- --contre origin/main` after the typecheck (the checkout is full-depth), and `prepublishOnly` runs it too.

## Recipe for another project

Do it in one lot per project: install, configure, `--init`, wire into the gate and the CI, commit the baseline.
`scripts/qualite.mjs` is generic apart from its three readers (`lireEslint`, `lireKnip`, `lireJscpd`): copy it, and
change `mesurer` to the tools of the project. Whatever the language, a tool joins the ratchet once its report is turned
into `tool|file|rule → count`.

### TypeScript / JavaScript

`npm i -D eslint typescript-eslint eslint-plugin-sonarjs knip jscpd`, then copy `eslint.config.mjs`, `knip.json`
and `.jscpd.json` of this repository and adapt `files`, `entry`, `project` and `path`. Add the `qualite` scripts to
`package.json`. In a monorepo, run the measure per workspace and prefix the keys with it.

### Python

| Role | Tool | Command |
|---|---|---|
| complexity and size | [ruff](https://docs.astral.sh/ruff/) | `ruff check --select C901,PLR0912,PLR0913,PLR0915 --output-format json` (`C901` is McCabe, `PLR0913` too many arguments, `PLR0915` too many statements); threshold: `[tool.ruff.lint.mccabe] max-complexity = 15` |
| complexity, maintainability | [radon](https://radon.readthedocs.io) | `radon cc -j -n C src` (blocks of rank C or worse), `radon mi -j -n B src` |
| dead code | [vulture](https://github.com/jendrikseipp/vulture) | `vulture src --min-confidence 80` |
| duplicates | jscpd, which also reads Python | `format: ["python"]` in `.jscpd.json` |

### Java (Maven)

| Role | Tool | Where |
|---|---|---|
| size and complexity | [Checkstyle](https://checkstyle.org) | `maven-checkstyle-plugin` with `FileLength`, `MethodLength`, `NestedIfDepth`, `ParameterNumber`, `CyclomaticComplexity` in the ruleset |
| smells, cognitive complexity, dead code | [PMD](https://pmd.github.io) | `maven-pmd-plugin`, rules `CognitiveComplexity`, `CyclomaticComplexity`, `UnusedPrivateField`, `UnusedPrivateMethod`, `UnusedLocalVariable` |
| duplicates | PMD CPD | `pmd:cpd-check` (`minimumTokens` 100 to start) |
| probable bugs | [SpotBugs](https://spotbugs.github.io) | `spotbugs-maven-plugin`, `check` goal |

Both Checkstyle and PMD write XML reports (`target/checkstyle-result.xml`, `target/pmd.xml`): count the violations per
file and rule from them. Bind `check` goals to the `verify` phase so that `mvn verify` is the gate's build command.

### Shell

[shellcheck](https://www.shellcheck.net): `shellcheck -f json1 scripts/*.sh`, one key per file and code (`SC2086`…).
Shell has no complexity rule: keep a script small, and move logic into a language that has the tools above.

## Choosing the thresholds

Start from the table above, measure, and fix the baseline **where the code is**: a threshold chosen to fit the existing
code is not a guard rail. Lower a threshold only when the baseline for it is empty or near, and never raise one: a
threshold that goes up is a decision, written in the plan.
