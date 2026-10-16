[← cadence](../README.md)

# session

```sh
cadence session start              # notes from the last close, lots in progress (silent ones flagged),
                                   # work done since yesterday by lot, drift, repo state, 3 proposals
cadence session start --since "3 days ago" --idle 2
cadence session close              # commits by lot since the last `session start`,
                                   # commits without a lot, lots in progress with no commit in that window,
                                   # drift, uncommitted / unpushed work; exit 1 while something is still open
cadence session close --since "2 days ago"   # --since overrides the window
cadence session start --all        # from a folder that is not a repository: one "## project" section per
cadence session close --all --depth 2   # sub-folder holding a plan (--depth n: n levels down, 1 by default);
                                   # exit = the worst code of the projects (2 error, 1 open, 0 closed)
cadence session next "finish L3" "review L4"    # shown by the next session start; replaces the previous notes
cadence session next --clear       # erase those notes, on purpose
cadence session context            # `ctx 42 % (84000/200000)`: the context of YOUR session, as the cadence-hud band publishes
                                   # it: the one named by $CLAUDE_CODE_SESSION_ID (set in Claude Code's Bash); --session <id>
                                   # overrides it; with no variable, the folder decides only if a single session publishes for it
                                   # (two sessions in one folder = exit 2, "pass --session"); exit 2 too when no fresh figure
                                   # (band not loaded) = treat as at the threshold
```

`session start` records its time in the worktree's state (`session.json`, under the git dir); the next
`session close` takes it as its window and names it in the section title: `Commits de la période (depuis
l'ouverture de 09:12)` (with the date when it is not today). A close never moves the boundary, refused
or not: run again without a `session start` in between (the `session-close` skill does, after fixing a
point), it still reports since that opening instead of an empty period. With no recorded opening, or an
unreadable file, the window is the current day, said as such (`depuis 2026-09-28 00:00`); `--since` is
quoted as given. (A `session.json` written by 0.18.0 after a close, `depuis la clôture de …`, is still read.)

On success `cadence session next` prints what it recorded (`2 lignes enregistrées pour la prochaine
ouverture`, then the lines as written, blank ones dropped), so `session-close` can report
them without running `session start` again.

`--all` runs the same command inside each project found under the current folder —
`docs/plan/raf.yaml`, or a `cadence.yaml` with `plan:` — and never enters a project
to look for another. `--since` and `--idle` go to every project; an error in one
project is printed in its section and the others still run. It replaces the shell
loop over the sub-folders. A project that is not the root of its own git repository gets a `✗` line
(and exit 2) instead of the parent repository's plan. `--all` and `--depth` are refused outside `session` (`--depth` is also read by `cadence lead tour`),
and `--all` refuses `--file`, `--config` and `RAF_FILE`: each project reads its own plan. For a one-line-per-project overview, `cadence lead tour`.

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

```yaml
session:
  clean: [ "~/projects/tmp/*", "tmp/*", "test-output-*" ]   # working files to propose for removal at close
  cleanDays: 7                                              # older than this many days (default 7)
```

`cadence session close` then lists, under "Nettoyage proposé", the entries matching these
patterns (`*` stands for part of a name and never crosses a `/`; `~` is the home folder, a
relative pattern starts at the repo root) that were not modified for more than `cleanDays`
days, oldest first — a folder's age is that of the most recent entry it contains, at any depth,
and an entry's age runs from the later of its modification time and its status-change time (ctime):
what `tar xf`, `cp -a` or `rsync -a` just brought in with an old modification time is not old.

An entry is proposed only if it could be measured entirely. Never proposed:

- a git repository, a folder that contains one at any depth, and anything under a `.git` folder;
- a git directory without a `.git` entry — a bare repository (`git init --bare`, `git clone
  --mirror`, `backup.git/`), a `--separate-git-dir`, a worktree's admin folder —, recognised by
  its content as git does (`HEAD` with `objects` and `refs`, or `HEAD` with `commondir`): neither
  it, nor anything inside it, nor a folder that contains one;
- anything `git` tracks, in any repository that has a `.git` entry above it. One limit, stated
  plainly: a bare repository driven with an external work tree (`git --git-dir=~/.dotfiles
  --work-tree=~`) leaves no `.git` beside the files, so its tracked files cannot be recognised and
  can be proposed — never point a pattern at such a work tree;
- a name starting with `.` unless the pattern itself starts that name with `.` (as in the
  shell, `tmp/*` does not match `tmp/.env`; `tmp/.cache-*` does);
- anything reached through a symbolic link matched by a `*` segment: unlike the shell, the walk
  never descends into such a link (`tmp/*/*` lists nothing behind `tmp/link → ../outside`), and a
  folder's age never looks behind a link; the link itself can be proposed, as a link — removing it
  leaves its target alone. Only segments written in full *before* the first `*` follow a link, as
  `cd` would (`~/shared/*` with `~/shared` a link lists the target's entries); once a `*` has been
  crossed no link is followed any more, even on a segment written in full (`tmp/*/out/*` with
  `tmp/run1/out → /elsewhere` lists nothing behind `out`);
- anything that could not be read entirely: a folder that cannot be listed — nor anything
  inside it, even named in full —, an entry that cannot be examined or vanished during the
  walk, an entry under a `.git` that `git` could not answer for. These are listed apart,
  under "Nettoyage : N élément(s) illisible(s), jamais proposé(s)";
- the repository itself, or a folder that contains it.

The command deletes nothing, never fails on the cleanup and does not change the exit code: the
`session-close` skill shows the list and removes the entries only after the human agrees.

The commands get `CADENCE_SINCE` and `CADENCE_TODAY`. `CADENCE_SINCE` is the `--since` as given; on `session close` without `--since` it is the instant of the last `session start` as an ISO 8601 UTC string (`2026-09-28T07:12:00.000Z`), or `<today> 00:00` when no mark exists.
The commands add facts and decide nothing: a failing command is reported and changes neither
the exit code nor the verdict.
