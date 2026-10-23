[← cadence](../README.md)

# orchestrate

`cadence orchestrate` is a program above `/lead`, not a conversation: for each lot you choose, it runs
a **fresh** `claude -p` session per step with a short brief, reads the result, writes the state in
files and moves on. The lead session keeps only the decision (which lots), the final table and the
questions. Nothing is resumed: a correction is a new session, never the author's reopened. The one
exception is a **formatting retry** (below).

```sh
cadence orchestrate finance-tracker:L41 ol-companion:L22 cadence:L18@haiku
cadence orchestrate L18                      # from inside a project
cadence orchestrate maritime-atlas:Q4/accueil-4-ux12@haiku   # a lot id may contain "/" (sub-tasks of read-only plans)
cadence orchestrate maritime:B28.4 --goal "…"   # the goal replaces the stale title as the objective of the briefs (below)
cadence orchestrate … --budget 1.5M          # 1500000, 1.5M, 800k; default 2M
cadence orchestrate … --max-sessions 3       # sessions running at the same moment, all waves together; default 2
cadence orchestrate … --dry-run              # preconditions + the plan of the wave; nothing is started
cadence orchestrate --continue [--until 18:00] [--priority cadence,maritime]   # the wave draws the next ready lot itself (below)
cadence orchestrate --waits [--since 2026-10-12]   # time spent waiting for a session slot, per day and per wave (below)
cadence orchestrate --status [<wave>]        # the live waves and the repositories they hold, then the table (default: the last wave of this folder)
cadence orchestrate --status [<wave>] --watch [--interval 10]   # the same, redrawn every 10 s (--interval in seconds); stops by itself when no wave is running (with an explicit `<wave>`: when that wave is no longer running)
cadence orchestrate --resume [<wave>] [--budget 1M] [--answer ol-companion:L22 "reply"] [--drop ccc:L29]
cadence orchestrate --resume <wave> --budget maritime:B26.4=+300k   # replay a lot handed back for its budget, with the budget raised (below)
cadence orchestrate --resume … --dry-run                         # refused: a resume cannot be simulated, it writes the wave state and relaunches sessions
cadence orchestrate --drop ccc:L29 [--wave <wave>]   # from another terminal: take a lot out of the running wave
cadence orchestrate --stop-after-current [--wave <wave>]   # from another terminal: let the running sessions finish, start nothing else
```

**`--drop` and `--stop-after-current` — steering a running wave (L79)**: both are run from the folder the wave was launched
from (`--wave <id>` when several waves run from it), and write a request in the wave's state folder
(`.cadence/runs/<wave>/control.log`, append-only), which the wave reads before each session — no signal, no edit of
`journal.log`. `--drop <project:lot>` (repeatable) takes a lot out of the wave: a lot not started yet never starts (no
`raf start`); a lot with a session running **lets that session finish** (it is not killed), then plays no other: it is
*handed back* (`retiré de la vague (--drop)`), its commits stay, and a lot that depended on it is handed back too. A lot
waiting for an answer (`question`) is handed back as well, at the end of the wave or on `--resume --drop`, instead of staying in
question forever. A lot that is unknown or already finished is refused (exit 2). `--stop-after-current` lets the sessions running finish, starts no
other session nor lot (`arrêt demandé (--stop-after-current)`), and leaves the wave **interrupted** and resumable
(`--resume`, which forgets the stop; `--continue` draws nothing more). Neither combines with lots to launch,
`--continue`, `--dry-run`, `--budget` or `--answer`, nor `--status`; without a live wave from that folder they are refused
(exit 2). A stopped wave is no longer live, so to take a lot out of it use **`--resume --drop <project:lot>`**: the lot is
handed back instead of being replayed (an unknown or finished lot is refused, exit 2, before anything runs). A lot taken out
this way is left out of the resume checks (repository lock, `.nvmrc` Node, dirty tree): only the lots that will be replayed can
refuse the resume, and a refusal writes nothing to `control.log`.
`--resume --stop-after-current` is refused (exit 2): resuming contradicts stopping.

**`--goal "…"` and `goal:` — the objective of the briefs when the title is stale (L258)**: the first line of the `{{objectif}}` of every
brief of a lot (and the title quoted in their first sentence) is the lot's title; when a change of scope made it stale, the lead no longer
has to delegate by hand. Three ways to give the goal, in this order of precedence (`--goal`, then the plan's key, then the title):
- `--goal "…"` on the command line: `cadence orchestrate maritime:B28.4 --goal "…"`. It takes **exactly one launched lot** (two lots,
  `--continue`, `--resume`, `--status` are refused, exit 2, with nothing written); an empty text, or one starting with `--` (a forgotten
  text: `--goal --dry-run` would otherwise swallow the option and start a real wave), is refused.
- the `goal:` key of the lot in a **native plan** (`.cadence/raf.yaml`): `goal: Dedup on merge, bank line kept`.
- on a plan **kept by another tool** (read-only, mapped by `plan.fields` in `cadence.yaml`, e.g. maritime's `docs/plan/taches.yaml`): map the
  key that holds the goal, `plan.fields: { goal: objectif }` (a list takes the first key present, like the other fields); without that
  mapping only a key literally named `goal` is read (a field left out is read under its own name), any other key is ignored without a message.
The key is read for every lot of a launch, so it is the way to give a goal to several lots at once, on both plan kinds (the lot of the plan is
never written: cadence only reads it). The notes and sub-tasks of the lot stay in the objective. The goal read at launch is kept in the state
of the lot and is the only source afterwards (briefs, `--dry-run`, table): a `--resume` replays the sessions with the goal of the launch, and
a `goal:` added or changed in the plan since is not read (to change it: `--resume --drop` the lot and launch it again). `--dry-run` prints
`objectif donné : …` under the lot, and the table of the wave repeats it (`<project>:<lot> — objectif donné : …`) so the lead sees which
objective the sessions worked from.
The review and UX briefs carry it too, on a line `Goal of the lot (it takes precedence over the title in the plan): …`, and `code-reviewer` / `qa-reviewer` measure the commits against it, not against the stale title still in a read-only plan.

**`--resume --budget <project>:<lot>=+N` — replaying a lot handed back for its budget (L223)**: a lot handed back with
`correction non jouée (budget)` or `budget du lot atteint` kept its findings but not its budget, and a plain `--resume` does not replay a
finished lot. `--budget maritime:B26.4=+300k` (the project may be left out when only one project carries the lot; the option is
repeatable for several lots, and `--budget 1M` still raises the wave's budget — the `=` tells them apart) puts the lot back in play:
its budget becomes **what its sessions already counted plus N** (849 k spent of 750 k, `=+300k`: 1 149 000), its outcome is cleared,
and the step that was not played (`fix`, `implement`, `spec` or `accept` — the only ones a lot budget bounds; a review is never handed
back for it) runs in a **new session** (never `claude --resume` on the earlier one) with the findings the lot kept, then the normal cycle
goes on: review, verdict recorded with the sha re-read and the plan committed. Nothing is recorded twice, since a lot handed back for
its budget never had a compliant review. The reserve rule is unchanged: a `fix` leaves only if spent + 155 000 < the new budget,
so N of at most 155 000 on a `fix` is refused, and a budget still too small hands the lot back again with the same text. The wave's own budget
and quota still apply (exhausted: the lot stays suspended, exit 3). A wave that is `done` is resumed this way when a lot is named; without the
option it is still refused. The named lot undergoes the checks of a live lot (dirty tree, repository held by another orchestration, `.nvmrc`
Node). Refused with exit 2, before anything is written: a malformed `projet:lot=+N` or an option without `--resume`, an unknown or
ambiguous lot (`projet:lot` is then asked), a lot that is not handed back for its budget with a write step to replay, a lot named twice
(`p:L` then `L` counts) or also named by `--drop` or `--answer`.
A wave runs on its own snapshot of the tool, but one launched before L223 would refuse `projet:lot=+N` as an invalid budget:
for such a wave (B26.4's included) the resume that names a lot runs on the current `dist/` instead, with a warning on the error output.
A wave runs on its own snapshot of the tool: one launched before L79 never reads `control.log`, so the request is written but the
command warns `ne lit pas les demandes de contrôle` on the error output.

**`--continue` — idle time (L147)**: lots given on the command line open the wave (none: the first ones are drawn from the
plan too); then, each time the lots in play are finished, the wave **draws the next ready lots of the plan** — up to the
session cap — and plays them in the same wave (same budget, same state folder, journal line `continue : tire …`). A lot
is drawn when it is `todo`, its `after` is lifted, it is not recurring, neither its title nor a note says « à décider »
(« à décider avec … », « (à décider) »: a lot waiting for a human decision), it is not already in the wave, and its own budget (derived from its estimate; a lot with `screen: page` is worth 1.3 M whatever its estimate (`component` and `journey` have their ordinary budget), or its ordinary budget plus the 450 k spec-stage allocation if that is more, and a lot with `spec: true` gets that allocation on top of its ordinary budget)
fits in the budget left — otherwise the next one that fits is taken (a lot that does not fit in what is left of the current
round is not dropped: it is tried again at the next round, once the budget allows it). A round takes at most **one lot per
repository** while other repositories have ready lots — the pool plays the lots of one repository one after the other, so a
second one would leave a session idle — and is completed with the same repository when nothing else is ready. Projects are visited in the declared **priority**:
`--priority cadence,maritime`, or a `priority: [cadence, maritime]` list in the `cadence.yaml` of the folder you launch from
(the parent of the projects); a name also covers `name-…` (`maritime` → `maritime-atlas`), the other projects come after, in
alphabetical order. Launched from inside a project, only that project is drawn. A `priority:` key that cannot be read is refused before anything
starts, lots given or not. A candidate that preflight refuses (dirty tree, Node missing…) is skipped with its cause in the
journal (`continue : lot sauté — <cause>`; for the first draw also on the error output). Drawing stops — `continue : arrêt — <reason>` — at: the budget, the
time window (`--until HH:MM`, today's clock: nothing new is drawn from then on, a running lot is not cut), the usage limit,
a question asked (the wave stays resumable with `--answer`), two lots handed back in a row, an interrupted wave, a `--stop-after-current` request (`arrêt demandé`, even when the last running
lots finished cleanly), or no ready
lot whose estimate fits the budget left. `--resume … --continue` draws again after the resumed lots. When the wave starts, `--continue` (and its `--dry-run`) prints the line `prêts, ressources libres : <project>:<lot> <title> (<resources>) · …` that `cadence lead tour` prints (L252): the ready lots, from every project of the folder, whose `uses:` resources (`raf uses`, `resources:` of the parent `cadence.yaml`) are held neither by a lot `doing` (of the folder's projects, and of every project that shares their resources: those under the folder whose `cadence.yaml` declares `resources:`, walked with its `depth:`, one level by default, so launched from a group or from inside one project it still sees the others) nor by an unfinished lot of a live wave nor by the lots of the first draw of the wave that starts (a lot of a wave is recognised by its repository and its id, not by the project name; those lots, and the ready lots that compete with them for a resource, are not listed); at most 3 lots per project, then `<project> +K`; nothing is held back by it, the draw below is unchanged. `--dry-run --continue` replays the
draws round by round with the same function as the wave (one lot per repository per round, pre-check, budget counted on the estimates) and
names the candidates skipped with their cause: `tour 1 : a:L2, b:L2 · tour 2 : a:L3, a:L4`. Drawing happens between rounds: a round of up to `--max-sessions` lots must finish before the next draw.

**Chaining without the human (L148)**: the `lead` skill, once the human has chosen the first lots and the order, does not ask « next? »
after a lot that comes back ready: it re-verifies it, records `raf done`, pushes, delivers, has the `qa-reviewer` check the
delivered app, then starts the next wave with `--continue`, in the declared priority — one project at a time, within the two-session
limit. Before each new wave it reads the context of its own session with `cadence session context` (the figure of the `ctx` segment of the `cadence-hud` band, which publishes the context of each session to `~/.cadence/orchestrate/hud-context/<session id>.json`; the command picks the file named by `$CLAUDE_CODE_SESSION_ID`, set in the environment of the session's Bash, never "the latest file of the folder" — two sessions of one folder alternate; without the band loaded in that session the command exits with code 2, and a missing or stale figure counts as at the threshold); from
**60 %** upward it starts nothing: it runs `session-close` in each project touched, writes its memory and records three lines for next
time (`cadence session next`). Stays with the human: the first choice and the order, the questions a session raised, the UX
reservations; a lot that is not ready, a red delivery or a blocking QA finding is reported and not chained over.

**Who gives the UX verdict (L197)**: by default the human looks at the `ux-reviewer`'s captures and gives the verdict of a `visible`
lot (`raf ux`). A human who is not a UX judge can set, in the `cadence.yaml` of the folder the `lead` skill works from:

```yaml
lead:
  ux: lead     # lead | human — default human, nothing changes without the key
```

With `lead.ux: lead` the lead forms the verdict itself, from the reviewer's report and its own look at the captures, records
`raf ux` and goes on; the human is consulted only at the slightest doubt (a reservation it cannot settle, a capture it
cannot read, a matter of taste), and the chain goes on with the other lots meanwhile. `cadence lead tour` prints
`verdict UX : lead …` as a last line when the setting is on (not part of `--json`), and `cadence.yaml · ✗ erreur : lead.ux doit
être « lead » ou « human »` for any other value. The setting is read from the parent folder only: a project's own `cadence.yaml` ignores it.

**Lot ids containing `/` (L120)**: the first `:` separates the project from the lot, a final `@` the model, and the lot
keeps its `/` (`maritime-atlas:Q4/accueil-4-ux12@haiku`); this holds for `--dry-run`, `--status`, `--resume` and
`--answer` too. In `.cadence/runs/<wave>/` the `/` of the lot becomes `__` (`maritime-atlas--Q4__accueil-4-ux12.json`,
same for the lot folder and the dry-run briefs); ids without `/` are unchanged.

You choose the lots; the order is the order given (one queue per repository, as many repositories at the
same time as the session cap allows — 2 by default). `@haiku|@sonnet|@opus` sets the model of the implementation and corrections of that
lot (default Sonnet; reviews are Opus, except the light review below; Haiku only when you write it, for a mechanical lot). Run it
in the background and read `--status`: it prints one line per transition and the final table.

**Following a wave (L49)**: `--status --watch` clears the screen and redraws the live waves and the table every
`--interval` seconds (default 10), then stops by itself, leaving the last render, as soon as no wave is running
(exit code 0, like `--status`; a wave already finished gives a single render). The `cadence-lead` skill names the background
task « vague `<id>` : `<project>:<lot>`, … », starts the wave with `--wave <id>` and arms a follow-up on
`.cadence/runs/<id>/journal.log` that pushes each transition (lot → state, question, ready, handed back) into the conversation.
The Claude Code status band is the `cadence-hud` plugin.

**Cycle of a lot**: preconditions (clean tracked files, lot `todo` or `doing`, dependencies met) →
`raf start` (committed alone) → implementation → **code review** → compliant (no blocking, no
major finding) → **UX review** if the lot is `visible` and the app is declared, **once**, on the code the review
found compliant (L221) → `raf review` is recorded by the orchestrator with the sha the *code* review read (the UX
verdict stays in the lot state, `uxVerdict`), then "ready to deliver". Not compliant → a correction in a new session,
then a new code review, with no UX session in between; a UX review that finds a blocking or major point sends the lot
to a correction (which receives the UX findings), then the code review, then the UX review again. **Two passes at most** (a third when the review converges: the count of blocking + major findings dropped
since the previous review and exactly one is left; the lot budget still applies), then the lot goes back to
you with the findings. A small lot (`estimate` ≤ 0.5 or `quickwin`) gets one single Opus pass for code and
usability (code only when the lot is not `visible`). Failing tests (reported red, or red when
`orchestrate.test` is run) go straight to a correction.

**One UX review per lot (L221)**: the UX review of a `visible` lot used to run before the code review and again after every correction (finance L75 on 2026-10-15: three Opus UX sessions for one useful verdict). It now runs once, as the last step, on the code the review found compliant: after the single pass on minor findings and its short review when there is one. Without `orchestrate.ux`, or when the app does not start (port taken, silent app), no UX session is played: the lot concludes on the compliant code review and keeps its note (« UX à faire par le lead », « UX non vérifiée : … »). The lot budget bounds writing, never this review; an exhausted wave budget suspends it like any session. Every write step (implementation, correction) clears the lot's UX state (`ux`, `uxVerdict`, UX findings), so a stale UX verdict never sends a compliant code review back to a correction. A resumed wave whose state says `next = ux` (written before this change) replays the code review first unless the last compliant one read the current `HEAD`. The recorded `raf review` verdict and sha are the code review's; a commit made by someone else since that review hands the lot back, as before. A small lot and a lot with no screen keep their single review. The measure before/after is in [`docs/mesures/ux-une-fois-2026-10-15.md`](mesures/ux-une-fois-2026-10-15.md).

**Tests already red at the start (L213)**: a lot is no longer handed back « tests rouges » for failures that were there before it. When `orchestrate.test` fails (or the session reports red tests), the program reads the failing tests from the runner's output (vitest/jest `FAIL`/`●`, pytest `FAILED`, go `--- FAIL:`, TAP `not ok`), replays the same command at the sha the lot started from (the parent of the lot's oldest work commit, plan-only commits left out, else the `HEAD` before its first session) in a throwaway `git worktree` outside the repository, and compares: if every failing test was already red, it is not a defect of the lot — no correction pass, the code review takes place, the reviewer is told, and the final table lists them apart (`déjà rouge au départ (<sha>) : <test>`, 30 at most then a count). The worktree gets links to the repository's ignored folders at any depth, such as `.venv` and, in a monorepo, `packages/*/node_modules`, when their parent exists at that sha; build outputs such as `dist` or `coverage` are left out. Each `node_modules` is rebuilt entry by entry, every entry linked to the live one except the workspace links of npm, pnpm and yarn (`node_modules/@x/shared -> ../../packages/shared`, a link to code of the repository outside any `node_modules`), which are remade towards the worktree's own copy so that the start sha is tested against its own sources, not the lot's (a workspace package that does not exist at the start sha gets no link). Known limit: only `node_modules` links are remade; whatever points into the live repository by an absolute path, such as an editable Python install (`.venv` with a `.pth` file naming the live `src`, `pip install -e`) or an absolute symlink in another ignored folder, still runs the lot's code in the baseline. Likewise, a workspace package consumed through its build output (`main: dist/...`) cannot load in the baseline worktree: output dirs are not linked and nothing is built there, so such a monorepo keeps the pre-L213 « tests rouges » outcome. A lot resumed in a later wave keeps the same baseline: the sha is the parent of its oldest work commit, not the `HEAD` of the new wave, so a failure the lot itself introduced in an earlier wave is never excused. A test red now and not at the start stays a blocking finding, and only that one is given to the correction (the others are counted as « already red »). When the output names no test, or the baseline cannot be run, the tests stay red as before (no comparison is guessed). A failure the output does not tie to a test (unhandled error, a spec file that fails to load such as jest « Test suite failed to run » or vitest `FAIL  a.test.ts [ a.test.ts ]`, coverage threshold) keeps the tests red. Without `orchestrate.test` the program cannot replay anything: a session that reports green tests and lists under `echecsDeBase` the failures it saw at the start sha gets them listed apart, marked « non vérifié » in the table, and the review takes place; a session that reports the tests red stays red, the brief asking it not to report red for base failures alone — unless (L215) the report says so in a structured way: with `vert: false`, a non-empty `echecsDeBase` and an empty `nouveauxEchecs` (the list of tests red now that were not red at the start sha), `vert: false` is not a reason to correct, the lot carries a « non vérifié » warning, the reviewer is told that the baseline is unverified and the review takes place. A non-empty `nouveauxEchecs` with `vert: false` triggers a correction pass (the new failures are in the finding); an absent `nouveauxEchecs`, or an empty `echecsDeBase`, keeps the correction. The program never guesses from the text of the result (« 24 failed »). The `implement` and `fix` briefs ask for `echecsDeBase` and `nouveauxEchecs`.

**Review sized to the lot (L108)**: a lot whose `estimate` is ≤ `orchestrate.review.threshold` (0.25 day by default)
is *light*: one single review (Sonnet by default, `code-reviewer` agent, same criteria), no minors pass — the minors are
returned to the lead as notes (proposals). A blocking or major finding on a light lot still triggers a correction, and
the review that follows is the full one (Opus); the cap of two correction passes is unchanged (except the convergence pass above). A bigger lot keeps the
chain described above (Opus, two corrections, minors pass). `--dry-run` shows « revue légère » on a light lot.

```yaml
orchestrate:
  review: { threshold: 0.25, light: sonnet, full: opus }   # defaults; threshold in days (0 = no light lot), models haiku|sonnet|opus
```

`full` is also the model of the UX review and of the single pass of a small lot that is not light.

**Effort level per pass** (L137). Each session is launched with `claude -p --effort <level>` (Claude Code 2.1.284; an
older `claude` is refused at launch unless every pass is `default`). Defaults: `precheck` low (it only reads),
`implement` and `fix` medium, `review` high (`review-small` follows `review`), `ux` high. A project overrides any of them
in `cadence.yaml`; the levels are `low`, `medium`, `high`, `xhigh`, `max`, and `default` sends no `--effort` (the
level of the session, as before this key). The format-retry session (`--resume`) keeps the level of its pass, and
`--dry-run` shows the flag in each command line, except for a `precheck: local` session: `claude-local` is launched
without `--effort` (see below), so `effort.precheck` has no effect on it and the `precheck (local)` line does not show it.

```yaml
orchestrate:
  effort: { precheck: low, spec: medium, maquette: high, fiche: medium, accept: medium, implement: medium, fix: medium, review: high, ux: high }   # defaults
```

To measure what a level costs, run the same kind of wave before and after changing the key: each step of
`<wave>/<project>--<lot>.json` records its `effort`, its `tokens` and its `started` / `ended` times (a step from a wave
older than L137, or with `default`, has no `effort`); compare the totals per `kind` between the two waves.

**Pre-check « deliverable already present? »** (L77). Before the first implementation of a lot that has no commit yet, a
short read-only session (Sonnet, `precheck` step, brief `templates/orchestrate/precheck.md`) looks in the repository for
what the lot asks for (another lot, or a correction, may have done it already). It answers `oui` (everything is there,
with proofs), `partiel` or `non`: on `oui` no implementation session is opened and the lot is handed back
(`livrable déjà présent : <résumé> (<preuves>)`) for the lead to drop or close it; on `partiel` the finding goes into the
implementation brief and a warning; on `non` — or an unreadable report, which only adds a warning — the wave goes on. A
lot that already has commits is never pre-checked (resuming it is legitimate). `orchestrate.precheck: false` turns it off.

## The spec step of a lot with `screen:`

A lot that declares `screen:` (`raf add … --visible --screen page|component|journey`, or `raf screen <id> page|component|journey` on a lot that already exists, see [raf](raf.md#raf)) gets, when it is `page`, one more session, `spec`, **after** the pre-check and **before**
the first implementation: `precheck → spec → maquette → accept → implement → review → ux` (`maquette` unless `orchestrate.maquette: false`, see [The mockup review](#the-mockup-review-before-any-code); `accept` only when the project declares `orchestrate.accept`, see below). A lot without `screen:` or `spec: true` follows the usual path, unchanged (a lot with `spec: true` and no screen has its own chain, see [The spec step of a lot with `spec: true`](#the-spec-step-of-a-lot-with-spec-true)). `--dry-run` lists the step
(`spec (sonnet)`), its command line and its brief `templates/orchestrate/spec.md`.

- **Threshold** (L209): only `screen: page` enters this chain. The measure of 2026-10-12 (no row of the success table reached, about 570 k tokens per lot, 4.5 correction passes per journey lot) narrowed it: `component` and `journey` stay valid values of `screen:` (no existing plan breaks, `raf screen` still sets them) but a lot that carries one follows the ordinary path and gets the ordinary budget, without the 1.3 M flat rate. A lot already in the chain (its sheet, or its `acceptation-<lot>.json`, exists) keeps its sheet and its lock. The `spec: true` step and the back part of a mixed lot do not change. The next measure covers 8 `page` lots.
- **The session** (L171): Sonnet, the `spec-writer` agent (it writes only the spec folder, never application code), Playwright loaded like for `implement`. It reads the lot,
  the project's CLAUDE.md and its charter (CSS, neighbouring components, `docs/qa/expectations.md`, existing routes and API contracts), then writes in
  `<orchestrate.spec.dir>/<écran>/` (`docs/specs` by default): `maquette.html` (static HTML + CSS to the project's own style; one section `#etat-vide`, `#etat-chargement`,
  `#etat-erreur` and `#etat-charge` per state; every field of the sheet carries `data-testid="<field id>"`), one capture per state and per width
  `maquette-<état>-<largeur>.png` (1440 and 390), and `fiche.yaml` (the template `templates/fiche.yaml` is part of its brief). The mockup is rendered by
  `orchestrate.spec.render` when the project declares it (the session runs that command), otherwise with Playwright; the captures land in the wave's output directory and the session copies the
  kept ones into the folder. `effort.spec` (default `medium`) sets its effort level. It commits the whole spec in one commit that cites the lot (`spec(L7): …`).
- **What the program checks** afterwards, with no model: the sheet passes `cadence spec check`, is the lot's (`ecran.lot`) and sits in the folder named by `ecran.id`; `maquette.html` exists with a
  `#etat-<état>` section per state and a `data-testid` per field; every state has its capture at both widths; everything is committed and the tree is clean. Anything missing is listed back to a fresh `spec` session whose brief names the points, within the lot's session budget: `orchestrate.maquetteReviews` sessions (3 by default) when the mockup review is on (see [The mockup review](#the-mockup-review-before-any-code)), 2 otherwise; if the spec is still not valid on the last one the lot is handed back (`spec non conforme après 3 passes : …`, `après 2 passes` with `orchestrate.maquette: false`).
- **A costly choice is a question, not a hypothesis.** A rule marked `hypothese` whose `si_faux` involves a data model or storage, a public or shared API contract or an already published route,
  a destructive or irreversible action, or a contradiction with a sourced rule, puts the lot in `question` (the program recognises these by keywords as a safety net behind the agent's own
  judgement; a keyword right after a negation — « rien d'irréversible », « sans suppression », « pas de paiement » — does not count); `--resume --answer <lot> "…"` gives the answer to the resumed `spec` session. Every other hypothesis (wording, order of fields, error state, spacing) stays written in the sheet.
  The agent can also ask a question itself in its report.
- **Under the threshold**: if the session finds that the lot changes no screen, it gives the reason in one line (`sousSeuil`), writes no mockup, and the lot goes on to `implement` as before; the reason is
  kept as a warning of the lot. On resume the spec step is skipped only when a sheet of the lot (`ecran.lot` is the lot) already passes the program's checks (`cadence spec check`, mockup, captures) and carries no costly hypothesis; otherwise the spec is played again. The sheet path in the report is relative to the repository (an absolute or `./` path is normalised, a path outside the repository is a finding).

## The spec step of a lot with `spec: true`

A lot that changes a behaviour but has no screen (`raf add … --spec`, or `raf spec <id> on`, see [raf](raf.md#raf); L188, design: [docs/superpowers/specs/2026-10-11-etape-spec-back-design.md](superpowers/specs/2026-10-11-etape-spec-back-design.md)) is specified **before** it is coded, on a sheet, like a screen:
`precheck → spec → fiche → accept → implement → review` (`fiche` unless `orchestrate.fiche: false`; `accept` only when the project declares `orchestrate.accept`). A lot with neither `screen:` nor `spec: true` keeps its path. `--dry-run` lists
`spec (sonnet)`, `fiche (sonnet)` and `accept (sonnet)` with their command lines and briefs `templates/orchestrate/spec-back.md`, `fiche.md` and `accept-back.md`; the lot's budget gets a 450 k allocation on top of its estimate-derived budget (the back chain measured on L120: 388 k).

- **The spec session**: Sonnet, the `spec-writer` agent, no Playwright. It reads the lot, the project's CLAUDE.md and the code and tests of the modules the lot touches (a rule already coded is a source, cited `file:line`), then writes only
  `<orchestrate.spec.dir>/<sujet>/fiche.yaml` in the format of [`templates/fiche-back.yaml`](../templates/fiche-back.yaml) (`sujet`, `cas`, `regles`, `contrats`, `donnees`; no mockup, no capture, no state) and commits it with a message that cites the lot.
  The same rules as for a screen: a rule is `sourcee` or `hypothese` with its `si_faux`, and a hypothesis that hides a costly choice is a question (a stored model, a published contract or route, an irreversible action, a contradiction with a sourced or coded rule — the program's keyword safety net applies as is).
  An optional field added to an existing response is not a break when a rule of the sheet proves the old response unchanged. A lot that changes no behaviour is reported under the threshold (`sousSeuil`, warning `étape spec : sous le seuil, aucune fiche — …`) and follows the usual path.
- **What the program checks**: the sheet passes `cadence spec check`, has a `sujet` block, is the lot's (`sujet.lot`), sits in the folder named by `sujet.id`, and is committed with a clean tree. Anything missing goes back to **one second `spec` session**; still invalid, the lot is handed back (`spec non conforme après 2 passes : …`).
  On a resume the step is skipped when a sheet of the lot (`sujet.lot`) already passes these checks and has no costly hypothesis.
- **The sheet review** (`fiche`): a fresh session of the `code-reviewer` agent in **sheet mode** (Sonnet, read-only, no Playwright; `effort.fiche`, default `medium`). It reads the sheet, then the code, tests and sources of the perimeter, and checks (1) every `sourcee` rule cites a source that exists (it opens the file:line) and no `hypothese` hides a costly choice,
  (2) no contradiction with a rule already coded or an existing contract, (3) every contract has its empty / absent / expired / oversized / duplicate inputs and the failures of its external sources covered by a rule or a motivated `sans_alternative` / `sans_erreur`, (4) every rule has a planned test whose name says what could fail.
  Findings are ranked blocking / major / minor, each with its measurement. A blocking or major one sends the sheet back for a **second `spec` session** (its brief carries the findings), then the sheet is reviewed again; still not conforming, the lot is handed back with what remains (`fiche non conforme après 2 revues : …`).
  The `spec` session has **one budget of two sessions**, shared by the program's check and the reviews: if the check already used the second one, a non-conforming review hands the lot back at once (`fiche non conforme et la spec a déjà joué 2 sessions`), with no second review. A question to the lead (the session's own, or a costly hypothesis) and its answer open a new budget.
  Minor findings become notes of the lot (`Revue de la fiche — mineur : …`, one per finding, committed with the plan; on a read-only plan they become `[note à poser]` proposals), not lines of the final table. This verdict is **not** `raf review`: the review of the code keeps that role. `orchestrate.fiche: false` skips the step.
- **A lot with a screen and a behaviour**: it is a lot with `screen:` whose **sheet** has a back part (a `sujet` block next to `ecran`, same folder), never a `spec: true` beside `screen: page` (`raf spec <id> on` only says so on such a lot and changes nothing; on `component` or `journey`, which follow the ordinary path since L209, `spec: true` makes a back-end spec lot, ordinary budget plus 450 k). The program reads the sheet, not the plan: as soon as the sheet has a `sujet` block (the contracts), the `code-reviewer` also reviews it,
  the chain is `spec → fiche → maquette → accept`, and the findings of the two reviews go together to a single `spec` session, which counts for one in the budget shared by both (`orchestrate.maquetteReviews` sessions, 3 by default, see the mockup review below). The brief of the spec of a lot with a screen offers the back part (and joins its template) without making it compulsory; a lot whose sheet has no `sujet` keeps its chain, without `fiche`. `--dry-run` cannot list `fiche` for a lot with a screen (the sheet does not exist yet).
- **Acceptance and code**: `accept` is the screen's step, with a back brief (`accept-back.md`: cases call the contracts of `contrats[]` as close as possible, external sources simulated from `entree`; no `data-testid`). `implement`, `fix` and `review` receive the sheet (cases, rules, contracts) as for a screen, without mockup; the review also checks that each contract is held (output, exact codes and messages of the errors).
- **Hypotheses**: a lot without a screen has no News entry. Once the sheet is final — after its review and the second `spec` session if there was one, just before `accept` or `implement`, and also for a sheet already present on a resume — the program writes **one note of the lot per hypothesis** (`Hypothèses (fiche <sujet>) — R3 : … ; si faux : …`, not duplicated on a resume) and commits it with the plan; on a plan kept by another tool the lines become proposals (`[note à poser] …`). The end-of-wave table lists them under each lot (`hypothèse de la fiche : …`) for the lead to relay.

## The mockup review: before any code

After a valid spec, a lot with a sheet gets a UX review of its mockup, `maquette` (L172), unless `cadence.yaml` sets `orchestrate.maquette: false` (default `true`): `precheck → spec → maquette → accept → implement → review → ux`.
`--dry-run` lists the step (`maquette (opus)`, the `review.full` model), its `ux-reviewer` command line and its brief `templates/orchestrate/maquette.md`.

- **The session**: the `ux-reviewer` agent in **mockup mode**, read-only, Playwright loaded, a fresh session. It opens `maquette.html` as a local file (no application, no server), looks at the captures
  `maquette-<état>-<largeur>.png` (1440 and 390 px) of every state, reads `fiche.yaml`, and reports findings ranked blocking / major / minor, each grounded in a rule (Nielsen, WCAG 2.2 AA) or a measurement. On top of
  that it checks the **consistency mockup ↔ sheet**: every field of the sheet in the mockup with its `data-testid`, every rule message visible, word for word, in the state its `etat` names, every state with its
  `#etat-<état>` section, the `masque` of an empty-state rule really hiding the fields it names. `effort.maquette` (default `high`) sets its effort level. Its verdict is **not** `raf ux`: the conformity pass after the code keeps that role.
- **A full sweep from the first review** (L230). The brief and the agent ask for a checklist in the text of the report, one line per item: every state of the sheet at 1440 and 390 px, every rule of the sheet, contrast, the real envelope of the app (usable width, side bar, header), gutters, empty or stretched panels, holes in the layout. What cannot be verified goes in `nonVerifie`; the program does not check the list. The first report must hold ALL the blocking and major findings, none kept for a later review.
- **The loop, `orchestrate.maquetteReviews` reviews at most** (integer ≥ 1, default 3; any other value is a configuration error). A blocking or major finding sends the mockup back to the spec writer: a fresh `spec` session whose brief carries the findings, then the mockup is reviewed again (the brief of review n says « review n of N », and « the last review » for the last). If the last review is
  still not conforming, the lot is handed back with what remains (`maquette non conforme après 3 revues : …`, `après 1 revue` when the key is 1) and nothing is implemented. A lot with a screen and `orchestrate.maquette` not `false` has a budget of `maquetteReviews` `spec` sessions, shared with the sheet review of a mixed lot (which keeps its two reviews); any other lot keeps two. If the program's check or the reviews already used the budget, a non-conforming review hands the lot back at once (`maquette non conforme et la spec a déjà joué 3 sessions`); an answer to a question of the lead opens a new budget.
- **Review defects in the journal.** From review 2, the agent marks `inchange: true` on each blocking or major finding about a point the spec writer did not change and the previous review had not raised (optional boolean of a finding; anything but `true` counts as false). For each one the program writes `<project>:<lot> · défaut de revue : maquette, revue <n>, majeur sur un point inchangé absent de la revue <n-1> : <text>` in the wave journal. Nothing else changes: verdict, loop and state of the lot are the same. A conforming review goes on to `accept` (or `implement`). On a resume, a **sealed** `acceptation.json` (its `empreintes` set by the program), still red or already green (`vert: true`), proves the review was done and is not replayed; an unsealed one proves nothing, a `vert: true` one included (only the cycle sets `vert`, after the seal). **A green and sealed acceptation never goes back to `accept` (L233)**, nor to the sheet and mockup reviews, even when its seal no longer holds (a test resealed by `cadence spec reseal`, a sheet amended since): the lot goes to `implement` or the review, the step would rewrite a green oracle and demand red tests. The `accept` brief and the `acceptance-writer` agent say the same: given a `vert: true` file whose `empreintes` hold one entry per listed test file, never rewrite it nor touch `resceaux`, `empreintes` or `vert`, write nothing and hand the lot back; given a `vert: true` file without `empreintes`, or whose `empreintes` lack one of the listed files (never sealed, it proves nothing), write the oracle as usual with `vert: false` (the program itself never starts an `accept` session on a green and sealed acceptation, even for a lot waiting on an answer with `next` = `accept`, so nothing relies on the prompt alone). A lot waiting on an answer is compared with the file as it was before its first `accept` session: if that session rewrote the green file and committed it before asking its question (`vert: false`, `resceaux` erased), the lot is handed back (`verrou des tests d'acceptation : … acceptation verte réécrite …`) instead of adopting the rewrite as its red commit; only a `cadence spec reseal` by the lead (journal `resceaux` longer, commit outside any session) is accepted. A `maquette` step with no sheet warns (`revue de la maquette ignorée : aucune fiche …`) and goes to `implement`.
- **Sample data** (L181): the spec brief asks the writer to compute the weekday of every date of the mockup (not to write it from memory), and the review recomputes them. A wrong sample datum (weekday, date, figure that does not add up) is a **minor** finding, never a major one, so it cannot by itself send the mockup back for a second review.
- **Minor findings** are not sent back: they are kept as proposals of the lot (`[mineur maquette] …`), like the minors of the other reviews. A report whose totals announce a major finding is not taken for conforming.
- **On resume**, a sheet already committed is reviewed before the next step, unless the lot already has a sealed, conforming `acceptation.json` (or a sealed green one, `vert: true`, conforming or not: L233; it can only have been written after the review), or already has code committed after the sheet (a commit citing the lot that touches a file outside the sheet's folder: `implement` only started once the review was done), including without `orchestrate.accept`.

## The accept step: red acceptance tests and their lock

After a valid spec, and only when `cadence.yaml` declares `orchestrate.accept` (the project's **dedicated command**, or a list of them, which run *only* the acceptance tests of one lot), a lot with a sheet gets one more
session, `accept` (L173): `precheck → spec → maquette → accept → implement → review → ux`. Without `orchestrate.accept` the step is skipped, with a warning on the lot (`étape accept ignorée …`), and the lot goes from `spec` to `implement` as before.
`--dry-run` lists the step (`accept (sonnet)`) and its brief `templates/orchestrate/accept.md`.

- **The session**: Sonnet, the `acceptance-writer` agent, a session other than the implementer's. Its brief gives it the sheet, the mockup and how to run the project's tests (the dedicated command, and the runner template below) — not the lot's objective, notes or
  sub-tasks, and no implementation. It writes one or more cases per rule, **named as the sheet plans them** (`regles[].tests`, e.g. `R3 — erreur : message et bouton Réessayer`), selectors = the `data-testid` of the fields, API calls simulated from `actions[]`,
  and commits them **red** in one commit (`test(L7): acceptation R1–Rn (rouge)`) with `<spec.dir>/<écran>/acceptation-<lot>.json` (**one file per lot**: two lots on the same screen never share a lock or a file; the id is reduced to `A-Za-z0-9._-`, so `app/L7` gives `acceptation-app-L7.json`; an older `acceptation.json` is still read, by its `lot` key) — `{ "lot", "fiche", "fichiers": [...], "vert": false }` — and the runner configuration. A second lot's tests that rewrite the first lot's test files hand the lot back, with the file named (the lock below). `effort.accept` (default `medium`) sets its effort.
- **One command or a list of runners** (L189). `orchestrate.accept` is a string or a **list** of commands, for a project with a front and a back runner (Vitest in `frontend/`, Jest in `backend/`):

  ```yaml
  orchestrate:
    accept:
      - cd frontend && npx vitest run -c vitest.acceptation.config.ts
      - cd backend && npx jest -c jest.acceptation.config.js
  ```

  The program runs **each** command from the repository root with `CADENCE_ACCEPTATION` (and `{acceptation}` substituted) and `CADENCE_ACCEPTATION_ROOT`, the command's **root**: the folder of its leading `cd <folder> &&`, else the repository (`.`). A command takes **only the files listed under its root**: `acceptationOnly()` of the runner template returns them relative to that root, where the runner starts. A command with **no listed file under its root is not run**; a listed file under **no root** is a deviation of the step (`fichiers listés … sous la racine d'aucune commande de orchestrate.accept`, one second pass, then `accept non conforme après 2 passes`). **Red check**: every command that is run must fail (the deviation names the one that passes); **green**: `vert: true` is set only when all of them pass, and a lot sent back to `fix` is told which commands are still red. A string keeps its behaviour: **it ignores its `cd` for the root** — the whole repository is its root and `CADENCE_ACCEPTATION_ROOT` is `.`, so `acceptationOnly()` returns paths relative to the repository; only a list derives a root from each command's leading `cd`. One lot per app wires its back runner (dedicated config, `exclude` in the ordinary one, a line in `cadence.yaml`): that is the app's plan, not cadence's.

  **Moving from a string to a list.** The two forms are not interchangeable: a string keeps the repository as its root, a list (even of **one** element) derives each root from the command's leading `cd <folder> &&` and sets `CADENCE_ACCEPTATION_ROOT` to it. The brief of the step and the cycle decide by the same test (a YAML list or not), so they always agree. To switch: (1) write the entries as `cd <folder> && <runner>`; (2) make the runner's config resolve from its own root (its `include` and `rootDir` relative to `<folder>`, since the runner starts there and `acceptationOnly()` returns the paths relative to that root); (3) **copy the runner template again** into the project (`templates/acceptation-runner.mjs` reads `CADENCE_ACCEPTATION_ROOT`; an older copy lists the repository-relative paths and matches nothing from a folder). A project that has not migrated stays on its string, unchanged.
- **Out of the ordinary test run and the CI while the lot is not green.** Red tests committed would fail `orchestrate.test` (after every `implement`/`fix`) and the project's CI (which `cadence deliver` waits for), for lots that are not theirs. So the
  runner configuration shared by `orchestrate.test` and the CI excludes the files listed in every acceptation file (`acceptation-<lot>.json`) whose `vert` is `false` — and, always, red or green, those of an acceptation with `"e2e": true` (a browser test needing the build, L203: `acceptationE2e()` lists them for the e2e suite run after the build) — and only the dedicated command runs them. `templates/acceptation-runner.mjs` is the helper the session copies
  into the project: `acceptationIgnored()` (Vitest `exclude`; `acceptationIgnored(root, dir, 'regex')` for Jest `testPathIgnorePatterns`) and `acceptationOnly()` (the `include` of the dedicated config, which reads the environment variable `CADENCE_ACCEPTATION`:
  the program sets it to the absolute path of the lot's acceptation file when it runs `orchestrate.accept`, and also replaces `{acceptation}` in the command with that path — quote it if the path may hold spaces). If the CI or the test command do not use that config
  (paths hard-coded), the session must not commit red tests and puts the question in its report.
  **Run by hand, outside a wave**, the dedicated command fails: `acceptationOnly()` requires `CADENCE_ACCEPTATION`, which only the program sets. Set it yourself, to the path of the lot's acceptation file:
  `CADENCE_ACCEPTATION=<path of the acceptation file> <command>` (with a `{acceptation}` in the command, write the path there too). For a command of an `orchestrate.accept` **list**, also set its root, which `acceptationOnly()` uses to return the files relative to where the runner starts: `CADENCE_ACCEPTATION=<path of the acceptation file> CADENCE_ACCEPTATION_ROOT=<root of the command> <command>` (the folder of its leading `cd <folder> &&`; without the variable the root is the repository `.`, and the paths are relative to it, which no runner started in a folder will match). A single string needs no root. Once the lot's tests are green (`vert: true`), they join the ordinary runner and the CI, so the usual test command runs them without that variable — **except an `"e2e": true` acceptation**, which never joins them: wire its `acceptationE2e()` files into the e2e suite run after the build (`npm run build && npx playwright test`). The dedicated `orchestrate.accept` command still runs those files for the red check and the return to green, so it must build and start what the browser needs.
- **What the program checks** afterwards, with no model: `acceptation.json` is the lot's (`lot`, `fiche`, listed files committed, `vert: false`), every test name planned in the sheet appears in the listed files, **each listed test file is new** (absent from the head before the first `accept` session: tests written into an existing test file would leave the ordinary run and the CI while the lot is red, so the check refuses `existait avant la session accept`), the other lots' acceptation tests are untouched, the dedicated command
  **fails** (a test green before the code proves nothing), `orchestrate.test` stays **green** with the red tests committed (proof that they are excluded; without `orchestrate.test` nothing proves it, and the step passes with a lot warning only), and the tree is clean. Anything missing goes to **one second `accept` session**; still not valid, the lot is handed back
  (`accept non conforme après 2 passes : …`). A question in the report puts the lot in `question`, like the other steps. The check that each listed test *individually* fails is not made: only the dedicated command's exit code is (it fails if any of them fails).
- **The seal.** Once the checks pass, **the program** (not the session) adds to `acceptation.json` the git fingerprint of each listed file (`empreintes`) and commits it (`test(L7): acceptation scellée …`): that commit is the **red commit**. Its sha is written nowhere in the file (a session could rewrite it): it is
  the latest commit in git history that changed the file otherwise than by its `vert` key, and the wave keeps it in the lot's state (`accept.rouge`) too.
- **The lock, for every session of the repository.** At the end of each `implement` and `fix` the cycle compares, for the acceptation files of **all** lots found under `orchestrate.spec.dir` (a repository has one queue: the next lot runs on the same branch), the listed test files with the red commit
  (`git diff <red commit> -- <files>`, empty expected, working tree included, and the fingerprints), and each `acceptation.json` with its version before the session. The only difference tolerated on `acceptation.json` is the `vert` key, and only **the cycle** sets it: a session that changes it, rewrites the
  file, deletes it, creates one outside the accept step, or modifies a locked test hands the lot back (`verrou des tests d'acceptation : …`) — for a modified test the message ends with `; premier commit fautif : <sha7> <subject>`, the oldest commit after the reference (red commit, or the head before the lot) that touched the sealed path (a deletion or a rename included, renames not followed), and names no commit when the deviation is only in the working tree (L231) — a useful change is a question to the lead or a review finding, never a silent gesture. The lock does not depend on `orchestrate.accept` being declared. **Exception — a delivered lot (`vert: true`):** a later lot that makes the rule evolve may modify the listed tests of that acceptation when **a commit that cites the lot in progress amends the sheet of the screen and comes after the red commit** (a strict descendant of it; the commit may have been made before the wave, and once one exists the exception covers the whole acceptation: the tests may change in the same commit as the sheet, in a later one or in a following session, a `fix` after the `implement` for instance, L231): the sheet is what evolves the rules, and tests and sheet change together. A sheet amended by another lot, by a commit that cites no lot, by a commit that is not after the red commit, or only in the working tree (not committed) opens nothing. The exception never covers the acceptation of the lot in progress (its `vert: true` is set right after the implement): that one keeps the whole lock. Without a sheet change the difference is still a deviation — except one narrow case (L184): a listed file whose content is identical to what it was at the head before the lot's first **work** commit (commits found by the plan's refs) is not a deviation, the lot having taken its own addition back (a lot handed back for writing in a locked file and resumed in a new wave, which then removes that addition). This applies to every acceptation, `vert: false` included, but only to a file that **exists** at that head and now: a file absent at that head (e.g. created by the lot's own red commit) or deleted since is never exempted, so deleting a locked test stays a deviation; nor when the sheet of the screen has changed since that head (an evolution admitted for another lot: going back to the old content would cancel it, not the lot's addition); apart from that, with `vert: false` the whole lock applies, sheet change or not; `acceptation.json` itself stays locked (only its `vert` key moves).
- **A sealed test that contradicts the sheet: `cadence spec reseal` (L200).** The lock is total for the lot in progress (the delivered-lot exception above never covers it; for a delivered lot, see the end of this item), so a test that is wrong against its sheet — e.g. the regex `/\d{1,2} /` of an acceptance test rejecting « T3 2027 annoncée », which the sheet allows — would leave the lot handed back with no way out. The way out is the lead's, outside any wave: correct the test in the working tree (the sheet is left as it is: unchanged since the red commit, or amended by commits of the lot and committed, see « A sheet amended in the same lot » below), then `cadence spec reseal <lot> <test> --reason "why the test contradicts the sheet"`. The program checks that the lot is in progress (`doing`; for a delivered lot, see the end of this item), that the test is listed in the lot's sealed `acceptation-<lot>.json`, that the sheet is unchanged since the red commit or amended by commits of the lot (below), that **no other listed test** changed (the lock keeps everything else) and that the test did change; it then redoes the fingerprint of that one test, appends `{ test, raison, date, avant, apres }` (plus `ficheAmendee` for an amended sheet, below) to the `resceaux` key of `acceptation.json`, commits the test and `acceptation.json` (`test(L35): acceptation rescellée, <test> : <reason>`, the new red commit) and the lot's note with the reason (`plan: …`). It is refused during an orchestrated wave (`CADENCE_ORCHESTRATED`, or the repository's wave lock while one of its lots still works, like `cadence deliver`), **while a wave that is not `done` (interrupted, suspended, or still alive with a lot waiting on a question) keeps open any lot of this repository that is still `doing` in this repository's plan (L238)** — the resealed lot, the `--porteur` or any other lot of the repository: the lock hands back every open lot of the repository, so a reseal committed in the meantime was handed back to any of them as the « first offending commit » of the lock (ol-companion L172, then L173). Open means any non-final state in the wave (a question waiting for its `--answer`, a lot suspended by the quota or the budget, a queued lot, a session running): a stopped wave holds no lock, but its `--resume` replays those lots. The filter is by repository (the repository of the lot's project, not its neighbour repositories: lot ids belong to each plan, so a finance-tracker L172 never blocks an ol-companion L172) and by plan: a lot that is `done` or absent in the plan never refuses, so an old interrupted wave whose lots are long delivered blocks nothing, and neither does a `done` wave. The error is a single message that names **every** wave concerned, with its launch folder and its open lots, the wave that holds the repository lock included (alive: while it has an open lot the lock refuses first, so the same message lists it together with the stopped waves of the repository, not the bare « orchestration en cours » line `cadence deliver` gives), and gives for each stopped wave ONE command, runnable as it stands, with a `--drop` per open lot of the repository in that wave, the queued ones that are not `doing` in the plan included (L239: `--resume` would relaunch them, and the lot would take the lock back and find the tree dirty with the corrected test): `cd <launch folder> && cadence orchestrate --resume <wave> --drop <project>:<lot> --drop <project>:<lot>` (`--resume` replays the whole wave except the dropped lots, so one command per lot would start sessions on the others; it looks for the wave in the folder it is run from only); a wave that is still alive is not called suspended, the error says it is running and is to be waited for. A repository reached by another path (a worktree, a symbolic link) is the same repository: the `.git` directories are compared by their real path. The waves read are those of `.cadence/runs/` of the repository root, of the plan's folder and of every folder above them (a wave keeps its state where `cadence orchestrate` was launched, usually the parent folder of the projects), with no `--reason`, and on a lot that is neither in progress nor delivered with a green acceptation. Then, depending on how the lot stands: a lot waiting on a `question` sits in a wave that is not `done`, which refuses the reseal (L238): answer it first (`--resume --answer`, the lot then goes on or is handed back) or close it (`--resume --drop`), reseal afterwards if the lot is handed back (a rewrite of `acceptation.json` without a `resceaux` entry stays a violation of the lock); a lot handed back with `verrou des tests d'acceptation` is finished for `--resume`, so it is replayed by a new wave `cadence orchestrate <project>:<lot>`, which starts again from the red commit. A session never does it, three guards: (1) `cadence spec reseal` is in the sessions' `--disallowedTools` (like `raf done`/`review`/`ux`); (2) a resealed commit is adopted as the new red commit only if it belongs to **no session of the wave** (commits listed in each `steps[].commits`, or in `headBefore..headAfter` of any session of any lot of the wave) — otherwise it stays a violation of the lock; (3) the lock is checked at the end of **every** work session, a session that ends with a question included, so a session that replaces the test, forges the fingerprint, commits and asks a question is handed back with `verrou des tests d'acceptation` without waiting for the lead's `--answer`. The reseal is atomic: if the commit fails (a `pre-commit` hook exiting 1, say) `acceptation.json` and the test are put back as they were before the command (the lead's correction in the working tree is kept, nothing staged) and a readable error says nothing was resealed. With a plan kept read-only by another tool, the reseal itself succeeds but the plan is not touched: the note of the lot is left to the lead (the reason stays in `acceptation.json` and in the commit message; the command only says a note is to be added). With a plan outside the repository or untracked, the note **is** written in the plan file but not committed (the command says `plan à commiter`); do not add it a second time. If the commit of the note is refused (a hook), the reseal stays done: the error gives its commit and says the note, already written, is to be committed by hand. **A sheet amended in the same lot (L217):** a sheet amended since the red commit is accepted, for a lot in progress as for a delivered one (the sheet is then not put back to its red state to be restored afterwards). When its net difference with the red commit (`git diff <red> -- <sheet>`) is not empty, the command reads `git log <red>..HEAD -- <sheet>`: every commit that touched it must cite the lot (read like `raf commits`, i.e. `citedRefs`: the scope of the subject first, the body otherwise; for a delivered lot, the lot, the `--porteur` or any delivered lot of the plan, status `done`, L229: the living sheet is the reference; one cited delivered lot among several is enough), and the sheet must be committed. The fingerprint of the test is then redone against the current sheet and the `resceaux` entry gains the optional key `ficheAmendee` (short sha of the last commit that touched the sheet); the lot's note and the commit message say `fiche amendée en <sha>` instead of `fiche inchangée`. Still refused, with nothing written: a sheet modified by a commit that cites neither the lot nor (delivered lot) the `--porteur` or a delivered lot (`la fiche … a été modifiée depuis le commit rouge … par un commit qui ne cite pas <lot> : <sha>`; for a delivered lot `… ne cite ni <lot>, ni le porteur <porteur>, ni un lot livré : <sha> (cite : <lots ou aucun lot>) — faire citer le porteur ou un lot livré par ce commit (le réécrire avant qu'il soit poussé) ou, sinon, rescelle à la main avec le lead`), a sheet deleted or renamed since the red commit, a sheet with uncommitted changes (working tree or index: `a des modifications non commitées : la commiter (en citant <lot>) avant le rescellé`), as before any other listed test touched, a test left unchanged, an orchestrated wave and a missing `--reason`; the atomicity is unchanged. A sheet amended then brought back to the identical content is treated as unchanged, whoever committed in between. After the reseal the new red commit is the reseal commit, so a second reseal sees the sheet as unchanged. **A delivered lot (L212):** a lot whose acceptation is green (`vert: true`) and whose sealed test turns out unstable while the contract does not change (seen: a tab read as « blank » in CI) had no way out but the « sheet modified in the same lot » exception. `cadence spec reseal <lot> <test> --reason "why" --porteur <lot in progress>` now covers it, with the same guards (the sheet unchanged since the red commit, or amended as above by commits that cite the delivered lot, the carrier or another delivered lot; no other listed test touched, no wave, `--reason`) and three differences: `--porteur` is required and names the lot in progress that carries the fix (refused if it is the delivered lot itself, unknown or not `doing`); the commit cites the **carrier** (`test(L113): acceptation rescellée du lot livré L47, <test> : <reason>`) and so does the plan note and its commit, the delivered lot being closed; the dated `resceaux` entry also records `porteur`, and `vert` stays `true`. `--porteur` on a lot in progress, or `spec reseal` on a delivered lot without `--porteur`, is refused.
- **Back to green, set by the cycle.** At the end of each `implement`/`fix`, once the session reports green, the cycle runs the dedicated command. Red: the findings go to a `fix` pass (the tests are made green without editing the locked files). Green: the cycle sets `vert: true` and commits it (`chore(L7): acceptation verte …`;
  `commitPlan` may commit the `acceptation.json` files, otherwise the dirty tree would stop the lot). The files then join `orchestrate.test` and the CI, which keep the lot green from then on (an `"e2e": true` acceptation excepted: its files stay in the e2e suite after the build); the following lot, running with `vert: true`, is compared with the head before its own work, not with the red commit, only once the sheet has changed between the red commit and that head: after an admitted evolution (tests changed along with the sheet) it sees no difference either; only a test changed *during* that lot without the sheet is a deviation.
- **When the lot is handed back** (question, budget, passes exhausted) its tests stay red but excluded from the project's runner and CI: the next lots and `cadence deliver` do not see them; `--resume` continues with the same lock. On resume, the step is skipped when the lot already has a valid committed **and sealed** `acceptation.json` (its `empreintes` set by the program); a conforming file without them proves nothing and `accept` runs again. A sealed green one (`vert: true`) also skips the step when its seal no longer holds (L233); a green one without `empreintes`, with `empreintes: {}`, or whose `empreintes` lack one of the listed files (copied from another file or lot) proves nothing and `accept` runs again (the contents are not compared here, only the presence of one fingerprint per listed file). The fingerprints are keyed by normalised path, so a listed `./test/x.ts` is recognised like `test/x.ts`, on resume and by the lock (which compares it to its fingerprint).

## The downstream briefs: sheet, rule → test → green, conformity, Hypothèses

Once the sheet exists, the steps after it all read it (L174, `src/orchestrate/aval.ts`, the `{{fiche}}` marker of the templates `implement.md`, `fix.md`, `fix-minors.md`, `review.md`, `review-small.md` and `ux.md`). A lot without a sheet (no `screen:`, or under the threshold) keeps exactly the briefs it had.

- **`implement` and `fix`** get the path of the sheet and of the mockup, and **one line per rule** (`- R3 [erreur, hypothese] statement. Message: « … ». Tests: « R3 — … »`). The session makes the acceptance tests green **without modifying them** (they are named when the `accept` step ran; the lock above hands the lot back otherwise), **the tests it writes in addition cite the rule** in their name (`R2 — …`), and it **does not invent a rule**: a case the sheet does not cover is written in the report (`nonVerifie` or `choix`), not coded. In a `fix` the sheet stays the reference: a finding that contradicts it is contested under `choix`. Both briefs also say that a conflict with the sealed test of **another** lot is a question to the lead naming both tests (file and `Rn — …` name), never a modification or a choice (L231). The `accept` and `accept-back` briefs and the `acceptance-writer` agent require each assertion to cite, in a comment, the rule and the sentence of its statement that it verifies, to assert nothing beyond that sentence, and to go through a self-check before the commit (an assertion with no sentence behind it is removed or listed under `choix`); the `review` and `review-small` briefs and the `code-reviewer` agent re-read each sealed assertion against the sentence it cites, and one that asserts more than the sheet is a *major* finding (« sealed test stronger than the sheet », worded « than its rule » in the briefs), corrected by the lead with `cadence spec reseal` (L231).
- **A self-check list before handing back (L222).** Both `implement.md` and `fix.md` carry the same fixed list (plain text, no marker, no new variable), taken from the recurring findings of the reviews of 2026-10-15: the usage documentation (README and architecture documentation) updated in the same commits as the behaviour; one test named `Rn — …` per rule of the sheet (one per business rule of the lot when there is no sheet); no dead code and no test that cannot fail (an assertion always true, or a test that does not exercise its rule); for a modified screen, the capture due of each state at 1440 and 390 px with a file name (where it goes is the Playwright paragraph's rule) (a lot with no modified screen owes none and says so); no false comment, docstring or message. The session goes through it point by point on its own commits before it reports, and a point it cannot hold is written under `choix` or `nonVerifie` of its report: the report schema has no new field. In `fix` the list covers only what the session changed, and "fix them, and nothing else" stays. The other briefs (`fix-minors`, `spec`, `spec-back`, `accept`, `review-small`…) are unchanged. The before/after measure — correction passes per lot, replayed with `cadence corrections` (`--until <bound>` for the "before", `--since <bound>` for the "after", the bound being the time of the `npm run service` that puts the list in service) — is in [docs/mesures/autocontrole-avant-revue-2026-10-15.md](mesures/autocontrole-avant-revue-2026-10-15.md).
- **Auto-verification once the tests are green (L236).** After the self-check list, `implement.md` and `fix.md` carry a second fixed block: when the full suite and the build pass, the session re-reads the complete diff of its lot (of its fix commits, in `fix`) against the grid of the `code-reviewer` agent — code bug, architecture drift, `docs/architecture.md` (or the project's architecture documentation) up to date, edge cases, one test per changed behaviour — fixes what it finds at once (test first, a `fix(<lot>): …` commit, suite and build replayed), then starts `resume` with an « auto-vérification » paragraph: what it re-read, found and fixed, could not hold. No new report field. The cost bound is written in the brief: one reading of the diff, not a second review (no subagent, no files the diff does not touch). Measure before the block (`cadence corrections --classify`, 10 to 17-10): 356 passes, 53 % code bug, 19 % architecture drift, 14 % unclear spec; `cadence perf` of 17-10: 37 % right the first time. Target: above 50 % on the next window with tokens per lot stable (`cadence perf`).
- **The code review (`review`, `review-small`) checks rule → test → green** (`règle → test → vert`). For each `Rn` of the sheet the reviewer checks that its test exists (named after the rule), that it is green, and that the behaviour is in the diff; when an acceptance file is named, that each listed test is unchanged since the red commit (`git diff <red commit> -- <file>` empty; the brief gives the red commit). A rule without a test, an acceptance test modified since the red commit, a rule coded that is not in the sheet, and a test that is green without exercising its rule are **major** findings. The reviewer no longer rebuilds the cases from the code.
- **The UX pass becomes a conformity pass.** For a lot with a sheet, the `ux` session (the `ux-reviewer` agent, **conformity mode**) no longer audits the whole screen: it compares the running app to the mockup and to its captures `maquette-<état>-<largeur>.png`, state by state, at 1440 and 390 px, and reports the differences of rendering and ergonomics the tests do not cover, each tied to a rule or a measure. The rules of the sheet are the tests' job. Its verdict feeds `raf ux`, which stays the lead's, decided on the captures. A small visible lot (single `review-small` pass) gets the conformity instruction in that pass.
- **The `## Hypothèses` section of the news entry.** The `implement` brief asks for an entry that ends with `## Hypothèses`: one line `- Rn — …` per rule whose status is `hypothese`, with what changes if it is wrong (its `si_faux`) — it is what the lead shows for the `raf ux` decision, the choices nobody validated.

  ```markdown
  ## Hypothèses
  - R3 — erreur de chargement : message « Impossible de charger le prochain match. » et bouton Réessayer. À confirmer ; sinon seul ce bloc change.
  ```

  **`cadence news check`** (not `build`) flags a lot whose sheet has hypotheses — found under `orchestrate.spec.dir` (default `docs/specs`), by `ecran.lot` — when none of its entries has the section, or when the section lacks a `- Rn` line for one of the rules (`L7 : la fiche a des hypothèses (R3, R4) mais l'entrée … n'a pas la section « ## Hypothèses »`). A lot without hypothesis needs no section.

**Production access of the sessions** (L168): a session of a wave (`implement`, `fix`, `precheck`, `spec`, `review`, `ux`) is
started with no *default* access to the production cluster (a guard against the ordinary path, not a barrier). What a session inherits was measured on the dev machine: `KUBECONFIG` (pointing at
`~/.kube/config`, the production cluster), the `kubectl` of the `PATH` (a link to `k3s`, which without `KUBECONFIG`
falls back on `/etc/rancher/k3s/k3s.yaml`) and the cloud and GitHub tokens of the environment. `cadence orchestrate` now
starts every session with `KUBECONFIG=/dev/null` (`kubectl get pods` answers « connection refused » on `localhost:8080`)
and without `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT`, `KUBE_TOKEN`, `ARGOCD_SERVER`, `ARGOCD_AUTH_TOKEN`, `ARGOCD_OPTS`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_TOKEN`, `CF_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (exactly these names: `AWS_PROFILE` or `AWS_WEB_IDENTITY_TOKEN_FILE` are kept), `GOOGLE_APPLICATION_CREDENTIALS`,
`AZURE_CLIENT_SECRET`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` (idea taken from the sandbox of docker/docker-agent,
closed by default). `HOME` is left alone, so the credential files `gh` keeps under `~/.config` stay readable (a session
can neither push nor deliver anyway) and so does `~/.kube/config`: a session that deliberately runs
`kubectl --kubeconfig ~/.kube/config …` or `KUBECONFIG=~/.kube/config kubectl …` still reaches the cluster. The restriction
stops the accidental access, not a deliberate workaround; making the file unreadable needs a filesystem sandbox
(a mount namespace, or the file sandbox of Claude Code), which cadence does not set up. `cadence deliver` and `cadence verify` are the lead's and keep their access; so do
the project's own `test`, `build` and `ux.command`, which the program launches. A lot that really needs the cluster is run in a
project with `orchestrate.prodAccess: true`: the restriction is lifted for all its sessions (default `false`).

`orchestrate.precheck: local` (L146) runs the pre-check on the local model of the dev machine instead of Sonnet: the
orchestrator launches `claude-local` with the same brief, the `precheck-reader` prompt and tools, no quota used and nothing counted in the
lot's budget (the step shows `local` as its model). `claude-local` is **not shipped with cadence**: it is a personal wrapper (a script on the `PATH`, `qwen3-coder:30b` by default) around
`claude` pointed at Ollama. `CADENCE_CLAUDE_LOCAL_BIN` names another binary, which must take the prompt as its **first argument**
and add itself `-p`, `--bare`, `--strict-mcp-config` and `--model` (cadence passes none of them), then accept `--output-format`,
`--json-schema`, `--tools`, `--session-id`, `--permission-mode`, `--add-dir` and `--disallowedTools`. A bare `claude` does not fit.
Without such a binary every local check fails and is replayed on Sonnet: keep `true`. Sonnet stays the safety net: a local session with no result (Ollama
down, timeout, no structured report) or an unreadable report is replayed on Sonnet with a warning, and a local `oui` — the
only answer that hands the lot back without an implementation — is confirmed by Sonnet before it counts. A local `partiel`
or `non` is taken as is. The default stays `true` (Sonnet): switch to `local` only after comparing verdicts and durations
against Sonnet on a few lots, and go back to `true` the first time the local model gets a `partiel` wrong. `--dry-run`
prints the step as `precheck (local)` with its `claude-local` arguments. Those arguments carry neither `--model` nor `--effort` nor `--agents`: `effort.precheck` applies only to the Sonnet
session (the fallback, or the confirmation of a local `oui`).

The `precheck-reader` agent does not set `omitClaudeMd` (Claude Code 2.1.271), on purpose: measured on a project with a
297-line `CLAUDE.md` (haiku, `--agents` + `--agent`, same prompt, with and without the flag), the session context is
identical (22 779 tokens, the project `CLAUDE.md` still answered when asked) — the flag only applies to an agent run as a
*subagent*, and cadence launches the step as the main agent of its own session. The same goes for `qa-reviewer`, which
is not launched by the wave: leave it as it is.

**A lot that already has commits** (a spec commit, an interrupted wave, a lot committed by hand, a lot sent back after a
review) still starts with the implementation session: its brief tells it to read the lot, its notes and its open
sub-tasks, which carry the findings of any earlier review. If that session ends without a new commit on a lot that
already has commits, the wave goes on to the review (warning `implement sans nouveau commit`) instead of handing the
lot back; with no commit on the lot at all it is handed back as `implement sans commit`. The same goes for a
correction pass: a `fix` session that adds no commit to a lot that already has work commits goes on to a fresh review
(warning `fix sans nouveau commit : revue lancée sur les commits du lot`), the pass still counted — the cap of two
correction passes stays the guard against a loop; with no commit on the lot it is handed back as `fix sans commit`.

**Compliant with minor findings**: the minors are not left for a follow-up lot. One **minors pass** runs
before concluding: a new Sonnet session with its own brief (`fix-minors.md`) fixes the minors that are right
and lists in `choix`, with the reason, the ones it rejects (it never stops to ask); it does not count among the
two defect passes. A short code re-review follows (for a visible lot, the UX review comes after it), and
concludes even when it finds new minors, which are returned to you as proposals (no second minors pass).
When the pass makes no commit (every minor judged wrong) and HEAD has not moved since the compliant review,
the lot concludes on that original review (if HEAD moved, e.g. a resume after a cut-off session that had
committed, a short re-review of that commit runs instead): `ready`, verdict recorded with the sha that review read (`… + passe des mineurs sans commit`),
the untreated minors returned as proposals. For a visible, non-small lot with `orchestrate.ux` declared, the
final UX review plays first and the lot concludes on that same original review once the UX is compliant. Same when the
budget is exhausted right after a compliant review with minors: it concludes on that review instead of staying
suspended, except for such a visible lot, where the UX session needs budget and the wave stays `suspended`
(budget reached) like any other session.

**Sub-tasks covered by commits (L82)**: when the review concludes compliant, the open sub-tasks of the lot that a work commit of the lot cites (`feat(L3/t2): …`, in the project or in one of the lot's neighbouring repositories; a commit that cites only the lot covers none) are closed in the same plan commit as the verdict, with the warning `sous-tâches closes : L3/t2 (sha)`, so `raf done` does not refuse the lot over finished work. A read-only plan is never written: each such sub-task is returned as a proposal `[sous-tâche clore] L3/t2 — couverte par <sha>`, for you to close with the project's tool. On a plan in a foreign format (read-only, `cadence.yaml` `plan:`), sub-task ids are read as the plan reads them: `B53/t4-ux1` covers `t4-ux1` only, not `t4`, and a list such as `feat(B53/t4-ux1,t5)` covers each of its sub-tasks. The lot id is not read inside another id (`fix(E-A2/t3,t4, A2/t1)` covers `A2/t1` only for lot `A2`), and a list may repeat the lot id (`fix(L1/t1, L1/t2,t3)` covers `t1`, `t2` and `t3`). A non-compliant review closes nothing.

**Choices, not questions**: the author brief tells the session to decide minor interpretation questions itself and to list them under `choix` in its report; the reviewer receives that list to re-read, and the final table prints each one (`choix fait : …`). A session stops with a question only on a real blocker: a decision that changes the scope or the architecture or is costly to undo, AND that the plan, its notes and CLAUDE.md do not settle; everything else is a choice.

**Frozen copy of the tool (L61)**: at the real start of a wave (not with `--dry-run` or `--status`), cadence copies the
parts of its package that run the wave (`bin/`, `dist/`, `templates/`, `agents/`, `skills/`, `package.json`; `node_modules`
is linked, not copied) into `.cadence/runs/<wave>/tool/` and relaunches the orchestrate process from that copy (the
parent process waits, relays the signals and exits with the same code or signal). Code, brief templates and agents
therefore come from the snapshot: a wave can orchestrate cadence itself, and a session of the wave may edit
`templates/` or rebuild `dist/` without touching the wave running. `--resume` relaunches from the snapshot of the
resumed wave, not from the current `dist/`; a wave without a snapshot (started before L61) resumes with the current
package and a warning. One more exception (L223): a wave whose snapshot predates L223 (its `dist/orchestrate/command.js`
has no `lotBudgets`) resumed with `--budget <project>:<lot>=+N` runs on the current `dist/` and templates, with a warning
on the error output, because that snapshot would refuse the option as an invalid budget; the sessions of such a resume still
get `<wave>/tool/bin` first in their `PATH` (see below), so the `raf` and `cadence` they call are the snapshot's. The copy is removed with the wave folder. The wave's pid in `--status` is the relaunched process.
The sessions of the wave also get `.cadence/runs/<wave>/tool/bin` (the `raf` and `cadence` entries of the snapshot) **first in their
`PATH`**, ahead of the per-project Node below and of the usual `PATH`: the `raf` a reviewer runs (`raf commits`…) is the
snapshot's, not the installed one. A wave without a snapshot leaves the `PATH` as it is.

**A short temporary folder per lot (L242, L243)**: each session gets a `TMPDIR` of its own lot, `<os.tmpdir()>/cadence-<8 hex of the sha1 of the lot's state folder>`
(created before the session, exported in the environment of `claude -p` and given to it as an `--add-dir`, so that a write there is not refused outside the working directory; outside the repository, hence never tracked by git),
and every brief names it: test logs, dumps and exports go there, not in the repository's `tmp/` (sessions left `tmp/suite-l149.txt`, `tmp/vt-*.json`,
`tmp/*.log` four times on 2026-10-18, one lot handed back for a « dirty repository »). **It is short on purpose**: Chrome (the Playwright MCP) puts its Unix
sockets under `TMPDIR`, and a socket path is limited to 107 characters. L242 put it under `.cadence/runs/<wave>/<project>--<lot>/tmp` (about 95 characters), Playwright
refused to start (« Socket path too long ») and the UX reviews of the finance wave 2026-10-19-fin-prev had no capture, 4 lots out of 4. The path leaves 60 characters free
(a test checks `TMPDIR` + 60 < 108); when `os.tmpdir()` is too long for that, `/tmp` is used. The wave's folder of the lot keeps a `tmp` **symbolic link** to it, to find it from there.
The folder is shared by the sessions of the lot (implement, review, fix…) and **removed, link included, at the end of each pass of the lot, and when a signal interrupts the wave** (lot finished, suspended or waiting for an answer: nothing is left in `/tmp`; the next session recreates it, empty). A `--dry-run` brief or one delegated by hand has no wave folder, hence no such line.

**The code in service (L195)**: on cadence's own repository, `bin/raf.js` and `bin/cadence.js` load `dist/`, so the `raf` and `cadence` of your
`PATH` used to be whatever the working repository last built. The snapshot protects the wave running, not that installed tool, and a wave's
sessions run `npm run build`, `npm install`… The code in service now lives in a **separate copy**: a detached git worktree built there,
`<root>/releases/<sha12>`, with `<root>/service` pointing at the current one (`<root>` is `~/.local/share/cadence`), and `~/.local/bin/raf` and
`~/.local/bin/cadence` linked to `<root>/service/bin/`. Nothing in the working repository (`npm run build`, `prepare`, `npm install`, `npm ci`,
an uncommitted `src/` file) touches it. `npm run build` only type-checks, which is what a session of a wave runs, with the tests, before its report.

The lead updates the copy after the review, once the lot is accepted (`raf done`):

```
npm run service -- <sha>   # [--root dir] [--bin-dir dir] [--repo dir]
```

The script refuses a sha that is not an ancestor of HEAD, and a sha whose commits (since the one in service; only the sha itself the first time)
cite a lot whose status is not `done` (`plan:` commits are ignored); a lot `dropped` is let through when every one of its commits is undone by a `git revert` present under the sha (L207), and still blocks when one is not. It builds the new copy aside (`npm ci --ignore-scripts`, then `tsc`) and switches
`service` and the two links only once the build succeeded (atomic renames): a failed install changes nothing. The previous copy is kept for a
rollback, the older ones are removed only once they are more than 7 days old, counted from the day they left service (a wave's snapshot links its `node_modules` to the copy that launched it). The first run is also what installs the links in `~/.local/bin`. It prints the fingerprint of the copy
(bin, dist, package.json).

## A lot whose work is in a neighbouring repository

Some lots are done in another repository that is not a cadence project (B64 of `maritime-atlas` lives in
`aetherwx-gitops`, a Helm chart repository). The lot declares it with the **lot key `repos:`** — a list of paths relative to
the project's repository, one path being enough as a string. There is no project-wide key: a neighbour belongs to a lot.

```yaml
lots:
  - id: B64
    title: …
    repos: [../aetherwx-gitops]
```

**Which commits count in a neighbour.** Nothing is inferred from the neighbour or from the project's name. A commit counts
when it cites the lot's id (as in the project: `feat(B64): …`, `maritime: … (B64)`) **and** is dated within the lot's period,
`started` to `finished` (an open end is open). That is all, whatever the prefix or scope of the subject says and whatever
the commit mentions. When a neighbour is shared between projects whose lots share an id prefix (`developpeur-gitops` holds
the charts of `finance-tracker`, `warhammer40k` and `ol-companion`, all `L…`), the lot says so with an **explicit key**: an
entry of `repos:` can be an object, and the list can mix both forms.

```yaml
    repos:
      - ../aetherwx-gitops                                  # id + period
      - { path: ../developpeur-gitops, cite: ol-companion } # id + period + this string
```

With `cite`, a commit must also contain that string (a substring, case-insensitive, searched in the subject and the body);
a commit of another app that cites the same id is dropped from `raf commits`, from the briefs, from the sha a review
records and from the orchestrator's « already has work » test. Without `cite`, in a shared neighbour, the commits of the
other apps that cite the same id **do** count: that is the default, so declare `cite` for such a neighbour. `cite` applies
to the neighbour it is written on, not to the project's own repository. The commits of the lot in the neighbour must carry the
string too (the briefs say so); one that does not is not counted.

A read-only plan declares it in `cadence.yaml` with `plan.fields.repos: <the file's key>` (a left-out field is read under
the name `repos`). The effect, for `cadence orchestrate`:

- **Preconditions** (refused before acting, exit code 2, like the project's own repository): every listed path exists and
  is inside a git repository, has no tracked file modified, has no `pre-push` hook of its own, and is not held by another
  live orchestration. `--dry-run` applies the same refusals and prints `dépôts voisins : <paths>`. The project's own
  repository and a duplicate listed twice are counted once.
- **Lock and guard**: the neighbour gets the repository lock (`orchestrate.lock`, so `cadence deliver` refuses it too, and no
  other wave can hold it), the temporary `pre-push` hook, and the same after-session checks (push, tampered hook, a review
  that changed it). Two lots that share a repository, as project or as neighbour, run one after the other, never two
  sessions in one repository; `--status` lists the neighbours among the repositories a wave still holds (a repository released once all its lots are finished no longer appears).
- **Sessions**: every session gets each neighbour as `--add-dir`, and the briefs name them: the implementation and the
  corrections must commit there too, with a message that cites the lot (`feat(B64): …`), and never push; the reviewers read
  the commits that cite the lot in the project **and** in each neighbour (`raf commits <lot>` lists them all; in a neighbour only the commits that cite the lot and are dated within the lot's period count, and also contain the `cite:` string when the lot declares one for it — a `fix(B64): …` outside the period, or one without the `cite:` string, is not listed.) A lot whose
  whole work is in the neighbour is not « without commit »; a commit there that does not cite the lot is a warning; a
  neighbour left with a tracked file modified hands the lot back.
- **Verdict**: `raf review` as recorded by the orchestrator stores the sha read in the project and in each neighbour
  (`review.repos`), and the verdict text ends with `dépôts relus : <path>@<sha>`. A commit made in a neighbour after the
  review hands the lot back, like one in the project.
- **Out of scope**: `raf check` does not audit the neighbours, and their delivery (push, CI, deploy) stays with the lead.

**What stays with you**: choosing the lots, the questions raised (`--resume --answer`), re-verifying
after the wave (`git log`, tests, `raf check`), `raf done`, **`raf ux`** (the orchestrator reports the UX
verdict and screenshots, it does not record it), the push and the deliveries, one project at a time.

**Several waves at once**: the lock is per **repository** (a lock in the repository's shared state,
`orchestrate.lock`, which also makes `cadence deliver` refuse that repository), not per folder. A wave is
refused only when one of its repositories is held by a live wave (`<repo> : une orchestration y est déjà en
cours`; the lock of a dead process is detected and cleared); two waves on different repositories run side by
side, even when started from the same parent folder. A repository is released **as soon as every lot of the wave that
touches it is finished** (ready, handed back or failed): its lock and its `pre-push` guard are lifted while the wave goes
on elsewhere, so `cadence deliver` accepts it (a repository with a lot still to play, a question or a suspended lot stays
held until the wave ends). `cadence deliver` also reads the wave's own state when a lock is still held: it refuses only if the wave still has a lot running, queued or suspended **in this repository**, and goes ahead when the lots left are elsewhere (an unreadable wave state still refuses). They share a **cap on simultaneous sessions**, counted
across all live waves: 2 by default, `--max-sessions N` (or `CADENCE_MAX_SESSIONS=N`) to change it — give
every wave the same value: each wave counts ALL live sessions, whatever their slot, and waits while that
count has reached ITS OWN cap, so with different caps the highest one can push the total past the lowest
(which then waits). A session that finds no free slot **waits** (the wave is not refused; the journal says
`en attente d'un créneau de session depuis …`, repeated every minute, then `créneau de session obtenu après …`).
`cadence orchestrate --waits [--since YYYY-MM-DD]` adds those waits up from the journals of `.cadence/runs/` of the launch folder — per day (cumulated wait, number of waits, waves, quota stops — one per "→ suspended — quota atteint" line of the journals, counted on the day of that line, so a wave resumed and stopped again on another day counts once on each day, not once as a wave, tokens) and per wave that waited (the longest wait, a wait that never got its slot) — to decide the cap from figures; each wait is paired with its lot (the journal line carries `project:lot`), so two lots of one wave waiting at the same time (one per repository) are each counted once, and only a wait that never got its slot is reported as such; journals from before this carry no lot and are paired per wave. it reads only, and refuses any other action in the same call. The figures of 2026-10-12 and the cost of a third slot are in `docs/mesures/attente-creneaux-2026-10-12.md`.
A slot or a registry entry is owned by a pid **and** its start time: a reused pid is a dead owner. Wave
identifiers are reserved atomically (`-2`, `-3` suffix when two waves start in the same minute; an existing
`--wave` is refused). The registry of live waves and the slots live under `~/.cadence/orchestrate/` (`CADENCE_HOME`
to move it): `cadence orchestrate --status` lists, from any folder, the live waves, the repositories each
still holds (those not yet released), the cap of each wave, the slots in use and the **free slots** (`créneaux libres : N sur M`: M — the cap set with `--max-sessions` or `CADENCE_MAX_SESSIONS`, 2 by default — minus, for each live wave, the smaller of its cap and the repositories it still holds — minus the sessions the lead started by hand and declared with `cadence lead hold <label>` (L255, [lead.md](lead.md#lead-hold-and-release): the line then reads `… · sessions du lead : N (labels) · créneaux libres : …`, and prints even with no live wave) — the figure the `lead` skill reads before starting a subagent; the lead never raises the cap itself, that is the human's decision, L208). Without an identifier it then prints the table of the wave launched most recently from this folder (by launch time, not by alphabetical order of the identifier).

**Guards, imposed by the code**: a global cap of simultaneous sessions, one wave per repository at
a time (above); `Agent`, `git push`, `cadence deliver`, `raf done|review|ux` are denied to the sessions; a
temporary `pre-push` hook, installed for the duration of the wave and removed at its end (or, for a repository, as soon as all the lots that touch it are finished), refuses any push
from a session (`CADENCE_ORCHESTRATED` is in their environment; a repository that already has another
`pre-push` hook is refused before anything starts — `pushurl` is never touched); after every session the
upstream ref and `git ls-remote` are compared with the "before" (a `git checkout <sha>` or `git switch` that only moves `HEAD` — detached `HEAD`, another branch, no upstream any more — is not a push: the upstream ref is compared only when it is the same branch on both sides, `git ls-remote` stays the judge; the write briefs forbid `git checkout` and `git switch` in the repository and point to a throwaway `git worktree add --detach <tmp> <sha>`; should a write session still end off its starting branch, a clean tree with nothing outside the branch gets the branch put back (`git checkout <branch>`, a warning in the log, the lot carries on from the right `HEAD`), anything else — including a put-back that fails (`index.lock`, a conflicting file), cause « HEAD déplacé — remise de la branche <b> impossible : <git message> » — hands the lot back with the cause « HEAD déplacé » and holds the queue of that repository, the other repositories carrying on; a push or a removed guard hook in ANY watched repository, project or neighbour, is checked first and wins over a moved `HEAD`, L214), and a read-only step that left only UNTRACKED files (screenshots written at the root by a script with a relative path) is not an incident: the files are moved to `.cadence/runs/<wave>/<project>--<lot>/stray/` (kept in their tree; for a neighbour repository, under `stray/<its relative path, `/` replaced by `_`>/`, e.g. `stray/.._gitops/`), a warning naming them goes to the lot's warnings and the wave log, the verdict is kept and the lot continues (L162; a move that is impossible, or an untracked file that vanished during the step, stays an incident); a review that changed `HEAD` or a tracked file (a commit, a modified file) is an incident of that lot only: the lot is handed back to the lead, the lots of the other repositories carry on while the lots still queued behind it in the same repository are suspended (resumable, nothing started on a dirty tree), and a verdict the review had already produced is reported in the outcome and the lot's warnings (never recorded in the plan). A push or a removed guard hook still stops the wave. `raf done|ux|review` and `cadence deliver` refuse when
`CADENCE_ORCHESTRATED` is set.

**Budget**: the wave counts input + cache writes + output tokens (default 2 M); cache reads are kept and
shown apart. Each lot also has its own budget, the 90th percentile of the *total* measured per lot on `.cadence/runs` (all the waves a lot went through, 250 lots) for its category (L194): an ordinary lot of up to 0.5 day gets 600 k (floor: a write pass, its review, one fix pass and the short review after it, 155 k being reserved for those last two; measured p90 374 k on 11-10, 451 k on 16–22-10: 3 of 145 lots over 540 k, all maritime-atlas, hence 600 k, L247), 0.5 to 1 day 750 k (p90 732 k), then 570 k per day of estimate, 750 k staying the floor until that exceeds it, i.e. up to 1.3 day (p90 1.14 M for 2 days); a lot with `screen: page` gets 1.3 M whatever its estimate (`component` and `journey` keep the ordinary budget; p90 1.28 M: spec, mockup, accept, conformity UX and passes), or its ordinary budget plus 450 k beyond that; a lot with `spec: true` gets its ordinary budget plus 450 k (the back chain measured on L120: 388 k); shown by
`--dry-run` with its basis): it bounds the *writing* passes, never the reviews. A lot that spent it gets no further implementation or
fix and is handed back to the lead, but its review (and its single UX review, once the code review is compliant) is played first; a fix pass starts only if
the remaining budget can also pay the fix and the short review that follows it (155 k tokens reserved: the p90 of a fix
pass, 65 k over 497 passes, plus the p90 of a short Opus review, 88 k over 272; measured on 2026-10-15 in the wave journals
`.cadence/runs`). A lot refused that fix is handed back with the cause `correction non jouée (budget) :` first, so the lead
takes the correction by hand (L218).
Exception: when the tests are red after a write pass, the lot goes to a fix pass without a review; if that fix pass is
refused for lack of budget the lot is handed back to the lead without a review, with its findings, and the cause names
the red tests: the pass it names is the one whose tests were red, counted by its number (« la passe fix 2 », « l'implémentation »), and « la passe des mineurs » appears only when that pass was the one played. The wave budget stays for the others. When the budget (or the usage limit) is reached no new session starts, the running ones
finish, the wave is *suspended* (exit code 3) and `--resume --budget …` continues. A session that returns
nothing readable, times out (45 min for work, 25 for a review) or fails is not retried; the lot is handed
back with the cause. Exit codes: 0 every lot ready · 1 at least one lot handed back (question, failure,
review still not compliant after two passes, or three when it converges) · 2 refused before acting · 3 wave suspended.

**Stacked lots** (L76): lots of one repository commit on top of each other on `main`. When a ready lot sits under a lot that
is not ready (handed back, failed…), the final table adds a line `<project>:<lot> — livrable jusqu'à <sha> … : git push origin <sha>:main && cadence deliver --sha <sha>`:
the last commit of the highest ready lot with no unfinished lot's commit beneath it. Ship it without the lot above by pushing
that sha alone, then delivering it: `git push origin <sha>:main && cadence deliver --sha <sha>` (with `ci: github` the CI wait
looks for the run of that exact sha, and GitHub only builds the tip of a push; pushing HEAD would also put the unreviewed lot
on `main`). A lot's commits are read from git (the commits that cite it, whatever session or wave made them; plan-only and
version commits do not count), not only from the sessions' reports, so a failed or timed-out session that committed still
bounds the line. Nothing is printed when every lot is ready or when the ready lots sit above the unfinished one.

**Formatting retry** (the only `--resume` of a session): when a session ends successfully but in plain text,
without the `structured_output` the schema asks for (the verdict is there, not in the required shape), the
orchestrator resumes **that same session once** (`claude -p --resume <session-id> --json-schema <same schema>`,
same model, permission mode and denied tools) with a short prompt that only asks for the report in the required
format. It applies to every step that has a schema (implementation, correction, reviews). The tokens of the
retry count in the wave budget and in the step (`formatRetry: true`); if the output is still missing after it,
the step fails as usual — never a second retry.

**Cut review, relaunched once (L256)**: a read-only step (review, small review, UX, precheck, mockup review, sheet) whose session is
killed by a signal without writing anything (exit code above 128, such as 143 for SIGTERM, and an empty output) is *cut*. The
orchestrator launches the same step **once more in a NEW session** (a fresh `--session-id`, the same brief; never `--resume`: a cut
session has nothing to resume and the formatting retry above does not apply to it) before handing the lot back. The cut session's
tokens are read from its journal and counted in the wave budget **and in the step** (so the lot's own budget and the table's token column see them), its `stderr` is kept in `<n>-<kind>.first.err`, and the table shows
`<kind> relancée en session neuve après une coupure (code 143, sortie vide)` among the warnings. Cut again, the lot fails with `coupure : …`.
A session killed by the orchestrator itself (Ctrl-C or SIGTERM of the wave) is never relaunched: the new one would outlive it. Write steps (implementation, correction, spec, acceptance) are never relaunched, nor are the local model, a timeout, a non-empty output or
an ordinary exit code. The table tells the three stops apart in the line under it: `quota atteint` (the lot is suspended, the wave
resumes with `--resume`), `coupure : <kind> coupée (…), relancée une fois en session neuve, coupée de nouveau` (the session itself was
killed twice: look at the machine, not the lot), `échec : <kind> sans résultat : <cause>` (the session ended without a usable report).

State is in `.cadence/runs/<wave>/` of the folder where the command is run (added to `.git/info/exclude`
when that folder is in a repository, together with `.cadence/corrections.json`; the rest of `.cadence/`, the plan and its notes, is versioned. `.cadence/runs/`, `.cadence/corrections.json` and `.playwright-mcp/`, where the Playwright MCP writes its
output, never count as a dirty repository, even when `.gitignore` does not list them, while a change to `.cadence/raf.yaml` does): `wave.json`, one `<project>--<lot>.json` per lot (steps, tokens
kept apart, session ids, commits, verdicts), the JSON output of every session and a `journal.log`. After a
cut (Ctrl-C, WSL closed) `--resume` replays an interrupted step entirely in a new session whose brief
lists the commits already present; finished steps are never replayed.

When a session ends — success, error, time limit (`timeouts`) or interruption of the wave — nothing it started
survives it: besides its process group, the tree of its descendants is tracked while it runs and killed with it, and
every session carries a `CADENCE_SESSION=<id>` mark in its environment that all its descendants inherit, even those
re-parented to init (`nohup srv &` or `setsid srv &` from a shell that exits at once): at the end — as soon as the session's root process exits, not when its output closes, so a descendant holding stdout open cannot turn a session that exited with code 0 into a "time limit" failure — every process
bearing the mark is killed (read from `/proc/<pid>/environ`, or, where there is no `/proc`, from `ps -axEww` on macOS — `-E` is the BSD option that prints the environment, `-e` only means "all processes" there — and `ps axeww` with procps on Linux).

Limits of the mark, stated rather than hidden: it is read from the process environment, so a descendant that
dropped it (`env -i`, `env -u CADENCE_SESSION`) is only reached by the tree tracking, and only if it was seen under
the session between two samples (every 200 ms); a process whose environment is unreadable (another user) is never
found; a process started through a daemon that already ran before the session (`docker compose up -d` talks to the
Docker daemon, which owns the containers) is out of reach. **Shared daemons are spared**: a tmux server, `screen`,
`gpg-agent` or `dirmngr` started on demand by a session carries its mark and would pass it to clients and panes opened
later from elsewhere, so killing by mark would kill the lead's own tmux panes; those daemons (only when they carry the mark: the lead's own tmux, where cadence itself may run, does not, and spares nothing), and everything that
descends from them, are left alone (a dev server started inside a tmux pane therefore survives its session). Not in
that list, because their name does not tell them from an ordinary client: the ssh master (`ControlPersist`), the
Gradle daemon (java) and pm2 (node) — they are killed if they carry the mark.

Briefs are the templates of `templates/orchestrate/` (`implement.md` is the `lead` skill's standard
brief; `--dry-run` writes the rendered ones). The `implement` brief of a `visible` lot also carries the
News instruction (`cadence news new <lot>`, factual user-side text, a screenshot in `docs/nouveautes/captures/` or
`nocapture:`, `cadence news check` green); the brief gives the absolute path of the wave's Playwright output directory and the `implement` session gets `--add-dir` on it, to copy the capture into the repository; the `fix` and `fix-minors` briefs of a `visible` lot give the same folder (and their sessions the same `--add-dir`), to fetch a screenshot a finding asks for; a lot that is not `visible` gets nothing. A `--dry-run` brief of a `visible` lot has no wave folder (the wave does not exist yet), nor does a brief delegated by hand: the News instruction then says to save the screenshot under the OS temp directory, never inside the repository, then copy it into `docs/nouveautes/captures/`. A project can declare, in `cadence.yaml`:

```yaml
orchestrate:
  test: npm test                         # run by the orchestrator after a work step (optional)
  build: npm run build                   # run after the tests; both results go to the reviewer, who does not redo them (optional)
  precheck: true                         # default: before the first implementation of a lot with no commit, a read-only Sonnet session checks whether the deliverable is already in the repository (see below); false skips it, local runs it on claude-local (Ollama) with Sonnet as fallback
  accept: npx vitest run -c vitest.acceptation.config.ts   # accept step (see « The accept step »): the dedicated command that runs ONLY the acceptance tests of the lot (optional; without it the step is skipped with a warning)
  maquette: true                         # default: UX review of the mockup between spec and accept (see « The mockup review »); false skips it
  maquetteReviews: 3                     # default 3: how many reviews of the mockup per lot (integer ≥ 1); also the `spec` session budget of a lot with a screen
  fiche: true                            # default: review of the back-end sheet of a lot with spec: true between spec and accept (see « The spec step of a lot with spec: true »); false skips it
  spec: { dir: docs/specs }              # spec step (see « The spec step of a lot with screen: »): folder of the screen specs, relative to the repository (default docs/specs); render: the command the spec session runs to render the mockups at 1440 and 390 px (optional, Playwright otherwise)
  prodAccess: false                      # default: wave sessions get no access to production (see « Production access of the sessions »); true lifts it for this project
  effort: { review: xhigh }              # effort level per pass (see « Effort level per pass »): precheck, spec, maquette, fiche, accept, implement, fix, review, ux
  ux: http://localhost:4200              # a URL, a launch command, or { command, url, timeout? } — for the UX review (see below)
  permissionMode: auto                   # default
  addDirs: [/home/me/projects/tmp]       # extra directories the sessions may use
  timeouts: { implement: 45, review: 25 }   # minutes
  # a plan kept by the project's own tool is read-only for raf: the orchestrator calls these instead
  start: python3 scripts/raf.py start {lot}
  verdict: python3 scripts/raf.py note {lot} "revue de code : {verdict}"
```

**`orchestrate.ux`, who starts the app**: a string is a URL if it starts with `http://` or `https://`, a launch
command otherwise; both forms behave as before (the `ux` brief gives the URL, or tells the session to start the app
with the command and stop it). The object form `{ command, url, timeout? }` makes **the program** start the app, not
the UX session. Before the `ux` step (played once, after the compliant code review, L221) and before the `review-small` single pass of a small `visible` lot, which follows
the same rule, the orchestrator:

0. takes a lock on the `host:port` of `url` (a file `cadence-ux-<host>-<port>.lock` in the OS temp folder, created
   exclusively, containing the pid of the orchestrator; a lock whose pid is dead is taken over). Another wave — in
   this process or another — that declares the same URL waits for it, and the wait counts in `timeout`; past it the
   note is « UX non vérifiée : url tenue par une autre vague » and nothing is started. The lock is given back after
   the app is stopped. Declaring **distinct ports per project** is still recommended: the lock serialises two waves
   on one URL, it does not make them fast;
1. probes `url`; if it already answers it does **not** start anything, notes « port occupé » (`uxNote`: the UX is not
   verified) and the lot goes on;
2. starts `command` with `sh -c` from the repository root, in its own detached process group, its output in
   `<wave>/<project>--<lot>/ux-app.log` (the command carries its own prefixes, e.g. `cd web && PORT=4300 npm start`;
   there is no `env`, `cwd` or account/PIN key);
3. probes `url` until an HTTP status below 500, for `timeout` seconds (default 300); the answer only counts while
   the process group it started is still alive. A command that exits early, or
   no answer in time, means « UX not verified » with the end of the log in the note: the UX session is skipped,
   the code review being already compliant the lot concludes with its note — it is never a failure of the wave (the single pass of a small lot still runs,
   on the code alone, its brief saying the app could not be verified);
4. gives the session « The running app is at `<url>` », with no instruction to start anything;
5. at the end of the step — success, error or SIGTERM of the wave — kills the group: SIGTERM, then SIGKILL after 10 s.

```yaml
orchestrate:
  ux: { command: 'cd web && PORT=4300 npm start', url: 'http://localhost:4300', timeout: 120 }
```

In the object form `url` must start with `http://` or `https://`, and `timeout` is only accepted together with both
`command` and `url` (the program only waits when it starts the app). A wave stopped (incident, quota, budget) before
the step suspends the lot without starting the app.

**Node per project (`.nvmrc`)**: when a project has a `.nvmrc` at its root, every session the
orchestrator launches for it (implementation, UX and code reviews, corrections) runs with the matching Node
first in its `PATH`, so `node`, `npm` and `npx` resolve to it (Astro needs 22 while the default may be 20) — and so does
the app the program starts for the UX review (`ux.command`): same links directory first in its `PATH`, no
`. ~/.nvm/nvm.sh && nvm use` prefix needed (it exits with code 3 under `sh`). Only
those four names (`node`, `npm`, `npx`, `corepack`) are exposed, through symlinks in
`.cadence/runs/<wave>/node-bin/<version>/` (recreated at start and at every `--resume`): the rest of that Node's
`bin` (globally installed `raf`, `cadence`, `claude`…) is never exposed, so it does not shadow the tools in the usual `PATH`;
only the snapshot's `tool/bin` (above) comes first, ahead of this Node directory. `--resume` resolves
the `.nvmrc` again for every live lot and refuses it like at start if it can no longer be resolved.
The file is read trimmed (`22`, `v22`, `22.22`, `v22.22.3`); the highest matching version installed under
`$NVM_DIR/versions/node` (default `~/.nvm/versions/node`) **that has an executable `bin/node`** is used: a higher
version with an empty or broken `bin` is skipped for a lower valid one (and `--dry-run` says so); if none is valid
the lot is refused. Only the sessions' environment changes,
never the orchestrator's own. No `.nvmrc` → nothing changes. A `.nvmrc` that cannot be resolved (`lts/*`, an
alias, a version not installed) refuses the lot before anything is started (exit 2), naming the requested
version and the folder searched — there is no silent fallback to the default Node. `--dry-run` prints
`node : v22.22.3 (.nvmrc 22)` under each lot that has one, with the skipped versions when it happens
(`node : v22.9.0 (.nvmrc 22 ; v22.22.3 écartée : pas de node exécutable)`).

**Minimal MCP servers per step**: every session the orchestrator launches gets `--strict-mcp-config --mcp-config
<file>`, with the file written by the orchestrator in the lot's folder of the wave
(`.cadence/runs/<wave>/<project>--<lot>/mcp-<step>.json`). `--strict-mcp-config` makes `claude` ignore every other
source (user, project, plugin servers: Serena, context7, Cloudflare…), so a session no longer starts a handful of
`npx`/`uvx` servers it does not use. `review` and `review-recheck` always get an empty set
(`{"mcpServers":{}}`); so do `implement`, `fix` and `fix-minors` on a lot without a screen. Playwright, launched as
`npx -y @playwright/mcp@latest --output-dir <wave>/<project>--<lot>/playwright`, is loaded for the `ux` and `maquette` steps and, on a
`visible` lot, for `spec`, `implement` and `fix` (`fix-minors` included) and, on a small `visible` lot, for `review-small` (its only
usability review; `review-small` of a small lot without a screen loads nothing), so the screenshots and snapshots of the work and of
the review stay with the wave, outside the repository, where the lead can look at them; the final table prints that
folder whenever Playwright was loaded for the lot, even if no `ux` step ran
(`<project>:<lot> — captures Playwright : <dir>`; `uxCaptures` in the wave state). For `maquette` and `spec` the server also gets
`--allow-unrestricted-file-access`: the mockup is a local file, and by default the server blocks every `file://` URL. The `implement`, `fix`,
`fix-minors`, `review-small`, `ux`, `maquette` and `spec` briefs carry a `{{shots}}` paragraph (L249) when the step loads the server: the absolute path of the wave's capture directory (`<lot folder>/playwright`), to put in front of every screenshot, snapshot and trace name. Measured on `@playwright/mcp` 0.0.83, `--output-dir` only covers the files the server names itself; a name given by the session is resolved against the server's workspace root, the repository, which is why « a relative file name only » left `savings-1440px.png`… at the root of 5 lots out of 5 on 2026-10-23 (finance L119 L120 L122 L124, warhammer L175). The server allows the absolute path (it lies in its output directory). A brief delegated by hand (`--dry-run`) has no wave folder, so no `{{shots}}` (a test reads the briefs `--dry-run` writes to check it); the `ux-reviewer` and `qa-reviewer` agents, which can also be run by hand with the Playwright plugin, give a path under `.playwright-mcp/` there (`.playwright-mcp/page-home.png`), never a bare name, which the server would put at the repository root. The brief otherwise tells the session to keep any Playwright CLI output outside the repository; `stray/` stays the safety net. The `review-small` brief also forbids a capture at the root of the reviewed repository (`romans-1440px.png`…, four times on 2026-10-17: finance L82 and L84, warhammer L138 and L139): it says that a capture reaches the wave's run directory only through the absolute path of `{{shots}}`, and that a bare file name is resolved against the repository (L237, L249).
`--dry-run` prints, under each step, `mcp : aucun` or `mcp : playwright (…)`. There is no per-project override in
`cadence.yaml` yet.

Without `start`, a read-only plan's `todo` lot is refused (start it with the project's tool); without
`verdict`, the review verdict stays in the wave's state and you report it. Only the plan's files
(`plan.path`, `plan.files`, the QA expectations file) are committed from those commands; anything else dirty stops the lot (`.cadence/runs/`, `.cadence/corrections.json` and `.playwright-mcp/` excepted, as above).
