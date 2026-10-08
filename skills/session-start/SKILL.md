---
name: session-start
description: Start a work session on a repository that uses cadence — gather the facts (open lots, work done since last time, drift between plan and history, delivery in progress, notes left at the last close), report them briefly, propose three lots from the plan, then WAIT for the human's priority. Triggers — "/session-start", "let's resume", "where are we?", "on reprend", start of the day.
---

# Session start — resume without reciting

The repository already carries the state: the plan (`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`), the history, the notes left at
the last close. The only thing missing is the human's priority for today. This skill gathers the facts,
proposes, and stops.

## Where to run

Every `cadence` / `raf` command works on the git repository of the current directory. When the
session runs from a parent folder that holds several projects (not itself a repository), run
`cadence session start --all` there (`--depth 2` for projects one folder deeper): one "## project"
section per sub-folder that contains `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key.
Other commands (`raf …`, `cadence deliver`) still run inside the project concerned: `cd <project> && cadence …`.

With no project named, run `cadence session start --all` from the parent folder (or `cadence session start` in **each** project that has a plan) and report
one or two lines per project (in progress, drift, notes left at the last close), then propose the
three most useful items across projects and wait. With a project named, work in that one only.

## Steps

1. Run `cadence session start` (after a weekend: `--since "3 days ago"`). If `cadence` is not on the
   PATH, use `npx -p @sylad/cadence cadence session start`.
2. Report **briefly**, in the human's language, in this order — never paste the raw output:
   - **In progress**: each `doing` lot; for a *silent* one, say whether it looks like a forgotten
     `raf done` / `raf note` (commits exist, work looks finished) or a real stop.
   - **Done since**: 3 to 6 lines, grouped by lot, not by commit. Mention commits without a lot.
   - **Drift**: each `✗` line from the check, with the one command that fixes it.
   - **Delivery in progress** or a stale lock: no new delivery until it is resolved.
   - **Effects in production** ("Effets en production"): a red `✗` line is the first thing to say —
     a delivered feature that no longer works outranks any new lot; re-run `cadence verify` to confirm
     (a network blip also shows as red).
   - **Notes from the last close**, if any.
   - **Project facts** ("Faits propres au projet"), when the project plugs its own morning script in
     (`session.start` in `cadence.yaml`): summarise what bears on today's choice — deadlines, the
     project's own planning, documentation drift — and leave the rest.
3. **The plan drives the work.** Propose exactly three items, each with its id and one sentence of
   justification, in the order the command gives them: finish what is in progress, then ready quick
   wins, then the next ready lots. An idea that is not in the plan is only proposed together with the
   `raf add "…"` that would put it there.
4. **Stop and wait** for the priority. Start nothing and commit nothing before the answer — the only
   exception is a `raf note <id> "…"` on a silent lot whose cause is already known.

A plan kept by the project's own tool (`cadence.yaml` maps its fields) is **read-only** for `raf`:
report from it as usual, but give the project's own command for every fix or start — `raf start`,
`raf done` and `raf note` refuse.

## After the answer

`raf start <id>` on the chosen lot, then the project's usual development workflow. Every commit cites
the lot id (`feat(L3): …`) so that the history links itself to the plan.

## A project with its own tooling

When the plan is read-only (held by the project's own tool, `plan:` with a field mapping in
`cadence.yaml`), every plan change — start, note, done — goes through that tool, not `raf`; the
project's instructions say which command. Its expert agents and its own skills stay in use.

## Do not

- Decide for the human: close a lot, drop one, create an agent or a skill.
- Re-read the whole plan or recite project instructions: they are already loaded.
