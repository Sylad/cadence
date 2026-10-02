---
name: lead
description: Lead several cadence projects from a parent folder without loading them into the main context — fan out one subagent per project to gather the facts, agree the priorities with the human, delegate each chosen lot to a subagent with a standard brief, have the work reviewed, re-verify it yourself, then deliver one project at a time. Triggers — "/lead", "pilot all projects", "on pilote tout", "délègue aux sous-agents", start of a multi-project day.
---

# Lead — decide at the top, work in subagents

The lead session stays small: it reads summaries, decides with the human, delegates, checks and
delivers. Project files are read and changed by subagents, each with its own context. The projects
are the sub-folders of the current directory that contain `docs/plan/raf.yaml`, or a `cadence.yaml`
with a `plan:` key. A project whose `cadence.yaml` maps the fields of a plan kept by its own tool is
**read-only** for `raf`: it takes part in the tour, and its plan is changed with the project's own
commands (its CLAUDE.md names them), never with `raf start|done|note`.

## Limits that always apply

- **At most two subagents running at once.** Queue the rest.
- **Never two subagents in the same repository at the same time**, and the lead does not commit in a
  repository where a subagent is working.
- **Deliveries and `raf ux` verdicts are done by the lead, one project at a time** — never by a
  subagent, never two deliveries in parallel.
- A subagent cannot ask the human anything. When it hits an ambiguity it stops and reports; the lead
  brings the question to the human.

## 1. Tour of the projects

For each project, a subagent (read-only) runs `cd <project> && cadence session start` and returns at
most five lines: lots in progress (silent ones flagged), drift, notes from the last close, the next
ready lot. Two at a time, in the background.

Then report to the human in a compact table — one row per project — and propose **three** items
across projects, each with project, lot id and one sentence of justification: finish what is in
progress, then drift that blocks a delivery, then ready quick wins. **Stop and wait for the priority.**

## 2. Delegation

For each chosen lot, the lead runs `cd <project> && raf start <lot>`, then gives a subagent this brief
(fill in the brackets, keep the rest verbatim):

> Work in `<absolute path of the project>` on lot `<id>` — "<title>" — of its plan
> (`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`; read the lot, its notes and sub-tasks, and the project's CLAUDE.md first).
> Goal: <what done looks like, from the human's words>.
> Rules: test first; commit each sub-part as soon as its tests pass, with explicit paths (never
> `git add -A` or `commit -a`), and a message that cites the lot (`feat(<id>): …`); run the project's
> full test suite and build before reporting; do not push, deliver, run `raf done` or `raf ux`.
> If something is ambiguous or needs a decision, stop and report the question instead of guessing.
> Report: commits (sha + subject), tests and build results with their numbers, what you could not
> verify, open questions.

A lot that adds or changes a screen is `visible`: after the implementation, have the
`ux-reviewer` agent review it (give it the URL or the way to run the app) and bring its verdict and
proposed sub-tasks back to the human.

## 3. Check

1. A fresh reviewer subagent (most capable model) reviews the lot's commits against its goal and
   reports real defects only.
2. **The lead re-verifies itself**: `git log` shows the commits, the test suite and build pass when
   run by the lead, `raf check` is clean. A subagent is green on what it *could* test; say plainly
   what nobody could verify.
3. Fix or re-delegate what the review found; then `raf done <lot>` (and `raf ux <lot> "…"` for a
   visible lot, with the reviewer's verdict).

## 4. Delivery

One project at a time, by the lead: push, then the `deliver` skill (`cadence deliver --dry-run`, then
`cadence deliver`). Follow the human's standing instructions about confirmation before production.

## 5. Close

At the end, the `session-close` routine in each project touched, and `cadence session next` lines in
each. Give the human one line per project: delivered, in progress, blocked (and why).
