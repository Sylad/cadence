---
name: lead
description: Lead several cadence projects from a parent folder without loading them into the main context — take the facts of every project with `cadence lead tour`, agree the priorities with the human, delegate each chosen lot to a subagent with a standard brief, have the work reviewed, re-verify it yourself, then deliver one project at a time. Triggers — "/lead", "pilot all projects", "on pilote tout", "délègue aux sous-agents", start of a multi-project day.
---

# Lead — decide at the top, work in subagents

The lead session stays small: it reads summaries, decides with the human, delegates, checks and
delivers. Project files are changed by subagents, each with its own context; the facts of the tour come from `cadence lead tour`, a program. The projects
are the sub-folders of the current directory that contain `docs/plan/raf.yaml`, or a `cadence.yaml`
with a `plan:` key. A project whose `cadence.yaml` maps the fields of a plan kept by its own tool is
**read-only** for `raf`: it takes part in the tour, and its plan is changed with the project's own
commands (its CLAUDE.md names them), never with `raf start|done|note|ux|review`.

## Limits that always apply

- **At most two subagents running at once.** Queue the rest. The sessions of an orchestrated wave
  (section 2b) count toward this limit: orchestrate sessions plus subagents never exceed two. A wave
  already caps itself (`--max-sessions`, 2 by default, shared by every wave); before starting a
  subagent, check `cadence orchestrate --status`, and while a wave runs, start none beyond the free
  slots. Read the free slots, do not compute them: `cadence orchestrate --status` and `cadence lead tour` print
  `créneaux libres : N sur 2` (the registry subtracts, for each live wave, min(cap, repositories it still holds)
  from the two slots; no line from `lead tour` means no live wave, so both are free). Never raise `--max-sessions` above two to speed a wave up.
- **Never two subagents in the same repository at the same time**, and the lead does not commit in a
  repository where a subagent is working.
- **Deliveries and `raf ux` / `raf review` verdicts are done by the lead, one project at a time** —
  never by a subagent, never two deliveries in parallel.
- A subagent cannot ask the human anything. When it hits an ambiguity it stops and reports; the lead
  brings the question to the human.

## 1. Tour of the projects

Run `cadence lead tour` from the parent folder (one command, no subagent, no model: it reads the same
facts as `cadence session start` for every project). It prints one line per project — lots in progress
(`silencieux Nj` when idle for more than three days), drift, notes from the last close, the next ready lot,
repository state — and exits 0 even when a project is in error (its line says so). `--json` gives the same
content. Read the lines yourself; open a project's own `cadence session start` only for the one you need to
look at closer.

Then report to the human in a compact table — one row per project — and propose **three** items
across projects, each with project, lot id and one sentence of justification: finish what is in
progress, then drift that blocks a delivery, then ready quick wins. **Stop and wait for the priority.**

## 2. Delegation

The default way to delegate is **`cadence orchestrate`** (section 2b): a program, not a conversation, that runs
one fresh short session per step; the wave runs from a frozen copy of the cadence package, so it can orchestrate cadence itself and its templates can be edited meanwhile. When the lead delegates by hand, the brief is the template
`templates/orchestrate/implement.md` of the cadence package — the single source, tested. The lead runs
`cd <project> && raf start <lot>`, then starts from the brief written by `cadence orchestrate --dry-run
<project>:<lot>`: it is already rendered (`{{chemin}}`, `{{lot}}`, `{{titre}}`, `{{objectif}}` and `{{news}}`,
the News instruction of a `visible` lot, are filled in; it names no wave Playwright directory — a hand delegation has none — so the screenshot goes under the OS temp directory, then into `docs/nouveautes/captures/`). The lead only adjusts the goal to what done looks
like (the human's words) and keeps the rest verbatim.

A lot that adds or changes a screen is `visible`: after the implementation, have the
`ux-reviewer` agent review it (give it the URL or the way to run the app) and bring its verdict and
proposed sub-tasks back to the human.

### 2b. A wave through `cadence orchestrate`

Once the human has chosen the lots, the lead runs, **in the background** (it is notified at the end; no
silent wait, no polling loop — `cadence orchestrate --status` shows where the wave is, and the follow-up below pushes each transition):

```sh
cadence orchestrate <project>:<lot> <project>:<lot>@haiku … --wave <id> [--budget 2M]
```

**Make the wave visible to the human.** Name the background task after what it runs — « vague `<id>` :
`<project>:<lot>`, … » (its `description`), so the task list says which projects and lots, not just « a task
is running » — and pass `--wave <id>` (e.g. `2026-10-08-1030`) so its state folder is known in advance. Right after
starting it, arm **one follow-up** (the Monitor tool) on the wave's journal, which holds one line per transition (lot → new
state, question, ready, handed back). The final table is not in the journal: it arrives with the background task's end notification, at which point stop the follow-up (it never ends by itself; a later `--resume` writes to the same journal):

```sh
tail -n +1 -F .cadence/runs/<id>/journal.log     # from the folder the wave was launched in
```

Each line it prints reaches this conversation as it happens: relay it to the human in one short sentence, and
bring a question back at once (`--resume --answer`). That follow-up replaces any waiting loop: still no polling,
no `sleep`. The human can also watch from a terminal with `cadence orchestrate --status --watch` (table refreshed
every 10 s, `--interval <s>` to change it; it stops by itself when no wave is running).

`cadence orchestrate --dry-run …` first when a precondition is in doubt. The program, not the lead, runs
for each lot a fresh short session per step — implementation (Sonnet), UX review if the lot is `visible`
and the project declares how to see its app (`orchestrate.ux` in `cadence.yaml`), code review last
(Opus, the `code-reviewer` agent; Sonnet, with no pass on the minor findings, for a lot whose estimate is
≤ 0.25 d — `orchestrate.review` in `cadence.yaml`; a blocker or major finding still brings a correction and an
Opus review), a correction in a new session if the review is not compliant (two
passes at most) — and records `raf review` itself when the code review is compliant. The state is in
`.cadence/runs/<wave>/`, not in this conversation. `@haiku` only when the human writes it, for a
mechanical lot. Exit code: 0 all ready · 1 some lots handed back · 2 refused before acting · 3 wave
suspended (budget or usage limit; `--resume --budget …` continues).

What the orchestrator does **not** do, and stays with the lead: choose the lots (with the human), bring the
questions back (`--resume --answer <project>:<lot> "…"`), look at the UX reviewer's captures and record
`raf ux` (the orchestrator reports its verdict, it never records it), re-verify (section 3, point 2),
`raf done`, push and deliver. Minor findings and proposed sub-tasks come back in the table: adding them to
the plan is the lead's decision. A minor finding becomes a lot of its own only if it describes an observable bug (a wrong output, a crash, a measured regression); otherwise it stays a note of the originating lot, so that a review never feeds the next one. If an orchestrated wave is running in a repository, do not commit there
and do not deliver it (`cadence deliver` refuses).

### 2c. Chaining without the human

Once the human has given the **first choice and the order** (the lots, and the priority: `--priority` or the
`priority:` list of the parent folder's `cadence.yaml`), the lead does not come back to ask « next? ». For each lot a
wave hands back **ready**, it chains, in this order, one project at a time: re-verify it yourself (section 3, point 2),
`raf done` (a read-only plan: the project's own command), push, deliver (section 4), the `qa-reviewer` check that
section asks for; then it starts the next wave, in the declared priority — `cadence orchestrate --continue --priority …` draws the next ready lot
of the plan itself (section 2b), and the limits of section « Limits that always apply » still hold. A lot that was not
handed back ready (refused, review not compliant after the correction passes, red delivery, blocking QA finding) is
not chained over: it is reported, and the chain goes on with the lots that do not depend on it.

**The threshold.** Before every new wave, read the context of the lead session with `cadence session context` (run it
from any folder): it prints `ctx 42 % (84k/200k)`, the figure the `ctx` segment of the `cadence-hud` band shows, which the
band publishes to a file because it is only a rendering the model cannot see. If the command fails (no figure, or one
older than two minutes — the band is not loaded), treat it as **at the threshold**: you cannot prove you are under it.
From **60 %** upward, start nothing: at the threshold the lead runs `session-close` in each project touched, writes its
memory (filtered, as `session-close` says), and records three lines for next time with `cadence session next` — the wave
that was about to start comes first among them. Under it, chain. The lead says in one sentence which side of the threshold
it is on each time it chains or stops; it never waits for the figure to move (never a polling loop).

**What stays with the human**: the first choice and the order; the questions a session raised (the lead brings them
back at once and does not answer in the human's place); the UX reservations (`raf ux` is recorded on the human's
verdict, a UX reviewer's captures are looked at by the human). While a question or a UX reservation is pending on a
lot, the chain goes on with the other lots and does not wait for it. A delivery that needs the human's confirmation
(their standing instructions, section 4) is a stop of the chain, not a bypass.

## 3. Check

0. After an orchestrated wave the review is already done, by a fresh session: read the table, then go to
   point 2. For a lot delegated by hand:
1. The `code-reviewer` agent, as a fresh subagent (most capable model), reviews the lot. Give it
   the absolute path of the project and the lot id, **not** the author's report: it reads the diff
   itself from the commits that cite the lot, runs the checks, and returns real defects only,
   ranked, with what it could not verify and a one-line verdict.
2. **The lead re-verifies itself**: `git log` shows the commits, the test suite and build pass when
   run by the lead, `raf check` is clean. A subagent is green on what it *could* test; say plainly
   what nobody could verify.
3. Fix or re-delegate what the review found; then record the verdict, `raf review <lot> "…"` with
   the code reviewer's last line brought up to date (and `raf ux <lot> "…"` for a visible lot, with
   the UX reviewer's), then `raf done <lot>`. Where the gate is on (`raf review enable`, the
   human's decision for each repository), `raf done` refuses a lot that has commits and no
   verdict, or a verdict older than its latest commit: a fix made after the review means a new
   review of the lot, not an edited verdict. A read-only plan has no gate in `raf` (a `uxSince` or `reviewSince` written in it is
   ignored): the verdict goes into the project's own tool.

## 4. Delivery

One project at a time, by the lead: push, then the `deliver` skill (`cadence deliver --dry-run`, then
`cadence deliver`). Follow the human's standing instructions about confirmation before production.

After a green delivery that changes what a page shows or what it is served (screen, API, data
source, configuration of either) — in practice every delivery except docs-, plan- or tests-only ones
— have the `qa-reviewer` agent check the delivered app, as a fresh subagent: give it the absolute
path of the project, the base URL of the delivered app and the lot id. The lot need not be
`visible`: a backend-only lot can empty a page without changing a screen. When the lot touched only
the backend, the agent starts with the pages that call the changed endpoints. It walks the pages in
a real browser against the project's expectations (`docs/qa/expectations.md`: per page, what the
user must find there) and returns measured findings; it reads only, and never logs in. Bring its
blocking findings back to the human — a page whose main content is missing, or that shows an error,
is a defect even when the delivery checks are green — with its proposed follow-up lines. A project
without an expectations file gets a draft back: show it to the human, who corrects it and decides
whether it is committed. It is not a gate: `raf done` does not wait for it, and a finding becomes a
new lot, not a reopened one.

## 5. Close

At the end, the `session-close` routine in each project touched, and `cadence session next` lines in
each. Give the human one line per project: delivered, in progress, blocked (and why).
