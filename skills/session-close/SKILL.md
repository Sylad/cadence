---
name: session-close
description: Close a work session on a repository that uses cadence — plan hygiene (lots in progress, commits without a lot, news entries), repository state (uncommitted, unpushed, delivery running), filtered memory, proposals for new skills or agents without creating them, and three lines for next time. Triggers — "/session-close", "let's stop for today", "on ferme", end of the day.
---

# Session close — close without memorising everything

## Where to run

Every `cadence` / `raf` command works on the git repository of the current directory. When the
session runs from a parent folder that holds several projects (not itself a repository), run
`cadence session close --all` there (`--depth 2` for projects one folder deeper): one "## project"
section per sub-folder that contains `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key.
Other commands (`raf …`, `cadence deliver`) still run inside the project concerned: `cd <project> && cadence …`.

With no project named, run `cadence session close --all` from the parent folder, or `cadence session close` in each project touched during the session
(`git log --since` or `git status` tell which), and close each one.

## Steps

1. Run `cadence session close` (the window runs from the last `session start`, even when the close is re-run, and is named in the "Commits de la période" title; over several days: `--since "2 days ago"`). Exit code 1 means
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
   wildcard `rm`, never a file `git` tracks). The agreement can be old by then: right before
   deleting, re-run `cadence session close` (or the scan) and delete only the entries that are
   still proposed, never one the human named from memory. Delete a proposed symbolic link as a
   link (`rm path`, no trailing `/`, never `rm -r` through it). Before proposing a screenshot, check nothing still
   refers to it (plan, news, docs). Anything kept: leave it, it will be listed again next close. No
   section: nothing to do; a project with no `session.clean` can propose adding it.
   An entry is proposed only if it could be measured entirely. Age: a folder's age is that of the
   most recent entry it contains, an entry's age counting from the later of its modification and status-change times. The report never proposes: a git repository, a folder that
   contains one at any depth, and anything under a `.git` folder; a git directory without a `.git`
   entry (bare repository, mirror, `--separate-git-dir`, worktree admin folder — recognised by
   `HEAD` with `objects` and `refs`, or with `commondir`), anything inside it or a folder that
   contains one; anything `git` tracks, in any repository that has a `.git` entry above it (one limit: a bare repository driven with an external work tree, `git --git-dir=~/.dotfiles --work-tree=~`, leaves no `.git` beside its files — their tracked files can be proposed, so check a proposed entry is not one); a name starting with `.`
   unless the pattern itself starts that name with `.`; anything behind a symbolic link a `*`
   matched (the link itself may be proposed: remove the link, never `rm -r` through it — a segment
   written in full before the first `*` does follow its link); the repository itself or a folder that contains it;
   anything that could not be read entirely — those are listed apart as "illisible(s)": tell the
   human, never delete those, and never widen the list by hand to entries the report did not
   propose.
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
7. **Three lines for next time**: `cadence session next "…" "…" "…"` — the next `session-start` shows them. The command prints the lines as recorded: report them from that output, do not run `session start` again.
   The lines replace the previous notes. Without a line the command refuses and keeps them; erase
   them on purpose with `cadence session next --clear`, only when nothing is left to say.

## Do not

- Write a recap of the day into memory: the plan, `raf now` and `git log` are the record.
- Close, drop or re-scope a lot the human has not agreed to.
