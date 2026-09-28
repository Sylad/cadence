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
several projects through subagents — plus a `ux-reviewer` agent: no user-facing
change is done before its usability review.

## raf

- The plan is a YAML file in the repo (`docs/plan/raf.yaml`), edited by the CLI.
  Your comments and hand edits are preserved.
- A commit belongs to a lot when its message cites the id: `feat(L3): …`,
  `fix: L3/t1 …`. The link is **computed from `git log`**, never stored, so
  committing never dirties the plan.
- `raf check` audits drift between the plan and the history.
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
| `raf now` | what to do next |
| `raf list [--status s]` | flat list |
| `raf check [--since date] [--idle 7]` | since the plan's adoption date by default: commits without a lot (commits touching only the plan are exempt), unknown ids, `todo` lots that already have commits, idle lots, `done` lots with open sub-tasks, bad or circular dependencies |
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
ignore: ['^chore\(batch\):']   # optional: subjects of automated commits, never audited
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
lots: [L8]
captures: [captures/l8.png]
# nocapture: reason, when a screenshot makes no sense
---
Imported statements now read **3.000** as three thousand, not three.
```

| Command | Effect |
|---|---|
| `cadence news new <lot…> [--title t]` | entry skeleton, dated today, titled after the lot |
| `cadence news list` | entries, newest first |
| `cadence news check` | visible lots done without entry, unknown lots, missing or undeclared screenshots, bad headers |
| `cadence news build [-o dir]` | `nouveautes.json` + `index.html` + screenshots (default `docs/nouveautes/site`) |

`--dir` changes the entries folder (default `docs/nouveautes` at the git root).
The Markdown is deliberately small: paragraphs, `-` lists, `**bold**`,
`` `code` ``, `[links](url)`; everything else is escaped text. The JSON holds
`{ project, generated, entries: [{ slug, title, date, lots, captures, html }] }`,
with screenshot paths relative to the JSON file.

### UX review

```sh
raf ux enable                      # from today, a --visible lot needs a UX review before done
raf ux L4 "compliant after 2 fixes"   # record the verdict (from the ux-reviewer agent)
raf ux L8 "no screen: calculation fix"
```

With the rule on, `raf done` refuses a visible lot without a review (`--force`
to override) and `raf check` reports visible lots finished after the `uxSince`
day without one. Plans without `uxSince` are not affected.

## session

```sh
cadence session start              # notes from the last close, lots in progress (silent ones flagged),
                                   # work done since yesterday by lot, drift, repo state, 3 proposals
cadence session start --since "3 days ago" --idle 2
cadence session close              # today's commits by lot, commits without a lot, lots in progress
                                   # with no commit today, drift, uncommitted / unpushed work
                                   # exit 1 while something is still open
cadence session next "finish L3" "review L4"    # shown by the next session start
```

Proposals come from the plan only: lots in progress, then ready lots (dependencies
done), quick wins first. Local state lives in the git directory, never committed:
the close notes per worktree, the delivery lock and log in `.git/cadence/`, shared
by all the worktrees of a clone.

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
  left of `verifyTimeout`) and reported as "délai dépassé".
- **CI** `github`: polls `gh run list --commit <sha>` every 15 s; no run after
  5 minutes is a failure (you probably pushed another commit than the one you
  deliver); every run must end `success`, `skipped` or `neutral`. `gh` errors
  are retried, and reported with their cause after 5 minutes.
- Commands get `CADENCE_SHA`, `CADENCE_SHORT` (7 characters) and `CADENCE_BRANCH`;
  `${SHA}` and `${SHORT}` are replaced in `url` and `contains`.
- On success the lots cited by the commits since the previous delivery are
  listed, so you can `raf done` those whose effect you have seen.

## Claude Code skills

As a plugin:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence@cadence
```

gives `/cadence:session-start`, `/cadence:session-close`, `/cadence:deliver`,
`/cadence:lead` and the `ux-reviewer` agent. Or copy them into the repository with
`cadence skills install` (to `.claude/skills/cadence-*` and
`.claude/agents/cadence-ux-reviewer.md`; `--dir` for another `.claude` folder,
`--force` to overwrite local edits).

- **session-start**: reports the facts briefly, proposes three lots from the
  plan, then waits for your priority — nothing starts before your answer.
- **session-close**: plan hygiene, clean repository, memory limited to what the
  repository does not say, new skills or agents proposed but never created, three
  lines for next time.
- **deliver**: dry run, delivery, and on failure the cause fixed rather than a
  blind retry.
- **lead**: from a folder holding several projects, one subagent per project
  gathers the facts, you choose the priorities, each lot is delegated to a
  subagent with a standard brief (test first, commits citing the lot, no push),
  reviewed, re-verified by the lead, then delivered one project at a time. Two
  subagents at most, never two in the same repository.
- **ux-reviewer** (agent): captures at 1440 and 390 px, findings grounded in a
  named rule (Nielsen, WCAG 2.2 AA) or a measurement, ranked, turned into
  `raf add --parent` sub-tasks, and a one-line verdict for `raf ux`. It never
  edits code.

## License

MIT
