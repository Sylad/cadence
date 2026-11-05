# Where cadence writes, and where a gate is declared

Two questions the other pages answer in pieces: which folders does cadence write to, and where do you switch a gate on? This page puts each answer in one place and points to the page that holds the detail.

## Where cadence writes

Four folders, on two user-level roots.

| Folder | What it holds | Versioned | Moved by |
|---|---|---|---|
| `.cadence/` in the repository | the plan (`raf.yaml`, its notes), `archive/` | yes (the plan is the project's history) | `plan:` in `cadence.yaml` ([raf](raf.md)) |
| `.cadence/runs/<wave>/` in the launch folder | one folder per wave: `wave.json` (the state of the wave and its lots), `journal.log` and, for a wave launched from a folder other than the repository root, the lots' worktrees (`worktrees/`); also `.cadence/corrections.json`, the cache of `cadence corrections` | no: cadence adds both to `.git/info/exclude` of the launch folder's repository, so state never dirties a tree | the folder the wave is launched from |
| `~/.cadence/orchestrate/` | what every live wave of the user shares: `waves/`, `slots/` (session slots), `holds/` (sessions started by hand), `waiters/`, `hud-context/`, and `worktrees/` for the waves launched from a repository root only | no, outside any repository | `CADENCE_HOME` (replaces the whole folder) |
| `~/.local/share/cadence/` | the copies of cadence in service (`npm run service`, [how it works](fonctionnement.md#4-putting-cadence-itself-in-service)) and, under `$XDG_DATA_HOME/cadence/references/`, the reference documents of `cadence ref add` | no | `XDG_DATA_HOME` for the reference documents; `references.dir` in `cadence.yaml` for their folder ([ref](ref.md)) |

`CADENCE_HOME` does not move `~/.local/share/cadence`: the two roots are independent. The copies in service are cleaned by `npm run service` itself (it keeps the copy in service and the 3 before it, [orchestrate](orchestrate-cycle.md)); a lot's worktree is removed with `cadence orchestrate --remove-worktree`. `session.clean` ([session](session.md)) lists working files of *your* project; it is not a list of cadence's state.

## Where a gate is declared

A gate is a check that sends a lot back instead of letting it through. It is declared in one of two places: **the plan** (a date from which it applies) or **`cadence.yaml`** (a key). A wave reads both when it starts and applies what it finds; it declares nothing of its own.

| Gate | Declared with | In | What it refuses |
|---|---|---|---|
| Code review | `reviewSince`, written by `raf review enable` | plan | `raf done` on a lot with commits whose review is not recorded ([raf](raf.md)) |
| UX review | `uxSince`, written by `raf ux enable` | plan | `raf done` on a `--visible` lot with no UX review ([news](news.md)) |
| Tests | `orchestrate.test` (with `testReplay`, `testRelated`) | cadence.yaml | a lot whose suite is red after a write step: it goes to a correction pass ([orchestrate](orchestrate-cycle.md)) |
| Build | `orchestrate.build` | cadence.yaml | a lot whose build or typecheck is red, played before the tests |
| Code without a test | `orchestrate.testGate` | cadence.yaml | code files changed with no test file touched: a correction pass before the review |
| Documentation | `docs.sync` (with `docs.since`) | cadence.yaml | a lot that changes code without touching the documents the rule names; acknowledged by `raf docs-ok <lot> --reason` ([news](news.md)) |
| Edge-case probe | `orchestrate.probe` | cadence.yaml | a lot whose diff a fresh session breaks with a red edge-case test ([orchestrate](orchestrate-gate.md#the-edge-case-probe-orchestrateprobe-l497)) |
| File bounds | `bounds` | cadence.yaml | nothing refuses on its own: the writer is told the limit ([below](#file-bounds-bounds)); a file over its bound is caught by the test the entry declares, in the targeted gate |
| Pre-check | `orchestrate.precheck` (on by default) | cadence.yaml | a lot whose deliverable is already in the repository: it is not implemented again |
| Mockup | `orchestrate.maquette` (on by default) | cadence.yaml | a lot with a screen whose mockup fails its UX review, before any code ([orchestrate](orchestrate-spec.md#the-mockup-review-before-any-code)) |
| Back-end sheet | `orchestrate.fiche` (on by default) | cadence.yaml | a lot with `spec: true` whose sheet fails its review, before any test is written |

Two keys do not add a gate, they say **where the gate is played**: `orchestrate.gate.host` (and `gate.install`, `gate.refs`, `gate.maxParallel`) plays the build and the tests on another machine through ssh ([remote gate](remote-gate.md)); `verify.inPlace` chooses, for `cadence verify --gate`, between the main tree and a throwaway copy ([deliver](deliver.md)).

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
2. **The brief of the writing session carries it.** The implementation and fix briefs end with one line per bound whose literal path the lot, its notes or the pre-check reading cite. A pattern (`docs/*.md`) or an entry with tests only adds no line.
3. **A hook measures after each write.** `cadence claude-hook bornes` (PostToolUse on Write, Edit and MultiEdit, in `hooks/hooks.json`) measures the written file against the `cadence.yaml` nearest above it and answers `borne dépassée : README.md : 70 lignes, limite 64` at once; it says nothing within the bound, and never refuses the write. A wave session disables every plugin, the `cadence` plugin included ([context of a session](orchestrate-cycle.md)), so the implementation and fix sessions receive the same hook line in their `--settings` argument, next to the disabled plugins; the `cadence` it runs is the wave's snapshot, first on the session's `PATH`.
4. **The targeted gate plays the declared tests.** When a lot touches a file matched by `paths`, the gate after a writing session adds the `tests` of that entry to the files given to `testRelated`, before the full suite of the integration. A test that nothing imports (it reads the file) is not found by `vitest related`; declaring it is the only way it runs in seconds. A declared test missing from the repository is left out.

`bounds` is a list; an unknown key, a limit that is not a positive integer or a test path with `..` is refused, like any key of `cadence.yaml` (the gate validates `cadence.yaml` after a lot that changed it).
