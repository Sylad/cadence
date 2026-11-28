# Where cadence writes, and where a gate is declared

Two questions the other pages answer in pieces: which folders does cadence write to, and where do you switch a gate on? This page puts each answer in one place and points to the page that holds the detail.

## Where cadence writes

Four folders, on two user-level roots.

| Folder | What it holds | Versioned | Moved by |
|---|---|---|---|
| `.cadence/` in the repository | the plan (`raf.yaml`, its notes), `archive/` | yes (the plan is the project's history) | `plan:` in `cadence.yaml` ([raf](raf.md)) |
| `.cadence/runs/<wave>/` in the launch folder | one folder per wave: `wave.json` (the state of the wave and its lots), `journal.log` and, for a wave launched from a folder other than the repository root, the lots' worktrees (`worktrees/`); also `.cadence/corrections.json`, the cache of `cadence corrections` | no: cadence adds both to `.git/info/exclude` of the launch folder's repository, so state never dirties a tree | the folder the wave is launched from |
| `~/.cadence/orchestrate/` | what every live wave of the user shares: `waves/`, `slots/` (session slots), `holds/` (sessions started by hand), `waiters/`, `hud-context/`, `hud-quota.json` (the weekly quota the band publishes, L700), and `worktrees/` for the waves launched from a repository root only | no, outside any repository | `CADENCE_HOME` (replaces the whole folder) |
| `~/.local/share/cadence/` | the copies of cadence in service (`npm run service`, [how it works](fonctionnement.md#4-putting-cadence-itself-in-service)) and, under `$XDG_DATA_HOME/cadence/references/`, the reference documents of `cadence ref add` | no | `XDG_DATA_HOME` for the reference documents; `references.dir` in `cadence.yaml` for their folder ([below](#references-cadence-ref-and-cadence-run), [ref](ref.md)) |

`CADENCE_HOME` does not move `~/.local/share/cadence`: the two roots are independent. The copies in service are cleaned by `npm run service` itself (it keeps the copy in service and the 3 before it, [orchestrate](orchestrate-cycle.md)); a lot's worktree is removed with `cadence orchestrate --remove-worktree`. `session.clean` ([session](session.md)) lists working files of *your* project; it is not a list of cadence's state.

## Where a gate is declared

A gate is a check that sends a lot back instead of letting it through. It is declared in one of two places: **the plan** (a date from which it applies) or **`cadence.yaml`** (a key). A wave reads both when it starts and applies what it finds; it declares nothing of its own.

| Gate | Declared with | In | What it refuses |
|---|---|---|---|
| Code review | `reviewSince`, written by `raf review enable` | plan | `raf done` on a lot with commits whose review is not recorded ([raf](raf.md)) |
| UX review | `uxSince`, written by `raf ux enable` | plan | `raf done` on a `--visible` lot with no UX review ([news](news.md)) |
| Tests | `orchestrate.test` (with `testReplay`, `testRelated`; `run.fastGate` for `cadence run`) | cadence.yaml | a lot whose suite is red after a write step: it goes to a correction pass ([orchestrate](orchestrate-cycle.md)); in a `cadence run` with `run.fastGate`, only the touched tests, the full suite at the delivery gate ([below](#fast-gate-during-a-run-runfastgate)) |
| Build | `orchestrate.build` | cadence.yaml | a lot whose build or typecheck is red, played before the tests |
| Static analysis | `analyse` | cadence.yaml | a run whose code adds a violation to a declared tool (ESLint, tsc, ruff, Checkstyle, PMD, SpotBugs, SARIF) above its versioned baseline, or raises that baseline: played by the gate of `cadence run` between build and tests ([analyse](analyse.md)) |
| Code without a test | `orchestrate.testGate` | cadence.yaml | code files changed with no test file touched: a correction pass before the review |
| Documentation | `docs.sync` (with `docs.since`) | cadence.yaml | a lot that changes code without touching the documents the rule names; acknowledged by `raf docs-ok <lot> --reason` ([news](news.md)) |
| Edge-case probe | `orchestrate.probe` | cadence.yaml | a lot whose diff a fresh session breaks with a red edge-case test ([orchestrate](orchestrate-gate.md#the-edge-case-probe-orchestrateprobe-l497)) |
| Plugin eval cases | `evals` | cadence.yaml | `raf done` on a lot whose work commits touch a file the key ties to an eval case while that case has no green verdict for the current content of its files; run `cadence eval <lot>`, `--force` only warns ([releasing](releasing.md#replaying-the-cases-of-a-lot-before-raf-done)). A malformed key is refused by the gate that validates `cadence.yaml` and by `raf done` itself, never read as « no case » |
| File bounds | `bounds` | cadence.yaml | nothing refuses on its own: the writer is told the limit ([below](#file-bounds-bounds)); a file over its bound is caught by the test the entry declares, in the targeted gate |
| Pre-check | `orchestrate.precheck` (on by default) | cadence.yaml | a lot whose deliverable is already in the repository: it is not implemented again |
| Mockup | `orchestrate.maquette` (on by default) | cadence.yaml | a lot with a screen whose mockup fails its UX review, before any code ([orchestrate](orchestrate-spec.md#the-mockup-review-before-any-code)) |
| Back-end sheet | `orchestrate.fiche` (on by default) | cadence.yaml | a lot with `spec: true` whose sheet fails its review, before any test is written |

Two keys do not add a gate, they say **where the gate is played**: `orchestrate.gate.host` (and `gate.install`, `gate.refs`, `gate.maxParallel`) plays the build and the tests on another machine through ssh ([remote gate](remote-gate.md)); `verify.inPlace` chooses, for `cadence verify --gate`, between the main tree and a throwaway copy ([deliver](deliver.md)). `orchestrate.gate.overflow` (L639, instead of `host`, never with it) keeps `gate.host` meaning « the gate is played on the host » for the projects that declare it, and plays the gate on the free machine: local first, the overflow host when the local machine is busy, one decision per lot ([remote gate](remote-gate.md#the-free-machine-first-gateoverflow-l639)).

## File bounds (`bounds`)

A document that grows past a bound used to be found by a test at the gate, after a whole session. `bounds` in `cadence.yaml` gives the same bound to the writer, at three levels, for any project:

```yaml
bounds:
  - paths: [README.md]            # patterns of `docs.sync`
    lines: 64                     # at most 64 lines
    columns: 160                  # no line of text over 160 columns (lines starting with `<` are skipped)
    tests: [test/readme.test.ts]  # tests that read these files
  - paths: [docs/concepts.md]
    chars: 15360                  # at most 15360 characters (an accent counts for one)
```

1. **The repository says it.** A `CLAUDE.md` at the root of the project lists the bounds in words, for the sessions that read it (cadence's own does).
2. **The brief of the writing session carries it.** The implementation and fix briefs end with one line per path or pattern of every entry that has a limit, whether the lot cites the file or not: the file a lot ends up touching is only known after the write, and a lot's text rarely names a README. An entry with tests only adds no line.
3. **A hook measures after each write.** `cadence claude-hook bornes` (PostToolUse on Write, Edit and MultiEdit, in `hooks/hooks.json`) measures the written file against the `cadence.yaml` nearest above it and answers `borne dépassée : README.md : 70 lignes, limite 64` at once; it says nothing within the bound, and never refuses the write. A wave session disables every plugin, the `cadence` plugin included ([context of a session](orchestrate-cycle.md)), so the implementation and fix sessions receive the same hook line in their `--settings` argument, next to the disabled plugins; the `cadence` it runs is the wave's snapshot, first on the session's `PATH`.
4. **The targeted gate plays the declared tests.** When a lot touches a file matched by `paths`, the gate after a writing session adds the `tests` of that entry to the files given to `testRelated`, before the full suite of the integration. A test that nothing imports (it reads the file) is not found by `vitest related`; declaring it is the only way it runs in seconds. A declared test missing from the repository is left out.
5. **A page a lot empties is read by tests nobody declared (L658).** The tests of another lot read a page of the docs (`read('docs/orchestrate-cycle.md')`): moving a section out of it broke one at the integration (L651, refused by R14 of lead-hold). The implementation and fix briefs list, for each existing `.md` page the lot's title or goal names, the tests whose text cites the page name; the targeted gate adds, for each `.md` file the lot touches, the same tests. The search is by name in `test/**/*.test.*`, so a test that builds the path from pieces escapes it; declare it in `bounds`.

6. **A usage page goes stale on a sentence of behaviour (L672).** The identifiers of L648 do not cover a phrase: L662 and L666 came back from two reviews with a major on a line of `docs/` that still said the old behaviour. The implementation and fix briefs list, for each page of `docs/` (subfolders included) with a line that contains a phrase the lot's title or goal quotes (between `« »`, `“ ”`, `""` or backticks, 5 characters or more, case and spacing ignored), the page and its line numbers (3 per page, 12 pages): read each one and update it in the same commit. Only the quoted phrases are searched, not the other words of the title; the check stops at the brief (no write-time hook).

`bounds` is a list; an unknown key, a limit that is not a positive integer or a test path with `..` is refused, like any key of `cadence.yaml` (the gate validates `cadence.yaml` after a lot that changed it).

## The lead settings (`lead:`)

The `lead:` block is read from the `cadence.yaml` of the folder where the lead runs (the parent folder of the projects), never from a
project's own file. `cadence lead tour` prints the settings it reads, so the lead never opens the file:

```yaml
lead:
  chain: on                 # on | off — default on (L772)
  ux: human                 # human | lead — default human (L197)
  contextThreshold: 150000  # tokens of context from which the lead starts nothing new (L437)
```

| Key | Default | Effect | Tour line |
|---|---|---|---|
| `chain` | `on` | `on`: the three proposals of the tour are launched without waiting for an answer; no empty slot (as soon as a run, a review or a delivery hands back, the next drawable lot is launched); a question of a run that is reversible and sourced (code, doc, norm, decision already taken) is settled by the lead with `cadence run --reponse`, noted in the plan and relayed in one line; only the irreversible, a spending, a visual taste without a rule or a contradiction with the register of requests goes up to the human. `off`: the tour stops and waits for the priority, every question goes to the human. `true` and `false` are read as `on` and `off` | `enchaînement : on (…)` or `enchaînement : off (…)`, always |
| `ux` | `human` | who records `raf ux` for a visible lot ([orchestrate](orchestrate.md)) | `verdict UX : lead …` when `lead`, last line |
| `contextThreshold` | `150000` | an integer ≥ 1 read by `cadence session context` ([lead](lead.md)) | none |

Any other value is refused with the key at fault (`cadence.yaml · ✗ erreur : lead.chain doit être « on » ou « off », pas "parfois"`
in the tour; `cadence config set` refuses to write it). The skill `/lead` reads these lines and behaves accordingly ([lead](lead.md)).

## References: `cadence ref` and `cadence run`

One key of `cadence.yaml`, `references`, serves both commands that read reference documents, in one form (L760):

```yaml
references:
  dir: ~/kb/references            # cadence ref: where its documents go (outside any Git repository)
  run:                            # cadence run: a word of the request turns on the complete mode
    - mots: [sigwx, jet, cb]      #   words, compared without accents or case, as whole words
      docs: [docs/normes/sigwx.md] #   documents read in full (relative to the repository, absolute or under ~)
```

`dir` is relative to the folder of `cadence.yaml`, absolute, or under `~` (`~` alone or `~/…`, replaced by `$HOME`; `~user` is not expanded).
Both parts are optional. Without `dir`, `cadence ref` stores under `$XDG_DATA_HOME/cadence/references` ([ref](ref.md)); without `run`,
`cadence run` takes the light mode unless a `--piece` or `--complet` is given ([cadence run](v2/2026-11-09-cadence-run.md)).
The two commands and the gate that validates `cadence.yaml` read the key with the same code (`scripts/references.mjs`): a file one accepts, the
others accept too. A malformed key is refused by all three with the key at fault (`references.run[0].docs : liste non vide de textes attendue`),
never read as « no reference »: an unknown key under `references` or in an entry, a `mots` or `docs` that is not a non-empty list of texts, an empty `dir`.

**The former form of `cadence run`** — a list directly under `references:` (`references:` then `- mots: …`) — is still read, as `references.run`,
and each command says so: `cadence run` in its launch lines, `cadence ref` on its error output, once per command
(« references en liste (ancienne forme de cadence run) : lue comme references.run ; écrire … »). Move the list under `run:` to silence it; such a
file has no `dir`, so `cadence ref` uses its default folder.

## Generated files: `run.regenerate`

A `cadence run` session may not run `cadence` or `raf`. A project whose generated files come from such a command (the News data of
`cadence news build`, a published plan) declares it, and the run plays it itself, in its worktree, after the rebase and before each gate (L781):

```yaml
run:
  regenerate:                                 # played in order; nothing declared, nothing played
    - { command: npm run news, dir: frontend } # dir: folder of the repository (default: its root)
    - { command: npm run plan }
```

What the commands change is committed as one commit of the lot, hooks included, with a neutral message
(`chore(<lot>): régénère les fichiers générés déclarés (cadence run <id>)`, trailer `Cadence-Run-Regeneration: <id>`), so the gate judges the
commit that is integrated. Nothing is guessed from a script name: a project without the key runs as before, even with a `news` script.
A failing command, a missing `dir`, a commit refused by a hook, or an uncommitted file the commands rewrite is handed back to the session like a
red gate, with the files put back as they were; this has its own correction, it does not use the one of the gate.
Before every rebase and every resumed session, all the run's regeneration commits are removed and played again on the updated tree.
Output written to files that git ignores is seen by the gate but never committed. `dir` is relative to the repository, without `..`,
`/` or `~`; any other key, or a malformed entry, is refused by `cadence run` and by the gate that validates `cadence.yaml`, with the key at fault.

## Fast gate during a run: `run.fastGate`

By default the gate of `cadence run` plays the whole suite before it integrates. A project whose suite is long declares a **fast gate** (L838):
during the run, the test step plays only the tests touched by the diff of the lot, and the full suite is played once, at the delivery gate
(`cadence verify --gate`, which the pre-push hook requires for the pushed sha). Build and `analyse` are played as before.

```yaml
run:
  fastGate: true                               # derived from orchestrate.test « [npx ]vitest run[ options] » : vitest related --run [options] {files}
  # or
  fastGate:
    command: npx jest --findRelatedTests {files} # any launcher that takes the touched files; {files} is required
    dir: backend                                 # files are passed relative to it and the command runs in it (default: the root)
    full: [package-lock.json, jest.config.js]    # touching one of them plays the full suite (cadence.yaml always does)
```

The files given to the command are the files the lot adds or changes since its start on the target branch, plus the tests that `bounds`
declares for them and the tests that cite the name of a touched file that is not code (a page, a data file: the test reads it, it does not
import it). **The full suite is played instead, and the run says why**, whenever the selection is uncertain: a file deleted or moved (the tests
that imported it cannot be found from the diff), a file of `full` touched, a file outside `dir`, no file at all, or a command that finds no test
(`No test files found`, `No tests found`, `no tests ran`). A green fast gate records **no verdict** for the sha: the delivery gate plays the
whole suite. A red test of a fast gate is first replayed alone, like one of the full gate (L842), through the replay of the suite it stands
for (`testReplay`, deduced launcher, or the replay of the part whose folder is `dir`). The state of the run keeps each gate it played (`portes`: targeted or not, green or red, seconds) and the integrated detail says
« porte rapide (run.fastGate) : tests touchés par N fichier(s) du lot ; la suite complète se joue à la porte de livraison ». A malformed key
(no `{files}`, a command that cannot be derived, a `dir` outside the repository) is refused by `cadence run` (state `sans-porte`) and by the
gate that validates `cadence.yaml`. Measure on cadence itself: [porte-rapide-l838](mesures/porte-rapide-l838.md).

The gate of a run is played by the **installed** cadence: declare the key only once every machine runs a version that knows it.
An older cadence refuses `cadence.yaml` (« run.fastGate inconnu ») and every run of the project ends red at its gate.

## Session base of a run: `run.session`

Each session of `cadence run` keeps from the user's Claude Code configuration only what a run uses (L936). By default its `--settings`
exclude the `CLAUDE.md` of the folders above the repository (`claudeMdExcludes`: they speak to the session that leads, not to the run),
deny the agents of the user (`<config>/agents`) and of the kept plugins (`permissions.deny` `Agent(<name>)`), turn off the user's skills
that neither the request, the brief nor a kept `CLAUDE.md` names (`skillOverrides`), deny the user's MCP servers (`mcpServers` of
`.claude.json`, `deniedMcpServers`), and add the lead's built-in tools (`Artifact`, `Workflow`, `ScheduleWakeup`, `SendMessage`, …) to the
disallowed tools. The user's `CLAUDE.md`, the project's own agents, skills and servers, the built-in ones, the hooks and the plugins cadence
and playwright stay. First call: 70k → 25k tokens ([measure](mesures/socle-run-2026-11-28.md)). A project keeps what it needs:

```yaml
run:
  session:
    parentClaudeMd: true          # default false: keep the CLAUDE.md of the folders above the repository
    userClaudeMd: false           # default true: also exclude the user's CLAUDE.md
    keepAgents: [gis-expert]      # agents of the user or of a kept plugin (cadence:code-reviewer) the run may call
    keepSkills: [norme-etude]     # user skills kept even when nothing names them
    keepMcpServers: [context7]    # user MCP servers kept
```

Any other key or a malformed value is refused by `cadence run` and by the gate that validates `cadence.yaml`, with the key at fault. The
bench does not take these cuts.

## Short writing: `ecriture:`

`ecriture:` sets the thresholds of `cadence ecriture` (L803): words per sentence (`phrase`, 25), per instruction (`consigne`, 20),
and whether the passive voice (`passif`) and the semicolon (`pointVirgule`) are flagged. Declared, it also makes `raf news check` warn
about the entries dated `depuis` or later; a warning blocks nothing. Details: [ecriture.md](ecriture.md).

## Language of the project files: `language:`

Some projects require every comment, test name and documentation line in English. `language:` (at the root of `cadence.yaml`,
`fr` or `en`; L791, issue #67) sets the language of the files cadence writes **into the project**. Without the key, or with `fr`,
nothing changes. With `language: en`:

- the step `accept` hands the session `templates/acceptation-runner.en.mjs`, the English runner template it copies into the project
  (e.g. `tests/acceptation-runner.mjs`), with the same code and no French comment;
- the step `spec` hands `templates/fiche.en.yaml` and `templates/fiche-back.en.yaml`, and the briefs of the spec writer and of the
  acceptance writer ask for English rules, labels, planned test names (`R1 — empty state: …`) and test comments;
- the states of a screen sheet are `empty`, `loading`, `error` (all three required by `cadence spec check`) and `loaded`, so the sections
  of the mockup are `#etat-empty`… and `masque` belongs to a rule of the `empty` state; `cadence spec qa` reads the same names.

The keys of the sheets (`ecran`, `regles`, `enonce`…) stay as they are: they are the format cadence reads. The texts the product shows on
screen (`message`, the mockup) keep the language of the product, since a test asserts them exactly. The plan, the reports to the lead and
the messages cadence prints keep their language. Any other value is refused by `cadence spec check`, `cadence run` and the gate that
validates `cadence.yaml`.
