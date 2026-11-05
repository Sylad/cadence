[← cadence](../README.md)

# The notions of cadence, for a human

cadence has become a rich tool, and its vocabulary comes faster than its pages. This one explains each notion in a few sentences,
**in the order you meet them**, with four figures; the technical detail stays in the pages it links, and the
[glossary](#glossary) at the end is the one-line version. You do not need to know cadence to read it: the journey of a lot
([figure 1](#the-steps-of-a-lot)) is the five minutes to keep if you keep only one thing.

## Plan and lot

The **plan** is a file in your repository (`.cadence/raf.yaml`): the list of what is left to do and what was done.
Each item is a **lot**: a piece of work small enough to be finished in a day or two, with an identifier (`L12`), a title, an
estimate and a status (`todo`, `doing`, `done`, or `dropped`). A commit that belongs to a lot cites it in its subject:
`feat(L12): …`. That link is the whole idea: from any commit you know what it was for, from any lot you know its commits.
The `raf` command reads and writes the plan; `raf check` lists the commits that cite no lot. Detail: [raf.md](raf.md).

## Verdicts

A lot is not finished when its code is written, but when two independent readers said so, and the plan keeps their word:
the **review verdict** (`raf review`) says the code is compliant, the **UX verdict** (`raf ux`) says the screen is
usable, for a lot that shows one (a `visible` lot). A verdict is recorded by the program (the review) or by the lead (the UX verdict, on the human's word), not by
the session that wrote the code. `raf done` is refused while a sub-task is open. Detail: [raf.md](raf.md), [news.md](news.md).

## Session and wave

A **session** is one fresh run of Claude Code with a brief and a single job (write the spec, write the code, review, fix). It
remembers nothing of the previous one: what it needs is in the brief and in the repository. A **wave** is a run of
`cadence orchestrate` over several lots: the program (not a model) starts the sessions, chains the steps of each lot, runs
the tests, and prints a final table with the lots ready and the lots handed back. A session cannot ask you anything: when it is
stuck it stops and reports, and the question comes back to you through the lead. Detail: [orchestrate.md](orchestrate.md).

## The steps of a lot

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="concepts-lot-dark.svg">
  <img alt="A lot goes through spec, code, review, correction, UX and ready; under each step, who does it: spec-writer, a fresh session, the code-reviewer, a fresh session, the ux-reviewer, the lead" src="concepts-lot-light.svg">
</picture>

Inside a wave, a lot goes through these steps, each in a fresh session. Dashed boxes are conditional.

| Step | What happens | Who |
|---|---|---|
| **spec** | For a lot that creates a screen (`screen: page`) or has a behaviour to pin down (`spec: true`): a mockup and a **sheet** (fields, states, numbered rules); reviewed before any code, and the acceptance tests are written from it, committed red and locked | the `spec-writer` agent, reviewed by the `ux-reviewer` (mockup) or the `code-reviewer` (sheet); then the `acceptance-writer` agent, a separate session, writes the tests; the program locks them |
| **code** | Test first, then the code, commits that cite the lot; the lot's own tests must pass | a fresh session of the program |
| **review** | Reads the diff against the lot (and the sheet, rule by rule) and returns findings: blocking, major, minor | the `code-reviewer` agent; the program records `raf review` when it is compliant |
| **correction** | Only if the review is not compliant: a new session fixes the findings, then a new review. Two passes at most, three when the findings converge; then the lot is **handed back** | a fresh session; the program decides how many |
| **UX** | For a visible lot: the screen is opened in a real browser, in each state, with captures at 1440 and 390 px | the `ux-reviewer` agent for the report; the verdict is **the human's**, or the lead's when the parent folder says `lead.ux: lead` |
| **ready** | In worktree mode the lot is integrated (see [below](#one-worktree-per-lot-and-integration)); without worktree (the default) it is ready as soon as its review is compliant; the lead re-checks it, records `raf done`, delivers it | the lead |

Before all that, a lot whose title cites a finding or another lot gets a **precheck**: « is it already done? ». Small lots (half a day or
less, [see their size](#the-size-of-a-lot)) get a single review pass. Detail: [fonctionnement.md](fonctionnement.md#2-a-lot-inside-a-wave), [spec.md](spec.md).

## The size of a lot

A lot's **size** is read from its estimate, in days, and decides how much ceremony it gets. There are four words, from the smallest:

| Word | When | Effect |
|---|---|---|
| **express** | estimate > 0 and ≤ 0.1 day (`EXPRESS_MAX_ESTIMATE`), no screen and not a spec lot | one session; no precheck, no probe, no separate review |
| **light** | estimate ≤ `orchestrate.review.threshold` (0.25 day by default) | the review runs on the light model (Sonnet by default), minor findings become notes |
| **small** | estimate ≤ 0.5 day, **or** the lot is flagged `quickwin` | one review pass: `review-small` (code and ergonomics) for a `visible` lot, a code `review` otherwise; no separate UX pass |
| **full** | anything bigger | the whole cycle of [the steps above](#the-steps-of-a-lot) |

The words nest: an express lot is also light and small, a light lot is also small. `quickwin` (the ⚡ flag, `raf add --quickwin`) is « small, said by hand »: it makes a lot small whatever its estimate, and `raf quickwins` lists the lots with an estimate of 0.25 day or less, or flagged ⚡. Detail: [orchestrate.md](orchestrate.md#orchestrate), [fonctionnement.md](fonctionnement.md#2-a-lot-inside-a-wave).

## The test gate

After each writing session the program plays the project's own **gate**: the build (`orchestrate.build`), then the tests
(`orchestrate.test`). A session's « the tests pass » is never taken on trust. Three rules keep the gate honest:

- **Already red at the start.** If a test fails, the program replays the suite at the sha the lot started from, in a **throwaway copy**
  of the repository (a temporary `git worktree` outside it, removed afterwards). A test that was already red is not the lot's fault: no correction pass,
  and the table lists it apart.
- **Replayed alone.** With `orchestrate.testReplay`, a test red in the whole suite is replayed alone: green alone means a load
  failure, not a defect, so no correction is spent on it. Without this key, nothing is replayed.
- **A test that reads the plan.** The commits that only touch the plan are crossed when the gate's verdict is carried over them. A project whose
  tests read `.cadence/raf.yaml` says so with `orchestrate.gate: { readsPlan: true }`, or the gate would not see a break.

A **resume** (`cadence orchestrate --resume`) picks a suspended or handed-back wave where it stopped, instead of starting again.
Detail: [orchestrate.md](orchestrate.md#orchestrate), [deliver.md](deliver.md), [remote-gate.md](remote-gate.md).

## One worktree per lot, and integration

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="concepts-worktrees-dark.svg">
  <img alt="Three lots each work in their own worktree on their own branch; at the end of their cycle they pass one at a time through the integration (rebase, replayed checks, fast-forward) into main" src="concepts-worktrees-light.svg">
</picture>

By default a wave plays the lots of a repository one after the other. With `orchestrate.worktrees: true`, independent lots play **at the same
time**, each in its own **worktree** (a second checkout of the same repository, in its own folder) on its own branch
`cadence/<wave>/<project>--<lot>`, so two sessions never edit the same files. When a lot's cycle ends, the program **integrates** it: one
lot at a time under a lock, it rebases the branch on the tip of `main`, replays the checks, and fast-forwards `main`. Only then is the
lot `ready`. If `main` moved in the meantime the rebase is replayed, twice at most, then the lot is handed back. Two rules protect
you: the program, not the sessions, writes the plan; and a session never commits on the `main` branch of another repository
(it uses a `wip/` branch). Detail: [orchestrate.md](orchestrate.md#one-worktree-per-lot-orchestrateworktrees-l279).

## Deliverable up to a sha

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="concepts-livraison-dark.svg">
  <img alt="Commits stack on main: L1 and L2 are ready, L3 is handed back, L4 is ready above it; the deliverable sha is the last commit of L2, so L3 and L4 are not pushed" src="concepts-livraison-light.svg">
</picture>

Lots commit on top of each other on `main`. When a ready lot sits **under** a lot that is not ready, pushing `HEAD` would also publish
unreviewed code. The final table then says « **livrable jusqu'à `<sha>`** »: the last commit of the highest ready lot that has no
unfinished lot beneath it. You ship exactly that, and nothing above:

```sh
git push origin <sha>:main && cadence deliver --sha <sha>
```

`cadence deliver` waits for the CI of that exact sha, deploys, and replays the effect checks: a delivery is finished only when its effect is proved.
Where the project declares a gate, the `pre-push` hook refuses a sha with no green `cadence verify --gate`. Detail: [deliver.md](deliver.md), [orchestrate.md](orchestrate.md#orchestrate).

## Lead and delivery agent

The **lead** is a Claude Code session (`/cadence:lead`) that drives the waves for you: it reads the state of every project
(`cadence lead tour`), proposes lots, starts the waves, relays each line of the journal and each question, **re-verifies** what comes back
(git log, tests, build, `raf check`), then delivers. It never codes and never commits where a wave runs. The **delivery agent**
(`livreur`) is a subagent the lead hands one ready lot to: it checks the sha, runs the gate, records `raf done`, pushes the sha and
delivers, then reports in one line. You stay the one who decides what matters, and the UX verdict if you did not delegate it.
Detail: [lead.md](lead.md), [skills.md](skills.md).

## Slots and holds

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="concepts-vague-dark.svg">
  <img alt="A queue of lots feeds the slots of a wave: two sessions running, a slot held by a fix the lead started by hand, a free slot that the wave fills from the plan; the wave's table goes to the lead" src="concepts-vague-light.svg">
</picture>

The machine and your quota are shared, so at most **N sessions run at once**: N is the cap (`CADENCE_MAX_SESSIONS` or `--max-sessions`, 2 by default;
the lead never raises it itself). Each running session occupies a **slot**; a lot waits in the queue until one is free, and a freed slot goes to the next
lot of the wave's queue; a freed slot is also filled at once by the next ready lot of the plan (always with `--continue`; a wave of named lots does it too since L587, and `--no-fill` stops it: only the lots given are played). A session the lead starts by hand (a fix, a QA pass) is invisible to the waves, so
the lead declares it with `cadence lead hold <label>` and lifts it with `cadence lead release <label>`: a **hold** takes a slot, and
the waves wait for it instead of overtaking it. `cadence orchestrate --status` prints `créneaux libres : 1 sur 3`. Detail: [lead.md](lead.md#lead-hold-and-release), [orchestrate.md](orchestrate.md#orchestrate).

**Free slots, one formula.** The `créneaux libres : N sur M` figure of `orchestrate --status`, `lead tour` and the `cadence-hud` band is, with M the cap:

> M, minus, for each live wave, the smaller of the **common cap** (the lowest cap declared by any live wave, M if none) and what the wave holds — one slot per lot that holds a claude session when the lots play in worktrees (`lanes`), one per repository held otherwise —, minus the sessions the lead declared with `lead hold` whose time limit has not run out; never below 0.

A wave that declares no cap is bounded by M instead of the common cap. A wave whose process is dead (or whose pid was reused by another process: pid and start time must both match), and a hold past its limit, count for nothing: liveness is judged when the figure is read, never when it was written. The registry (`freeSlots` of `src/orchestrate/registry.ts`) and the band (`freeSlots` of `plugins/cadence-hud/hooks/format.ts`, which works without the CLI) are two implementations of this one formula, and `test/creneaux-libres-contrat-l598.test.ts` plays both on the same registry. Not to be confused with the *vacant lanes* of a wave (`vacantLanes` in `pool.ts`): the places of that wave that no queue holds, which it fills from the plan (L527).

## Escalation

A lot that is still not compliant after its correction passes would normally be handed back. A project can ask for one more try
with a stronger model: `orchestrate.escalation: { model: fable }` plays one correction and one fresh review on that model first
(absent, nothing changes; it costs a share of the lot's budget). If that is not enough, the lot is **handed back** to the lead,
who either fixes it, answers the question, or brings it to you: the question always reaches a human, never a session. Detail: [orchestrate.md](orchestrate.md#orchestrate), [perf.md](perf.md).

## Putting into service and release

Two moments are easy to confuse. **Putting into service** concerns cadence itself, where the `raf` and `cadence` commands you type must
not run the code a wave is rewriting: they read a separate copy, updated only by `npm run service -- <sha>`, which refuses a sha
that is not an ancestor of `HEAD` or whose lots are not `done`. A **release** is a published version: `cadence release patch|minor|major` writes the version
files and the changelog, then prints the steps the lead plays (tag, gate, push, CI, publication). Detail: [fonctionnement.md](fonctionnement.md#4-putting-cadence-itself-in-service), [releasing.md](releasing.md).

## Glossary

- **plan**: the file `.cadence/raf.yaml` that lists the lots; the single source of truth.
- **lot**: one item of the plan, cited by its commits (`feat(L12): …`).
- **verdict**: the recorded opinion of a reviewer on a lot: `raf review` (code) and `raf ux` (screen).
- **session**: one fresh Claude Code run with a brief and one job.
- **wave**: a `cadence orchestrate` run that plays several lots and prints a table of what is ready and what is handed back.
- **sheet**: the written spec of a screen or a behaviour, with numbered rules, each tested.
- **gate**: the build and the tests the program plays after each session (the related ones only, in a worktree, since L590; the full suite at integration), with the already-red baseline and the replay alone.
- **readsPlan**: `orchestrate.gate` key declaring that a test reads the plan, so plan-only commits are not crossed.
- **worktree**: a second checkout of the repository on its own branch, one per lot, so lots play at the same time.
- **integration**: rebasing a lot on the tip of `main`, replaying the checks and fast-forwarding, one lot at a time, before `ready`.
- **handed back**: a lot the wave could not finish and returns to the lead with its cause.
- **deliverable up to**: the sha up to which a delivery is safe, below the first lot that is not ready.
- **lead**: the session that drives the waves, re-verifies and delivers; it never codes.
- **delivery agent**: the `livreur` subagent that delivers one ready lot and reports in one line.
- **express**: the smallest [size of a lot](#the-size-of-a-lot), estimate > 0 and ≤ 0.1 day, no screen and not a spec lot: one session, no precheck, no separate review.
- **light**: estimate ≤ 0.25 day by default (`orchestrate.review.threshold`): the review runs on the light model.
- **small**: estimate ≤ 0.5 day or `quickwin`: one single review pass, no separate UX pass.
- **full**: any lot bigger than small: the whole cycle of steps.
- **quickwin**: the ⚡ flag of a lot, set by hand, that makes it small whatever its estimate; `raf quickwins` lists them.
- **git hook**: a script git runs (`pre-commit`, `post-commit`, `pre-push`), `raf hook install` installs `post-commit` and `pre-commit` (`hook.autostart` configures the pre-commit one); `cadence orchestrate` puts a temporary `pre-push` in place during a wave and, when the project declares a gate, leaves behind a permanent gate-only `pre-push` (it refuses a push with no green `cadence verify --gate`): do not delete it. See [raf.md](raf.md).
- **Claude Code hook**: a command Claude Code runs around a tool call, declared in the plugin's `hooks/hooks.json` and played by `cadence claude-hook retour|attente|pipe`. See [lead.md](lead.md).
- **plan.onWrite**: not a hook of git nor of Claude Code: the command of `cadence.yaml` that cadence runs after each write of the plan, to refresh the files derived from it. See [raf.md](raf.md).
- **mod hook**: a function hook of the `cadence-hud` mod (`plugins/cadence-hud/hooks/`), in Claude Code's plugin vocabulary; it draws the band. See [cadence-hud.md](cadence-hud.md).
- **docs-ok**: one notion, three spellings: the command `raf docs-ok`, the key `docs_ok` of a lot in the plan (and the file `.cadence/docs-ok.yaml` when the plan is read-only), and the field `docsOk` in the TypeScript code. It acknowledges a documentation gap that is not one. See [raf.md](raf.md).
- **slot**: one place under the cap of simultaneous sessions.
- **hold**: a slot kept by a session the lead started by hand, so waves do not overtake it.
- **escalation**: one more correction and review on a stronger model before a lot is handed back.
- **service**: the separate copy of cadence the `PATH` commands read, updated by `npm run service -- <sha>`.
- **release**: a published version, prepared by `cadence release`.
