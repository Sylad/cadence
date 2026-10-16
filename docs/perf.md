[← cadence](../README.md)

# perf

`cadence perf [folder] [--since date] [--json]` is the permanent dashboard of the workflow. It calls no model, writes nothing
(no journal, no plan, no cache) and reads, from the folder (default: the current one), the wave journals
`<folder>/.cadence/runs/<wave>/<project>--<lot>.json` (with each wave's `wave.json`) and the plan of every project of the folder
(one nesting level, like `cadence corrections`: `group/gamma`). Exit code `0`, even when a `⚠` is printed; `1` on a usage or read error.

It compares two windows of 7 calendar days (local days): the **current** one (the last 7 days, today included) and the **previous**
one (the 7 days before). Every speed indicator is printed on the same line as its **quality twin**, never alone ("fast *and* well"):

| Family | Indicator | Twin | Decision it informs |
|---|---|---|---|
| Throughput | lots ready, lots handed back per day, lots delivered (plan `done` with `finished` in the window), share of handed-back lots within their token budget | escaped defects | is the flow dropping? look for the bottleneck before adding lots; are the budgets right? |
| Corrections | median of `fix` passes per lot, share of lots with 2 passes or more | share of lots right the first time (no `fix` pass) | is the first write good enough? harden the sheet or the brief |
| Corrections | dominant causes (top 3 of the classified passes, the unclassified share apart) | — | which link to fix |
| Lead interventions | lots handed back by a wave then finished outside it, `ux` sessions per visible lot | escaped defects | does the wave stop too early? does the ergonomics review cost more than one round? |

A line starts with `⚠` and ends with the decision it informs when its value is **worse than the previous window by more than 25 %**
(a drop for the throughput and the share right the first time; a rise for passes, interventions and escaped defects). No `⚠`, and the line says
why, when one window holds fewer than 5 lots for the indicator, when the previous value is zero, or when `--since` truncates a window.
A window with no lot gives `n/d` (`null` in JSON), never `0`. A **clear bottleneck** (one cause weighing at least half of the classified passes of the
current window, with at least 10 classified passes) is flagged by a `⚠` even without a trend.

- **Dating.** A journal is dated by the end of its last step (else by the creation of its wave); a journal without a readable date is left out. A correction pass is dated
  by the end of its `fix` step. The classification of a pass is `cadence corrections`' (same reading, `src/corrections.ts`): without finding to read it is `sans-constat`,
  otherwise the cause of `<folder>/.cadence/corrections.json` (a manual cause first), `non-classe` when absent from it. `perf` never classifies: run `cadence corrections --classify`.
- **Escaped defects** = distinct lots with a plan note dated in the window, written after the lot was done, that starts with `QA` (after the `DD-MM` date prefix) and
  contains `bloquant` or `majeur` not preceded by `0` or `aucun`. Until a plan holds such a note the value is `n/d` ("aucune note QA reconnue : convention à fixer (L227)"). Reopened lots are not counted: the plan does not date a reopening.
- **Lead interventions.** A lot counts when its last journal (all waves of the folder) is `handed-back` or `failed` and its plan lot is `done` with `finished` on or after the day it was handed back.
  A journal joins its plan by the project name (the path of the project relative to the folder) and the `lot` field of the journal; an id `Q4/accueil-4-ux12` joins the plan lot `Q4`. Journals with no plan lot are counted aside (`N lot(s) de journal sans plan`) and never counted as finished outside the wave.
  An unreadable plan skips its project with a warning on the error output, and the indicators that read the plans are `n/d`.
- **`--since date`** is an ISO date that ignores everything before that day in both windows; a window starting before it is *truncated* (its per-day rates divide by the days covered, no `⚠`).
  It is **not** the instant of `cadence corrections --since` (waves created strictly after).
- **`--json`** prints one object `{ since, today, windows: { current, previous }, throughput, corrections, interventions, orphans, warnings }`; every indicator carries
  `{ current, previous, change, warn, twin, lots, note }` (`twin`: the path of its quality twin, e.g. `throughput.escaped`). Same values as the text.

No indicator of produced volume (lines of code, commits, tokens consumed) is printed or exposed: tokens only relate a lot to its budget.
