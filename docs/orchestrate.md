[← cadence](../README.md)

# orchestrate

`cadence orchestrate` is a program above `/lead`, not a conversation: for each lot you choose, it runs
a **fresh** `claude -p` session per step with a short brief, reads the result, writes the state in
files and moves on. The lead session keeps only the decision (which lots), the final table and the
questions. Nothing is resumed: a correction is a new session, never the author's reopened. The one
exception is a **formatting retry** (« Formatting retry » in [orchestrate-cycle.md](orchestrate-cycle.md)).


## The five pages

This page keeps the opening, the commands and the options of a running wave. The reference of every key of `cadence.yaml` under `orchestrate:` (`test`, `build`, `testReplay`, `worktreeDeps`, `budgetTopUp`, …), one commented line each, is [« The `orchestrate` keys of `cadence.yaml` (reference) »](orchestrate-cycle.md#the-orchestrate-keys-of-cadenceyaml-reference). The rest of the former single page moved, unchanged, to four pages:

- [orchestrate-cycle.md](orchestrate-cycle.md): cycle of a lot, review and its sizing, escalation, librarian, effort, pre-check, minors, frozen copy, reviews that converge, express lane, cost, plan commits, the reference of the `orchestrate` keys of `cadence.yaml`, budget, retries, `orchestrate.ux`, per-step MCP servers, `plan.onWrite`.
- [orchestrate-gate.md](orchestrate-gate.md): the program's gate (build, tests, tests already red, replay alone, gate declared in parts, shares of the machine), the pre-check of sealed tests and shared files, the edge-case probe.
- [orchestrate-spec.md](orchestrate-spec.md): the spec step (`screen:`, `spec: true`), the light mockup, the mockup review, the accept step and its lock, the downstream briefs.
- [orchestrate-worktrees.md](orchestrate-worktrees.md): one worktree per lot, integration, a lot whose work is in a neighbouring repository, a session never commits on another repository.

```sh

cadence orchestrate finance-tracker:L41 ol-companion:L22 cadence:L18@haiku
cadence orchestrate L18                      # from inside a project
cadence orchestrate .:L18                    # the same, with the project named « . » (inside a repository)
cadence orchestrate maritime-atlas:Q4/accueil-4-ux12@haiku   # a lot id may contain "/" (sub-tasks of read-only plans)
cadence orchestrate maritime:B28.4 --goal "…"   # the goal replaces the stale title as the objective of the briefs (below)
cadence orchestrate … --budget 1.5M          # 1500000, 1.5M, 800k; default 2M
cadence orchestrate … --max-sessions 3       # sessions running at the same moment, all waves together; default 2
cadence orchestrate … --dry-run              # preconditions + the plan of the wave; nothing is started
cadence orchestrate a:L1 b:L1 --no-fill        # the wave plays the given lots only: a free slot is not filled with the next ready lot of the plan (L587)
cadence orchestrate --continue [--until 18:00] [--priority cadence,maritime]   # the wave draws the next ready lot itself (below)
cadence orchestrate --waits [--since 2026-10-12]   # time spent waiting for a session slot, per day and per wave (below)
cadence orchestrate --status [<wave> | --wave <wave>]   # the live waves and the repositories they hold, then the table (default: the last wave of this folder)
cadence orchestrate --status [<wave>] --detail <project:lot>   # the detail of one lot that the compact table leaves out: given goal, UX note and captures, tests already red at the start, choices made, hypotheses of the sheet, proposals, UX verdict (read from the wave's state; the bare `<lot>` is enough when unique in the wave; not with `--watch`)
cadence orchestrate --follow [--wave <id>] [--interval 5]   # follows a wave's journal and prints only the lines that ask the lead for a gesture (L588); ends by itself with « fin de vague »
cadence orchestrate --status [<wave>] --watch [--interval 10]   # the same, redrawn every 10 s (--interval in seconds); stops by itself when no wave is running (with an explicit `<wave>`: when that wave is no longer running)
cadence orchestrate --resume [--wave <wave> | <wave>] [--budget 1M] [--answer ol-companion:L22 "reply"] [--drop ccc:L29]
cadence orchestrate --resume --wave <wave> --budget maritime:B26.4=+300k   # replay a lot handed back for its budget, with the budget raised (below)
cadence orchestrate --resume --wave <wave> --integrate ccc:L29   # replay a lot handed back at the integration step of a worktree wave (« One worktree per lot »)
cadence orchestrate --resume --wave <wave> --replay ccc:L29      # same, and also a lot handed back on a refused plan write (fiche notes) at the step it had reached
cadence orchestrate --remove-worktree ccc:L29 [--abandon-commits]   # remove the kept worktree and branch of a lot (« One worktree per lot »)
cadence orchestrate --resume … a:L1                             # refused: a resume replays the lots of the wave, it launches none
cadence orchestrate --resume … --dry-run                         # refused: a resume cannot be simulated, it writes the wave state and relaunches sessions
# `--resume` without a wave resumes the only unfinished wave of the folder; with several, it lists them and is refused (exit 2): name one with `--resume --wave <wave>`
# every resume command the program prints (under a question, after `--stop-after-current`, on a lot handed back at the integration step, in the `spec reseal` refusal, in the several-waves refusal) has the form `cadence orchestrate --resume --wave <wave> …`; `--resume <wave>` with an id that looks like a lot (`suite2`) is read as a lot to launch and refused, and the refusal prints the `--wave` form
# the table of a wave (end of wave and `--status`) prints, under each question, the command that answers it with the wave named: `cadence orchestrate --resume --wave <wave> --answer <project>:<lot> "…"` (`--wave` rather than `--resume <wave>` so that an id that looks like a lot, `suite2`, is read as a wave too)
# a resume running on the wave's snapshot receives `--resume <wave>` in place of `--wave <wave>`, so an older snapshot cannot pick another wave; a wave whose id looks like a lot (`suite2`) cannot be named that way, so it is resumed with the current `dist/` and templates
cadence orchestrate --drop ccc:L29 [--wave <wave>]   # from another terminal: take a lot out of the running wave
cadence orchestrate --stop-after-current [--wave <wave>]   # from another terminal: let the running sessions finish, start nothing else
cadence orchestrate --answer ol-companion:L22 "reply" [--wave <wave>]   # from another terminal: answer a lot of the running wave that is waiting for it (below)
cadence orchestrate --add ccc:L30 [--add ol-companion:L23] [--wave <wave>]   # from another terminal: add lots to the running wave instead of launching a second one (below)
```

**Claude Code must be installed and logged in** (L378). Before starting a lot, `cadence orchestrate` runs `claude auth status` (no model, no cost); when it says `loggedIn: false` the command is refused (exit 2) before anything is written: no `raf start`, no plan commit, the lot stays `todo`. The message says what to do: « claude n'est pas connecté : lancer `claude` puis /login (état : `claude auth status`) ». `--dry-run` starts no session, so it is not refused: it prints the same message after its first line, as a `⚠`. `claude auth status` is read once per launch, so with `--continue` the rounds of a wave do not run it again for every candidate lot. An unreadable answer (a `claude` without `auth status`) is not a refusal.

**A stale `.git/index.lock` is refused up front** (L385). While the lock exists, every commit of the repository fails, the plan commit at the start of a lot included, and the plan would stay modified so that the next lot is handed back as a dirty repository. `cadence orchestrate` (and `--dry-run`, and `--resume`) therefore looks for `<git-dir>/index.lock` in each repository of the lot before writing anything, and refuses (exit 2): `<repo> : .git/index.lock présent depuis 13:46 (5 h 12 min), aucun processus git en cours : verrou périmé ; le retirer avec `rm <chemin>` puis relancer`. The process check is `ps`: when a `git` process is running the message says so and does not suggest removing the lock; when `ps` is unreadable it says the check could not be made. If a plan commit still fails during a wave (a lock taken after the start, a refusing hook), the plan is put back as it was, without going through the index, which the lock blocks: the lot fails, the next one finds a clean repository.

A `<project>` is a sub-folder of the current folder. Launched from inside `alpha`, `alpha:L1` looks for `alpha/alpha` and is refused: `alpha:L1 : dossier …/alpha/alpha introuvable (le projet est un sous-dossier du dossier courant ; dans un dépôt, `.:L1`)` (L376). Inside a repository, `.:L1` or `L1` names the lot of the repository itself.

**`--drop` and `--stop-after-current` — steering a running wave (L79)**: both are run from the folder the wave was launched
from (`--wave <id>` when several waves run from it), and write a request in the wave's state folder
(`.cadence/runs/<wave>/control.log`, append-only), which the wave reads before each session — no signal, no edit of
`journal.log`. `--drop <project:lot>` (repeatable) takes a lot out of the wave: a lot not started yet never starts (no
`raf start`); a lot with a session running **lets that session finish** (it is not killed), then plays no other: it is
*handed back* (`retiré de la vague (--drop)`), its commits stay, and a lot that depended on it is handed back too. A lot
waiting for an answer (`question`) is handed back as well, at the end of the wave or on `--resume --wave <wave> --drop`, instead of staying in
question forever. A lot that is unknown or already finished is refused (exit 2). `--stop-after-current` lets the sessions running finish, starts no
other session nor lot (`arrêt demandé (--stop-after-current)`), and leaves the wave **interrupted** and resumable
(`--resume --wave <wave>`, which forgets the stop; `--continue` draws nothing more). Neither combines with lots to launch,
`--continue`, `--dry-run`, `--budget` or `--answer`, nor `--status`; without a live wave from that folder they are refused
(exit 2). A stopped wave is no longer live, so to take a lot out of it use **`--resume --wave <wave> --drop <project:lot>`**: the lot is
handed back instead of being replayed (an unknown or finished lot is refused, exit 2, before anything runs). A lot taken out
this way is left out of the resume checks (repository lock, `.nvmrc` Node, dirty tree): only the lots that will be replayed can
refuse the resume, and a refusal writes nothing to `control.log`.
`--resume --wave <wave> --stop-after-current` is refused (exit 2): resuming contradicts stopping.

**Answering on a live wave (L407).** `--answer <project:lot> "…"` (from the folder that launched the wave, `--wave` when several are live) no longer waits for the wave to end: on 28-10 a lot waited about 15 minutes for its answer because another lot of the wave was still running, and `--resume` refuses a wave that is running. The answer is appended to the wave's queue (`answers.log` in `.cadence/runs/<wave>/`, one JSON line per answer and per answer taken), the command prints `<lot> : réponse déposée` and returns at once. The live wave reads the queue every 2 seconds and each time a lot finishes, applies the answer to the lot (the same state as `--resume --answer`: the answer joins the brief of its next session) and replays it as one more line of the pool, as soon as a session slot is free; a lot with no worktree never plays together with another lot of its repository. The documented form `--resume --wave <wave> --answer …` does the same when that wave is still running (it used to be refused with `tourne encore`); combined with another resume option (`--budget`, `--drop`, `--integrate`, `--continue`) it is still refused. Refused (exit 2) before anything is written: a lot that is unknown, that several projects carry, or that is not waiting for an answer (`question`); no live wave in that folder (the message gives the `--resume --wave <wave> --answer` form for a stopped wave); a wave started before L407, whose snapshot does not read the queue. `--answer` alone does not combine with `--drop`, `--stop-after-current`, `--budget`, `--dry-run`, `--continue` or lots to launch. An answer whose lot is no longer waiting when the wave reads it (dropped, or already answered by an earlier line) is discarded and the journal says so (`réponse écartée`), it is never played twice; if the wave finishes between the check and the write, the answer is withdrawn and the command says to use `--resume`. Not covered: a lot that depends (`after`) on the answered lot and was left waiting in the pool is not started by this wave when the answer makes the lot ready; `--resume` plays it.

**The next gesture, printed (L554).** Every refusal of `orchestrate` that has one exact next command prints it, and so does every lot handed back (source: `src/orchestrate/geste.ts`, one table). On 3 November the lead lost 1 h 40 and eight refused commands by guessing it. A lot handed back for an open docs.sync gap (`documentation en retard (docs.sync)`) refused by `--integrate` or `--replay`: `— le geste : raf docs-ok <lot> --reason "…" (dépôt principal, plan commité), puis à la fin de la vague : cadence orchestrate <project:lot>` (without « à la fin de la vague » once the wave is stopped): once the acknowledgement is committed in the main repository, a NEW wave finds the lot's worktree (« le lot repart de son travail ») and goes to the integration; `--replay` is not the gesture. A `--resume` whose `--replay` is refused still exits 2 as a whole, and now names the resume without it: `la reprise sans --replay : cadence orchestrate --resume --wave <wave> <other options>` (nothing when `--replay` was the only option). `--replay` (or `--integrate` with another resume option) on a live wave: `la vague … tourne encore (pid …) : à la fin de la vague : cadence orchestrate --resume --wave <wave> --replay <project:lot>`. `--remove-worktree` of a lot of a live wave: `… ; à la fin de la vague : cadence orchestrate --remove-worktree <project:lot> --wave <wave>`. `--add` of a lot already dropped from the wave (`--drop`): `… : retiré de la vague : le lancer dans une nouvelle vague, à la fin de la vague : cadence orchestrate <project:lot>` (the launch is refused while the wave holds the repository, and that refusal points back to `--add`: hence the wait). When the wave was launched from the repository itself, the commands print `.:<lot>` (`--remove-worktree .:<lot>`, `cadence orchestrate .:<lot>`), replayable from that folder. `--resume --integrate|--replay` that waits for another wave's repository lock now says so: `l'attente ne réserve aucun créneau de session` (the waiting resume is registered with no lane, so the free slots count does not change). `--status` and the table of a wave add a `geste` column (only when a lot has a gesture): `--integrate` for a lot handed back at the integration step, `--replay` for a refused plan write, the docs-ok gesture (then a new wave) for a docs.sync gap, a new wave for a dropped lot, empty for the others. 

**Integrating a lot on a live wave (L532).** `--resume --wave <wave> --integrate <project:lot>` (from the folder that launched the wave) no longer fails with `la vague … tourne encore` when that wave is still running: on 2 November the lead had a lot (L527, then L435) reviewed in its worktree and could not integrate it until the wave ended, hours later under `--continue`. The request is appended to the wave's queue (`integrates.log` in `.cadence/runs/<wave>/`, one JSON line per request and per request taken), the command prints `<lot> : intégration déposée` and returns at once. The live wave reads the queue every 2 seconds and each time a lot finishes, and replays the lot at the `integrate` step as one more line of the pool, **ahead of the lots already queued** (L620: on 5 November L602, reviewed, stayed suspended 65 minutes behind the queue; answers and added lots still queue behind), as soon as a session slot is free (`<project>:<lot> → suspended — intégration reprise (--resume --integrate)` in the journal, or `… : revue conforme du lead hors vague, <sha>` for a lot the lead corrected and reviewed, L370). The lot is checked twice, when the command is typed and when the wave takes the request: it must be handed back at the integration step, or handed back elsewhere and reviewed `conforme` by the lead in its worktree at the last commit; a request whose lot no longer qualifies by then (already taken by an earlier line, a commit after the review, tracked file modified in the worktree) is discarded and the journal says so (`intégration écartée (…)`), it is never played twice. Refused (exit 2) before anything is written: a lot that is unknown, that several projects carry, named twice, or not eligible (same message as the resume); a wave started before L532, whose snapshot does not read the queue. a wave that was resumed without that lot (L610: a resumed wave plays only the lots it took back, listed in `playing` of its `wave.json`; it would discard the request as `lot inconnu`): `la vague … ne joue pas ce lot`, followed by `à la fin de la vague : cadence orchestrate --resume --wave <wave> --integrate <project:lot>`. Combined with another resume option (`--answer`, `--budget`, `--drop`, `--continue`) or with `--replay`, the command is still refused with `tourne encore`. If the wave finishes between the check and the write, the request is withdrawn and the command says to use `--resume`.

**Adding a lot to a live wave (L421).** A second `cadence orchestrate <project:lot>` in a repository that a live wave holds is refused (`une orchestration y est déjà en cours (<wave>, pid …)`), and the lead used to wait for the whole wave to end. The refusal now names the way out when that wave was launched from the same folder: `… ; pour y ajouter ce lot : cadence orchestrate --add <project>:<lot> --wave <wave>`. `--add <project:lot> [--wave <wave>]` (repeatable; from the folder that launched the wave, `--wave` when several are live) checks each lot like a lot given at launch (known, open, dependencies, Node, `repos:`), with three differences: a repository held **by that wave** is accepted (its dirty tree and its push guard are the wave's own), a dependency counts when it is a lot of the wave or an earlier `--add` of the same call, and the remaining budget of the wave (`budget − consumed`) must hold the budget of the lot. Then it appends the lot to the wave's queue (`adds.log` in `.cadence/runs/<wave>/`, one JSON line per request and per request taken), prints `<lot> : ajout déposé` and returns at once. The live wave reads the queue with the answers (every 2 seconds and each time a lot finishes), checks the lot again at that moment, and adds it: the lot is written in the wave state and in `wave.json`, the repository lock and push guard are taken if the wave does not hold the repository (any more), and the journal says `<lot> : ajouté à la vague <wave>`. The lot then plays as one more line of the pool as soon as a session slot is free; in a repository in `orchestrate.worktrees: true` mode with a cap above one it plays in its own worktree at once, in parallel with the lot already playing there (L527, every lot of such a repository has its own); otherwise a lot of a repository where another lot of the wave is playing waits for it (never two sessions in one repository), and plays in its own worktree only when every lot still to play in that repository does. Refused (exit 2) before anything is written, nothing queued for any lot as soon as one is refused: a lot unknown or already finished, a lot already in the wave or already queued, a dependency neither done nor in the wave, a repository held by another wave, a budget that does not fit, no live wave in that folder, several live waves without `--wave`, a wave started before L421 (its snapshot does not read the queue). `--add` combines with nothing but `--wave`. A request that no longer holds when the wave reads it (lot done meanwhile, repository taken by another wave, budget spent, `--stop-after-current` requested, usage limit, incident) is discarded and the journal says so (`ajout écarté (<cause>)`) — a request kept waiting for its repository is checked again at the moment it is taken, so a stop requested or a budget spent while it waited discards it too, and the lot never enters `wave.json`; the same goes for a request still queued when no session is left to play (`la vague a fini de jouer`) — if the wave ends between the check and the write, the command withdraws the request and says to launch the lot in a new wave. A legitimate commit of an added lot on the main branch of its repository is not an incident for a session already running in a sibling repository (L456). With `--continue`, the lots added by hand count as lots of the wave and are not drawn a second time. The case of `--resume --integrate` refused while another wave holds the repository is not part of `--add`: the resume waits for that wave (L443), except when it plays only integrations of lots that have their worktree and no session of that wave works in the main tree: it then passes between that wave's steps without waiting (L553, see the resume section below).

**A lot the wave handed back after the lead fixed it (L563).** `--add <project:lot>` also takes a lot of the live wave that the wave itself handed back at the end of its cycle, once the lead has fixed and **committed** the work in the lot's kept worktree: it goes on in the same worktree and branch, without waiting for the end of the wave or for a new wave (`--replay` stays refused on a live wave). Only the six hand-backs that `toFix` writes at the cap of correction passes are taken, the whitelist `FIN_DE_CYCLE_WHATS` (`src/orchestrate/cycle/review.ts`, read by `addableHandBack` in `src/orchestrate/geste.ts`): `revue non conforme`, `tests rouges`, `code sans test`, `documentation en retard`, `sonde de cas limites`, `UX non conforme`, each followed by ` après <N> passe(s) de correction` (and, for the first, an optional `; escalade …`). Every other hand-back keeps the refusal `lot déjà dans la vague`: spec, fiche, maquette and accept steps (their step failed: a new wave resumes them), write-step hand-backs (`sans commit`, `délai dépassé`, `dépôt sale`), incidents (`HEAD déplacé`, commit on the main branch of another repository, dependency not ready, worktree impossible, plan modified by the session), the integration (`--resume --integrate`), the budget (`--budget`), `--drop`, the docs.sync gap, a refused plan write, and any outcome the whitelist does not name. Before anything is written the command checks the kept worktree (exit 2 otherwise): the worktree and the wave branch must exist and no tracked file may be modified — the refusal is `<lot> : worktree du lot introuvable ou arbre sale : <cause>`, names the uncommitted files and the command to replay after the commit; the program never commits nor discards the lead's tree. The check is played again when the wave takes the request (the tree may have changed while it waited for a slot): a lot whose tree is dirty then, or that is no longer handed back, is discarded and said in the journal (`<lot> : ajout écarté à la prise : worktree du lot introuvable ou arbre sale : …`), and stays handed back. When taken, the new lot context **replaces** the old one (a single occurrence in the wave's lists and in `wave.lots`) and `resumeNext` (`src/orchestrate/ajout.ts`) copies the old state into it: steps, findings, review counts, tokens are kept; `pass` goes back to 0, the escalation is cleared, the budget becomes what the lot already spent plus the budget of a new lot (that new budget must fit the remaining budget of the wave); `resumedFrom` is the wave itself. The step is chosen there, because `runLot` skips its start block for a lot that keeps its steps: `toFix` when the lot has code-review findings (`a:L1 : reprise du lot rendu à la correction, worktree <path>`), otherwise `firstReview` when it passed a review (the review of the lead's fix, `… à la revue …`), otherwise `firstWrite` (`… à l'écriture …`: never reviewed, or only red-test findings). The `geste` column of `--status` shows `cadence orchestrate --add <project>:<lot> --wave <wave>` (`.:<lot>` from the launch folder) for such a lot on a live wave; it does not read the tree, so a dirty tree is refused by `--add` itself.

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
The key is read for every lot of a launch, so it is the way to give a goal to several lots at once, on both plan kinds (cadence only reads the plan,
it never writes a goal into it). The notes and sub-tasks of the lot stay in the objective. The goal read at launch is kept in the state
of the lot and is the only source afterwards (briefs, `--dry-run`, table): a `--resume` replays the sessions with the goal of the launch, and
a `goal:` added or changed in the plan since is not read (to change it: `--resume --wave <wave> --drop` the lot and launch it again). `--dry-run` prints
`objectif donné : …` under the lot, and the table of the wave repeats it (`<project>:<lot> — objectif donné : …`) so the lead sees which
objective the sessions worked from.
The review and UX briefs carry it too, on a line `Goal of the lot (it takes precedence over the title in the plan): …`, and `code-reviewer` / `qa-reviewer` measure the commits against it, not against the stale title still in a read-only plan.
A goal that narrows a lot to commits already merged skips the mockup and lets the reviews judge only the diff of the goal (L621, [docs/orchestrate-cycle.md](orchestrate-cycle.md#a-goal-that-narrows-a-lot-to-commits-already-merged-l621)).

**`--resume --budget <project>:<lot>=+N` — replaying a lot handed back for its budget (L223)**: a lot handed back with
`correction non jouée (budget)` or `budget du lot atteint` kept its findings but not its budget, and a plain `--resume` does not replay a
finished lot. `--budget maritime:B26.4=+300k` (the project may be left out when only one project carries the lot; the option is
repeatable for several lots, and `--budget 1M` still raises the wave's budget — the `=` tells them apart) puts the lot back in play:
its budget becomes **what its sessions already counted plus N** (849 k spent of 750 k, `=+300k`: 1 149 000; when the lot still holds the share of the escalation (L349) it is added on top, so N stays the margin of the ordinary passes), its outcome is cleared,
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
(« à décider avec … », « (à décider) »: a lot waiting for a human decision), it is not already in the wave, the project's draw setting does not hold it back (L390, below), and its own budget (derived from its estimate; a lot with `screen: page` is worth 1.3 M whatever its estimate, or its ordinary budget plus the 450 k spec-stage allocation if that is more, a visible lot with another `screen:` (or none) above 0.1 day has its ordinary budget plus that allocation (light mockup, L459), and a lot with `spec: true` gets that allocation on top of its ordinary budget)
fits in the budget left — otherwise the next one that fits is taken (a lot that does not fit in what is left of the current
round is not dropped: it is tried again at the next round, once the budget allows it). A round takes at most **one lot per
repository** while other repositories have ready lots — the pool plays the lots of one repository one after the other, so a
second one would leave a session idle — and is completed with the same repository when nothing else is ready. Projects are visited in the declared **priority**:
`--priority cadence,maritime`, or a `priority: [cadence, maritime]` list in the `cadence.yaml` of the folder you launch from
(the parent of the projects); a name also covers `name-…` (`maritime` → `maritime-atlas`), the other projects come after, in
alphabetical order. Launched from inside a project, only that project is drawn. A `priority:` key that cannot be read is refused before anything
starts, lots given or not (`--no-fill` avoids that refusal only without `--continue`); if it becomes unreadable while the wave plays, the draw of that look is skipped, with a journal line `remplissage : tirage passé`. A candidate that preflight refuses (dirty tree, Node missing…) is skipped with its cause in the
journal (`continue : lot sauté — <cause>`; for the first draw also on the error output). Drawing stops — `continue : arrêt — <reason>` — at: the budget, the
time window (`--until HH:MM`, today's clock: nothing new is drawn from then on, a running lot is not cut), the usage limit (« usage limit reached », « rate limit », « You've hit your weekly limit »),
a question asked (the wave stays resumable with `--answer`), two lots handed back in a row, an interrupted wave, a `--stop-after-current` request (`arrêt demandé`, even when the last running
lots finished cleanly), or no ready
lot whose estimate fits the budget left. `--resume … --continue` draws again after the resumed lots. When the wave starts, `--continue` (and its `--dry-run`) prints the line `tirables, ressources libres : <project>:<lot> <title> (<resources>) · …` that `cadence lead tour` prints (L252): the drawable lots, from every project of the folder, whose `uses:` resources (`raf uses`, `resources:` of the parent `cadence.yaml`) are held neither by a lot `doing` (of the folder's projects, and of every project that shares their resources: those under the folder whose `cadence.yaml` declares `resources:`, walked with its `depth:`, one level by default, so launched from a group or from inside one project it still sees the others) nor by an unfinished lot of a live wave nor by the lots of the first draw of the wave that starts (a lot of a wave is recognised by its repository and its id, not by the project name; those lots, and the drawable lots that compete with them for a resource, are not listed); at most 3 lots per project, then `<project> +K`; nothing is held back by it, the draw below is unchanged. `--dry-run --continue` simulates the
free-slot fill below with the same function as the wave, one lot at a time (the first ready lot in the priority order, pre-check, budget counted on the estimates), and
names the candidates skipped with their cause: `tirés ensuite, un par un au fil des créneaux libres, dans l'ordre de priorité (budget décompté sur les estimations) : b:L2, a:L2, a:L3` (ten at most, then `…`). The simulation cannot know which repository will be busy at each look: it lists the lots in the order the fill would take them if every repository were free. The round draw happens between rounds: a round of up to `--max-sessions` lots must finish before the next round draw; a free slot is filled in the meantime (below).

**A free slot is filled at once (L527, GitHub issue #21).** Between rounds is not the only moment of the draw: while the pool plays, each time a session slot is free — no queue playing, none waiting for its dependency; a queue whose lot waits for its integration turn gives its slot back (L591), so the wave may draw a lot from the plan during that wait — the wave draws the next ready lot of the plan, in the priority order above, and plays it without waiting for the lots still playing (on 02-11 a lot added to a wave waited behind the other one, played alone in the main tree, while a slot stayed empty; a lot handed back at the pre-check frees its slot within seconds the same way). The wave looks at the slots at the end of each lot and every 2 seconds. The draw keeps every rule of the round: at most `--max-sessions` sessions across all the waves; never two sessions in one repository (a candidate whose repository is playing is kept for the next look, the next lot of another repository goes first; with `orchestrate.worktrees: true` and more than one slot every lot of the repository plays in its own worktree — given alone, drawn by the fill or added by `--add`, with or without `--continue` — so the next lot of its repository can fill the free slot); a lot whose `uses:` resource is held by a lot `doing` or by an unfinished lot of a live wave (this one included) is not drawn; the project's `continue:` setting; a lot refused by the pre-check is skipped, with its cause in the journal (`lot sauté — <cause>`, said once — `continue : lot sauté — <cause>` for the round draw of `--continue`; a refusal of the repository, such as a dirty tree, is looked at again at the next look). The stops are those of the round (`continue : arrêt`): `--stop-after-current`, the usage limit, a question asked, two lots handed back in a row, `--until`, the budget. The budget a lot still playing has not spent yet stays reserved (its budget minus the tokens counted for it): the next lot must fit in the rest. When several slots are free at once, each lot taken counts before the next: its budget comes off the rest, and a lot that wants a `uses:` resource the fill has just taken waits for the next look. Each start is told in the journal: `créneau libre rempli par <project>:<lot>`, then `<project>:<lot> : ajouté à la vague <wave>` as for `--add`; the lot is in `wave.json`. **A wave of named lots fills its free slots too (L587)**: `cadence orchestrate a:L1 b:L1` no longer needs `--continue` for that — when a slot is free and nothing is queued for it, the wave draws the next ready lot of the plan exactly as above (the `priority:` list of the parent `cadence.yaml`, free `uses:` resources, mature lots only, the `continue:` setting of L390), until the budget is spent; on 04-11 two waves were filled by hand with `--add` between events and slots stayed empty in between. An unreadable `priority:` key refuses the wave before anything starts, as with `--continue`. `--no-fill` keeps the previous behaviour: the lots given are the only ones played (with `--continue`, it only turns the free-slot fill off: the draw between rounds stays); `--no-fill` with neither lots nor `--continue` is refused, unless another action is asked (`--resume`, `--add`, `--status`, …): it has no effect there. `--resume` replays the wave as it was and fills only with `--continue`; `--dry-run` does not simulate the fill of a wave of named lots. The round draw stays for the first lots and for what the free-slot fill did not take (a refused lot that is clean again).
**Keeping a lot out of the draw (L390, `orchestrate.continue`)**: `--continue` draws the first ready lot of the plan, even a big one with no spec and no sub-task (maritime B6 « Profils verticaux, coupes (10) », effort L, drawn on 27-10 then withdrawn by the lead). A project says what its draw may not take, in its own `cadence.yaml`:

```yaml
orchestrate:
  continue:
    maxEstimate: 1        # days: a lot whose estimate is above is not drawn (equal is drawn)
    exclude: [L12, L40]   # lot ids never drawn
```

Both keys are optional; no `continue:` key keeps the old behaviour. A lot whose title or a note says « non tirable » (any case) is not drawn either, with no setting needed — the same convention as « à décider ». The setting belongs to the project: the other projects of the folder draw as before. It only governs the draw: a lot given on the command line (`cadence orchestrate maritime-atlas:B6`) is played whatever the setting says, and `--resume` replays the lots already in the wave. `--dry-run --continue` prints, after the `--continue : priorité …` line, `réglage de tirage — <project> : maxEstimate 1, exclude L12 L40` for each project that sets one, then `lot écarté — <project>:<lot> écarté du tirage : <cause>` for each ready lot held back (`estimate 3 > continue.maxEstimate 1`, `listé dans continue.exclude`, `marqué « non tirable »`); the wave itself says nothing about them, round after round. An unknown key, a `maxEstimate` that is not a positive number or an `exclude` that is not a list of ids refuses the configuration (`continue.<key> …`). The line `tirables, ressources libres` is a view of the ready lots by resource and does not apply this setting.

**Chaining without the human (L148)**: the `lead` skill, once the human has chosen the first lots and the order, does not ask « next? »
after a lot that comes back ready: it re-verifies it, records `raf done`, pushes, delivers, has the `qa-reviewer` check the
delivered app, then starts the next wave with `--continue`, in the declared priority — one project at a time, within the two-session
limit. Before each new wave it reads the context of its own session with `cadence session context` (the figure of the `ctx` segment of the `cadence-hud` band, which publishes the context of each session to `~/.cadence/orchestrate/hud-context/<session id>.json`; the command picks the file named by `$CLAUDE_CODE_SESSION_ID`, set in the environment of the session's Bash, never "the latest file of the folder" — two sessions of one folder alternate; without the band loaded in that session the command exits with code 2, and a missing or stale figure counts as at the threshold); once it has reached
**`lead.contextThreshold`** (tokens, `150000` by default, see [session](session.md)) it starts nothing: it runs `session-close` in each project touched, writes its memory and records three lines for next
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
same time as the session cap allows — 2 by default; the `orchestrate.worktrees: true` mode (on in cadence's own `cadence.yaml`, off where the key is absent) plays the lots of one repository in parallel, each in its own worktree — « One worktree per lot »). `@<model>` sets the model of the implementation and corrections of that
lot (`@haiku`, `@sonnet`, `@opus`, or any other name, passed as it stands to `claude --model` like `orchestrate.escalation.model`: `@fable`, `@claude-fable-5-1` — L345; the dry-run warns, without refusing, for a name outside the three aliases; default Sonnet; reviews are Opus, except the light review (« Review sized to the lot » in [orchestrate-cycle.md](orchestrate-cycle.md)); Haiku only when you write it, for a mechanical lot). Run it
in the background and read `--status`: it prints one line per transition and the final table.

**Following a wave (L49)**: `--status --watch` clears the screen and redraws the live waves and the table every
`--interval` seconds (default 10), then stops by itself, leaving the last render, as soon as no wave is running
(exit code 0, like `--status`; a wave already finished gives a single render). The `cadence-lead` skill names the background
task « vague `<id>` : `<project>:<lot>`, … », starts the wave with `--wave <id>` and arms `cadence orchestrate --follow --wave <id>` as its follow-up.
The Claude Code status band is the `cadence-hud` plugin.

**Goal not verified (L632)**: a lot whose implementation report announced red tests with a command the gate does not play, or whose last review lists the goal under `nonVerifie`, is shown `prêt à livrer — objectif non vérifié : <goal>` in the table, in `--follow` and in the `raf review` note; with `orchestrate.prodAccess` false, a lot naming `kubectl`, a cluster or a bench URL is flagged at launch and in `--dry-run` ([details](orchestrate-cycle.md)).

**Minutes after the first review (L625)**: The `après revue` column (next to `durée`) sums the durations of the steps that follow the lot's first code review (`review` or `review-small`; the review itself and what precedes it are not counted, an unfinished step counts 0): what the fixes and later reviews cost. `—` while the lot has no code review.

**`--follow` (L588)**: reads `.cadence/runs/<id>/journal.log` (`--wave <id>`, else the last wave of the folder) every `--interval` seconds (default 5) and prints, with their timestamp, only the lines **written after it was armed** that ask the lead for a gesture: a lot `ready`, `handed-back` or `failed`, a `question`, a `suspended` on `budget atteint`, `quota atteint` or an incident (`vague arrêtée : push détecté…`, `dépôt … sali par la revue de …`, `dépôt … laissé en HEAD déplacé …`: the lead cleans up before resuming), `intégré : <sha>..<sha>`, and « rendu à l'intégration ». The transitions `implementing`, `reviewing` and `fixing`, the suspensions that are the lead's own gesture (`arrêt demandé (--stop-after-current)`, `… (--resume --integrate)`, `… (--resume --budget)`, `… (--resume --replay)`), the sessions, the worktrees and the control requests stay in the journal (on 04-11, 453 events reached the lead over 3 waves, 91 of them useful: the other 80 % cost 300–400 k tokens of its context). Lines written before the follow-up was armed are not replayed: a `--follow` re-armed after a `--resume` does not print again the `ready` and `question` lines already relayed (`--status` and `tail` show them). The wave is held over once it has been out of the registry of live waves for 6 consecutive polls (30 s by default): a wave being resumed — including a `done` one resumed with `--integrate` or `--budget projet:lot=+N`, whose status stays `done` until its first session — registers only after its snapshot, locks and push guards, and a `--continue` wave leaves the registry between two rounds, so one absent poll is not an end. Then it prints one last line, `fin de vague <id> : <status>` (`done`, `suspended-budget`, `suspended-quota`, `interrupted` — an incident ends in `interrupted`; its text is in the journal line of the suspended lot and in the final table), and exits 0. A `--wave` that has not written its state yet is awaited for 30 polls before « vague inconnue »; without `--wave`, no wave in the folder is refused at once. `--follow` combines with nothing but `--wave` and `--interval`. The journal itself is unchanged: `tail -F` still shows everything.

## Moved sections

The anchors of the sections that moved, kept for one version so that an old link still lands on a line that says where to go.

### The `orchestrate` keys of `cadence.yaml` (reference)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#the-orchestrate-keys-of-cadenceyaml-reference).

### The spec step of a lot with `screen:`

Moved to [orchestrate-spec.md](orchestrate-spec.md#the-spec-step-of-a-lot-with-screen).

### The light mockup (L459)

Moved to [orchestrate-spec.md](orchestrate-spec.md#the-light-mockup-l459).

### The spec step of a lot with `spec: true`

Moved to [orchestrate-spec.md](orchestrate-spec.md#the-spec-step-of-a-lot-with-spec-true).

### The mockup review: before any code

Moved to [orchestrate-spec.md](orchestrate-spec.md#the-mockup-review-before-any-code).

### Brief size (L559)

Moved to [orchestrate-spec.md](orchestrate-spec.md#brief-size-l559).

### The accept step: red acceptance tests and their lock

Moved to [orchestrate-spec.md](orchestrate-spec.md#the-accept-step-red-acceptance-tests-and-their-lock).

### Elements of a reference document in the briefs (L367)

Moved to [orchestrate-spec.md](orchestrate-spec.md#elements-of-a-reference-document-in-the-briefs-l367).

### The downstream briefs: sheet, rule → test → green, conformity, Hypothèses

Moved to [orchestrate-spec.md](orchestrate-spec.md#the-downstream-briefs-sheet-rule--test--green-conformity-hypothèses).

### Proposals the lot's own commits may have treated (L422)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#proposals-the-lots-own-commits-may-have-treated-l422).

### Reviews converge: follow-ups and a wall cap (L622)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#reviews-converge-follow-ups-and-a-wall-cap-l622).

### Express lane (L519)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#express-lane-l519).

### Cost in euros, before and after a wave (L529)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#cost-in-euros-before-and-after-a-wave-l529).

### Sealed tests and shared files: the pre-check of what a lot may collide with (L500)

Moved to [orchestrate-gate.md](orchestrate-gate.md#sealed-tests-and-shared-files-the-pre-check-of-what-a-lot-may-collide-with-l500).

### The edge-case probe (`orchestrate.probe`, L497)

Moved to [orchestrate-gate.md](orchestrate-gate.md#the-edge-case-probe-orchestrateprobe-l497).

### The subject of the plan commits (`plan.commit`, L343)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#the-subject-of-the-plan-commits-plancommit-l343).

### One worktree per lot (`orchestrate.worktrees`, L279)

Moved to [orchestrate-worktrees.md](orchestrate-worktrees.md#one-worktree-per-lot-orchestrateworktrees-l279).

### A lot whose work is in a neighbouring repository

Moved to [orchestrate-worktrees.md](orchestrate-worktrees.md#a-lot-whose-work-is-in-a-neighbouring-repository).

### A session never commits on another repository (L456)

Moved to [orchestrate-worktrees.md](orchestrate-worktrees.md#a-session-never-commits-on-another-repository-l456).

### `plan.onWrite`: the published plan follows every write (L346)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#planonwrite-the-published-plan-follows-every-write-l346).

### Time limit of a write step (L298)

Moved to [orchestrate-cycle.md](orchestrate-cycle.md#time-limit-of-a-write-step-l298).
