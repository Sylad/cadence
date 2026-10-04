# cadence

A small working method that lives in your repository. Solo developers and
AI-assisted sessions lose track of *what is left to do* and *what each commit
was for*; cadence keeps both in plain files next to the code.

Four tools:

- **raf** (French *reste à faire*, "what is left to do"): the plan, linked to your commits;
- **news**: a user-facing changelog with screenshots, tied to the plan;
- **session**: the facts to start and to close a work session;
- **deliver**: wait for the CI of the pushed commit, deploy, then **verify the effect**.

And four [Claude Code](https://claude.com/claude-code) skills that turn them
into rituals — `session-start`, `session-close`, `deliver`, and `lead` to pilot
several projects through subagents — plus three reviewer agents: `ux-reviewer`
(no user-facing change is done before its usability review) and `code-reviewer`
(no lot with commits is done before its code review), each behind an opt-in
gate, and `qa-reviewer`, which walks the delivered app in a real browser and
reports a page left empty or in error.

## raf

- The plan is a YAML file in the repo (`docs/plan/raf.yaml`), edited by the CLI.
  Your comments and hand edits are preserved.
- A commit belongs to a lot when its message cites the id: `feat(L3): …`,
  `fix: L3/t1 …`. The link is **computed from `git log`**, never stored, so
  committing never dirties the plan. The id is read as a whole word: `XL3`,
  `L3x` and `L3.4` do not cite `L3`, while `L3.` at the end of a sentence does.
  When the subject has a scope that cites lots (`feat(L3): …`,
  `chore(L31,L32): …`), **the scope alone decides**: a passing mention
  (`page équipe (L27)`), a range (`L28–L31`, `L45 à L48`) or the body does not
  count. Without a scope citing a lot, the whole message is read as before.
- `raf check` audits drift between the plan and the history.
- Plan upkeep needs no lot. A commit is plan upkeep when **every file it
  touches is a plan file**: the plan itself, its Gantt page (only at its default place, `gantt.html` next to the plan — written elsewhere with `raf gantt -o`, declare it under `plan.files`), the `plan:` key of the config file in use (`cadence.yaml`, or
  the `--config` file; a change to `deliver:`/`session:` is work), or a file the
  project lists under `plan.files` in `cadence.yaml` (a page it generates from
  the plan, a journal). Such a commit is never a "commit without a lot", and it
  does not count as work on the lots it cites: it is absent from `raf commits`,
  does not start a `todo` lot, does not make a code review stale, and
  `cadence deliver` does not announce the lots it cites as delivered. The files
  decide, never the subject: a `chore(plan): …` commit that touches a source
  file is a commit like any other.
- `raf gantt` writes a single self-contained HTML page (no server, no CDN).

```sh
npm install -g @sylad/cadence    # or: npx -p @sylad/cadence raf …

raf init                          # docs/plan/raf.yaml + post-commit hook
raf add "Monthly dedup on merge" --estimate 2
raf add "Typo in footer" --quickwin
raf add "Loan cache" --after L1
raf add "write the migration" --parent L1     # → L1/t1
raf start L1
git commit -m "feat(L1): dedup by calendar month"
raf now                           # in progress, next up (quickwins first), recently done
raf done L1/t1 && raf done L1
raf check                         # exit 1 on drift
raf gantt                         # docs/plan/gantt.html
```

### Commands

| Command | Effect |
|---|---|
| `raf init [--project name] [--prefix L] [--no-hook]` | create the plan and install the hook |
| `raf add "title" [--estimate d] [--quickwin] [--visible] [--after L2,L4] [--parent L3]` | add a lot or a sub-task, print its id |
| `raf start <id>` · `raf done <id> [--force]` · `raf drop <id> [--reason text]` | dated transitions (`done` refuses open sub-tasks unless `--force`) |
| `raf note <id> "text"` | dated note — keep decisions next to the work |
| `raf commits <id>` | the commits counted for a lot (the set the code review gate uses), one `<sha> <subject>` per line, oldest first |
| `raf now` | what to do next |
| `raf list [--status s]` | flat list |
| `raf check [--since date] [--idle 7]` | since the plan's adoption date by default: commits without a lot (commits touching only plan files are exempt), unknown ids, `todo` lots that already have commits, idle lots, `done` lots with open sub-tasks, bad or circular dependencies |
| `raf gantt [-o file]` | standalone Gantt page |
| `raf hook install` | add the (non-blocking, read-only) post-commit hook |

Global options: `--file path` or `RAF_FILE`; `RAF_TODAY=YYYY-MM-DD` to freeze
the date. `cadence raf …` is the same as `raf …`.

### Plan file

```yaml
version: 1
project: my-app
prefix: L
since: 2026-09-28     # commits before this date are not audited
ignore: ['^chore\(batch\):']   # optional: subjects of automated commits, neither audited nor counted for a lot
lots:
  - id: L1
    title: Monthly dedup on merge
    status: doing        # todo | doing | done | dropped
    estimate: 2          # working days
    quickwin: false
    visible: true        # user-facing: a news entry is expected when done
    after: [L0]
    created: 2026-09-28
    started: 2026-09-29
    notes:
      - { date: 2026-09-29, text: "keep the bank line when both sources exist" }
    tasks:
      - { id: t1, title: write the migration, status: done }
```

### A plan elsewhere, or in another format

`cadence.yaml`, at the repository root, can say where the plan is. The short form keeps raf's own
format, and the plan stays writable:

```yaml
plan: planning/todo.yaml
```

A project that publishes its plan (a JSON generated from it and committed with it)
declares that file, so a commit touching only the plan and its published copy is
plan upkeep; the plan keeps raf's format and stays writable:

```yaml
plan:
  files: [frontend/public/plan-data/plan.json]
```

Until the file is declared, such a commit is reported as a "commit without a
lot" when it cites none, and counts as work on the lots it cites.

A project that already keeps its plan with its own tool is read **without migrating it**: describe
the file, and `raf now`, `raf list`, `raf commits`, `raf check`, `raf gantt` and
`cadence session start|close` work on it. Such a plan is **read-only** —
`raf add|start|done|note|ux|review` refuse and leave the file to the project's tool, and the two
review gates do not apply to it (a `uxSince` or `reviewSince` written in it is ignored).

```yaml
plan:
  path: docs/plan/taches.yaml
  project: my-app               # what the file does not say itself: project, since, ignore
  since: 2026-10-02
  ignore: ['^plan: ']
  files: [docs/plan/journal.ndjson]   # kept with the plan: a commit touching only these is a plan commit
  lots: taches                  # root key holding the list (default: lots)
  fields:                       # raf field: key in the file (a list = first one present)
    title: titre
    status: etat
    estimate: effort
    created: cree_le
    started: demarre_le
    finished: [livre_le, ferme_le]
    notes: note
    parent: parent
  statuses:                     # raf status: their states
    todo: [prevu, specifie]
    doing: [en_cours, teste]
    done: [deploye, valide]
    dropped: caduc
  estimates: { S: 0.5, M: 1, L: 3 }   # their effort labels, in working days
```

- Fields: `id`, `title`, `status`, `estimate`, `quickwin`, `visible`, `after`, `created`, `started`,
  `finished`, `notes`, `parent`; one left out is read under its own name. A timestamp counts for
  its day; a note written as plain text is one note.
- `parent`: an entry `B33/t1-fusion` whose parent is `B33` becomes the sub-task `t1-fusion` of `B33`.
- Ids need no prefix: a commit belongs to a lot when its message cites one of the plan's ids as a
  whole word (`E-A2`, `NC2.4`, `B33/t1-fusion`).
  An id that is not in the plan cannot be told from ordinary text: such a commit counts as
  "without a lot", never as an unknown reference.
- A state missing from `statuses`, or an effort label missing from `estimates`, is reported by
  `raf check`.

### Gantt scheduling

One lane of work. Finished lots use their real dates (or their commits' dates);
lots in progress run until `max(start + estimate, today)`; lots to do follow in
file order, after their dependencies, on working days.

## news

What changed *for the user*, one entry per visible lot, each with a screenshot.

- Mark a lot as user-facing with `raf add … --visible` (or `visible: true` in
  the YAML). `raf done` and the post-commit hook remind you to write its entry;
  `raf check` fails while a visible lot is done without one.
- An entry is a Markdown file in `docs/nouveautes/`, with a YAML header.
  Screenshots are files you take yourself, stored next to the entries.
- `cadence news build` writes `nouveautes.json` for your app to display, a
  self-contained `index.html`, and copies the screenshots.

```sh
raf add "Amounts like 3.000 read as three thousand" --visible   # → L8
raf start L8 && git commit -m "fix(L8): thousands separator" && raf done L8
cadence news new L8          # docs/nouveautes/2026-09-29-amounts-like-3-000-….md
# add docs/nouveautes/captures/l8.png, list it under `captures:`, write the text
cadence news check           # exit 1 on drift (also part of raf check)
cadence news build -o frontend/public/nouveautes
```

```markdown
---
title: Amounts like 3.000 read as three thousand
date: 2026-09-29
created: 2026-09-29T14:32+02:00
lots: [L8]
captures: [captures/l8.png]
# nocapture: reason, when a screenshot makes no sense
---
Imported statements now read **3.000** as three thousand, not three.
```

A screenshot can say what it shows: write it as `{ file, alt }` instead of a
bare path, one text per screenshot.

```yaml
captures:
  - { file: captures/l8-before.png, alt: "Statement total read as 3 instead of 3,000" }
  - captures/l8-after.png          # a bare path still works: no alternative text
```

| Command | Effect |
|---|---|
| `cadence news new <lot…> [--title t]` | entry skeleton, dated and timed now (`date`, `created`), titled after the lot |
| `cadence news list` | entries, newest first (see *Order* below) |
| `cadence news check` | visible lots done without entry, unknown lots, missing or undeclared screenshots, entries without creation time, bad headers |
| `cadence news stamp` | migration: writes `created:` into entries without one (or with an empty one), from the author date of the commit that added the file under its current name (now if not committed yet) |
| `cadence news build [-o dir]` | `nouveautes.json` + `index.html` + screenshots (default `docs/nouveautes/site`) |

`--dir` changes the entries folder (default `docs/nouveautes` at the git root).
The Markdown is deliberately small: paragraphs, `-` lists, `**bold**`,
`` `code` ``, `[links](url)`; everything else is escaped text. The JSON holds
`{ project, generated, entries: [{ slug, title, date, lots, captures, html }] }`,
with screenshot paths relative to the JSON file. `captures` is always a list of
paths; an entry that gives at least one alternative text also carries `alts`,
the texts in the same order (`""` for a screenshot without one) — an entry
without any keeps exactly the shape above. The built page puts the text in the
image's `alt`, and falls back to "Capture : <title>".

**Order.** Everywhere (`list`, `build`, the JSON), entries are strictly newest
first: by `date`, then, on the same day, by creation time. Every entry carries
it to the minute in its `created` header, which `cadence news new` writes as
local time with an explicit offset (`2026-09-29T14:32+02:00`, or `Z`). The
offset is required, so the order does not depend on the machine's time zone:
`news check` (and `raf check`) flags a value without it, an impossible one, an
empty `created:`, and an entry without `created`. `cadence news stamp` fills
it in older entries (or replaces an empty one) from the author date of the
commit that added the file under its current name; until then, that date is
used for sorting (an entry not committed yet counts as the newest). Renames
are not followed: a renamed entry counts as added on the day of the rename,
so stamp it before renaming it. The file name only breaks the remaining ties,
since it follows the title, not the chronology. The page and the JSON still
show the day only.

### UX review

```sh
raf ux enable                      # from today, a --visible lot needs a UX review before done
raf ux L4 "compliant after 2 fixes"   # record the verdict (from the ux-reviewer agent)
raf ux L8 "no screen: calculation fix"
```

With the rule on, `raf done` refuses a visible lot without a review (`--force`
to override) and `raf check` reports visible lots finished after the `uxSince`
day without one. An empty verdict is refused, and one left empty or blank by hand
in the YAML counts as no review. Plans without `uxSince` are not affected.

### Code review

```sh
raf review enable                  # from today, a lot with commits needs a code review before done
raf commits L4                     # what there is to review: the commits the gate counts for the lot
raf review L4 "compliant after 2 fixes"   # record the verdict (from the code-reviewer agent)
```

The counterpart of the UX review, off by default. With the rule on, `raf done`
refuses a lot that has at least one commit citing it and no recorded verdict
(`--force` to override), and `raf check` reports such lots finished after the
`reviewSince` day. A lot with no commit has nothing to review; neither does a
lot whose only commits touch plan files alone (the plan, or a file listed under
`plan.files`), predate the plan's `since` or match an `ignore:` pattern — `raf commits <id>` prints exactly the counted set.

The verdict is tied to what was reviewed: `raf review` stores it on the lot with
the sha of the lot's latest counted commit (`review: { date, verdict, commit }`,
`commit: null` when the lot had none). A counted commit made after that one
makes the review stale: `raf done` refuses (`--force` to override), and
`raf check` reports a finished lot, until the lot is reviewed again and
`raf review` is rerun. A verdict
written by hand without a `commit` field is not checked for staleness. An empty
verdict is refused, and one left empty or blank by hand in the YAML counts as no
review. Plans without `reviewSince` are not affected.

### QA review

No gate and no command here: the QA review comes **after** a delivery, and
`raf done` does not wait for it. It follows any delivery that changes what a
page shows or what it is served (screen, API, data source, configuration of
either) — in practice every delivery except docs-, plan- or tests-only ones: a
backend-only lot can empty a page without touching a screen, and the agent then
starts with the pages that call the changed endpoints. The `qa-reviewer` agent
opens each page of the running app in a real browser and judges it from the
user's side. A page can be empty while everything else is green — no code
changed, a data source went down upstream, the unit tests replace the network,
`/api/health` answers ok, and the "nothing found" on screen is the message the
code was written to show.

The agent cannot tell such an empty state from a normal one by itself: the
project says what each page must show, in `docs/qa/expectations.md` — one
`## <route>` section per page, three kinds of lines:

```markdown
# QA expectations

## *
- shows: the header and the navigation links
- never: "Loading failed", "Too Many Requests"
- api: /api/live/current — may be empty when no match is within 24 hours

## /players
- shows: the squad of the last match — at least 11 players
- shows: the season statistics table, 8 columns — 1440 only
- never: "No recent line-up found"
- api: /api/squad/last — a non-empty list

## /fixtures/:id   (the first match linked from /fixtures)
- shows: both team names, the date, the score once the match is played
- never: "Unknown match"
- api: /api/fixtures/:id
```

- `shows:` — content that must be present and non-empty, with a count where one exists;
- `never:` — texts that must not appear: error messages, and empty-state messages that mean
  missing data;
- `api:` — the calls the page depends on: each must answer 2xx with a non-empty body (a 200 with
  `[]`, `{}` or `null` is a failure, unless its line says `may be empty when …`).

An optional `## *` section holds what every page must show, never show and call. A line may end
with a condition in plain words, which the agent honours: `may be empty when …`, `1440 only`,
`390 only` (a line without a width holds at both). Content hidden on the phone by design is not a
defect unless a `shows:` line requires it at 390; content pushed outside the visible area (it
needs a sideways scroll) is reported as suspect and handed to `ux-reviewer` in one line.

The rest is free text, written for a reader: a line can be repeated, and a route with a parameter
names a real value to visit or says where to find one. The file can live elsewhere:

```yaml
# cadence.yaml
qa:
  expectations: docs/quality/pages.md
```

Only the agent reads that key; the CLI does not use it. Without an expectations file the agent walks
the routes it discovers and still runs its universal checks: an error shown, a failed API call
whose content is missing on screen, a broken or missing content image are defects with or without a
file; an empty 2xx body, like whatever else would need an expectation to judge, is suspect at most
(it may be a normal absence). For a route with a
parameter, it finds a real value in the app's links or its API responses and says how it built the
URL. The agent then returns a draft for you to correct — it never writes the file itself.

## session

```sh
cadence session start              # notes from the last close, lots in progress (silent ones flagged),
                                   # work done since yesterday by lot, drift, repo state, 3 proposals
cadence session start --since "3 days ago" --idle 2
cadence session close              # today's commits by lot, commits without a lot, lots in progress
                                   # with no commit today, drift, uncommitted / unpushed work
                                   # exit 1 while something is still open
cadence session next "finish L3" "review L4"    # shown by the next session start; replaces the previous notes
cadence session next --clear       # erase those notes, on purpose
```

`cadence session next` without a line refuses (exit 2) and leaves the notes of the
last close as they are — it used to erase them silently; erasing is `--clear`.

Proposals come from the plan only: lots in progress, then ready lots (dependencies
done), quick wins first. Local state lives in the git directory, never committed:
the close notes per worktree, the delivery lock and log in `.git/cadence/`, shared
by all the worktrees of a clone.

A project that already has its own morning and evening scripts keeps them: name
them in `cadence.yaml` and their output is added to the report, under "Faits
propres au projet", before the proposals (start) or the verdict (close).

```yaml
session:
  start: ./scripts/morning.sh "$CADENCE_SINCE"    # sh, at the repo root, 120 s at most
  close: ./scripts/evening.sh "$CADENCE_SINCE"
```

The commands get `CADENCE_SINCE` (the `--since` in effect) and `CADENCE_TODAY`. They
add facts and decide nothing: a failing command is reported and changes neither
the exit code nor the verdict.

## deliver

A delivery is done when its checks pass, not when a tool says "success".

```yaml
# cadence.yaml, at the repository root
deliver:
  ci: github              # github | none | { command: "…" }   (default: none)
  ciTimeout: 1800         # seconds
  deploy:                 # sh commands, in order, at the repo root
    - ./scripts/deploy.sh "$CADENCE_SHORT"
  verify:                 # at least one; retried every 10 s until verifyTimeout
    - url: https://app.example.com/api/health
      status: 200         # default 200
    - url: https://app.example.com/version.txt
      contains: "${SHORT}"
    - command: kubectl rollout status deploy/app --timeout=60s
  verifyTimeout: 300
  deployTimeout: 1800     # seconds, per deploy command
```

```sh
cadence deliver --dry-run    # preconditions, then the resolved steps; nothing runs
cadence deliver              # 0 delivered and verified · 1 a step failed · 2 refused before acting
```

- **Preconditions**: no modified tracked file; `HEAD` is on a remote branch (the
  CI can only build what was pushed); no other delivery running (a lock whose
  process died is removed with a warning); with `ci: github`, `gh` installed and
  logged in.
- Every command is killed when it exceeds its budget (CI, `deployTimeout`, what is
  left of `verifyTimeout`) and reported as "délai dépassé". Killed means the
  whole tree, followed while the command runs: every 200 ms cadence lists the
  command's descendants and remembers each process it has seen with its start
  time, so a process whose parent exits (re-parented to init — a background
  child of a script, `sh`'s fork for each command) stays known. To kill, cadence
  takes every remembered process still alive with the same start time (never a
  recycled pid) plus all its current descendants, stops each one first
  (`SIGSTOP`, the tree is re-read until nothing new appears), then kills them
  (`SIGKILL`). This happens on a delay overrun, and at once when cadence
  receives `SIGTERM`. On Ctrl-C or a hangup the tree has already received the
  signal from the terminal: cadence gives the whole followed set, not just the
  command, up to 2 seconds to finish (a script's `trap`, git removing its
  `index.lock`), carries on the moment none of it is alive, and kills what is
  left after the 2 seconds, a background child that ignores Ctrl-C included. If
  the command was never listed (process list unreadable from the start), the
  grace lasts as long as the command itself is alive, and what remains after
  2 seconds is killed through the same fallback (its group and itself).
  A delay overrun and `SIGTERM` give no grace: a script's own `trap` does not
  get to finish there. The lock is held until the followed set is empty: when
  cadence dies of the signal it dies after the tree, and its stale lock, which
  the next delivery removes, leaves nothing of the first delivery running.
  What can still outlive cadence and run concurrently with the next delivery:
  a process that leaves the tree before cadence first sees it (a daemon's
  double fork, `setsid`, `nohup … &` from a shell that exits, all within less
  than 200 ms), a process of another user that cadence may not signal (`sudo`),
  a background process still running when the command returns normally (it is
  neither waited for nor killed), and everything if cadence itself is killed
  with `SIGKILL` (`kill -9`, the OOM killer).
  Where the process list cannot be read (no `/proc` and `ps` failing), cadence
  falls back on the command's group and its root process: a descendant that left
  the group (`setsid`) is then not killed, since the command is deliberately
  kept in cadence's group. A list that fails for more than a second is no longer
  trusted (a followed pid may have been recycled): nothing is signalled from it.
  cadence says so once on stderr when the list is unavailable.
- Commands run in cadence's own process group and session, attached to the
  terminal: `ssh`, `sudo` or `pinentry` can prompt on `/dev/tty`, and Ctrl-C or
  closing the terminal stops the running command together with cadence (within
  the limits above).
- **CI** `github`: polls `gh run list --commit <sha>` every 15 s; no run after
  5 minutes is a failure (you probably pushed another commit than the one you
  deliver); every run must end `success`, `skipped` or `neutral`. `gh` errors
  are retried, and reported with their cause after 5 minutes.
- Commands get `CADENCE_SHA`, `CADENCE_SHORT` (7 characters) and `CADENCE_BRANCH`;
  `${SHA}` and `${SHORT}` are replaced in `url` and `contains`.
- On success the lots cited by the commits since the previous delivery are
  listed, so you can `raf done` those whose effect you have seen. With a
  read-only plan, only the lots that were in progress when the delivery started
  are listed: an id quoted in a message for context (a finished lot, a
  reservation number that looks like one) is not a delivered lot. Plan upkeep
  commits (see "Plan upkeep needs no lot") are skipped in that list: they cite
  lots without delivering anything.

### A project with its own delivery script

A project that already delivers with its own script (CI wait, deploy, business
checks) plugs it in instead of rewriting it as `ci` / `deploy` / `verify`:

```yaml
deliver:
  script: ./scripts/ship.sh "$CADENCE_SHORT"   # replaces ci and deploy
  allowDirty: true                             # optional: a modified tree is reported, not refused
  deployTimeout: 3600                          # seconds, for the whole script
  verify: []                                   # optional here: the script's own checks count
```

```sh
cadence deliver -- api frontend --news docs/changelog/x.md -- map    # everything after the first « -- » goes to the script
cadence deliver --dry-run -- api                                      # shows the full command, runs nothing
cadence deliver --sha 6b0d9aa -- api                                  # an earlier pushed commit instead of HEAD
```

`--sha` (any mode) delivers a pushed commit other than `HEAD` — for a CI that
builds each service only on the commit that touched it. `allowDirty` suits a
working tree shared by several sessions when the delivery starts from a pushed
sha and never from local files; without it a modified tree is refused.

cadence keeps what the script usually lacks: the preconditions (clean tree, pushed
`HEAD`), the lock (never two deliveries at once), the delivery log and the lots
delivered. Arguments are quoted for `sh`, so spaces and quotes reach the script
intact. If the script commits and pushes during the delivery (stamping a
changelog entry, say), the new `HEAD` is the sha recorded as delivered. Exit code
0 of the script means delivered; `verify` checks, if any, run after it.

### verify: replay the effect checks, outside a delivery

A green delivery says the effect was right *then*. `cadence verify` replays the
`deliver.verify` checks of `cadence.yaml` at any time — no CI, no deploy, no lock,
no journal entry, nothing written.

```sh
cadence verify                # one pass, one line per check, then a one-line summary
cadence verify --retry 60     # retry each failing check for up to 60 s (deliver's 300 s is not applied)
cadence verify --sha 6b0d9aa  # the sha that replaces ${SHA} / ${SHORT} (default: last delivery, else HEAD)
```

```
✓ GET https://ol.example/api/health → 200
✗ GET https://ol.example/api/lineup → 200, contient « "starters" » — « "starters" » absent de la réponse
verify : 1 effet rouge sur 2 vérifications
```

Exit code: **0** every check green · **1** at least one red effect · **2** nothing
to verify or invalid configuration.

Time limits differ from deliver's. `verify` runs all the checks **in parallel**,
each try with the whole 120 s limit (a `url` request gives up after 20 s; a slow
check is killed at its limit, "délai dépassé", and takes nothing from the others); results are printed in the order
of `cadence.yaml`. Retries repeat every 10 s (deliver's interval) up to `--retry`
seconds for each check on its own, so a run lasts at most `--retry` + 120 s.
deliver, by contrast, runs its checks one after the other, retries each until
`verifyTimeout` (300 s by default) is spent, and stops at the first check that
never turns green. The check code is deliver's own (`url` / `status` /
`contains` / `command`, same messages). A project with
a delivery script (`deliver.script`) and no `verify` declares no effect checks —
`verify` says so and exits 2 (its script's own checks stay its business); add
`deliver.verify` to replay some.

Each `command` check of `verify` (and of `session start`) runs in a process group
of its own, detached from the terminal (no `/dev/tty`: a check must not prompt).
At its time limit the whole group is killed, so no child survives it; Ctrl-C,
`SIGTERM` or a closed terminal is passed on to the running checks before cadence
exits. As the checks run together, the output of their commands may interleave;
the result lines come after it, in order.

Make `verify` count: a health endpoint stays green while the data is wrong (a
lineup served empty for 38 h behind a green `/api/health`). Add a check on the
content that matters, e.g. `url: …/api/lineup` with `contains: '"starters"'`.

`cadence session start` runs the same checks in parallel (one try each, command
output muted), each with a 10 s limit, so the whole step takes about 10 s at worst;
it is not deliver's `verifyTimeout`, and there is no retry. It adds an
**"Effets en production"** section to the morning report: a single `✓` line when
everything is green, the red effects and the summary otherwise. It is a fact like
the others: it never changes the exit code, and an unreachable network shows up
as red lines ("erreur réseau") without blocking the session. No section for a
project without `deliver.verify`.

## orchestrate

`cadence orchestrate` is a program above `/lead`, not a conversation: for each lot you choose, it runs
a **fresh** `claude -p` session per step with a short brief, reads the result, writes the state in
files and moves on. The lead session keeps only the decision (which lots), the final table and the
questions. Nothing is resumed: a correction is a new session, never the author's reopened. The one
exception is a **formatting retry** (below).

```sh
cadence orchestrate finance-tracker:L41 ol-companion:L22 cadence:L18@haiku
cadence orchestrate L18                      # from inside a project
cadence orchestrate … --budget 1.5M          # 1500000, 1.5M, 800k; default 2M
cadence orchestrate … --dry-run              # preconditions + the plan of the wave; nothing is started
cadence orchestrate --status [<wave>]        # the table, read back from the state (default: the last wave)
cadence orchestrate --resume [<wave>] [--budget 1M] [--answer ol-companion:L22 "reply"]
```

You choose the lots; the order is the order given (one queue per repository, two repositories at most
at the same time). `@haiku|@sonnet|@opus` sets the model of the implementation and corrections of that
lot (default Sonnet; reviews are always Opus; Haiku only when you write it, for a mechanical lot). Run it
in the background and read `--status`: it prints one line per transition and the final table.

**Cycle of a lot**: preconditions (clean tracked files, lot `todo` or `doing`, dependencies met) →
`raf start` (committed alone) → implementation → **UX review** if the lot is `visible` and the app is
declared → **code review**, which always comes last (a UX fix changes code) → compliant (no blocking, no
major finding) → `raf review` is recorded by the orchestrator with the sha the review read, then
"ready to deliver". Not compliant → a correction in a new session, then a new review, **two passes at
most**, then the lot goes back to you with the findings. A small lot (`estimate` ≤ 0.5 or `quickwin`)
gets one single Opus pass for code and usability. Failing tests (reported red, or red when
`orchestrate.test` is run) go straight to a correction.

**What stays with you**: choosing the lots, the questions raised (`--resume --answer`), re-verifying
after the wave (`git log`, tests, `raf check`), `raf done`, **`raf ux`** (the orchestrator reports the UX
verdict and screenshots, it does not record it), the push and the deliveries, one project at a time.

**Guards, imposed by the code**: at most two sessions, one per repository (a lock in the repository's
shared state, `orchestrate.lock`, which also makes `cadence deliver` refuse that repository) and one wave
per folder; `Agent`, `git push`, `cadence deliver`, `raf done|review|ux` are denied to the sessions; a
temporary `pre-push` hook, installed for the duration of the wave and removed at its end, refuses any push
from a session (`CADENCE_ORCHESTRATED` is in their environment; a repository that already has another
`pre-push` hook is refused before anything starts — `pushurl` is never touched); after every session the
upstream ref and `git ls-remote` are compared with the "before", and a review that changed `HEAD` or the
tree is an incident that stops the wave. `raf done|ux|review` and `cadence deliver` refuse when
`CADENCE_ORCHESTRATED` is set.

**Budget**: the wave counts input + cache writes + output tokens (default 2 M); cache reads are kept and
shown apart. When the budget (or the usage limit) is reached no new session starts, the running ones
finish, the wave is *suspended* (exit code 3) and `--resume --budget …` continues. A session that returns
nothing readable, times out (45 min for work, 25 for a review) or fails is not retried; the lot is handed
back with the cause. Exit codes: 0 every lot ready · 1 at least one lot handed back (question, failure,
review still not compliant after two passes) · 2 refused before acting · 3 wave suspended.

**Formatting retry** (the only `--resume` of a session): when a session ends successfully but in plain text,
without the `structured_output` the schema asks for (the verdict is there, not in the required shape), the
orchestrator resumes **that same session once** (`claude -p --resume <session-id> --json-schema <same schema>`,
same model, permission mode and denied tools) with a short prompt that only asks for the report in the required
format. It applies to every step that has a schema (implementation, correction, reviews). The tokens of the
retry count in the wave budget and in the step (`formatRetry: true`); if the output is still missing after it,
the step fails as usual — never a second retry.

State is in `.cadence/runs/<wave>/` of the folder where the command is run (added to `.git/info/exclude`
when that folder is in a repository): `wave.json`, one `<project>--<lot>.json` per lot (steps, tokens
kept apart, session ids, commits, verdicts), the JSON output of every session and a `journal.log`. After a
cut (Ctrl-C, WSL closed) `--resume` replays an interrupted step entirely in a new session whose brief
lists the commits already present; finished steps are never replayed.

Briefs are the templates of `templates/orchestrate/` (`implement.md` is the `lead` skill's standard
brief; `--dry-run` writes the rendered ones). A project can declare, in `cadence.yaml`:

```yaml
orchestrate:
  test: npm test                         # run by the orchestrator after a work step (optional)
  ux: http://localhost:4200              # a URL, a launch command, or { url, command } — for the UX review
  permissionMode: auto                   # default
  addDirs: [/home/me/projects/tmp]       # extra directories the sessions may use
  timeouts: { implement: 45, review: 25 }   # minutes
  # a plan kept by the project's own tool is read-only for raf: the orchestrator calls these instead
  start: python3 scripts/raf.py start {lot}
  verdict: python3 scripts/raf.py note {lot} "revue de code : {verdict}"
```

Without `start`, a read-only plan's `todo` lot is refused (start it with the project's tool); without
`verdict`, the review verdict stays in the wave's state and you report it. Only the plan's files
(`plan.path`, `plan.files`) are committed from those commands; anything else dirty stops the lot.

## Claude Code skills

As a plugin:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence@cadence
```

gives `/cadence:session-start`, `/cadence:session-close`, `/cadence:deliver`,
`/cadence:lead` and the `ux-reviewer`, `code-reviewer` and `qa-reviewer` agents. Or copy them into the
repository with `cadence skills install` (to `.claude/skills/cadence-*` and
`.claude/agents/cadence-*.md`; `--dir` for another `.claude` folder,
`--force` to overwrite local edits).

- **session-start**: reports the facts briefly, proposes three lots from the
  plan, then waits for your priority — nothing starts before your answer.
- **session-close**: plan hygiene, clean repository, memory limited to what the
  repository does not say, new skills or agents proposed but never created, three
  lines for next time.
- A project with its own tooling keeps it: its plan is read where it is (`plan:`),
  its delivery script is called by `cadence deliver` (`deliver.script`), its
  morning and evening scripts feed the session report (`session:`), and its own
  skills can become one-line aliases of `session-start` / `session-close`.
- **deliver**: dry run, delivery, and on failure the cause fixed rather than a
  blind retry; after a green delivery that changes what a page shows or what it
  is served, the `qa-reviewer` agent walks the delivered app.
- **lead**: from a folder holding several projects, one subagent per project
  gathers the facts, you choose the priorities, the lots are delegated with
  `cadence orchestrate` (fresh short sessions with a standard brief — test first,
  commits citing the lot, no push — reviewed by the `code-reviewer` agent, see
  [orchestrate](#orchestrate)), re-verified by the lead, then delivered
  one project at a time; a delivery that changes what a page shows or what it is
  served is then checked in the running app by the `qa-reviewer` agent, whose
  blocking findings come back to you. Two
  subagents at most, never two in the same repository.
- **ux-reviewer** (agent): captures at 1440 and 390 px, findings grounded in a
  named rule (Nielsen, WCAG 2.2 AA) or a measurement, ranked, turned into
  `raf add --parent` sub-tasks, and a one-line verdict for `raf ux`. It never
  edits code.
- **code-reviewer** (agent): any stack; given a repository and a lot id, it reads
  the diff itself from the commits that cite the lot — not the author's summary —
  and the project's CLAUDE.md, when there is one, for its conventions; findings grounded in a
  measurement (a failing command, changed code without a test, a duplicated
  block, dead code) or a named rule, each with `file:line` and a concrete
  scenario; real defects only, ranked, what it could not verify, and a one-line
  verdict for `raf review`. It takes the lot's commits from `raf commits`, never
  runs a build whose output is used live, and never edits code.
- **qa-reviewer** (agent): any web app; given a repository and a base URL (and
  optionally a lot id, to start with the pages it touched — for a backend-only
  lot, those that call the changed endpoints), it opens each page of
  the project's expectations file in a real browser at 1440 and 390 px and
  measures: expected content present and non-empty, no error or missing-data
  message, every API call answered 2xx with a non-empty body, no console error,
  no broken content image. Findings are defects (a line of the expectations
  broken, or a universal check failing with a visible effect, with or without an
  expectations file), suspects (it looks like missing or wrong data and no
  expectation settles it) or noise (a console error or a failed request with no
  visible effect, ranked minor), ranked, each with
  the route, what was expected, what was measured and the evidence; pages checked
  N/N, follow-ups as `raf add` lines, what it could not verify, a one-line
  verdict. Read-only: GET only, no login, nothing submitted; it stops at a PIN.

## Releasing

A version exists in three places and is published in two; a release does all of it, in this order:

1. Bump `version` in `package.json` (then `npm install` to refresh `package-lock.json`),
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, in the commit that closes the lot.
2. `git tag v<version> && git push origin main v<version>` — the tag starts `.github/workflows/publish.yml`,
   which publishes to npm through Trusted Publishing (OIDC, no token stored anywhere): it checks the tag
   matches `package.json`, then `npm publish --provenance`, where `prepublishOnly` runs the type-check and the
   tests and `prepare` builds `dist/`; a red suite stops the publication. The trusted publisher is declared
   once on npmjs.com (package settings → Trusted Publisher → GitHub Actions, `Sylad/cadence`, `publish.yml`).
3. Watch the run: `gh run watch` (or `gh run list --workflow publish.yml`).
4. Check the effect: `npm view @sylad/cadence version` answers the new version.

The Claude Code plugin is read from the repository, so pushing `main` is what updates it; npm is what
`npx @sylad/cadence` and a global install read, and only the tag publishes there. A missing tag, or a red
publish run, leaves npm behind without any other error — 0.3.0 and 0.4.0 were never published — hence
step 4.

## License

MIT
