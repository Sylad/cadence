---
name: session-close
description: Close a work session on a repository that uses cadence — plan hygiene (lots in progress, commits without a lot, news entries), repository state (uncommitted, unpushed, delivery running), filtered memory, proposals for new skills or agents without creating them, and three lines for next time. Triggers — "/session-close", "let's stop for today", "on ferme", end of the day.
---

# Session close — close without memorising everything

## Where to run

Every `cadence` / `raf` command works on the git repository of the current directory. When the
session runs from a parent folder that holds several projects (not itself a repository), run each
command inside the project concerned: `cd <project> && cadence …`. The projects are the sub-folders
that contain `docs/plan/raf.yaml`.

With no project named, run `cadence session close` in each project touched during the session
(`git log --since` or `git status` tell which) and close each one.

## Steps

1. Run `cadence session close` (over several days: `--since "2 days ago"`). Exit code 1 means
   *not closed*: something below is still open.
2. **Plan hygiene**, lot by lot:
   - a `doing` lot with no commit in the period → `raf done <id>` if its tests are green,
     otherwise `raf note <id> "where it stands, what blocks"`;
   - a commit without a lot that belongs to one → `raf note <id> "commits: <sha> …"`; nothing if it
     is genuinely outside the plan (docs, chores);
   - a finished lot marked `visible` without a news entry → `cadence news new <id>`, written for the
     user, with a screenshot;
   - rerun until the check part is clean.
3. **Memory, filtered** (only if you keep a persistent memory): write down what the repository does
   NOT already say — a trap and its cause, a decision or correction from the human, a collaboration
   rule. Test: "do `git log` or the docs already say it?" → then no memory.
4. **Skills and agents, on threshold, PROPOSED**: a skill when the same chain of commands was done by
   hand at least twice today; an agent update when an agent got something wrong or its domain moved.
   List them with the benefit; the human decides. Never create them here.
5. **Clean state**: everything committed and pushed, no delivery running. If the command still exits 1,
   say what remains and do NOT say the session is closed.
6. **Three lines for next time**: `cadence session next "…" "…" "…"` — the next `session-start` shows them.

## Do not

- Write a recap of the day into memory: the plan, `raf now` and `git log` are the record.
- Close, drop or re-scope a lot the human has not agreed to.
