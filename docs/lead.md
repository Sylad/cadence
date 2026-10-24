# The lead workflow

The `lead` skill pilots several projects from a parent folder. Its session stays small: it reads
summaries, decides with the human, and leaves the work to fresh short sessions run by a program
(`cadence orchestrate`). This page draws who does what, in three lanes: the **human**, the
**lead session**, and the **`orchestrate` program with its agents**.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="lead-workflow-dark.svg">
  <img alt="The lead workflow in three lanes (human, lead session, orchestrate program and agents), from the tour of the projects to the close of the session" src="lead-workflow-light.svg">
</picture>

Dashed boxes are conditional steps: the precheck runs only for a lot without a commit yet whose title cites a finding (`constat`, `revue`, `review`, `audit`) or another lot (unless `orchestrate.precheck: false`), and the spec, sheet review and accept steps run only for a `screen: page` lot or a `spec: true` lot. The skill itself is `skills/lead/SKILL.md`; this page is its
picture, not its source.

## The steps

1. **Tour.** The lead runs `cadence lead tour` (a program, no model) and reports one row per project.
   It proposes three items: finish what is in progress, then drift that blocks a delivery, then ready
   quick wins. It stops and waits: the human picks the lots and the order (`--priority`, or the
   `priority:` list of the parent folder's `cadence.yaml`).
2. **Wave.** The lead starts `cadence orchestrate <project>:<lot> … --wave <id>` in the background.
   When a lot's title is stale, the lead does not delegate by hand: it passes `--goal "…"` (one lot per launch), or writes a `goal:` key on the lots in the plan (several lots at once) — in the native plan as `goal:`, in a plan kept by another tool (read-only) by mapping its key with `plan.fields: { goal: <their key> }` in `cadence.yaml` — which replaces the title as the objective of the briefs (L258, [orchestrate](orchestrate.md)).
   For each lot the program runs, in fresh sessions and in this order: `precheck → spec → maquette →
   accept → implement → review → ux`. The **precheck** applies to a lot without a commit yet whose title cites a finding (`constat`, `revue`, `review`, `audit`) or another lot (unless
   `orchestrate.precheck: false`; L288). The spec steps exist only for a lot that declares
   a `screen:` of `page` (a visible lot that creates or changes a whole screen; `screen: component` and `screen: journey`
   lots take the ordinary path, straight to the implementation, unless they already have a sheet) or `spec: true` (a lot without a screen
   that still has a behaviour to pin down: `precheck → spec → fiche → accept → implement → review`);
   spec, sheet review and accept apply to `screen: page` and to `spec: true` alike; the other lots go
   straight from the precheck (when it applies) to the implementation:
   - **spec**: the `spec-writer` agent draws a static mockup to the project's own style and writes the
     screen sheet (`fiche.yaml`: fields, states, numbered rules), rendered at 1440 and 390 px;
   - **fiche** (a lot with a back-end part: `spec: true`, or a screen lot whose sheet has a `sujet` block):
     the `code-reviewer` agent in sheet mode reviews the back-end sheet (two passes at most, then the lot
     is handed back) unless `orchestrate.fiche: false`; a mixed lot has both reviews, and their findings
     go together to a single second `spec` pass. A lot without a screen has no News entry: the
     hypotheses of its final sheet become one note of the lot each, and the end-of-wave table lists them
     as `hypothèse de la fiche : …` — the lead relays them to the human;
   - **maquette**: the `ux-reviewer` agent reviews the mockup (two passes at most, then the lot is handed
     back) unless `orchestrate.maquette: false`;
   - **accept**: a separate session writes the acceptance tests from the sheet, committed red and locked,
     when the project declares `orchestrate.accept`; without it the step is skipped with a warning;
   - the implementation (test first, commits citing the lot) makes them green without touching them;
   - a UX pass if the lot is `visible` and the project says how to see its app (`orchestrate.ux`); for a
     lot with a sheet it is a conformity pass against the mockup;
   - the code review (Opus; Sonnet for a lot of 0.25 day or less), which also follows each rule of the
     sheet to its test;
   - a correction in a new session if the review is not compliant (two passes at most, a third when the review
     converges — blocking + major findings down and only one left —, each followed by a review).

   The program records `raf review` itself once the review is compliant.
3. **Relay.** The lead follows the wave's journal (`tail -n +1 -F .cadence/runs/<id>/journal.log`, one
   line per transition) and tells the human each line in one sentence, with no polling loop. A
   question from a session comes back to the human at once; the answer goes in with
   `cadence orchestrate --resume --wave <wave> --answer <project>:<lot> "…"` (the wave is named: the
   command is printed under each question of the table, ready to run; without a wave, `--resume` is refused as
   soon as the folder keeps several unfinished waves). The lead never answers in the
   human's place. `--drop` and `--stop-after-current` steer a wave that is running.
4. **Review.** The final table of the wave lists the lots ready, handed back, and the line
   « livrable jusqu'à <sha> » for a ready lot stacked under a handed-back one. Minor findings come back in
   the table: one becomes a lot of its own only if it describes an observable bug.
5. **Re-check.** The lead verifies itself, one project at a time: `git log`, the test suite and the
   build run by the lead, `raf check` clean. A `visible` lot waits for the human to look at the
   UX reviewer's captures: the lead records `raf ux` on the human's verdict, never on its own — unless the parent folder's `cadence.yaml` says `lead.ux: lead`: then the lead forms the verdict from the reviewer's report and its own look at the captures, and asks the human only at the slightest doubt. Then
   `raf done`.
6. **Delivery.** Push (for a « livrable jusqu'à <sha> », that sha alone, never HEAD), then
   `cadence deliver`. A lot that turns ready is delivered while the wave runs (`cadence deliver --sha <sha>`, accepted when no commit of the sha belongs to a lot that is not ready), not at the end of the wave. After a green delivery that changes what a page shows or what it is served, the
   `qa-reviewer` agent walks the delivered pages in a real browser, reads only, and brings its blocking
   findings to the human. It is not a gate: a finding becomes a new lot.
7. **Threshold and chaining.** Before every new wave the lead reads `cadence session context`. Under
   **60 %** it chains: `cadence orchestrate --continue` draws the next ready lot of the plan, in the
   declared priority, without asking the human « next? ». From 60 % upward, or when the figure cannot
   be read (exit code 2: the band is not loaded, or its figure is stale), it starts nothing. A lot
   that was not handed back ready is reported, not chained over; a question or a UX reservation
   pending on a lot never stops the chain on the other lots.
8. **Close.** `session-close` in each project touched, filtered memory, three lines for next time
   with `cadence session next` (the wave that was about to start comes first), then one line per project
   to the human: delivered, in progress, blocked (and why).

## Permanent rules

| Rule | Why |
|---|---|
| At most **as many subagents as the session cap** running at once (2 by default; the human sets it with `CADENCE_MAX_SESSIONS`), orchestrate sessions included | `cadence orchestrate --status` and `cadence lead tour` print `créneaux libres : N sur M`, M being the configured cap and the sessions the lead started by hand (`cadence lead hold`, L255) being subtracted; the lead never raises `--max-sessions` or `CADENCE_MAX_SESSIONS` itself |
| Never two sessions in the same repository at the same time; the lead does not commit where a wave runs (the experimental worktree mode, `orchestrate.worktrees: true`, is refused without `CADENCE_EXPERIMENTAL_WORKTREES=1` until L299–L301 are done: not a rule for the lead) | a wave's lock refuses `cadence deliver` while a lot still works there |
| A locked acceptance test that contradicts the sheet is corrected by the lead with `cadence spec reseal <lot> <test> --reason "…"` (lot in progress, outside a wave and with no wave that is not `done` keeping open a lot of the repository still `doing` in its plan, the resealed lot or another, e.g. a question waiting: `--resume --answer` or `--drop` first, the one error lists every wave concerned, the live one that holds the lock (to wait for) and the stopped ones, and gives for each stopped wave the single `cd <launch folder> && cadence orchestrate --resume <wave> --drop <project>:<lot> [--drop …]` to run, a `--drop` per open lot of the repository in that wave, the queued ones that are not `doing` in the plan included, since `--resume` would relaunch them and they would take the lock back, L238 L239; an amended sheet is accepted once committed, every commit that touched it citing the lot, L217, never put it back to the red state; a delivered lot with an unstable test: add `--porteur <lot in progress>`, L212), then a new `cadence orchestrate <project>:<lot>` for a lot handed back (`--resume` skips it) | never by a session, never by editing `acceptation.json` |
| Deliveries and the `raf ux` / `raf review` verdicts belong to the lead, one project at a time | never to a subagent, never two deliveries in parallel |
| The UX verdict is the human's unless `lead.ux: lead` (parent `cadence.yaml`, default `human`) | then the lead decides from the report and the captures, and brings any doubt to the human |
| A session cannot ask the human anything | it stops and reports; the lead brings the question back |
| Never push or deliver HEAD above a handed-back lot | HEAD holds code that was not reviewed |
| A plan kept by another tool is read-only for `raf` | its own commands record the lot's state |

## Exit codes

`cadence orchestrate`:

| Code | Meaning |
|---|---|
| `0` | every lot is ready |
| `1` | some lots were handed back to the lead |
| `2` | refused before acting (a precondition failed) |
| `3` | wave suspended (budget or usage limit); `--resume --budget …` continues |

`cadence session context` exits `2` when it cannot prove the figure (no band, several sessions in
the folder without `$CLAUDE_CODE_SESSION_ID`, figure older than two minutes): the lead then treats it
as being at the threshold.

The mechanics around it (the life of a lot in the plan, a lot inside a wave, putting cadence in service, the budgets) are drawn in
[fonctionnement.md](fonctionnement.md). See also the [lead tour](lead.md#lead-tour) section below and the [orchestrate](orchestrate.md#orchestrate)
page.

## lead hold and release

`cadence lead hold <label> [--ttl minutes]` and `cadence lead release <label>` (L255) declare the sessions the lead starts by hand — a fix subagent, a review, a QA pass launched outside an orchestrated wave. No wave carries such a session, so the slot registry could not see it: on 2026-10-23 the lead ran 4 sessions under a cap of 3 while `créneaux libres` said one slot was free. `hold` registers the session under its label for `--ttl` minutes (an integer ≥ 1, 60 by default; holding the same label again renews it instead of counting twice); `release` hands it back (releasing a label that is not held answers `aucune session « <label> » inscrite` and exits 0). A hold whose time has run out stops counting, but is not forgotten: nothing stops the session (L278), so `cadence lead tour` and `cadence orchestrate --status` print `⚠ session du lead échue : <label> (inscrite depuis 5 h 10 min, échue depuis 2 h 10 min) — la reprendre (cadence lead hold <label> --ttl <minutes>) ou l'arrêter (cadence lead release <label>)` after the slots line, and the `cadence-hud` band shows the same ⚠ row, until the lead renews the hold or releases it (an expired hold nobody touched is dropped 24 h after its expiry). The `--ttl` is therefore the maximum duration declared for the session; the `lead` skill says to renew or stop it at each ⚠. The line is not part of `--json`.

The held sessions are kept in the `holds/` folder of the cadence home (`CADENCE_HOME`, shared by every folder and every wave). While at least one is held, the line of the live waves of `cadence orchestrate --status` and of `cadence lead tour` gains a segment and subtracts them: `vagues en cours : 1 · sessions en cours : 0 · sessions du lead : 1 (correctif-L12) · créneaux libres : 0 sur 3`. A held session alone is enough to print the line (`vagues en cours : 0`). It is a display, like the rest of the slots line: a hold blocks no session and never raises the cap (a wave that is already running keeps its own slot counting), and the `lead` skill declares every hand-started session with it.

## The librarian by hand

For a lot the lead delegated by hand, `raf check` or the `dérive` column of `cadence lead tour` reporting `documentation en retard` is
handled before the review, as an orchestrated wave does it: the lead hands the project (absolute path) and the lot id to the
`doc-keeper` agent ([skills](skills.md), [news](news.md#the-librarian-doc-keeper)), in a writing session, or read-only when it
only wants the list of the documents to change (L306). A document outside the repository is named by the `docs.articles` key
of the project's `cadence.yaml`, never guessed: the lead reads that key itself and puts its entries in the brief with the absolute path of each repository (the subagent is given read access to it), because the agent examines no outside document the brief does not name. The agent proposes a lot for the plan of that repository, in the `resume` of its
report, and the lead decides whether to add it (`raf add` in that repository). The agent never writes to that plan.

## lead tour

`cadence lead tour [folder] [--idle 3] [--depth n] [--json]` is the lead's morning table, with no model in
the loop. From a parent folder (default: the current one) it takes every direct sub-folder that
holds `.cadence/raf.yaml` or `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key (a plan kept by another tool
included; hidden folders, `node_modules` and `tmp/` — throwaway working copies — are skipped), and for each one reads the same facts as `cadence session start` — in-process, no
sub-process, no call to `claude` — then prints **one line per project**:

```
alpha · en cours L1 (1 commit, silencieux 4j) · dérive 1 (✗ L2 a 1 commit(s) mais est encore todo) · notes : finir L1 puis livrer · prochain L3 Typo · dépôt non commité, non poussé
beta · en cours rien · dérive aucune · notes : aucune · prochain T2 Second · dépôt propre
```

| Column | Content |
|---|---|
| `en cours` | ids of the lots in progress, each with its number of commits (`0 commit` included: a close note on a lot without commit is not « done, `raf done` forgotten »); then `aucune activité` when it has no activity at all, `silencieux Nj` when the lot's last activity (commit, note or start) is more than `--idle` days old (default 3) |
| `dérive` | the gaps `raf check` reports (a lot whose commits leave a document behind, [`docs.sync`](news.md#documentation-that-follows-the-code), included), counted and the first two shown |
| `notes` | the notes left by the last `session close`, joined with ` / ` and cut at 120 characters |
| `prochain` | the first ready lot (quick wins first) — id and title cut at 60 characters; a lot whose [`gate`](raf.md#plan-file) is not met is not ready |
| `attend` | only when a lot waits on its `gate`: `attend L190` |
| `dépôt` | `non commité` (modified or untracked files), `non poussé` (commits ahead of the upstream), `livraison en cours` (live delivery lock); `propre` otherwise |

After the project lines the tour lists the **worktrees kept by waves** (L279, experimental mode, not enabled until L299–L301 are done; [`orchestrate.worktrees`](orchestrate.md#one-worktree-per-lot-orchestrateworktrees-l279)): a title, then one line per kept worktree — repository, lot, age, number of unintegrated commits, path — so that a lot handed back with unintegrated commits is never forgotten; nothing is printed when there is none (`--json`: `worktrees` on the project's row). `cadence orchestrate --status` and the final table of a wave print the same lines; the lead removes one with `cadence orchestrate --remove-worktree <project>:<lot> [--abandon-commits]`.

Before the project lines the tour prints the **perf header** (L227): one line per `⚠` of `cadence perf` for the folder, in the order of `perf`, each ending with its decision and, for a trend, the value of its quality twin (speed and quality side by side); the net-bottleneck `⚠ goulot` line is relayed as is. Nothing is printed when no `⚠` stands, and the output is then the one of a tour without header. The header is read with `perf`'s own reading of the folder (projects up to two levels, whatever `--depth`) and only in the text output: `--json` is unchanged. When `perf` cannot read the folder (no `.cadence/runs`, malformed price grid, unreadable journals or plans) the tour prints no header, reports no perf error and exits 0. The [lead skill](skills.md) reads the header before proposing the three lots and opens an improvement lot only on a trend confirmed on two windows or a net bottleneck.

When an orchestrated wave is live, one more line closes the tour (not part of `--json`): `vagues en cours : 1 · sessions en cours : 0 · créneaux libres : 1 sur 2` — the lead reads the free slots there instead of computing them (L141). The `sur M` is the cap the human set (`CADENCE_MAX_SESSIONS`, 2 by default), not a fixed 2 (L208); an invalid value falls back to 2 in this display. The sessions held with [`lead hold`](#lead-hold-and-release) are subtracted from the free slots, and one alone is enough to print the line (L255).

Next to it, when at least one ready lot is free, a line `prêts, ressources libres : alpha:L3 <title> · beta:L2 <title> (banc)` (L252, GitHub issue #13, 2/3) lists, for every project of the tour, the ready lots (same rule as `next`, minus the ones marked « à décider ») that can start now: a lot is free when none of the resources in its `uses:` (shown in parentheses) is held by a lot `doing` in any project of the tour or in any project that shares its resources (the projects under the folder whose `cadence.yaml` declares `resources:`, walked with that file's `depth:`, one level by default, so `P/x` and `P/grp/alpha` share the `banc` of `P/cadence.yaml` with `depth: 2` wherever the tour is launched from, even from inside one project; with no declared resource, the projects of the parent folder), nor by an unfinished lot of a live wave (a wave's lot is recognised by its repository and its id, not by the project name: a nested project `grp/alpha` matches the wave launched from `grp/` that cites it as `alpha`, and a wave launched from another folder only hides the lots of its own repositories); a lot with no `uses:` holds none and is always free. The line shows at most 3 lots per project, then `alpha +K` for the others. Like the slots line it prints while a wave is live, or as soon as a session is held with `lead hold` (L255); with neither, it stays silent. It is a display: nothing locks, `raf start` and `orchestrate` still start a lot whose resource is taken. `--json` gives the same lots, always, as a `free` array on each project (`id`, `title`, and `uses` when the lot has any; absent when the project has none).

The `lead` skill (L253, GitHub issue #13, 3/3) tells the lead to read that line again each time an agent comes back and each time a lot is blocked, before waiting: a lot it lists can start at once, with the free slots line saying a slot is free, instead of waiting behind the blocked one. The line never raises the slot cap.

`--json` prints the same content as an array of objects (`project`, `doing`, `drift`, `notes`, `waiting` (only when a lot waits on its `gate`),
`free` (L252, above),
`next`, `repo`, and `error` when the project could not be read), plus `progress` — `{ done, doing, todo, added7 }`,
the lots done / in progress / to do (dropped and recurring lots left out) and those created in the last 7 days (L149), which
[`cadence-hud`](../plugins/cadence-hud/README.md) draws as one progress bar per project. Projects come in the order of the
`priority:` key of the folder's `cadence.yaml` (the one `orchestrate --continue` reads), the others after, alphabetically; an unreadable `cadence.yaml` or
a `priority:` that is not a list of names (`priority: ol`, `priority: []`) keeps the alphabetical order and adds a first row `cadence.yaml · ✗ erreur : <cause>` (`project: "cadence.yaml"` with `error` in `--json`).
Sub-projects are looked for one level down by default. `--depth n` goes `n` levels down (same meaning as in `cadence session start --all --depth n`:
a folder that is a project is not entered; an integer ≥ 1, otherwise refused), and the `depth:` key of the folder's `cadence.yaml`, next to `priority:`, sets it once for all
(`depth: 2`); `--depth` wins over the key, and a `depth:` that is not an integer ≥ 1 adds the same first row `cadence.yaml · ✗ erreur : …` and leaves one level read.
`cadence-hud` asks the tour from the folder of the session, so it follows the key with no change. A project is named by its folder's name; one found below the first level is named by its path from the folder (`groupe/gamma`), unique and ready for `cadence orchestrate groupe/gamma:L1` run from there, while `priority:` and the alphabetical order read the folder's own name.
"Created in the last 7 days" means today and the six days before. When the folder has no sub-project but is itself a project, the tour is that project's single line
(this is what `cadence-hud` asks from a session opened inside a project). The tour is read-only: it changes
no plan. It exits 0 even when a project is in error — that project's line reads
`beta · ✗ erreur : <cause>`. The `lead` skill runs it instead of one subagent per project.
