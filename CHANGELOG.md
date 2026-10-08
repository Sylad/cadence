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
| Changelog and GitHub releases | [0.11.0](#0110---2026-10-06) |
| Parallel waves on different repositories, shared session cap (`--max-sessions`) | [0.11.0](#0110---2026-10-06) |
| `cadence-hud` plugin: a status band above the Claude Code prompt | [0.12.0](#0120---2026-10-08) |
| `raf ignore`, `raf check` warning on a visible lot without public title | [0.12.0](#0120---2026-10-08) |
| Waves: review sized to the lot, precheck of an already-present deliverable, `orchestrate.ux` starts the app | [0.12.0](#0120---2026-10-08) |

## [Unreleased]

### Changed
- `cadence-hud`'s first line takes back the segments that fit once a big one has dropped: after the priority drop, the dropped segments that fit in the cells left come back, most useful first (the reset times before the per-model consumption, through the segment's `back` rank), instead of staying lost with ~25 cells free. The per-model segment is now short, `opus 1.2M sonnet 0.8M` (tokens only, 40 characters at most instead of 60). (L121)

### Added
- `CADENCE_HUD_AMBIGUOUS=1|2` sets the width of the ambiguous-width characters `▰ ▱ ⚙ │ ↻` that `cadence-hud` measures with; default 2 (worst case, unchanged), 1 for a terminal or the desktop app that draws them in one cell (14 cells more on the first line). Documented in the plugin's README; no terminal detection. (L121)

## [0.13.0] - 2026-10-08

### Added
- `cadence orchestrate --status --watch [--interval s]`: the table of a wave, redrawn every 10 s (screen cleared between two renders), which stops by itself when no wave is running; exit code as `--status`. The `cadence-lead` skill names the background task « vague <id> : project:lot, … », starts the wave with `--wave <id>` and arms a follow-up on `.cadence/runs/<id>/journal.log` that pushes each transition into the conversation. (L49)

### Changed
- `publish.yml` uses `actions/checkout@v5` and `actions/setup-node@v5`: the v4 actions ran on Node 20, deprecated, and the v0.12.0 run was forced onto Node 24. To check on 2026-10-19: `ubuntu-latest` moves to Ubuntu 26 (not verified in this lot). (L117)

### Fixed
- `cadence orchestrate` accepts a lot id containing `/` (`maritime-atlas:Q4/accueil-4-ux12`, a sub-task of a read-only plan): only the first `:` separates project and lot, a final `@model` stays a suffix, and `--dry-run`, `--status`, `--resume --answer` follow; in `.cadence/runs/<wave>/` the `/` becomes `__` in file and folder names. Ids without `/` behave as before. (L120)
- `cadence-hud`'s first line no longer uses the other ambiguous-width characters (`·`, `…`, `—`): separators, ellipses and unknown values are ASCII (` | `, `...`, `-`), and the spend-limit window reads `EUR` instead of `€`, so `▰ ▱ ⚙ │ ↻` are the only non-ASCII characters left to measure, and the README states that worst case. A test refuses any other character on that line. (L119)
- `cadence-hud` measures the segments of its first line in terminal cells (the ambiguous-width `▰ ▱ ⚙ │ ↻` count for 2) instead of string length, so the priority drop also holds in a terminal set to ambiguous width = 2. (L116)
- `raf check` no longer warns about a visible lot without public title on a read-only plan whose `plan.fields` maps no `public` field: the warning could not be cleared and came back at every session. Exception: when a lot of the file already carries a literal `public:` key, the plan does hold public titles, so the warning stays. (L115, L118)
- The `README` and the brief templates now describe the Playwright output of briefs written outside a wave (`--dry-run`, delegation by hand: no wave folder, capture under the OS temp directory; no Playwright server promised) and that `fix` / `fix-minors` of a visible lot get the wave folder and `--add-dir`. (L91)

## [0.12.0] - 2026-10-08

### Added
- `raf check` warns (`⚠`, exit code unchanged) about a visible lot that has no public title — set with `raf public <id> "…"` or `raf add --public`; dropped lots and non-visible lots are not concerned, nor is a done lot that a News entry cites (the site reuses its title). The summary counts errors and warnings apart, and `session start/close` shows the warning without blocking the close. (L32)
- The `cadence-hud` plugin, in the repository's marketplace (`/plugin install cadence-hud@cadence`): a band above the Claude Code prompt with the session's context, 5 h / 7 d quota windows, cost and its split per model, the subagents running, and every live `cadence orchestrate` wave (budget, sessions, one aligned line per active lot) — the last finished wave stays on a grey line until the next one; `/hud` hides it. Outside the npm package. (L111)
- The `qa-reviewer` agent walks within a time budget (the caller's, otherwise 15 minutes), never waits in silence on its own background work, and appends a line to a results file after each width it measures (one line per page and width); a pass that is stopped reports from that file, with the pages measured at one width marked partial and the rest named. (L101)
- `raf ignore <sha> | "exact subject" [--reason text]` acknowledges a commit without a lot (a tooling chore, a plan commit citing an unknown id) without rewriting history: a dated, reasoned line in the plan's `acknowledged:` section, honoured by `raf check` and `session close`; `raf check --ignored` lists them. (L73)
- The `code-reviewer` and `ux-reviewer` agents and the orchestrate review briefs now propose a sub-task only for a minor finding that describes an observable bug (a wrong output, a crash, a measured regression); any other minor stays a note of the lot, and the `lead` skill applies the same rule, so a review no longer feeds the next one. (L109)
- `cadence orchestrate` sizes the review to the lot (L108): a lot whose `estimate` is at most
  0.25 day gets one single review (Sonnet, `code-reviewer` agent, same criteria) and no minors
  pass — the minors come back to the lead as notes; a blocking or major finding still triggers a
  correction and an Opus review. Bigger lots keep the full chain. Threshold and models are set in
  `cadence.yaml` (`orchestrate.review: { threshold, light, full }`, defaults 0.25 / sonnet / opus).
- `cadence orchestrate` checks, before opening an implementation session on a lot with
  no commit, whether the deliverable is already in the repository (a short read-only
  Sonnet session): when it is, the lot is handed back as « livrable déjà présent » with
  its proofs instead of spending an implementation session on it; a partial finding
  goes into the implementation brief. `orchestrate.precheck: false` in `cadence.yaml`
  turns it off. (L77)
- `orchestrate.ux` accepts `{ command, url, timeout? }`: with both `command` and
  `url`, the orchestrator itself starts the app before the UX step (and before the
  single pass of a small visible lot) and stops it afterwards, so the wave does the
  UX review without the lead. If the URL already answers nothing is started and the
  lot notes « port occupé »; if the app does not answer within `timeout` seconds
  (default 300) the UX review is skipped with the end of the log, and the lot goes
  on to the code review — never a failed wave. Two waves declaring the same URL take
  turns (lock per `host:port` in the OS temp folder; the wait counts in `timeout`),
  the app only counts as ready while the process it started is alive, a wave stopped
  before the step starts nothing, and `url` must be `http(s)://` with `timeout` only
  allowed beside `command` and `url`. (L60)

### Changed
- The `implement` brief of `cadence orchestrate` requires the README and the usage documentation to describe the behaviour delivered, like the CHANGELOG, and the `code-reviewer` agent reports a README that does not follow the change as a major finding. (L114)

## [0.11.0] - 2026-10-06

### Added
- `CHANGELOG.md` and a « What's new » section in the README: what each release brings,
  and since which version each feature exists; every tag gets a GitHub release with
  its changelog section, and a tag without a section is not published. (L69)

### Changed
- `cadence orchestrate` locks per **repository** instead of per parent folder: two
  waves on different repositories now run side by side, even when started from the
  same folder; the same repository is still always refused. (L71)
- Sessions of all live waves share a cap of simultaneous sessions (2 by default;
  `--max-sessions N` or `CADENCE_MAX_SESSIONS`); a session waits for a free slot
  instead of exceeding it; each wave counts every live slot against its own cap, and
  the wait is logged with its duration. (L71)
- Wave identifiers are reserved atomically; slots and registry entries are owned by
  pid + start time (a reused pid is a dead owner). (L71)
- `cadence orchestrate --status` lists the live waves, the repositories they hold and their cap.
  (L71)

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
