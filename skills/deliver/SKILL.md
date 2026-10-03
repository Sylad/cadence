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

Its arguments go after `--`: `cadence deliver -- api frontend` (`--sha <rev>` to deliver a pushed
commit other than HEAD). Ask the human (or the project's own
delivery skill) which arguments this delivery needs; never guess them.

## Where to run

Every `cadence` / `raf` command works on the git repository of the current directory. When the
session runs from a parent folder that holds several projects (not itself a repository), run each
command inside the project concerned: `cd <project> && cadence …`. The projects are the sub-folders
that contain `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key.

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
   is `visible` or not: give it the repository path, the base URL and the lot id. When the lot
   touched only the backend, the agent starts with the pages that call the changed endpoints. It
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
