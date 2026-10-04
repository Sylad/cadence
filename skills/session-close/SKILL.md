---
name: session-close
description: Close a work session on a repository that uses cadence — plan hygiene (lots in progress, commits without a lot, news entries), repository state (uncommitted, unpushed, delivery running), filtered memory, proposals for new skills or agents without creating them, and three lines for next time. Triggers — "/session-close", "let's stop for today", "on ferme", end of the day.
---

# Session close — close without memorising everything

## Where to run

Every `cadence` / `raf` command works on the git repository of the current directory. When the
session runs from a parent folder that holds several projects (not itself a repository), run each
command inside the project concerned: `cd <project> && cadence …`. The projects are the sub-folders
that contain `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key.

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
   - a plan commit reported because it also touches a file generated from the plan (a published
     plan) → propose to declare that file under `plan.files` in `cadence.yaml`; the files of a commit
     decide whether it is plan upkeep, never its subject;
   - a finished lot marked `visible` without a news entry → `cadence news new <id>`, written for the
     user, with a screenshot;
   - a lot that `raf done` refuses, or that the check reports as finished, for lack of a review —
     code review of a lot with commits, or one older than the lot's latest commit
     (`raf review enable`), UX review of a visible lot (`raf ux enable`) → have the `code-reviewer` / `ux-reviewer` agent review it, then record its
     verdict with `raf review <id> "…"` / `raf ux <id> "…"`; never write a verdict nobody gave;
   - rerun until the check part is clean.
3. **Stale working files** (report section "Nettoyage proposé", from `session.clean` in `cadence.yaml`):
   list them to the human — shared tmp folder, screenshots no one refers to, throwaway scripts,
   folders left by tests — and delete them only after the human agrees, with explicit paths (never a
   wildcard `rm`, never a file `git` tracks). Before proposing a screenshot, check nothing still
   refers to it (plan, news, docs). Anything kept: leave it, it will be listed again next close. No
   section: nothing to do; a project with no `session.clean` can propose adding it.
4. **Memory, filtered** (only if you keep a persistent memory): write down what the repository does
   NOT already say — a trap and its cause, a decision or correction from the human, a collaboration
   rule. Test: "do `git log` or the docs already say it?" → then no memory.
5. **Skills and agents, on threshold, PROPOSED**: a skill when the same chain of commands was done by
   hand at least twice today; an agent update when an agent got something wrong or its domain moved.
   List them with the benefit; the human decides. Never create them here.
   When the report has a "Faits propres au projet" section (`session.close` in `cadence.yaml`), treat
   what it flags as part of this hygiene; with a read-only plan, use the project's own tool wherever
   these steps say `raf`.
6. **Clean state**: everything committed and pushed, no delivery running. If the command still exits 1,
   say what remains and do NOT say the session is closed.
7. **Three lines for next time**: `cadence session next "…" "…" "…"` — the next `session-start` shows them.
   The lines replace the previous notes. Without a line the command refuses and keeps them; erase
   them on purpose with `cadence session next --clear`, only when nothing is left to say.

## Do not

- Write a recap of the day into memory: the plan, `raf now` and `git log` are the record.
- Close, drop or re-scope a lot the human has not agreed to.
