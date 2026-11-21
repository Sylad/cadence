# Static analysis per technology: `analyse:` and `cadence analyse`

Checkstyle, PMD, SpotBugs, ESLint, ruff, the .NET analyzers: each technology has its tools, and a project that adopts them late
has hundreds of findings on day one. `cadence analyse` runs the tools a project declares, freezes what exists in a baseline per
tool, and fails only on **new** violations (L801). The gate of `cadence run` plays it on every run. Nothing in it is specific
to one repository: the tools are commands, their reports are read by format.

The ratchet is the one of [qualite.md](qualite.md), which guards cadence's own code with ESLint, knip and jscpd
(`scripts/qualite.mjs`); `scripts/analyse.mjs` reuses its comparison, its migration rule and its reading of the start of a lot,
for any tool.

## Declaring the tools

```yaml
analyse:
  - name: eslint                                  # names the baseline: .cadence/analyse/eslint.json
    command: npx eslint -f json .
    format: eslint-json
    configs: [eslint.config.mjs]                  # thresholds and exclusions: frozen like the baseline (below)
  - name: tsc
    command: npx tsc --noEmit --pretty false
    format: tsc
  - name: checkstyle
    dir: backend                                  # where the command runs (default: the repository root)
    command: mvn -q -B checkstyle:checkstyle
    format: checkstyle-xml
    report: target/checkstyle-result.xml          # read from this file (relative to dir), else from the standard output
```

Keys of an entry: `name` (lowercase, digits, dashes; unique), `command`, `format`, and optionally `dir`, `report`, `baseline`
(another path for the baseline file) and `configs`. Paths are relative to the repository, without `..`. Any other key, an
unknown format or a malformed entry is refused by `cadence analyse`, by the run's gate (nothing is played, the run ends
`sans-porte` naming the key) and by the check of `cadence.yaml` that `cadence config` runs before writing.

## Formats

| `format` | Report | What is counted (`file|rule`) |
|---|---|---|
| `eslint-json` | `eslint -f json` | per rule, plus `|total`: the sum of the figures measured (complexity 20 and 31 → 51), as in [qualite.md](qualite.md#the-ratchet) |
| `tsc` | `tsc --noEmit --pretty false` | per error code (`TS2322`); an error with no file under `(global)` |
| `ruff-json` | `ruff check --output-format json` | per code (`C901`, `PLR0913`…); a syntax error under `syntax-error` |
| `checkstyle-xml` | `target/checkstyle-result.xml` (any tool that writes the Checkstyle format) | per check, the last segment of `source` without `Check` (`MethodLength`) |
| `pmd-xml` | `target/pmd.xml` | per `rule` |
| `cpd-xml` | `target/cpd.xml` | `duplication` per file, plus `|lignes`: the lines of the duplicated blocks |
| `spotbugs-xml` | `target/spotbugsXml.xml` | per bug `type`; the file is the `sourcepath` SpotBugs writes (relative to the source root) |
| `sarif` | SARIF 2.1: .NET analyzers (`dotnet build -p:ErrorLog=build.sarif%2Cversion=2.1`), Semgrep, CodeQL… | per `ruleId`; a result suppressed in the source still counts |

A file path is made relative to the repository (absolute, `file:` URI, or relative to `dir`).

**A tool never passes for « zero violation »**: a report that is not JSON or XML of the expected root, a declared `report` the
command did not write (it is deleted before each run, so an old one never counts), a command killed or past 20 minutes, or
`tsc` failing with no error line, all exit 2 with the tool's last output. The exit code of the tool itself is not judged:
most of them exit 1 when they find something.

**Suppression comments count as violations.** Per format, the files git tracks under `dir` are read and each directive is
counted per file under `directive:<name>`: `eslint-disable` in a `//`, `/*` or `/**` comment, and the inline config
`/* eslint <rule>: off */` (`eslint-config`, any rule set inline, a raised threshold too) (eslint-json); `@ts-ignore`,
`@ts-nocheck`, `@ts-expect-error` (tsc); `# noqa` (ruff); `CHECKSTYLE:OFF` and `@SuppressWarnings("checkstyle:…")`,
`// NOPMD` and `@SuppressWarnings("PMD…")`, and `@SuppressWarnings("all")` for both; `CPD-OFF`, `@SuppressFBWarnings`,
`#pragma warning disable` and `[SuppressMessage]` (.cs, .vb). Adding one makes the measure go up like a new finding.

## The ratchet

1. `cadence analyse --init` measures once and writes one baseline per tool (`.cadence/analyse/<name>.json`, keys sorted),
   to commit with the code. It refuses when the baseline exists.
2. `cadence analyse` measures again: a key **higher** than in the baseline, or absent from it (a new file, a rule never
   broken), fails with exit 1 and names it (`src/b.ts|TS2322 : 0 → 1`). The existing code passes.
3. A measure that went **down** passes, with a reminder; `cadence analyse --ecrire` writes the gain, and refuses (writing
   nothing) if anything got worse. The baseline is only ever lowered.
4. `--contre <ref>` (what the run's gate passes: its target branch) also judges the baseline of the lot against the one at
   the start of the lot (merge-base with `<ref>`), with the guards of `scripts/qualite.mjs`: a key raised by hand is refused
   (« remonte par rapport à main »), and so is a key of a new file above its measure (a moved file whose baseline was edited
   up: it would leave room to grow back in the next lot). **A baseline is born, and a tool changes identity, only in a lot
   the plan declares `config: true`**: an entry of `analyse:` added, removed or changed (name, command, format, dir, report,
   baseline, configs), a baseline absent at the start of the lot, or a file of `configs` that differs from the start is
   refused unless every commit that touches it cites only such lots, or the run is on the branch of such a lot (which then
   touches nothing but configs, baselines and tests). Renaming a tool never gives a fresh, free baseline. The rule and its
   reading of the plan are shared with [qualite.md](qualite.md) (`scripts/lot-de-config.mjs`).
5. **Moving or splitting a file** makes new keys: `cadence analyse --migrer --contre main` rewrites the baseline only if no
   file that existed went up, no total went up, and each new file is credited by its source (the file it takes at least
   50 % of its lines from), as `--migrer` in [qualite.md](qualite.md#the-ratchet). A copy that leaves its source intact is refused.

`--outil <name>` plays one tool. Exit codes: 0 green, 1 refused, 2 a tool or the command could not run.

## Where it runs

- **The gate of `cadence run`**: with an `analyse:` key, the gate plays `node <cadence>/scripts/analyse.mjs --contre <target>`
  after `orchestrate.build` and before `orchestrate.test`; a red analysis goes back to the same session like any red gate,
  with the violations named. A project with only `analyse:` and no build or test still has a gate. `cadence verify --gate`
  and the waves of `cadence orchestrate` do not play it yet.
- **The CI**: `npx cadence analyse --contre origin/main` (full-depth checkout), after the build.
- **The weekly measure**: each lowering is a commit of `.cadence/analyse/`; `git log -p -- .cadence/analyse/` shows the
  frozen violations going down, and every `cadence analyse` line ends with « N violation(s), M gelée(s) ».

## Recipe per technology

Do it in one lot per project, declared `config: true` in the plan: install the tools, declare them, `cadence analyse --init`,
commit the baselines.

**TypeScript / JavaScript.** `npm i -D eslint typescript-eslint`; a typed config (`tseslint.configs.recommendedTypeChecked`
with `parserOptions.projectService: true`) plus the size rules of [qualite.md](qualite.md#the-four-tools-and-what-each-one-is-for);
two entries, `eslint-json` and `tsc`. Set `linterOptions.noInlineConfig` if you want `eslint-disable` refused by ESLint as well
as counted. In a monorepo, one entry per workspace (`dir`).

**Python.** `pip install ruff`; thresholds in `pyproject.toml` (`[tool.ruff.lint] select = ["E", "F", "B", "C901", "PLR"]`,
`[tool.ruff.lint.mccabe] max-complexity = 15`); entry `command: ruff check --output-format json --exit-zero`, `format: ruff-json`,
`configs: [pyproject.toml]`.

**Java (Maven).** Declare `maven-checkstyle-plugin`, `maven-pmd-plugin` and `spotbugs-maven-plugin` in the `pom.xml` with
`failOnViolation`/`failsOnError` false (the ratchet judges, not the plugin), then one entry per report:
`mvn -q -B checkstyle:checkstyle` (`checkstyle-xml`, `target/checkstyle-result.xml`), `mvn -q -B pmd:pmd pmd:cpd`
(`pmd-xml`, `target/pmd.xml`; and `cpd-xml`, `target/cpd.xml`), `mvn -q -B compile spotbugs:spotbugs` (`spotbugs-xml`,
`target/spotbugsXml.xml`). Rulesets: [qualite.md](qualite.md#java-maven). `configs: [pom.xml, checkstyle.xml, pmd-ruleset.xml]`.

**C# (.NET).** Analyzers are on in the SDK: `<AnalysisLevel>latest-recommended</AnalysisLevel>` and
`<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>` in `Directory.Build.props`; entry
`command: dotnet build -p:ErrorLog=build.sarif%2Cversion=2.1 --no-incremental`, `report: build.sarif`, `format: sarif`,
`configs: [.editorconfig, Directory.Build.props]`.

**Anything else** that writes SARIF or the Checkstyle format (Semgrep, detekt, ktlint, golangci-lint `--out-format checkstyle`)
joins the same way; another format is a reader to add to `scripts/analyse.mjs` (`LECTEURS`).
