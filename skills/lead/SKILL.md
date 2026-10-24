---
name: lead
description: Lead several cadence projects from a parent folder without loading them into the main context — take the facts of every project with `cadence lead tour`, agree the priorities with the human, delegate each chosen lot to a subagent with a standard brief, have the work reviewed, re-verify it yourself, then deliver one project at a time. Triggers — "/lead", "pilot all projects", "on pilote tout", "délègue aux sous-agents", start of a multi-project day.
---

# Lead — decide at the top, work in subagents

The lead session stays small: it reads summaries, decides with the human, delegates, checks and
delivers. Project files are changed by subagents, each with its own context; the facts of the tour come from `cadence lead tour`, a program. The projects
are the sub-folders of the current directory that contain `.cadence/raf.yaml` or `docs/plan/raf.yaml`, or a `cadence.yaml`
with a `plan:` key. A project whose `cadence.yaml` maps the fields of a plan kept by its own tool is
**read-only** for `raf`: it takes part in the tour, and its plan is changed with the project's own
commands (its CLAUDE.md names them), never with `raf start|done|note|ux|review`.

## Limits that always apply

- **At most as many subagents running at once as the session cap, 2 unless the human set another.** Queue
  the rest. The cap is the human's setting (`CADENCE_MAX_SESSIONS`, or `--max-sessions` on a wave; 2 by
  default, shared by every wave). The sessions of an orchestrated wave (section 2b) count toward this limit:
  orchestrate sessions plus subagents never exceed the cap. A wave already caps itself; before starting a
  subagent, check `cadence orchestrate --status`, and while a wave runs, start none beyond the free slots. Read the cap and the
  free slots, do not compute them: `cadence orchestrate --status` and `cadence lead tour` print
  `créneaux libres : N sur M` (M is the configured cap; the registry subtracts, for each live wave, min(cap,
  repositories it still holds) and one slot per lead session (below) from the M slots; no line from `lead tour` means no live wave and no lead session, so all M are free).
  **A session you start by hand counts too** (a fix subagent, a review, a QA pass launched outside a wave): the registry does not
  see it, so declare it. Right before starting it, `cadence lead hold <label> [--ttl minutes]` (60 minutes by default,
  the label names the session: `correctif-L12`); as soon as it comes back, `cadence lead release <label>`. While it is held, both
  commands print `sessions du lead : N (labels)` and subtract it from `créneaux libres`; the `--ttl` is the maximum duration you
  declare for the session (size it to the slot you have, not to the optimistic case). When it runs out the hold stops counting, but
  nothing stops the session: `lead tour` and `orchestrate --status` print `⚠ session du lead échue : <label> (…)` until you
  release it, and the band shows the same ⚠ row. **At each ⚠, decide at once**: either it is still worth the slot, so renew it
  with `cadence lead hold <label> --ttl <minutes>` and say why in one sentence, or stop it (`TaskStop` or the agent's end) and
  `cadence lead release <label>`. A fix that ran 5 h on a 3 h slot (23-10) is the case this catches. Holding does not block anything and never raises the cap.
  Never raise `--max-sessions` or `CADENCE_MAX_SESSIONS` yourself to speed a wave up: raising the cap is a decision of
  the human (a trial at 3 was decided on 2026-10-12); if the slots are the bottleneck, say so and let them decide.
- **Never two subagents in the same repository at the same time**, and the lead does not commit in a
  repository where a subagent is working.
- **Deliveries and `raf ux` / `raf review` verdicts are done by the lead, one project at a time** —
  never by a subagent, never two deliveries in parallel.
- A subagent cannot ask the human anything. When it hits an ambiguity it stops and reports; the lead
  brings the question to the human.

## 1. Tour of the projects

Run `cadence lead tour` from the parent folder (one command, no subagent, no model: it reads the same
facts as `cadence session start` for every project). It prints one line per project — lots in progress with their commit count
(`0 commit` included; `silencieux Nj` when idle for more than three days), drift, notes from the last close, the next ready lot,
repository state — and exits 0 even when a project is in error (its line says so). `--json` gives the same
content. Read the lines yourself; open a project's own `cadence session start` only for the one you need to
look at closer.

The tour opens with the **perf header**: one line per `⚠` of `cadence perf` (speed and quality side by side), nothing
when everything is stable. Read it **before proposing the three items** and relay each `⚠` in one line in your report.
Open an **improvement lot** only on a trend confirmed on two windows (a `⚠` of trend: two windows compared, enough lots, window
not truncated) or on a net bottleneck (`⚠ goulot`): at most one improvement lot per tour, in addition to the three, never in
their place, and the human decides. Never open a lot for a micro-optimisation or for the variation of a single window.
Without a `⚠`, the header is empty and you say nothing about perf.

Then report to the human in a compact table — one row per project — and propose **three** items
across projects, each with project, lot id and one sentence of justification: finish what is in
progress, then drift that blocks a delivery, then ready quick wins. **Stop and wait for the priority.**

## 2. Delegation

The default way to delegate is **`cadence orchestrate`** (section 2b): a program, not a conversation, that runs
one fresh short session per step; the wave runs from a frozen copy of the cadence package, so it can orchestrate cadence itself and its templates can be edited meanwhile. When the lead delegates by hand, the brief is the template
`templates/orchestrate/implement.md` of the cadence package — the single source, tested. The lead runs
`cd <project> && raf start <lot>`, then starts from the brief written by `cadence orchestrate --dry-run
<project>:<lot>`: it is already rendered (`{{chemin}}`, `{{lot}}`, `{{titre}}`, `{{objectif}}` and `{{news}}`,
the News instruction of a `visible` lot, are filled in; it names no wave Playwright directory — a hand delegation has none — so the screenshot goes under the OS temp directory, then into `docs/nouveautes/captures/`). The lead only adjusts the goal to what done looks
like (the human's words) and keeps the rest verbatim. **A stale title is no reason to delegate by hand**: the lot's scope changed since the plan was written, so give the new goal to the program — `--goal "…"` on the launch (one lot per launch), or a `goal:` key on the lots in the plan (every launch, several lots at once): `goal:` in a native plan, and in a plan kept by another tool (read-only, e.g. maritime's `docs/plan/taches.yaml`) the key of theirs that holds it, mapped with `plan.fields: { goal: <their key> }` in `cadence.yaml` (an unmapped key other than `goal` is ignored without a message). It replaces the title as the objective of every brief and shows in the wave table.

A lot that adds or changes a screen is `visible`: after the implementation, have the
`ux-reviewer` agent review it (give it the URL or the way to run the app) and bring its verdict and
proposed sub-tasks back to the human — or, where the folder's `cadence.yaml` says `lead.ux: lead`, form the UX verdict yourself (see « The UX verdict » in section 2c).

### 2b. A wave through `cadence orchestrate`

Once the human has chosen the lots, the lead runs, **in the background** (it is notified at the end; no
silent wait, no polling loop — `cadence orchestrate --status` shows where the wave is, and the follow-up below pushes each transition):

```sh
cadence orchestrate <project>:<lot> <project>:<lot>@haiku … --wave <id> [--budget 2M]
```

For a single lot whose title is stale, add `--goal "<what done looks like>"` (refused with two lots, `--continue` or `--resume`); for several lots, a `goal:` key per lot in the plan (mapped by `plan.fields.goal` on a plan kept by another tool).

**Make the wave visible to the human.** Name the background task after what it runs — « vague `<id>` :
`<project>:<lot>`, … » (its `description`), so the task list says which projects and lots, not just « a task
is running » — and pass `--wave <id>` (e.g. `2026-10-08-1030`) so its state folder is known in advance. Right after
starting it, arm **one follow-up** (the Monitor tool) on the wave's journal, which holds one line per transition (lot → new
state, question, ready, handed back). The final table is not in the journal: it arrives with the background task's end notification, at which point stop the follow-up (it never ends by itself; a later `--resume` writes to the same journal):

```sh
tail -n +1 -F .cadence/runs/<id>/journal.log     # from the folder the wave was launched in
```

Each line it prints reaches this conversation as it happens: relay it to the human in one short sentence, and
bring a question back at once (`--resume --answer`). That follow-up replaces any waiting loop: still no polling,
no `sleep`. The human can also watch from a terminal with `cadence orchestrate --status --watch` (table refreshed
every 10 s, `--interval <s>` to change it; it stops by itself when no wave is running).

**Steering a wave that is running.** From the folder the wave was launched in (`--wave <id>` when several run from it), in
another command: `cadence orchestrate --drop <project>:<lot>` takes a lot out of the wave — a lot not started never starts, a lot
with a session running lets that session finish, then it is handed back to the lead (its commits stay); a lot that depended on it is
handed back too. `cadence orchestrate --stop-after-current` lets the sessions running finish and starts nothing else: the wave
ends `interrupted`, and `--resume` takes it up again. To take a lot out of a wave that is already stopped, use
`--resume --drop <project>:<lot>` (the lot is handed back instead of being replayed). Neither kills a session.

**One worktree per lot is experimental and not enabled** (`orchestrate.worktrees: true`, L279): `cadence orchestrate` refuses it (exit 2, `--dry-run` too) while lots L299, L300 and L301 are not done, unless `CADENCE_EXPERIMENTAL_WORKTREES=1` is set (the mode's tests only) — never set it for a real wave. Its options exist but belong to that mode: `--resume <wave> --integrate <project:lot>` replays a lot handed back at the integration step (the wave's output names that exact command), `--replay <project:lot>` also after a refused plan write, `--remove-worktree <project:lot> [--abandon-commits]` removes a kept worktree and branch, and `cadence orchestrate --status` and `cadence lead tour` list the worktrees kept by waves (nothing to list in the default mode).

**Delivering while the wave runs.** A lot that turns **ready** in the journal is not left waiting: once the lead has re-verified it (section 3, point 2) and recorded its verdict (`raf done`), it delivers that lot at once, without waiting for the end of the wave. The re-check runs at that sha in a throwaway `git worktree add --detach <tmp> <sha>` (removed afterwards), never in the shared tree, which holds the lots still running. Take the sha to deliver from `git log`: the last commit of the ready lot such that no commit of a lot that is not ready (running, queued, in question, handed back) sits beneath it — the same « livrable jusqu'à » the final table prints. Push that sha alone (`git push origin <sha>:main`, never HEAD, which holds the code of lots still running), then `cadence deliver --dry-run --sha <sha>` and `cadence deliver --sha <sha>`: `deliver` accepts a `--sha` during a wave of the same repository when none of its commits belongs to a lot that is not ready, and refuses otherwise, naming the lots. Without `--sha` it stays refused until every lot of the repository is ready or handed back. The wave's sessions keep committing in the working tree: `--sha` never reads it. What the log keeps is `<sha>`, unless the delivery script declares another deployed commit in `CADENCE_DEPLOYED_FILE`; if HEAD moved during the delivery without that declaration, `deliver` warns (« la tête a avancé pendant la livraison ») and the log keeps `<sha>`: it is not a failure. This is the measured gain: a ready lot used to wait for the slowest lot of its wave (1,554 lot-minutes between « ready » and the end of the wave over 28 waves).

**Free resources.** While a wave is live or a session is held with `cadence lead hold`, `cadence lead tour` and `cadence orchestrate --continue` print, after the free slots line, `prêts, ressources libres : <project>:<lot> <title> (<resources>) · …`: the ready lots whose shared resources (`uses:`) nothing holds. Read it again each time an agent comes back (a session ended, a lot handed back or ready) and each time a lot is blocked (a question, a refusal, a resource taken), **before waiting** for the next transition: a lot listed there can start now, so start it (with the free slots line saying a slot is free) instead of waiting behind the blocked one. The line is a display: nothing is locked, and it never raises the cap — no `créneaux libres`, no new session. No line means no ready lot is free: wait.

`cadence orchestrate --dry-run …` first when a precondition is in doubt. The program, not the lead, runs
for each lot a fresh short session per step — implementation (Sonnet), code review
(Opus, the `code-reviewer` agent; Sonnet, with no pass on the minor findings, for a lot whose estimate is
≤ 0.25 d — `orchestrate.review` in `cadence.yaml`; a blocker or major finding still brings a correction and an
Opus review), a correction in a new session if the review is not compliant (two
passes at most, a third when the review converges: blocking + major findings down from one review to the next and only one left), then, once, a UX review if the lot is `visible` and the project declares how to see its app (`orchestrate.ux` in `cadence.yaml`) — and records `raf review` itself when the code review is compliant and the UX review too. A lot with `spec: true` (no screen) goes `spec → fiche → accept` before the code: the `code-reviewer` reviews its back-end sheet, and the hypotheses of the final sheet come back in the table as « hypothèse de la fiche » lines, which the lead relays to the human. The state is in
`.cadence/runs/<wave>/`, not in this conversation. `@haiku` only when the human writes it, for a
mechanical lot. Exit code: 0 all ready · 1 some lots handed back · 2 refused before acting · 3 wave
suspended (budget or usage limit; `--resume --budget …` continues).

What the orchestrator does **not** do, and stays with the lead: choose the lots (with the human), bring the
questions back (`--resume --answer <project>:<lot> "…"`), look at the UX reviewer's captures and record
`raf ux` (the orchestrator reports its verdict, it never records it; who decides it is the `lead.ux` setting, section 2c), re-verify (section 3, point 2),
`raf done`, push and deliver. **A locked acceptance test that contradicts the sheet** (the lot is handed back with `verrou des tests d'acceptation`, or the session's question says its own test is wrong, e.g. a regex that rejects a sentence the sheet allows) has a path, and it is the lead's, never a session's: correct the test in the working tree (the sheet is left as it is; if it was amended, **commit it first, citing the lot**: an amended sheet whose every commit cites the lot is accepted, L217, never put it back to the red state), then `cadence spec reseal <lot> <test> --reason "why it contradicts the sheet"` (outside any wave): the program redoes the fingerprint of that one test, writes the reason in `acceptation.json` (`resceaux`) and as a note of the lot, commits both, and the lock keeps everything else. For a **delivered** lot (`vert: true`) whose contract does not change but whose test is unstable, add `--porteur <the lot in progress that carries the fix>`: the commit and the note cite that lot, `vert` stays true (L212). It refuses a lot that is neither in progress nor delivered, a sheet with uncommitted changes or touched by a commit that does not cite the lot, and any other listed test touched, and during a wave of that repository. It is atomic (a refused commit restores `acceptation.json` and the test), with a plan kept read-only by another tool it leaves the plan untouched and says a note is to be added by hand, with an untracked plan or one outside the repository it writes the note but does not commit it (`plan à commiter`: do not add it again), and if the commit of the note is refused the reseal stays done and the error says to commit the plan by hand. It is also refused while a wave that is not `done` (stopped on a question or the quota, or still alive) keeps open any lot of that repository still `doing` in its plan, **the resealed lot, the porteur or any other lot of the repository** (the lock hands back all of them, L238; a lot `done` or absent in the plan, an old abandoned wave, a lot of another repository with the same id never block): the error is a single message, also when a live wave holds the repository lock: it lists every wave (the live ones and the stopped ones) with its launch folder and its lots and gives, for each stopped wave, ONE command to run as it stands, `cd <launch folder> && cadence orchestrate --resume <wave> --drop <project>:<lot> --drop <project>:<lot>` (a `--drop` per open lot of the repository, queued ones not yet `doing` in the plan included, since `--resume` replays the whole wave; or `--resume <wave> --answer …` to let it go on); a wave still alive is waited for. Close them **first**, reseal afterwards. Do it **between two sessions**, never inside one: a resealed commit that belongs to a session of the wave is not adopted (still a lock violation), and sessions are forbidden the command. Then continue the lot: a new wave `cadence orchestrate <project>:<lot>` when it was handed back (`--resume` skips finished lots). Minor findings and proposed sub-tasks come back in the table: adding them to
the plan is the lead's decision. A minor finding becomes a lot of its own only if it describes an observable bug (a wrong output, a crash, a measured regression); otherwise it stays a note of the originating lot, so that a review never feeds the next one. If an orchestrated wave is running in a repository, do not commit there
and do not deliver it (`cadence deliver` refuses).

### 2c. Chaining without the human

Once the human has given the **first choice and the order** (the lots, and the priority: `--priority` or the
`priority:` list of the parent folder's `cadence.yaml`), the lead does not come back to ask « next? ». For each lot a
wave hands back **ready**, it chains, in this order, one project at a time: re-verify it yourself (section 3, point 2),
`raf done` (a read-only plan: the project's own command; a `visible` lot first waits for the human's UX verdict, `raf ux` (the lead's own where the UX-verdict setting below hands it over), and is neither closed nor delivered without it — the chain goes on with the other lots), push, deliver (section 4; when the final table gives « livrable jusqu'à <sha> » for a repository — a ready lot under a handed-back one — push that sha alone with `git push origin <sha>:main`, then `cadence deliver --sha <sha>`, never HEAD, which holds the unreviewed code of the lot above), the `qa-reviewer` check that
section asks for; then it starts the next wave, in the declared priority — `cadence orchestrate --continue --priority …` draws the next ready lot
of the plan itself (section 2b), and the limits of section « Limits that always apply » still hold. A lot that was not
handed back ready (refused, review not compliant after the correction passes, red delivery, blocking QA finding) is
not chained over: it is reported, and the chain goes on with the lots that do not depend on it.

**The threshold.** Before every new wave, read the context of the lead session with `cadence session context`: the
`cadence-hud` mod publishes the context of each session, one file per session named after its id, and the command reads the
one named by `$CLAUDE_CODE_SESSION_ID` (Claude Code sets it in the environment of your Bash, so it is your own session,
whatever the folder; `--session <id>` overrides it). Without the variable it falls back to the folder only if a single
session publishes for it; two sessions in one folder make it exit 2 ("pass --session"), never guess the latest. It prints
`ctx 42 % (84000/200000)`, the figure the `ctx` segment of the band shows, which the band publishes to
a file because it is only a rendering the model cannot see. If the command fails (exit code 2: the band is not loaded in
this session, several sessions share the folder without the variable, or the figure is older than two minutes), treat it as
**at the threshold**: you cannot prove you are under it, and without the band loaded the lead does not chain.
From **60 %** upward, start nothing: at the threshold the lead runs `session-close` in each project touched, writes its
memory (filtered, as `session-close` says), and records three lines for next time with `cadence session next` — the wave
that was about to start comes first among them. Under it, chain. The lead says in one sentence which side of the threshold
it is on each time it chains or stops; it never waits for the figure to move (never a polling loop).

**What stays with the human**: the first choice and the order; the questions a session raised (the lead brings them
back at once and does not answer in the human's place); the UX reservations (by default `raf ux` is recorded on the human's
verdict and a UX reviewer's captures are looked at by the human; with `lead.ux: lead` only a doubt comes back to them, see below). While a question or a UX reservation is pending on a
lot, the chain goes on with the other lots and does not wait for it. A delivery that needs the human's confirmation
(their standing instructions, section 4) is a stop of the chain, not a bypass.

**The UX verdict.** By default (`lead.ux: human`, or no `lead:` key) the human gives the UX verdict of every `visible` lot.
Where the `cadence.yaml` of the parent folder says

```yaml
lead:
  ux: lead     # lead | human — default human
```

the human has said they are not a UX judge and want to be asked only when in doubt (`cadence lead tour` prints
`verdict UX : lead …` as its last line when the setting is on, and `cadence.yaml · ✗ erreur : lead.ux …` for a value
other than `lead` or `human`). The lead then forms the verdict itself: it reads the `ux-reviewer`'s report, **looks at the
captures itself** (it opens the images, it does not trust the report's words), and records `raf ux <lot> "…"` with the
reviewer's last line brought up to date. It does so only when the reviewer has no reservation left and the captures show
what the lot promised. At the **slightest doubt** — a reservation of the reviewer it cannot settle, a capture it cannot read,
a layout or wording choice that is a matter of taste, a state the captures do not show — it records nothing, brings the
captures and the question to the human, and the chain goes on with the other lots as for any UX reservation. The verdict
is always recorded by the lead's own `raf ux`, never by a subagent.

## 3. Check

0. After an orchestrated wave the review is already done, by a fresh session: read the table, then go to
   point 2. For a lot delegated by hand:
0b. For a lot delegated by hand, `raf check` or the `dérive` column reporting `documentation en retard` is handled **before** the review: hand the lot to the `doc-keeper` agent (a fresh subagent; the absolute path of the project and the lot id; it updates the documents, or only lists them if you say read-only). A proposed lot it returns for a document outside the repository (`describedBy`) is yours to decide: it never writes to that plan.
1. The `code-reviewer` agent, as a fresh subagent (most capable model), reviews the lot. Give it
   the absolute path of the project and the lot id, **not** the author's report: it reads the diff
   itself from the commits that cite the lot, runs the checks, and returns real defects only,
   ranked, with what it could not verify and a one-line verdict.
2. **The lead re-verifies itself**: `git log` shows the commits, the test suite and build pass when
   run by the lead, `raf check` is clean. A subagent is green on what it *could* test; say plainly
   what nobody could verify.
3. Fix or re-delegate what the review found; then record the verdict, `raf review <lot> "…"` with
   the code reviewer's last line brought up to date (and `raf ux <lot> "…"` for a visible lot, with
   the UX reviewer's; with `lead.ux: lead` the lead has formed that verdict, section 2c), then `raf done <lot>`. Where the gate is on (`raf review enable`, the
   human's decision for each repository), `raf done` refuses a lot that has commits and no
   verdict, or a verdict older than its latest commit: a fix made after the review means a new
   review of the lot, not an edited verdict. A read-only plan has no gate in `raf` (a `uxSince` or `reviewSince` written in it is
   ignored): the verdict goes into the project's own tool.
   On the cadence repository itself, the `raf` and `cadence` of the `PATH` are not the working repository's `dist/`: they
   are a separate, detached copy (`~/.local/share/cadence/service`, built there), so nothing a session or a wave does in the working
   repository (`npm run build`, `npm install`, `npm ci`, uncommitted `src/` files) changes the code in service. Once the verdict is recorded
   and the lot accepted (`raf done`), the lead updates that copy with `npm run service -- <sha>`, where `<sha>` is the accepted code, not HEAD
   when a handed-back lot is stacked above it (the wave's table says « livrable jusqu'à <sha> »). The script refuses a sha that is not an
   ancestor of HEAD, or whose commits cite a lot that is not done; it builds the new copy aside and switches only when the build succeeded.
   A lot found non-compliant is never put in service.

## 4. Delivery

One project at a time, by the lead: push, then the `deliver` skill (`cadence deliver --dry-run`, then
`cadence deliver`). Follow the human's standing instructions about confirmation before production.

When the wave's final table gives a line « livrable jusqu'à <sha> » for the repository (a ready lot stacked under a
handed-back or failed one), HEAD holds the code of the lot above, which was not reviewed: never push or deliver HEAD.
Push that sha alone first (`git push origin <sha>:main`), then deliver it (`cadence deliver --dry-run --sha <sha>`, then
`cadence deliver --sha <sha>`). The push comes first because with `ci: github` the CI wait looks for the run of that exact
sha, and GitHub only builds the tip of a push: without it, the wait ends on « no CI run for this sha ».

After a green delivery that changes what a page shows or what it is served (screen, API, data
source, configuration of either) — in practice every delivery except docs-, plan- or tests-only ones
— have the `qa-reviewer` agent check the delivered app, as a fresh subagent: give it the absolute
path of the project, the base URL of the delivered app and the lot id. The lot need not be
`visible`: a backend-only lot can empty a page without changing a screen. With a lot id, the agent walks only the pages the lot touched (the pages that call the changed endpoints, the pages of the changed screens, the pages that consume the services the lot changed, the home page; when the diff changes no route and no screen, or cannot be linked to pages, it walks every page and says so) and names the others under « Not walked »: they are not checked. It walks the pages in
a real browser against the project's expectations (`docs/qa/expectations.md`: per page, what the
user must find there) and returns measured findings; it reads only, and never logs in. Bring its
blocking findings back to the human — a page whose main content is missing, or that shows an error,
is a defect even when the delivery checks are green — with its proposed follow-up lines. A project
without an expectations file gets a draft back: show it to the human, who corrects it and decides
whether it is committed. It is not a gate: `raf done` does not wait for it, and a finding becomes a
new lot, not a reopened one.

## 5. Close

At the end, the `session-close` routine in each project touched, and `cadence session next` lines in
each. Give the human one line per project: delivered, in progress, blocked (and why).
