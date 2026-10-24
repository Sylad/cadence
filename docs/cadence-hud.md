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
aligned line per active lot (status, step, model, elapsed, start of the title), the lots still
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
answers `argument inconnu : … (attendu : cmd, projets)` and leaves the band as it is. The source lives in [`plugins/cadence-hud`](../plugins/cadence-hud/README.md)
(its own README has the details of every cell); it is not part of the npm package. To work on it:
`claude plugin validate plugins/cadence-hud`, `claude plugin test plugins/cadence-hud`, and
`tsc -p plugins/cadence-hud` once Claude Code has loaded the plugin at least once (it generates
the `.claude-plugin/types` the tsconfig extends).
