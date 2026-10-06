# Changelog

What each release of cadence brings to the people who use it. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); newest first, one
section per git tag. `(L12)` cites the lot of the plan (`docs/plan/raf.yaml`)
that brought the change.

Versions 0.1 to 0.4 were never tagged nor published (0.3.0 and 0.4.0 never
reached npm): what they brought is part of the first tagged release, 0.5.0.

## Available since

| Feature | Since |
|---|---|
| `raf` plan, Gantt page, `raf check`, commit hook | [0.5.0](#050---2026-10-03) |
| `news` entries with screenshots | [0.5.0](#050---2026-10-03) |
| `session start / close / next`, `deliver`, Claude Code skills | [0.5.0](#050---2026-10-03) |
| UX review and code review gates (`raf ux`, `raf review`) | [0.5.0](#050---2026-10-03) |
| `qa-reviewer` agent | [0.6.0](#060---2026-10-03) |
| `cadence verify`, commit attribution by scope | [0.8.0](#080---2026-10-04) |
| `cadence orchestrate`, recurring lots, public titles, safe clean-up at close | [0.9.0](#090---2026-10-04) |

## [0.10.1] - 2026-10-05

### Changed
- QA expectations (`docs/qa/expectations.md`, or the file named by `qa.expectations`)
  are kept with the plan: a commit that only touches them no longer has to cite a
  lot, and the path is normalised and validated like the `plan.*` keys. (L65, L67)

## [0.10.0] - 2026-10-05

### Added
- `cadence orchestrate` sends a lot whose commits already exist straight to review
  instead of implementing it again; a fix without a new commit on such a lot chains
  on a fresh review. (L53, L56)
- Sessions of a wave may only ask a question that names what it would change;
  minor choices are decided by the session and reported for the reviewer. (L57)

### Fixed
- `cadence verify` waits for the pushed head to be on the upstream when there is no
  deploy command, tells you about unpushed commits, and only does so on the
  production branch; a local upstream is never taken for production. (L54, L55)

## [0.9.0] - 2026-10-04

### Added
- **`cadence orchestrate`**: runs several lots as a wave of short Claude sessions
  (implementation, fresh UX then code review, up to two fix passes, then a single
  pass for the minor findings), two at a time, with a token budget, dependencies
  between lots, a resumable state and a table of results. The hooks and locks it
  needs are temporary. (L3, L33, L38, L39)
- Recurring lots: `every` / `last` fields, `raf add --every`, `raf did`, and
  « due for N days » in `raf now` and `session start`. (L11)
- Public title of a lot: `raf add --public`, `raf public <id>`. (L12)
- `session close` offers to clean up stale working files (`session.clean`), and
  never proposes a git repository, a hidden name, a bare repository or the
  content of a symbolic link. (L4)
- `qa-reviewer` follows a clearer method and names the commands that list the open
  lots. (L10, L35)

### Changed
- `publish.yml` pins npm on major 11 and checks the tag against the plugin files
  as well as `package.json`. (L23, L34)
- The test suite no longer leaves `cadence-*` folders in the temp directory. (L45, L46)

### Fixed
- Commands run by `deliver` and `verify` are killed with their whole process tree
  at the deadline and on Ctrl-C, hang-up or SIGTERM; the lock is held until the
  tree is empty. (L19, L20, L21, L30, L37)
- A quota, an incident or an interrupted step in a wave is counted and resumed
  correctly. (L25–L29, L40, L41)

## [0.8.0] - 2026-10-04

### Added
- **`cadence verify`**: replays the delivery effect checks outside a delivery, with a
  per-check budget; `session start` replays it too and reports a red effect among
  the morning facts. (L8, L19)

### Changed
- A commit is attributed to a lot by its scope, `type(L24): …`; `cadence.yaml` is a
  plan file. Hook, `deliveredLots` and `raf check` apply the same rule. (L13–L17)
- Commands run by `deliver` stay in the foreground (tty, Ctrl-C) and are killed with
  their tree at the deadline. (L19, L20)
- Publication to npm goes through Trusted Publishing (OIDC): no stored token, tag
  checked against `package.json`, type-check and tests before `npm publish --provenance`. (L22)

## [0.7.0] - 2026-10-03

### Added
- News: alternative text per screenshot (`{ file, alt }`), exported as `alts` in
  `nouveautes.json`. (L5)

### Changed
- Plan maintenance is decided by the files a commit touches, never by its subject:
  the `chore(plan):` exemption is removed. (L5)
- `cadence session next` without a line refuses (exit 2) instead of silently erasing
  the notes of the last close; `--clear` erases on purpose. (L5)
- On a read-only plan, `cadence deliver` only announces the lots that were in
  progress when the delivery started. (L5)

### Fixed
- An empty or blank review verdict written by hand no longer counts as a review;
  `feat(Lx.4)` no longer links a commit to lot `Lx`. (L5)

## [0.6.0] - 2026-10-03

### Added
- **`qa-reviewer` agent**: after a green delivery of a visible lot, walks the
  delivered app in a real browser against `docs/qa/expectations.md` and reports a
  page left empty or in error. Read-only, GET only; reports defects, suspicions
  and things already planned. (L9)

## [0.5.0] - 2026-10-03

First tagged release; it gathers everything built before (0.1 to 0.4, never tagged).

### Added
- **`raf`**: the plan as a YAML file in the repository, edited by the CLI with your
  comments preserved; commits are linked to lots from `git log`; `raf check` audits
  the gaps; Gantt scheduling and a standalone Gantt page; a non-blocking
  post-commit hook; a plan kept by another tool can be read without migration
  (`plan:` in `cadence.yaml`). (L1)
- **`news`**: user-facing entries in Markdown with screenshots, tied to the lots,
  checked and built into JSON and a standalone page.
- **`session start | close | next`**: the facts to open and close a work session
  and what to do next, drawn from the plan.
- **`deliver`**: waits for the CI of the pushed commit, runs the deploy commands,
  then verifies the effect; a lock, a dry run, and a `deliver.script` for projects
  with their own delivery script. (L2)
- **Claude Code skills** `session-start`, `session-close`, `deliver`, `lead`, and the
  `cadence skills install` command.
- **UX review gate** (`raf ux`) and **code review gate** (`raf review`, `raf commits`):
  `raf done` refuses a lot with commits and no verdict, the verdict is tied to the
  commit that was read; agents `ux-reviewer` and `code-reviewer` ship with the
  plugin. (L6)
- Publication to npm, with a type-check and the tests before every publish. (L7)
