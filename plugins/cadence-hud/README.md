# cadence-hud

A band above the Claude Code prompt (terminal and desktop app), refreshed every 5 s: context, quota windows, cost, subagents,
background commands, the live `cadence orchestrate` waves and the progress of the plans. Short card; the single description of the
band, with every cell, is [docs/cadence-hud.md](../../docs/cadence-hud.md), which makes the reference (fait foi).

## Install

```
/plugin marketplace add Sylad/cadence
/plugin install cadence-hud@cadence
```

The band does not need the `cadence` CLI, except for the progress of the plans and the lots panel (`@sylad/cadence` on the PATH).

## Segments

- `ctx` — context of the session; `5h`, `7j` — quota windows and time to their reset; `$1.23` — cost of the session;
  `fable 410k sonnet 85k` — consumption per model;
- `⚙ 2 agents` — subagents of this session; `2 cmd` — background commands of this session;
- one header and one aligned line per active lot for each live `cadence orchestrate` wave; free slots and the sessions of the lead;
- one progress bar per project with open lots.

## Commands

`/hud` hides or shows the band; `/hud cmd` lists the background commands counted; `/hud projets` folds the project list;
`/hud lots` opens the lots panel (`/hud lots <project>` folds a project in it).

## Work on it

`claude plugin validate <folder>` · `claude plugin test <folder>` · `tsc -p <folder>` once Claude Code has loaded the plugin.
To load it from elsewhere: `claude --plugin-dir <folder>` or `CLAUDE_CODE_PLUGIN_DIRS=<folder>`.
