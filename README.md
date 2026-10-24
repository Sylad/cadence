# cadence

A small working method that lives in your repository: a versioned plan linked to your commits, waves of fresh AI sessions driven by a program, and deliveries proved by their effect.
Solo developers and AI-assisted sessions lose track of *what is left to do* and *what each commit was for*; cadence keeps both in plain files next to the code.
**raf** is the plan, **news** the changelog with screenshots, **session** the facts to open and close a day, **deliver** waits for the CI, deploys, then checks the effect.
**orchestrate** runs a lot through spec, review, code and UX passes, each in its own session (with a short `TMPDIR` of its own, `<os tmpdir>/cadence-<hash>`, outside the repository and the wave's state folder, removed at the end of each pass of the lot; short because Chrome's Unix sockets live there and are limited to 107 characters); the **lead** decides, re-verifies and delivers. An **experimental** worktree mode (`orchestrate.worktrees: true` in `cadence.yaml`: independent lots of one repository in parallel, each in its own git worktree) is built but **refused**, on start and on `--resume`, without `CADENCE_EXPERIMENTAL_WORKTREES=1`; lots L299–L301 must be done before it is enabled ([docs/orchestrate.md](docs/orchestrate.md#one-worktree-per-lot-orchestrateworktrees-l279)).
Four [Claude Code](https://claude.com/claude-code) skills, three reviewer agents and a status-band plugin (`cadence-hud`) turn it into rituals.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/cycle-vague-dark.svg">
  <img alt="A lot goes through spec, mockup, accept, implement, review, ux and deliver; the lead picks the lots, answers the questions, re-verifies and delivers" src="docs/cycle-vague-light.svg">
</picture>

## Start

```sh
npm install -g @sylad/cadence    # or: npx -p @sylad/cadence raf …
raf init                         # .cadence/raf.yaml + .cadence/notes/ + a post-commit hook
                                 # (a legacy docs/plan/raf.yaml is still read until moved: `raf migrate` moves it, see docs/raf.md)
raf add "My first lot" --estimate 1
```

Then `raf start L1`, commit with `feat(L1): …`, `raf now` to see where you are, `raf done L1` when it is finished. A title gone stale after a change of scope is replaced with `raf title L1 "new title"` (any status, the old one is kept in a dated note). A lot that occupies a resource shared between projects says so with `raf add --uses banc` or `raf uses L1 banc`, the folder's `cadence.yaml` lists the resources (`resources: [banc]`), and `raf check` refuses a name that is not declared ([docs/raf.md](docs/raf.md#shared-resources-uses-and-resources)); `cadence lead hold <label>` / `lead release <label>` declare the sessions the lead starts by hand so that they are subtracted from the free slots of `orchestrate --status` and `lead tour` ([docs/lead.md](docs/lead.md#lead-hold-and-release)); `cadence lead tour` and `orchestrate --continue` list, next to the free slots, the ready lots whose resources no `doing` lot (in any project sharing them, at every `depth:` of the declaring `cadence.yaml`) or live wave holds (`--json`: `free`); the `lead` skill reads that list again each time an agent comes back or a lot is blocked, before waiting).

## Install as a Claude Code plugin

The repository is its own [Claude Code](https://claude.com/claude-code) plugin marketplace. In a Claude Code session:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence@cadence        # skills /cadence:session-start, session-close, deliver, lead + the three reviewer agents
/plugin install cadence-hud@cadence    # the status band above the prompt
```

The two plugins are independent. `cadence@cadence` carries the rituals, which call the **`cadence` CLI** (`raf`, `session`, `deliver`, …): install it too with `npm install -g @sylad/cadence`, the plugin does not bring it. `cadence-hud` works without the CLI; only its per-project plan progress needs `cadence` on the `PATH`. Without the plugin, `cadence skills install` copies the skills and agents into the repository. Details: [docs/skills.md](docs/skills.md) and [docs/cadence-hud.md](docs/cadence-hud.md).

## Where to read more

| Page | What it covers |
|---|---|
| [docs/raf.md](docs/raf.md) | the plan: commands, plan file, foreign plan formats, Gantt |
| [docs/orchestrate.md](docs/orchestrate.md) | waves of sessions: budgets, spec, accept and review steps, neighbouring repositories, one worktree per lot (experimental, not enabled: `orchestrate.worktrees: true` is refused until L299–L301 are done; `--integrate`, `--replay`, `--remove-worktree` belong to it, and a new wave of a lot handed back recovers its branch) |
| [docs/deliver.md](docs/deliver.md) | delivery: wait for CI, deploy, verify the effect |
| [docs/spec.md](docs/spec.md) | the screen and back-end sheets, `cadence spec check\|qa\|reseal` |
| [docs/lead.md](docs/lead.md) | the lead workflow and `cadence lead tour` |
| [docs/ref.md](docs/ref.md) | reference documents: `cadence ref add` (rendered pages, positioned text, images, figure index), `cadence ref measure` (colours, WCAG contrast, boxes, OCR, font size), `cadence ref check` (the inventory schema, `templates/inventaire.json`), `cadence ref eval` (recall, precision, false « read », tokens per page against a known inventory) and `cadence ref corpus` (the synthetic corpus with a known truth, rendered by Playwright) |
| [docs/stabilite.md](docs/stabilite.md) | what is guaranteed from 1.0.0 and what is not |

Also: [news](docs/news.md) (changelog, UX, code and QA reviews, documentation that follows the code), [session](docs/session.md), [corrections](docs/corrections.md), [perf](docs/perf.md), [skills and agents](docs/skills.md), [cadence-hud](docs/cadence-hud.md), [releasing](docs/releasing.md), [overview](docs/overview.md), [how it all works](docs/fonctionnement.md) (four figures).

<details>
<summary>The four tools in short</summary>

- **raf** (French *reste à faire*, "what is left to do"): the plan, linked to your commits by the lot id in the message, computed from `git log` and never stored.
- **news**: a user-facing changelog with screenshots, tied to the plan; a lot is not done until its entry is written.
- **session**: `session start` and `session close` gather the facts of a work session (each lot in progress shows its commit count, `0 commit` included, next to its last activity).
- **deliver**: wait for the CI of the pushed commit, run the deploy commands, then **verify the effect**; a delivery is done only when its checks pass. A failed delivery is logged as a *red delivery* with its class (refusal, CI, deploy, check) and the last lines of the failing command's output. While a wave runs, `cadence deliver --sha <sha>` is accepted when no commit of the sha belongs to a lot that is not ready, so a ready lot ships while the wave runs.
- **auto-verification** (L236): before it reports, an `implement` or `fix` session re-reads the complete diff of its lot (of its fix commits, in `fix`) against the grid of the `code-reviewer` (code bug, architecture drift, architecture documentation, edge cases, one test per changed behaviour), fixes what it finds and writes an « auto-vérification » paragraph in its report; the measure is `cadence corrections --classify` and the share right the first time of `cadence perf`.
- **perf**: `cadence perf` is the dashboard of the workflow (speed next to quality, `⚠` on a trend), including the red deliveries and the blocking QA findings; `cadence lead tour` opens with its *perf header*, one line per `⚠`, nothing when stable ([docs/perf.md](docs/perf.md)).
- **doc-keeper** (L306): a generic agent that reads the diff of a lot and the project's map of documents (`docs.sync`, README, `docs/`, CHANGELOG, news), says which documents must change and updates them (or only lists them, read-only); `cadence orchestrate` calls it before the review when `docs.sync` reports a document behind the lot, the lead by hand; a document outside the repository only through the `docs.articles` key of the project's `cadence.yaml` (it then proposes a lot, never writes it) ([docs/news.md](docs/news.md#the-librarian-doc-keeper)).
Reviews are opt-in gates: `ux-reviewer` (no user-facing change is done before its usability review), `code-reviewer` (no lot with commits is done before its code review) and `qa-reviewer`, which walks the delivered app in a real browser.

</details>

## What's new

Two lines per version; the long form is in [docs/whats-new.md](docs/whats-new.md) and the full history, with dates, in [CHANGELOG.md](CHANGELOG.md).

- **1.8.0**: `cadence perf` shows the speed of the workflow next to its quality (cost in euros per delivered lot, red deliveries, blocking QA findings), and `cadence lead tour` opens with a perf header.
- **1.7.0**: `cadence orchestrate` no longer replays `accept` on a green sealed acceptation and refuses `--resume --dry-run`; `spec reseal --porteur` accepts a sheet amended by a delivered lot; the README becomes a short home page.
- **1.6.0**: the mockup review sweeps everything in its first report and runs up to `orchestrate.maquetteReviews` times (3 by default); the acceptance lock names the first offending commit.
- **1.5.1**: publishes 1.5.0 (tagged, never published): one UX review per lot, replay of a lot handed back for its budget, a self-check list in the briefs, a `tests.yml` workflow.
- **1.5.0**: `gate: { count: N, … }` makes a lot wait for N done lots of a kind; `raf todo <id>` puts a started lot without work commits back to `todo`.
- **1.4.0**: `cadence spec reseal` accepts a sheet amended by the lot's commits; wave budgets recalibrated; a `git checkout` in a session no longer stops the wave.
- **1.3.0**: the spec step narrows to `screen: page`; `cadence spec reseal … --porteur` re-seals an unstable test; `cadence orchestrate --waits`; a third correction pass when the review converges.
- **1.2.0**: the spec step reaches lots without a screen (`spec: true`), `orchestrate.accept` may be a list of runners, `lead.ux: lead`, and the code in service is a separate worktree.
- **1.1.0**: the spec step of `cadence orchestrate`: screen sheet, reviewed mockup, red locked acceptance tests, and briefs that carry rule → test → green.
- **1.0.0**: the first major release, a stable contract that follows semantic versioning; the [stability page](docs/stabilite.md) lists what is guaranteed.

<details>
<summary>Older versions (0.10.0 to 0.28.0)</summary>

Each is a paragraph in [docs/whats-new.md](docs/whats-new.md) and a full section in [CHANGELOG.md](CHANGELOG.md): `cadence-hud` (0.12.0 to 0.25.0), `cadence orchestrate --continue` and `--status --watch`, `cadence lead tour`, `hook.autostart`, `docs.sync` and `docs.articles`, neighbouring repositories, `raf ignore`.

</details>

## License

MIT
