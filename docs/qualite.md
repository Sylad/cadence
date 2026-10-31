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
   `jscpd|src/config.ts`) and its value a count. For ESLint every key also has a `…|pire` twin: the worst figure
   measured (a file of 1397 lines records 1397), so a file that is already too big cannot grow **inside** its one finding.
2. `npm run qualite` measures again and compares key by key. A key that is **higher** than in the baseline, or absent from
   it (a new file, a rule never broken before), makes the command fail (exit 1) and names it with its old and new value.
   The existing code passes; nothing can get worse; a touched file can only go down.
3. A measure that went **down** passes, with a reminder. `npm run qualite:cliquet` (`--ecrire`) writes the gain into the
   baseline — and refuses, leaving the file untouched, if anything got worse. `--init` refuses to run when the baseline
   exists: the baseline never goes up, it is only ever lowered.
4. A tool that crashes or whose output cannot be read fails the command (exit 2); it never counts as « zero finding ».
   A missing baseline also exits 2, and says how to create it.

Counts, not line numbers, are compared: moving code inside a file does not move anything.
The way out of a finding is to fix it and lock the gain; a `// eslint-disable` comment is a decision to be justified in
review (ESLint reports a disable directive that disables nothing, and the ratchet counts it under `analyse`).

The baseline is also the project's list of cleanups: each cleanup lot is measured by what it removes from it.

## Where it runs

- **The wave's gate**: `cadence.yaml` declares `orchestrate.build: npx tsc --noEmit && node scripts/qualite.mjs`. The
  build runs before the tests ([orchestrate.md](orchestrate.md)); a worse measure hands the lot back as a « build » finding,
  and the session is told the exact command.
- **The CI**: `.github/workflows/tests.yml` runs `npm run qualite` after the typecheck, and `prepublishOnly` runs it too.

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
