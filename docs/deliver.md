[← cadence](../README.md)

# deliver

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

A public title (`public:`) longer than the site's Plan page accepts fails its build. Declare the limit
in `cadence.yaml` and it is caught before the push:

```yaml
news:
  publicTitleMax: 80      # characters; without the key, `raf check` warns at 80 in a project that has a news directory
```

`raf check` also warns (`⚠`, not an error: exit code 0 if nothing else is wrong) about every visible lot, dropped ones excepted, that has no public title: the site would show its technical title (a done lot cited by a News entry is spared: the site reuses that entry's title). Fix it with `raf public <id> "…"`. On a plan kept by another tool (read-only), the warning only applies if `plan.fields` maps a `public` field, or if some lot already carries a literal `public:` key (a field left out is read under its own name): without either there is no public title to set, so it would come back at every session.

With the key, `raf public`, `raf add --public`, `raf done` (on a lot whose public title is too long) and
`cadence news new` (its title) refuse above it; without it, only `raf check` warns.

```sh
cadence deliver --dry-run    # preconditions, then the resolved steps; nothing runs
cadence deliver              # 0 delivered and verified · 1 a step failed · 2 refused before acting
```

- **Preconditions**: no modified tracked file; `HEAD` is on a remote branch (the
  CI can only build what was pushed); no other delivery running (a lock whose
  process died is removed with a warning); with `ci: github`, `gh` installed and
  logged in.
- **Red delivery log** (L282): a failure after the lock is taken appends one line to
  `<git common dir>/cadence/deliveries-failed.log`: `day sha [class] reason ⏎ line ⏎ line`.
  The class says where it broke: `refus` (the project script exited with code 2 — the
  convention of `deliver` itself for « refused before acting »), `ci`, `deploiement`
  (the project script with any other code, a deploy command, an unusable
  `CADENCE_DEPLOYED_FILE`) or `verification`. The reason is the first line of the failure
  message, followed by the **last 5 non-empty lines** (200 characters each, ANSI sequences
  removed) of the output of the command that failed: the project script, the CI command, the
  deploy command or the check command. A GitHub CI run or an URL check has no output of its
  own, so no line follows. cadence now relays the output of those commands through itself
  (same bytes on its own stdout and stderr, but the command no longer sees a terminal there,
  so it may drop colours or progress bars). A line rewritten with `\r` (a progress bar that
  did not drop) keeps only its last non-empty frame, not 5 frames of the bar. **Probable
  secrets are masked** (`***`) in the reason and in those lines before the file is written:
  known token shapes (GitHub, GitLab, npm, Slack, AWS key id, `sk-…`), `Bearer`/`Basic`
  values, `user:password@` in a URL, and any `NAME=value` (shell variable or URL query
  parameter) whose name has a word such as token, secret, password, key, auth, signature, or
  ends with one of token, secret, password, pwd, key, credential, signature (`APIKEY`,
  `ACCESSTOKEN`, `GITHUBTOKEN`, `MYSQLPWD`) (L294). The 8192 characters kept are the END of the
  output (`OUTPUT_KEPT`, `src/deliver.ts`), so the bound cannot cut the end of a value; it can cut
  its beginning (the name and the opening quote gone), and that case is **not handled** — the log
  stays local. A quoted value never closed is not treated either (L294 tried, and each fix opened a
  new leak): only closed values and unquoted values are matched.
  This is a list of likely patterns, not a guarantee: a secret of another shape printed by a
  command can still land in the log, which stays local (`<git common dir>/cadence/`). `cadence perf` reads classes and projects from it
  ([perf](perf.md#delivery-quality-and-the-tour-header-l227)); a line written before L282
  has no `[class]`: it is read by its wording (the one `deliver` writes itself, see
  [perf](perf.md#delivery-quality-and-the-tour-header-l227)) and counts as « non classée » only when the wording is not recognised. The file is never rewritten.
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
  2 seconds is killed through the same fallback (the command itself only). The
  same fallback applies when the process list fails while the command runs and
  is still failing when the kill comes (the last listing is not trusted after
  1 second): only the command is killed, its descendants survive, and cadence
  says so once on stderr.
  The 2 seconds are a constant of the real dependencies (`realDeps`, the `graceMs`
  argument), injectable so that the tests measure the kill, not the load of the machine.
  A Ctrl-C goes to the whole foreground group, so the command can die and its
  exit be processed before the signal addressed to cadence: while followed
  processes are still alive after the command exits, or the command itself died
  of a termination signal (SIGINT, SIGTERM, SIGHUP, or exited 128 plus one of
  them: a `curl` killed by the Ctrl-C), cadence waits up to
  2 seconds more (`SIGNAL_PENDING_MS`, the `pendingMs` argument) for that signal,
  and plays the grace above if it comes. Without it a background child that
  ignores Ctrl-C would survive, and a second Ctrl-C would kill cadence without
  releasing the lock. A command that leaves a daemon behind, or that exits 130
  without any signal coming, therefore returns up to 2 seconds later. The termination listener is installed before
  the command is spawned, so a Ctrl-C received while cadence first reads the
  process list is handled too, not killed by the default action.
  A delay overrun and `SIGTERM` give no grace: a script's own `trap` does not
  get to finish there. The lock is held until the followed set is empty: when
  cadence dies of the signal it dies after the tree, and its stale lock, which
  the next delivery removes, leaves nothing of the first delivery running.
  What can still outlive cadence and run concurrently with the next delivery:
  a process that leaves the tree before cadence first sees it (a daemon's
  double fork, `setsid`, `nohup … &` from a shell that exits, all within less
  than 200 ms), a process of another user that cadence may not signal (`sudo`),
  a background process still running when the command returns normally (cadence
  waits up to 2 seconds for a signal on its way, see above, then carries on
  without killing it), and everything if cadence itself is killed
  with `SIGKILL` (`kill -9`, the OOM killer).
  Where the process list cannot be read (no `/proc` and `ps` failing), cadence
  can only kill the root command (`sh`): it leads no group of its own, since it
  is deliberately kept in cadence's group, so its descendants are not killed and
  survive it. A list that fails for more than a second is no longer
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
- Commands get `CADENCE_SHA`, `CADENCE_SHORT` (7 characters) and `CADENCE_BRANCH` (a `deliver.script` also gets `CADENCE_DEPLOYED_FILE`, see below);
  `${SHA}` and `${SHORT}` are replaced in `url` and `contains`.
- On success the lots cited by the commits since the previous delivery are
  listed, so you can `raf done` those whose effect you have seen. With a
  read-only plan, only the lots that were in progress when the delivery started
  are listed: an id quoted in a message for context (a finished lot, a
  reservation number that looks like one) is not a delivered lot. Plan upkeep
  commits (see "Plan upkeep needs no lot") are skipped in that list: they cite
  lots without delivering anything.
- With [`docs.articles`](news.md#an-article-elsewhere-that-follows-the-delivery), a green delivery of lots with a
  public title also opens the lot `Article <project> à rafraîchir` in the plan.

## A project with its own delivery script

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
builds each service only on the commit that touched it. To deliver an earlier commit while `HEAD` holds work that must not ship, push that sha alone first (`git push origin <sha>:main`), then `cadence deliver --dry-run --sha <sha>` and `cadence deliver --sha <sha>`: with `ci: github` the wait is for the run of that exact sha, and GitHub only builds the tip of a push (L334, the `deliver` skill says so). The push goes to the branch delivered (`main` here); skip it when the sha is already on a remote branch, and when it is refused as non-fast-forward never force it (that would rewind the remote branch): the sha is not deliverable that way, stop and ask. `allowDirty` suits a
working tree shared by several sessions when the delivery starts from a pushed
sha and never from local files; without it a modified tree is refused. `--sha`
itself never reads the working tree: a tracked file modified outside the delivered
sha (the plan after `raf done`, say) neither refuses nor is reported, with or
without `allowDirty`.

**While a wave runs.** `cadence orchestrate` holds the repository: a plain `cadence deliver` is refused until every lot of the
repository in the wave is ready or handed back. `--sha` is the exception (L277): it is accepted while the wave runs when no
commit in the history of `<sha>` belongs to a lot of the wave that is not ready (running, queued, in question, suspended,
handed back, failed), that is when `<sha>` is « livrable jusqu'à » (the line the wave's final table prints). A ready lot is
then delivered while the wave runs, without waiting for the slowest lot. The refusal names the lots that hold the sha back. A lot's commits
are what git attributes to it in the repository (the commits that cite it) **and** what its sessions' reports noted, for the project's own
repository as for a neighbour one (the lot's `repos:` key): git sees at once the commit of a session still running, cut by the quota or failed,
which the reports only note when the session ends validly. A lot of the wave with no commit yet blocks nothing. What cannot be verified is
refused: an unreadable wave state, an unknown sha, or a lot that is not ready whose commits cannot be read (its project's plan is unreadable or
does not know the lot) while none of the commits already known holds the sha back. Push the sha alone first (`git push origin <sha>:main`).

**What is logged as delivered.** cadence no longer guesses which commit a project script deployed. Before running `deliver.script` it creates an
empty file and hands its path to the script in `CADENCE_DEPLOYED_FILE` (next to `CADENCE_SHA`, `CADENCE_SHORT`, `CADENCE_BRANCH`). A script
that deploys a commit other than `CADENCE_SHA` (it committed a `--news` timestamp itself, say) writes that sha into the file. After the script:

- the file holds a hexadecimal sha (7 to 40 characters) that resolves to a commit: that is the sha logged, and `✓ livré :` names it (« sha déclaré par le script ») — it wins over
  HEAD, during a wave or not;
- the file holds anything else (not a commit, several lines, `HEAD` or a branch name — a revision would be resolved after the script, possibly at another lot's commit, so only a sha is accepted): the delivery fails with a message that says so, nothing is logged;
- the file is empty and the delivery runs **while a wave runs**: the log keeps `<sha>`, and if HEAD moved during the delivery a warning says
  so (« la tête a avancé pendant la livraison ; sans sha déclaré par le script (CADENCE_DEPLOYED_FILE), le journal garde <sha> ») — the new
  commit may be the script's, a running lot's, or a plan commit, and cadence cannot tell them apart;
- the file is empty and **no wave runs**: the historical rule stays, a script that committed and pushed during the delivery has delivered the new
  HEAD, which is logged (« head moved by the script »).

cadence keeps what the script usually lacks: the preconditions (clean tree, pushed
`HEAD`), the lock (never two deliveries at once), the delivery log and the lots
delivered. Arguments are quoted for `sh`, so spaces and quotes reach the script
intact. If the script commits and pushes during the delivery (stamping a
changelog entry, say), outside a wave the new `HEAD` is the sha recorded as delivered; during a wave, or to be exact
about it anywhere, the script declares it in `CADENCE_DEPLOYED_FILE` (above). Exit code
0 of the script means delivered; `verify` checks, if any, run after it.

## verify: replay the effect checks, outside a delivery

A green delivery says the effect was right *then*. `cadence verify` replays the
`deliver.verify` checks of `cadence.yaml` at any time — no CI, no deploy, no lock,
no journal entry, nothing written.

```sh
cadence verify                # one pass, one line per check, then a one-line summary
cadence verify --retry 60     # retry each failing check for up to 60 s (deliver's 300 s is not applied)
cadence verify --sha 6b0d9aa  # the sha that replaces ${SHA} / ${SHORT} (default: see below)
```

```
✓ GET https://ol.example/api/health → 200
✗ GET https://ol.example/api/lineup → 200, contient « "starters" » — « "starters" » absent de la réponse
verify : 1 effet rouge sur 2 vérifications
```

Exit code: **0** every check green · **1** at least one red effect · **2** nothing
to verify or invalid configuration.

**Which sha is expected.** By default `${SHA}` / `${SHORT}` is the last recorded
delivery (else `HEAD`). One case differs: a project with `ci: none` (the default) and
**neither** deploy commands (`deliver.deploy`) nor a delivery script — a host that
builds every push, like Cloudflare Pages — delivers by pushing, and every push counts,
plan-maintenance commits included. The expected sha is then the head of the tracked
upstream branch (`origin/<branch>`, as last fetched — `verify` does no network git),
**provided that upstream is the remote's production branch**: read without network from
`refs/remotes/origin/HEAD` (set by `git clone` or `git remote set-head origin <branch>`);
when that reference does not exist locally (repository created with `git init` + push),
`main` then `master` are taken as the production branch. A work branch pushed with `-u`
is not published by such a host, so it keeps the default rule. A project with `ci: github`
or a `ci.command` and no deploy also keeps the last delivery. When local `HEAD` is ahead
of the upstream, the report says so first — `2 commit(s) non poussé(s) — l'effet vérifié
est celui de origin/main` — so a red there reads "waiting for a push", not "broken
effect". `session start` uses the same rule; `--sha` always wins.

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

## verify --gate: replay the project's gate at a sha (L348)

`cadence verify` above replays the *effect* of a delivery. `cadence verify --gate --sha <sha>`
replays the *gate* of the project, `orchestrate.build` then `orchestrate.test` of `cadence.yaml`
(the order of the wave's gate: the tests read what the build produces), at one commit, for the
lead's re-verification (« the lead re-verifies itself », skill `lead`). It never touches the shared
tree, which holds the lots still running.

```sh
cadence verify --gate --sha 6b0d9aa                  # in the project
cadence verify --gate --sha 6b0d9aa --project app    # from the parent folder, the project `app` (its own git repository)
```

It adds a throwaway worktree of the sha under the OS temporary folder (`cadence-verify-…`), links
the **untracked dependencies** of the main tree into it, runs the commands there, and removes the worktree
whatever the result. A bare worktree has no `node_modules` or `.venv`: on 26-10 the re-verification of a lot
in one gave nine red suites that were only missing dependencies. Which dependencies:

- `orchestrate.worktreeDeps: [node_modules, .venv, front/node_modules]` in `cadence.yaml`: those paths, relative to the repository
  (no absolute path, no `..`); one that does not exist in the main tree is reported and skipped;
- absent: the same folders as the worktrees of a wave (the ignored folders of every level, `node_modules`, `.venv`…; build outputs such as `dist` excluded). The
  workspace links of a `node_modules` are made again towards the worktree, so the code run is the sha's.

```
✓ build (npx tsc --noEmit)
✗ tests (npx vitest run) — code 1
  - test/a.test.ts > R3 — …
verify --gate 6b0d9aa : rouge (1 étape sur 2)
```

Both commands always run, even when the first is red, so the report is whole. A red step lists the failing
tests the output names (the same reading as the wave's baseline) and the test files that do not load (`- test/a.test.ts (ne se charge pas)`, the typical sign of a missing dependency); with none identifiable (or when an unnamed failure is mixed with them), the last 10 lines of the output, each prefixed `  | `: a red that names no test, seen three times under load on 27-10 (L380, B28.17), is no longer a bare exit code.
With `orchestrate.testReplay` declared (`docs/orchestrate.md`, « A red test is replayed alone »), the gate does what a wave does: a red test the output names is **replayed alone, twice at most**, in the same throwaway worktree. Green at a replay it is *unstable under load*: the step prints `✓ tests (…) — N test(s) rouge(s) sous charge, verts rejoués seuls (instables sous charge) :` with the names and does not make the gate red; the tests still red stay listed and the unstable ones follow, under a line of their own. A failure the output ties to no test, or a file that does not load, is never replayed and stays red. Without `testReplay` nothing is replayed.
Each command has 30 minutes (then its whole process group is killed, code 124). Ctrl-C, SIGTERM or a hangup received by cadence kills the running command and removes the worktree before cadence dies.
`--sha` is required (the moving head of a wave is not a sha to re-verify) and `--retry` does not apply. Exit code:
**0** green · **1** red · **2** nothing to replay (neither `orchestrate.build` nor `orchestrate.test`), unknown sha or a worktree that cannot be made.
The Node of the `.nvmrc` is not selected here, and `CADENCE_TEST_WORKERS` is not set: the commands run with the environment of the caller (`PATH` included), so a re-verification run during a wave should export the session's `CADENCE_TEST_WORKERS` itself, or vitest takes every core.
