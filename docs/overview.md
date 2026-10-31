[← cadence](../README.md)

# Overview: the tools and the skills

The longer introduction the README used to open with, and everything the README handed over to keep itself a short home page (L326): the introduction in full, the start in detail, the plugin installation, the map of the documentation and the four tools in short.

A small working method that lives in your repository. Solo developers and
AI-assisted sessions lose track of *what is left to do* and *what each commit
was for*; cadence keeps both in plain files next to the code.

Four tools:

- **raf** (French *reste à faire*, "what is left to do"): the plan, linked to your commits;
- **news**: a user-facing changelog with screenshots, tied to the plan;
- **session**: the facts to start and to close a work session;
- **deliver**: wait for the CI of the pushed commit, deploy, then **verify the effect**.

And four [Claude Code](https://claude.com/claude-code) skills that turn them
into rituals — `session-start`, `session-close`, `deliver`, and `lead` to pilot
several projects through subagents — plus three reviewer agents: `ux-reviewer`
(no user-facing change is done before its usability review) and `code-reviewer`
(no lot with commits is done before its code review), each behind an opt-in
gate, and `qa-reviewer`, which walks the delivered app in a real browser and
reports a page left empty or in error.

And a second plugin, [`cadence-hud`](cadence-hud.md): a status band above the Claude
Code prompt that shows the session's context, quota, cost and the orchestrate waves running.

## The README's introduction, in full

A small working method that lives in your repository: a versioned plan linked to your commits, waves of fresh AI sessions driven by a program, and deliveries proved by their effect.
Solo developers and AI-assisted sessions lose track of *what is left to do* and *what each commit was for*; cadence keeps both in plain files next to the code.
**raf** is the plan, **news** the changelog with screenshots, **session** the facts to open and close a day, **deliver** waits for the CI, deploys, then checks the effect.
**orchestrate** runs a lot through spec, review, code and UX passes, each in its own session (with a short `TMPDIR` of its own, `<os tmpdir>/cadence-<hash>`, outside the repository and the wave's state folder, removed at the end of each pass of the lot; short because Chrome's Unix sockets live there and are limited to 107 characters); the **lead** decides, re-verifies and delivers. The **worktree mode** (`orchestrate.worktrees: true` in `cadence.yaml`: independent lots of one repository in parallel, each in its own git worktree) is on in cadence's own `cadence.yaml` since 2026-10-25 (L320, after the trials L310 and L316: −45 % and −22 % of wall time, three automatic integrations without incident); a project that does not set the key keeps one lot at a time in the repository ([docs/orchestrate.md](orchestrate.md#one-worktree-per-lot-orchestrateworktrees-l279)).
Four [Claude Code](https://claude.com/claude-code) skills, three reviewer agents and a status-band plugin (`cadence-hud`) turn it into rituals.

## Start

```sh
npm install -g @sylad/cadence    # or: npx -p @sylad/cadence raf …
raf init                         # .cadence/raf.yaml + .cadence/notes/ + a post-commit hook
                                 # (a legacy docs/plan/raf.yaml is still read until moved: `raf migrate` moves it, see docs/raf.md)
raf add "My first lot" --estimate 1
```

Then `raf start L1`, commit with `feat(L1): …`, `raf now` to see where you are, `raf done L1` when it is finished. A title gone stale after a change of scope is replaced with `raf title L1 "new title"` (any status, the old one is kept in a dated note). A lot that occupies a resource shared between projects says so with `raf add --uses banc` or `raf uses L1 banc`, the folder's `cadence.yaml` lists the resources (`resources: [banc]`), and `raf check` refuses a name that is not declared ([docs/raf.md](raf.md#shared-resources-uses-and-resources)); `cadence lead hold <label>` / `lead release <label>` declare the sessions the lead starts by hand so that they are subtracted from the free slots of `orchestrate --status` and `lead tour` ([docs/lead.md](lead.md#lead-hold-and-release)); `cadence lead tour` and `orchestrate --continue` list, next to the free slots, the ready lots whose resources no `doing` lot (in any project sharing them, at every `depth:` of the declaring `cadence.yaml`) or live wave holds (`--json`: `free`); the `lead` skill reads that list again each time an agent comes back or a lot is blocked, before waiting).

## Install as a Claude Code plugin

The repository is its own [Claude Code](https://claude.com/claude-code) plugin marketplace. In a Claude Code session:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence@cadence        # skills /cadence:session-start, session-close, deliver, lead, orchestrate + the three reviewer agents
/plugin install cadence-hud@cadence    # the status band above the prompt
```

The two plugins are independent. `cadence@cadence` carries the rituals, which call the **`cadence` CLI** (`raf`, `session`, `deliver`, …): install it too with `npm install -g @sylad/cadence`, the plugin does not bring it. `cadence-hud` works without the CLI; only its per-project plan progress needs `cadence` on the `PATH`. Without the plugin, `cadence skills install` copies the skills and agents into the repository. Details: [docs/skills.md](skills.md) and [docs/cadence-hud.md](cadence-hud.md).

## Where to read more

| Page | What it covers |
|---|---|
| [docs/quickstart.md](quickstart.md) | getting started as a lead of several projects, in 10 minutes: install, the parent folder, `raf init`, the tour, the first wave |
| [docs/with-your-tools.md](with-your-tools.md) | cadence next to a tracker, `HANDOFF.md`, ADRs and a commit convention: what it does not replace, what is optional, what plugs in (`plan:` read-only, `plan.commit`, `docs.sync`), what it adds |
| [docs/raf.md](raf.md) | the plan: commands, plan file, foreign plan formats, Gantt |
| [docs/orchestrate.md](orchestrate.md) | waves of sessions: budgets, spec, accept and review steps, neighbouring repositories, one worktree per lot (`orchestrate.worktrees: true`, on in cadence's own `cadence.yaml`, off by default elsewhere; `--integrate`, `--replay`, `--remove-worktree`; recovery of a handed-back lot's branch and the `CHANGELOG.md` union at the integration are described there) |
| [docs/deliver.md](deliver.md) | delivery: wait for CI, deploy, verify the effect |
| [docs/releasing.md](releasing.md) | releasing: `cadence release patch\|minor\|major` prepares the version commit (version fields, CHANGELOG, `docs/whats-new.md` check) and prints the lead's steps; nothing is published by it |
| [docs/spec.md](spec.md) | the screen and back-end sheets, `cadence spec check\|qa\|reseal\|green` |
| [docs/lead.md](lead.md) | the lead workflow and `cadence lead tour` |
| [docs/ref.md](ref.md) | reference documents: `cadence ref add` (rendered pages, positioned text, images, figure index), `cadence ref measure` (colours, WCAG contrast, boxes, OCR, font size), `cadence ref check` (the inventory schema, `templates/inventaire.json`), `cadence ref eval` (recall, precision, false « read », tokens per page against a known inventory), `cadence ref corpus` (the synthetic corpus with a known truth, rendered by Playwright) `cadence ref coverage` (which elements of the inventory no done lot covers, nor a written exclusion), `cadence ref diff` (reconciles two readings of a document by program) and `cadence ref analyse` (one reading by the `reference-analyst` agent; `--double` for two independent readings, `ref diff`, a third look by `reference-verifier` and the reconciled inventory, an option whose measurement showed no gain; 20 pages at most per reading) |
| [docs/stabilite.md](stabilite.md) | what is guaranteed from 1.0.0 and what is not |
| [docs/qualite.md](qualite.md) | code-quality guard rails: ESLint (typescript-eslint, sonarjs), knip and jscpd compared to a versioned baseline by a ratchet (`npm run qualite`, `--init`, `--ecrire`, `--migrer`, `--contre`), in the wave's gate and the CI; the recipe for TypeScript, Python, Java and shell |

Also: [news](news.md) (changelog, UX, code and QA reviews, documentation that follows the code), [quality](qualite.md), [session](session.md), [corrections](corrections.md), [perf](perf.md), [skills and agents](skills.md), [cadence-hud](cadence-hud.md), [releasing](releasing.md), [overview](overview.md), [how it all works](fonctionnement.md) (four figures).

<details>
<summary>The four tools in short</summary>

- **raf** (French *reste à faire*, "what is left to do"): the plan, linked to your commits by the lot id in the message, computed from `git log` and never stored.
- **news**: a user-facing changelog with screenshots, tied to the plan; a lot is not done until its entry is written.
- **session**: `session start` and `session close` gather the facts of a work session (each lot in progress shows its commit count, `0 commit` included, next to its last activity).
- **deliver**: wait for the CI of the pushed commit, run the deploy commands, then **verify the effect**; a delivery is done only when its checks pass. A failed delivery is logged as a *red delivery* with its class (refusal, CI, deploy, check) and the last lines of the failing command's output. While a wave runs, `cadence deliver --sha <sha>` is accepted when no commit of the sha belongs to a lot that is not ready, so a ready lot ships while the wave runs. Outside a wave, `--sha` refuses a range that holds commits of a lot that is neither done nor ready (its code review covering its commits up to the sha, not above), and `--dry-run` lists the lots of the range with their state (L474).
- **auto-verification** (L236): before it reports, an `implement` or `fix` session re-reads the complete diff of its lot (of its fix commits, in `fix`) against the grid of the `code-reviewer` (code bug, architecture drift, architecture documentation, edge cases, one test per changed behaviour), fixes what it finds and writes an « auto-vérification » paragraph in its report; the measure is `cadence corrections --classify` and the share right the first time of `cadence perf`.
- **real walkthrough and decisions** (L344): once the tests are green an `implement` session plays what it delivered as a user (the command in a throwaway repository following its own documentation, the screen in each state with the failure in view) and reports it under « parcours réel »; the notes of the lot and of its parent that record a decision of the human reach the `implement` and `fix` briefs under « Decisions to respect », a departure being a question, never a choice (`docs/orchestrate.md`).
- **perf**: `cadence perf` is the dashboard of the workflow (speed next to quality, `⚠` on a trend), including the red deliveries and the blocking QA findings; `cadence lead tour` opens with its *perf header*, one line per `⚠`, nothing when stable; a rise of the tokens per lot names the step that carries it, and when the share right the first time rose too it reads as quality paid for, not a wrong estimate ([docs/perf.md](perf.md)).
- **doc-keeper** (L306): a generic agent that reads the diff of a lot and the project's map of documents (`docs.sync`, README, `docs/`, CHANGELOG, news), says which documents must change and updates them (or only lists them, read-only); `cadence orchestrate` calls it before the review when `docs.sync` reports a document behind the lot (a lot never ends ready with that gap open: the documentation is written, or the gap is acknowledged with `raf docs-ok <lot> --reason`, L317), the lead by hand; a document outside the repository only through the `docs.articles` key of the project's `cadence.yaml` (it then proposes a lot, never writes it) ([docs/news.md](news.md#the-librarian-doc-keeper)).
- **reference-planner** (L367): an agent that reads an inventory and the plan and proposes lots that cite the ids they cover, feasible or blocked, with their dependencies; it creates nothing (`cadence ref coverage` lists what is left).
- **reference-analyst** (L265): an agent that reads one reference document (mock-ups, a spec with figures, a norm) page by page and zone by zone, measures with `cadence ref measure`, and writes a reading (`lectures/a.json`) in the format of `templates/inventaire.json`; `cadence ref analyse` launches it for one reading and has the program check the file and count the tokens (once by default; with `--double` (L266) twice, readings A and B in `lectures/a.json` and `b.json`, which must not see each other; [docs/ref.md](ref.md#cadence-ref-analyse-documentpdf---sections-3-59---slug-name---model-sonnetopushaiku---model-b-sonnetopushaiku---seuil-30---double)).
Reviews are opt-in gates: `ux-reviewer` (no user-facing change is done before its usability review), `code-reviewer` (no lot with commits is done before its code review) and `qa-reviewer`, which walks the delivered app in a real browser.

</details>

## What's new

Two lines per version, then one paragraph per version, in [whats-new.md](whats-new.md); the full history, with dates, is in [CHANGELOG.md](../CHANGELOG.md).
