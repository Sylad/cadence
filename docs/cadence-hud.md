[← cadence](../README.md)

# cadence-hud

A band above the Claude Code prompt (terminal and desktop app), refreshed every 5 s:

```
ctx ▰▰▰▰▱▱▱▱▱▱  42 % 84k/200k  │  5h  23 % ↻ 2 h 10  │  7j  61 % ↻ 6 j 15 h  │  $1.23  │  fable 410k sonnet 85k  │  ⚙ 2 agents  │  2 cmd
⟳ cadence · 2026-10-07-2131 en cours  │  budget ▱▱▱▱▱▱▱▱▱▱   1 % 14k/2M  │  1 session/2
  L112  implémente  implement@sonnet 34 s         global-setup coupe le cache de compilation de Node...
```

Context of the session (green / orange / red at 50 and 75 %), the 5-hour and 7-day quota
windows with the time to their reset, the cost of the session and its split per model, the
subagents of this session, the background commands in progress (`2 cmd`: Bash run in the background and Monitor, subagents' included, as the app's "background commands" card counts them), and every live `cadence orchestrate` wave: budget, sessions, one
aligned line per active lot (status, step, model, elapsed, start of the title; `porte@tests 3 min` while the program's build or test gate runs with no session, L395), the lots still
waiting. When no wave is running, the last finished one stays on a grey line for 30 minutes
after it ended, then disappears. A background command counted for more than an hour, or with no
record of when it started, is no longer shown as running: it moves to a grey `N cmd sans fin
vue` ("end never seen") right after `N cmd`, because its end notification may never have reached
the session. Waves are read from disk (`~/.cadence/orchestrate/waves/`, then `.cadence/runs/`); no
cadence command is run, and the CLI is not required for those. One more block needs it: the **progress of the plans**,
one line per active project (a project with open lots), in the order of `priority:`:

```
ol      ▮▮▮▮▮▯▯▯▯▯ 39/78 · 0 en cours · +3 cette semaine
cadence ▮▮▮▮▮▯▯▯▯▯ 10/20 · 2 en cours : L149 L153
```

The **sessions of the lead** (L276) — the ones started by hand and declared with `cadence lead hold <label>` — are drawn
under the waves, even when no wave is running: the slots line of `cadence orchestrate --status` and one line per session
(label, age, time left):

```
sessions du lead : 1 · créneaux libres : 2 sur 3
  correctif-L12  depuis 4 min · reste 56 min
```

With a live wave and no held session the line reads `créneaux libres : 1 sur 2`; with neither, nothing. A session whose
time limit has run out stops counting in the slots but is not dropped (L278): a row `⚠ session du lead échue : correctif-B28  échue depuis 2 h 10` stays under the others (in red) until `cadence lead release <label>` or a renewed `lead hold`, since nothing stops the session itself. They are read from disk (`holds/` of the cadence home), like the waves.

The bar is lots done over lots done + in progress + to do (dropped and recurring lots left out); the count of lots in progress is followed by their ids (`2 en cours : L149 L153`), cut to three then `…` (`5 en cours : L1 L2 L3 …`), the count alone at zero;
`+N cette semaine` counts the lots created in the last 7 days (today and the six before) and is left out at zero. The source is
`cadence lead tour <folder> --json` (the folder a wave was launched from, otherwise the session's: a folder of projects gives one line per project, a project with no sub-project gives its own single line),
read again at every wave transition and otherwise every minute; without `cadence` on the PATH, the
lines are simply not drawn.

Install it as a plugin from the same marketplace:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence-hud@cadence
```

`/hud` hides or shows the band. `/hud cmd` lists the background commands being counted (id, tool,
origin `session` or `agent <id>`, age, name; `(sans fin vue)` on the ones above). Any other argument
`/hud projets` folds the project list to one line, and opens it again. Any other argument
answers `argument inconnu : … (attendu : cmd, projets, lots)` and leaves the band as it is.

### The lots panel (`/hud lots`, L401)

`/hud lots` opens a **panel**, read-only for the lots themselves beside the conversation (inline above the prompt on the main screen); the same command closes it. It is never opened on its own, and the command opens it whatever the width of the window, Claude placing it; when Claude cannot place it, the command answers `panneau des lots non placé : <reason>` and nothing opens. For each project of the folder (the order of `priority:`) it draws the open lots as a tree, with their state and their `after:` links:

```
Lots  lecture seule  lu à 15:52
▾ cadence  7 lots non clos
 ▾L401        Panneau des lots (mod cadence-hud, Pane)  2 sous-lots  ▶ en cours
  ├ L401/2    Écrire le panneau et son rafraîchissement      ▶ en cours
  └ L401/3    Test du rendu (claude plugin test) et doc      ○ à faire
  L402        Réordonner par glisser-déposer  after: L400 L401   ⊘ bloqué
▾ ol  1 lot non clos
  L80         Calendrier des matchs                          ⟳ relit
/hud lots pour fermer
```

Each project name is a button (L409): a click, or Enter once it has the focus (click in the panel, or ctrl+x then tab), folds the project to one line (`▸ maritime  159 lots non clos · 3 en cours`, the name, the open lots and those in progress) or opens it again (`▾`). `/hud lots <project>` does the same from the keyboard (`projet inconnu : … (projets : …)` for a name that is not in the panel). A project with more than 20 open lots (native sub-tasks not counted) is folded until you choose; your choice wins over that default either way, and it is kept between two openings of the panel and between sessions (the plugin's `$.store`, key `lotsFolds`). A folded project that is shown is not counted in `… +N lots de plus`, and when the panel is short it keeps its line even after the cut (the open lots before it give way); if there are more folded projects than the panel has room for, the ones left out are counted there with their open lots. A project the tour could not read has no button.

Inside a project the lots are ordered (L410): those in progress first (`doing`, or in a wave being implemented, reviewed, corrected, in question, ready or handed back), then the free ones (no open `after:`, whatever the wave state of a queued, failed or suspended lot), then the rest (blocked by an open `after:`), the order of the plan kept within each group. A sub-lot stays under its parent, and a parent with a sub-lot in progress rises with it (that sub-lot before its siblings).

A project shows at most 5 lots (L411), the first ones in the order above (so those in progress first); a lot and its sub-lots count for one, and the project's count (`12 lots non clos`) stays whole. Past 5, a `+ N lots` button (`N`: the lots left out) opens the rest of the project, and turns into `moins`, which closes it again. A lot that has sub-lots (a sub-lot of a plan, or native sub-tasks) shows `▸` (closed) or `▾` (open) glued to its id, in the last cell of its indent and their count after its title (`2 sous-lots`); it is closed by default and a click opens or closes it, at any depth. Both choices are kept between two openings of the panel and between sessions (the plugin's `$.store`, key `lotsViews`); a folded project (L409) shows neither lots nor button. `… +N lots de plus`, when the panel is short, counts lots only, never these buttons; when the panel is short, the button of the project being cut keeps its line (like a folded project) and the lots give way, so `moins` is always there to close the rest, and the lots hidden behind a button that is cut with its project are counted in `… +N`.

States: `▶ en cours` (doing), `○ libre` (todo, no open `after:`), `⊘ bloqué` (todo, an `after:` is still open); a lot in a wave takes the wave's state and words, as the band writes them (`… en attente`, `⟳ implémente`, `⟳ relit`, `⟳ corrige`, `? QUESTION`, `✔ prêt`, `↩ rendu`, `✖ échec`, `⏸ suspendu`). In a native plan the sub-tasks of an open lot (`L401/2`) are its sub-lots (`├`/`└`); they only read `▶ en cours` or `○ à faire`, and are not counted in the project's `N lots non clos`. In a plan kept by another tool the sub-lots come from `parent:`. An `after:` id that is closed or unknown is struck through and blocks nothing. A project the tour could not read shows `illisible : <error>`; the others stay.

Before the first reading the panel says `Lecture des plans…`; if `cadence lead tour` does not answer it says `Lots illisibles : cadence lead tour n'a pas répondu. Nouvelle lecture dans une minute.` (a failed re-reading keeps the last table); a `cadence` too old to give the `lots` field says `Lots indisponibles : cadence est trop ancien, mettez-le à jour.`; with no open lot, `Aucun lot non clos dans les projets de ce dossier.`. A tree taller than the panel ends with `… +N lots de plus`. Under 60 columns the `after:` list moves to its own line and the title is cut with `…`, never the id or the state.

The data is the `lots` field of `cadence lead tour --json` ([lead tour](lead.md#lead-tour)), read together with the band's `progress` (same call, same folder). While the panel is open, the modification date of each plan (`.cadence/raf.yaml` and `cadence.yaml` of the folder and of its direct sub-folders) is read every 5 s, one `stat` each: a changed plan, like a wave transition, triggers a new reading before the minute is over. Cost of the `lots` field (R18, measured on 2026-10-28 with `cadence lead tour --json` on the parent folder of ten projects, three passes each): before L401 (cadence 1.19.1, no `lots`) 8.0 / 9.1 / 7.3 s and 86 KB of output; after (the L401 code) 7.5 / 7.0 / 8.4 s and 188 KB (192,503 bytes). The output more than doubles in size but the duration stays in the same order, under the 20 s refresh delay of the band, so the rule holds.

The source lives in [`plugins/cadence-hud`](../plugins/cadence-hud/README.md)
(its own README has the details of every cell); it is not part of the npm package. To work on it:
`claude plugin validate plugins/cadence-hud`, `claude plugin test plugins/cadence-hud`, and
`tsc -p plugins/cadence-hud` once Claude Code has loaded the plugin at least once (it generates
the `.claude-plugin/types` the tsconfig extends).
