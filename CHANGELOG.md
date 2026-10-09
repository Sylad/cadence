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
| `cadence-hud`: dropped segments taken back when they fit, `CADENCE_HUD_AMBIGUOUS` | [0.13.1](#0131---2026-10-08) |
| `cadence lead tour`: the lead's table of projects without a model | [0.14.0](#0140---2026-10-08) |
| `hook.autostart` (`warn` \| `refuse` \| `start`): what the pre-commit hook does with a lot still todo | [0.15.0](#0150---2026-10-08) |
| `cadence session start\|close --all [--depth n]`: every project under a folder, one section each | [0.15.0](#0150---2026-10-08) |
| Wave lock per repository: `cadence deliver` on a repository whose lots are finished while the wave continues | [0.19.0](#0190---2026-10-08) |
| `cadence-hud`: `/hud cmd` lists the counted background commands, `N cmd sans fin vue`, finished waves greyed then hidden | [0.20.0](#0200---2026-10-09) |
| `docs.sync` in `cadence.yaml`: `raf check`, `lead tour` and the review brief report a document that does not follow the code | [0.21.0](#0210---2026-10-09) |
| `docs.articles` in `cadence.yaml`: after a green `cadence deliver`, a lot `Article <project> à rafraîchir` opened in the neighbouring repository | [0.21.0](#0210---2026-10-09) |

## [Unreleased]

### Added

- `cadence-hud`: under the waves, one line per active project with the progress of its plan — `ol ▮▮▮▮▮▯▯▯▯▯ 39/78 · 0 en cours · +3 cette semaine` — in the order of `priority:`, read again at each wave transition and otherwise every minute, folded and unfolded with `/hud projets`; `cadence lead tour --json` gains `progress` (`done`, `doing`, `todo`, `added7`) and sorts the projects by `priority:` (L149).
- `cadence orchestrate --continue [--until HH:MM] [--priority a,b]`: the wave draws the next ready lot of the plan itself when the lots in play are finished, in the priority declared by `--priority` or by `priority:` in the `cadence.yaml` of the parent folder, until the budget, the time window, the usage limit, a question, two lots handed back in a row, or no ready lot whose estimate fits the budget left; lots « à décider » (« à décider avec … », « (à décider) ») and lots whose `after` is not lifted are never drawn; a round draws at most one lot per repository while other repositories have ready lots (the pool would play two lots of one repository one after the other), then completes with the same repository; a lot that does not fit in what is left of the current round is drawn at a later round once the budget allows it; a candidate refused by the first draw is reported on the error output and in the journal with its cause; an unreadable `priority:` key is refused before anything starts (L147).
- `lead` skill: chains without the human — after a ready lot it re-verifies, `raf done`, pushes, delivers, runs the QA check and starts the next `--continue` wave in the declared priority, while the context of the lead session (the `ctx` segment of the `cadence-hud` band) stays under 60 %; at the threshold it runs `session-close`, writes memory and records three lines for next time; the first choice and order, questions and UX reservations stay with the human, and a `visible` lot waits for the human's UX verdict before `raf done` and delivery (L148). The threshold comes from `cadence session context [--session <id>]` (prints `ctx 42 % (84000/200000)`): the `cadence-hud` band writes the context of each session to `~/.cadence/orchestrate/hud-context/<session id>.json` every 5 s, tagged with the session's folder, and the command reads the file of the session named by `$CLAUDE_CODE_SESSION_ID` (set in the environment of Claude Code's Bash; `--session` overrides it); without the variable the folder decides only if a single session publishes for it, two sessions in one folder exit 2 asking for `--session` (exit 2 also without a fresh figure; files older than 24 h removed).

### Fixed

- `cadence orchestrate`: the cause « tests rouges après … » of a lot handed back without review now names the write pass that was really played, from the pass counter: after a minors pass followed by a short review with a major finding and a red fix pass, it says « la passe fix 1 », no longer « la passe des mineurs ». (L151)

### Changed
- `cadence orchestrate`: the final review is always played (one exception, below). A lot's own budget (derived from its estimate) now bounds the writing passes only, never the reviews: a lot that spent it during the implementation or a fix still gets its review (and UX review), and is handed back after it, not before. A fix pass starts only if the lot's remaining budget can pay a review after it: 65 k tokens are reserved, a fixed amount close to the 90th percentile of the reviews, measured on 2026-10-09 in the wave journals `.cadence/runs` (67 waves, 10-04 to 10-09, `tokens.counted`): 187 reviews, median 43.4 k, p90 62.7 k, max 105.9 k; 114 short reviews (after the minors pass), median 37.4 k, p90 67.6 k, max 82.7 k, so the short review has a higher p90 than the full one; all 301 together: median 42.3 k, p90 67.0 k. Otherwise the lot is handed back after the review that asked for the fix, with the reason, and the minors pass follows the same rule. One exception: when the tests are red after a write pass, the lot goes to a fix pass without a review, and if that fix pass is refused the lot is handed back to the lead without a review, with its findings; the cause then names the red tests. The wave budget and the usage limit still stop everything. (L145)

## [0.21.0] - 2026-10-09

### Added
- `orchestrate.effort` in `cadence.yaml`: the effort level (`claude -p --effort`, Claude Code 2.1.284) of each pass of a wave — `precheck` low, `implement` and `fix` medium, `review` (and `review-small`) high, `ux` high by default; `default` sends no `--effort`. The format-retry session keeps its pass's level, `--dry-run` shows the flag, an older `claude` is refused, and each step recorded in the wave state carries its `effort` next to `tokens` and its times, to compare two waves. (L137)
- `docs.articles` in `cadence.yaml`: a list of `{ repo, file, name? }` (an article of a neighbouring repository, e.g. the project's case study on a showcase site). After a green `cadence deliver`, for the delivered lots that have a public title, cadence opens in the plan the lot `Article <project> à rafraîchir` (`repos:` set to the neighbour, filtered by the project name) with a note quoting the public titles delivered and the sections of the article to read again; played in an ordinary wave. An already-open lot gets a note instead of a duplicate; entries with the same name (two neighbouring repositories) share one lot that declares both; `--dry-run` announces the articles; a read-only plan gets the instruction on the output line. The plan is written, not committed. Replaces the `sync-site-docs` skill. (L144)
- `docs.sync` in `cadence.yaml`: a list of `{ paths, docs }` pairs (code paths → the README, usage doc or CLAUDE.md that must follow them; `*`, `**`, a trailing `/` for a folder). `raf check` reports an open lot whose commits touch the paths without touching any of the documents (`✗ L7 : documentation en retard — src/a.ts, … sans toucher README.md (docs.sync)`), `cadence lead tour` shows it in the project's drift, and the review brief of `cadence orchestrate` carries the list the program computed, to be reported as one major finding per line (not just the sentence "the README must follow"). A `!pattern` leaves files out (tests); `docs.since` extends the audit to lots finished on or after that day. (L143)
- `cadence orchestrate --status` and `cadence lead tour` print the free session slots (`créneaux libres : N sur 2`) from the registry of live waves; the `lead` skill reads the figure instead of computing `2 − Σ min(cap, …)` by hand. (L141)

### Fixed
- `cadence orchestrate --status` without an identifier showed the table of the wave whose name sorts last (an old `ol-gains-1`) instead of the most recently launched one; it now picks by launch time. `--resume` without an identifier follows the same rule. (L141)

## [0.20.0] - 2026-10-09

### Fixed
- The `qa-reviewer` and `ux-reviewer` agents are read-only for real: their frontmatter now lists `tools: Read, Grep, Glob, Bash` and the Playwright tools (`mcp__playwright`, `mcp__plugin_playwright_playwright`), where it had no `tools:` and so inherited `Edit` and `Write` while the text said read-only. A wave that loads Playwright no longer adds `mcp__playwright` twice. Checked with a real session on 2026-10-09: the installed `ux-reviewer.md` file (`.claude/agents/`, interactive Playwright plugin server) opened a page, took a DOM snapshot (`browser_snapshot`), a screenshot (`browser_take_screenshot`) and listed the network requests (`browser_network_requests`), and `Edit`/`Write` were absent from its tool list. (L140)

### Changed
- `cadence-hud` 0.3.4: the band no longer misleads after the work is over. `/hud cmd` lists the background commands it counts (id, tool, origin `session` or `agent <id>`, age, name), and any other `/hud` argument answers `argument inconnu : … (attendu : cmd)` instead of silently hiding the band; a subagent that is finished or gone from the agent list takes its commands with it, `TaskStop` removes its task even when the result does not name it (the call's `task_id` / `shell_id`, and the command names, are read where `tool.call` carries a tool's arguments, beside `tool`, not under a non-existent `input`), and a command with no end seen for over an hour, or with no record of when it started, is no longer counted as running (grey `N cmd sans fin vue`, right after `N cmd`); the refresh reads the agent list after the collector wait, so a subagent launched meanwhile no longer has its first command stripped of its record and counted forever. A finished wave shows grey on one line (`terminée il y a 12 min  │  3 prêts`) without its budget and disappears 30 minutes after its end. (L142)

## [0.19.1] - 2026-10-09

### Fixed
- `cadence-hud`: the `N cmd` counter goes back down: a Monitor that expires (`[Monitor expired …]`, no status) ends its task, the background commands a subagent started end with it (their own notification never reaches the session), and a session (or a hot reload of the plugin) starts with no command. (L135)
- `cadence-hud`: the `tool.call` and `prompt.submit` guard hooks now carry a `.catch` on their registration (`on(...).catch(($, e, next) => next(e))`), which clears the `claude plugin validate` "gating hook without .catch" warning; a failing state write still loses a HUD line at worst. (L136)

## [0.19.0] - 2026-10-08

### Fixed
- `cadence-hud`: the lot rows of a wave are aligned on every surface (desktop included): each column is a fixed-width box instead of space padding, the title is truncated in the remaining width. (L134)
- `cadence orchestrate`: a review that leaves the repository dirty (screenshots at the root, a commit) is an incident of that lot, not of the wave: the lot is handed back to the lead and the lots of the other repositories keep running, while the lots still queued behind it in the same repository are suspended (nothing starts on a dirty tree; the wave is then `interrupted`, exit code 1, not `suspended-budget`) until the lead has cleaned it and resumed; the verdict the review had produced before the incident (conforme or not) is reported in the lot's outcome and warnings instead of being lost, and is not recorded in the plan. A push or a removed `pre-push` guard still stops the wave. (L133)
- `cadence orchestrate`: the repository lock (and its `pre-push` guard) is lifted as soon as every lot of the wave that touches the repository is finished, not at the end of the wave : a repository that is ready can be delivered with `cadence deliver` while the wave continues on another one. (L132)
- `cadence session close` re-run without a `session start` in between (as the `session-close` skill does after fixing a point) no longer reports `depuis la clôture de HH:MM` with an empty period and every lot in progress as "aucun commit" : a close no longer records its own time, so the window stays the last opening. (L131)

## [0.18.0] - 2026-10-08

### Changed
- `cadence session next "…"` no longer succeeds in silence: it prints `N lignes enregistrées pour la prochaine ouverture` and the lines as recorded, so `session-close` reports them without running `session start` again. (L129, #6)
- `cadence session close` now covers the period since the project's last opening (`session start`) or last successful close, not the whole day or 24 h, and says so: `Commits de la période (depuis l'ouverture de 09:12)`. Lots already reported in the morning are no longer listed again. `--since` still takes precedence; with no known opening, the window stays the current day (`depuis 2026-09-28 00:00`). A close that leaves points open does not move the boundary, so rerunning it after a fix keeps the same report. (L130, #7)

## [0.17.0] - 2026-10-08

### Added
- `cadence-hud` shows an `N cmd` segment next to the agents: the background commands of the session in progress (Bash run in the background, by `run_in_background`, Ctrl+B or timeout, and Monitor, subagents' included, except a command started by a synchronous subagent, which carries `backgroundEndsWithFinalResponse: true`, ends with the subagent's final response rather than at a notification, and is deliberately not counted), as the window's "background commands" card counts them, where the band only counted agents (seen on 2026-10-08: app "2 running, 3 tasks", band "1 agent"). Tracked from the tool results, ended by the task's notification or `TaskStop`; hidden at zero, dropped with the agent counter on a narrow window. (L126)

## [0.16.0] - 2026-10-08

### Added
- A lot can declare **neighbouring repositories** with the lot key `repos:` (paths relative to the project's repository; a read-only plan maps it with `plan.fields.repos`), for work that lives in a repository that is not a cadence project (B64 in `aetherwx-gitops`). `cadence orchestrate` then refuses before acting a listed path that is missing, not a git repository, with a modified tracked file, with its own `pre-push` hook or held by another live orchestration; locks it (so `cadence deliver` refuses it too), guards it with the temporary `pre-push` hook and the after-session checks, queues lots that share a repository one after the other, and gives every session each neighbour as `--add-dir`. The implementation brief names them and requires that commits there cite the lot; the reviewers read the commits that cite the lot in the project and in each neighbour. `raf commits` and `raf show` list those commits (one `dépôt <path> :` section per neighbour), and the code review verdict (`raf review`, and the orchestrator's) stores the sha read in each repository under `review.repos`. In a neighbour, a commit counts when it cites the lot id and is dated within the lot's period (`started` to `finished`); nothing is inferred from the repository or the project's name. For a neighbour shared between projects (`developpeur-gitops`), an entry of `repos:` can be an object, `repos: [{ path: ../developpeur-gitops, cite: ol-companion }]` (strings and objects can be mixed, `plan.fields.repos` of a read-only plan accepts both): the commit must then also contain that string (substring, case-insensitive, subject and body); without `cite`, the commits of other apps citing the same id count. `raf check` does not audit the neighbours; their delivery stays with the lead. (L62)

## [0.15.0] - 2026-10-08

### Added
- `hook.autostart` in `cadence.yaml` (`warn` by default, `refuse`, `start`): what the new pre-commit hook does with a commit that cites a lot still `todo`. `refuse` fails the commit with `raf start <id>` in the message; `start` runs `raf start` in the hook and stages the plan, so it goes in the same commit (no amend), but only when the plan file is identical to `HEAD`: with an uncommitted change to the plan (staged or not) it starts nothing, says why, and behaves like `warn`. `warn` keeps today's post-commit warning. `raf hook install` now installs both hooks; run it again in an existing repository. (L104, #4)
- `cadence session start|close --all [--depth n]`: from a folder that is not a repository, runs the command in each sub-folder holding a plan (`docs/plan/raf.yaml`, or a `cadence.yaml` with `plan:`), `--depth n` levels down (1 by default), one `## project` section each; `--since` and `--idle` go to every project, an error stays in its section and the others still run, a project without its own `.git` gets a `✗` line, `--file`, `--config` and `RAF_FILE` are refused, exit code is the worst of the projects. The `session-start` and `session-close` skills use it in place of the shell loop. (L103, #3)

## [0.14.0] - 2026-10-08

### Added
- `cadence lead tour [folder] [--idle 3] [--json]`: the lead's table without a model. For every direct sub-folder with a plan (`docs/plan/raf.yaml`, or a `cadence.yaml` with `plan:`, read-only plans included) it reads the facts of `session start` in-process and prints one line per project: lots in progress (`silencieux Nj` past `--idle` days), `raf check` gaps, notes of the last close (cut at 120 characters), next ready lot, repository (`non commité`, `non poussé`, `livraison en cours`). Read-only, exit 0 even when a project is in error (its line says so); `--json` gives the same content. The `lead` skill calls it in place of one subagent per project (about 150 k tokens for a tour of 10 projects on 2026-10-08). (L122)

## [0.13.1] - 2026-10-08

### Changed
- `cadence-hud`'s first line takes back the segments that fit once a big one has dropped: after the priority drop, the dropped segments that fit in the cells left come back, most useful first (the reset times before the per-model consumption, through the segment's `back` rank), instead of staying lost with ~25 cells free. The per-model segment is now short, `opus 1.2M sonnet 800k` (tokens only, 40 characters at most instead of 60). (L121)

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
