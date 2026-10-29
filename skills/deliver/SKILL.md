---
name: deliver
description: Deliver the pushed HEAD of a repository that uses cadence — wait for its CI run, run the configured deploy commands, then VERIFY THE EFFECT with the configured checks. A delivery is only done when its checks pass. Triggers — "/deliver", "ship it", "deploy", "livre", "mets en prod".
---

# Deliver — a delivery is proven by its effect

`cadence deliver` reads `cadence.yaml` at the repository root:

```yaml
deliver:
  ci: github                 # github | none | { command: "…" }
  deploy:
    - ./scripts/deploy.sh "$CADENCE_SHORT"
  verify:
    - url: https://app.example.com/api/health
    - url: https://app.example.com/
      contains: "${SHORT}"   # the new version is the one being served
```

A project that already has its own delivery script declares it instead — cadence then keeps the
preconditions, the lock, the log and the delivered lots, and the script keeps the CI wait, the deploy
and its business checks:

```yaml
deliver:
  script: ./scripts/ship.sh "$CADENCE_SHORT"
```

A script that deploys a commit other than `$CADENCE_SHA` (it committed a Nouveautés timestamp itself)
writes that sha into the file named by `$CADENCE_DEPLOYED_FILE`: cadence logs it as delivered and never guesses
(a content that is not a hexadecimal commit sha — `HEAD` or a branch name included — fails the delivery; empty during a wave, the log keeps `$CADENCE_SHA` and a warning
says the head moved).

Its arguments go after `--`: `cadence deliver -- api frontend` (`--sha <rev>` to deliver a commit
other than HEAD, see « Delivering a commit that is not HEAD »). Ask the human (or the project's own
delivery skill) which arguments this delivery needs; never guess them.

## Delivering a commit that is not HEAD

When HEAD holds work that must not ship and an earlier commit must, push **that sha alone** first,
then deliver it:

```sh
git push origin <sha>:main
cadence deliver --dry-run --sha <sha>
cadence deliver --sha <sha>
```

The order matters. With `ci: github`, cadence waits for the run of that exact sha, and GitHub only
builds the tip of a push: a sha that was never pushed as the tip has no run to wait for. Pushing HEAD
instead would ship the unfinished work; never reset HEAD to get there.

The push targets the branch being delivered (`main` here). Two cases where it does not apply:

- The sha is already on a remote branch: skip the push, it is useless. A sha that was pushed earlier has a CI run
  only if it was the tip of a push; if it never was, no run exists to wait for.
- The push is refused as non-fast-forward (the sha is not a descendant of `origin/main`, or `origin/main`
  has moved past it): **never force it**, `--force` would rewind the remote branch. The sha cannot be delivered
  that way: stop and ask the human.

**The sha pushed needs a green verdict of the gate (L426).** Where the project declares a gate (`orchestrate.test` or
`orchestrate.build`), the `pre-push` hook a wave installs, and the gate-only hook it leaves behind, refuse with exit 3 a push
of a branch whose local sha has no green verdict of `cadence verify --gate`; the message names the sha and the command. The
lot's sha the lead re-checked has one; a plan or release commit above it has none, and the wave's record does not cover it:
run `cadence verify --gate --sha <sha>` on the very sha you push (a full replay for such a commit, ~5 minutes) before the
push, HEAD included when you push `main`. `CADENCE_PUSH_UNGATED=1 git push …` lets a push through with no verdict and says so
on stderr: only when the human asks for it, never the routine.

## Where to run

Every `cadence` / `raf` command works on the git repository of the current directory. When the
session runs from a parent folder that holds several projects (not itself a repository), run each
command inside the project concerned: `cd <project> && cadence …`. The projects are the sub-folders
that contain `.cadence/raf.yaml` or `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key.

Deliver one project at a time: the one the human names, or ask.

## Steps

1. Before anything: tests and build green locally, everything committed **and pushed** — the CI can
   only build what it has received, and `cadence deliver` refuses a sha that is not on a remote branch.
2. `cadence deliver --dry-run`: read the resolved commands and checks. If there is no `cadence.yaml`,
   help write one: ask the human for the deploy command, and propose at least one check that proves
   the NEW version is live (a version string, a new endpoint), not merely that the site answers.
3. `cadence deliver`. Exit codes: 0 delivered and verified, 1 a step failed, 2 refused before acting.
4. On failure: read which step failed and why. Fix the cause, commit, push, deliver again. Never rerun
   blindly, never skip a check to make it pass.
5. On success: `raf done <id>` (or the project's own tool when its plan is read-only) for the lots it lists **whose effect you have seen**; if one of them is
   `visible`, `cadence news build` and deliver the news too. With a read-only plan the list holds only
   the lots that were in progress when the delivery started; the project's own tool has the last word
   on what it marked delivered.
6. After a green delivery that changes what a page shows or what it is served (screen, API, data
   source, configuration of either) — in practice every delivery except docs-, plan- or tests-only
   ones — have the `qa-reviewer` agent walk the delivered app in a real browser, whether the lot
   is `visible` or not: give it the repository path, the base URL and the lot id. With a lot id, the agent walks only the pages the lot touched (the pages that call the changed endpoints, the pages of the changed screens, the pages that consume the services the lot changed, the home page; when the diff changes no route and no screen, or cannot be linked to pages, it walks every page and says so) and names the others under « Not walked »: they are not checked. It
   checks each page against `docs/qa/expectations.md` — what the user must find there — and
   reports a page left empty, an error shown, an API call that failed or came back empty: what
   the checks of `cadence.yaml` do not see. Bring its blocking findings to the human. It is not a
   gate: the delivery stays done, a finding becomes a new lot.

## Rules

- Never two deliveries at once: a second one can silently overwrite the first one's deploy. The lock
  enforces it; do not delete a live lock.
- A green tool status (CI "success", a deploy tool "synced", a job "completed") is not a proof. Only
  the checks are.
- Delivering to production is an outward-facing action: follow the human's standing instructions about
  confirmation before running step 3.
