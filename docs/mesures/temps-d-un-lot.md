[← cadence](../../README.md)

# Where the time of a lot goes (L517)

Measure of the wall time and the tokens of every lot of the waves created from 2026-10-17 to 2026-11-01 (15 days), split by item, to decide where to cut. L518 (one full gate per lot) and L519 (express lane for touch-ups) are sized on these figures.

## Method (replayable)

```
cadence corrections ~/projects/developpeur --json --since 2026-10-17T00:00Z --until 2026-11-01T19:00:00Z > corrections.json
node scripts/temps-d-un-lot.mjs --runs ~/projects/developpeur/.cadence/runs --since 2026-10-17T00:00Z --until 2026-11-01T19:00:00Z --corrections corrections.json
```

`--json` prints the per-lot detail instead of the tables; `--since` and `--until` bound the creation date of the waves (the `--until` of the command above leaves out the wave still running when the measure was taken); `--transcripts` names the folder of the Claude Code transcripts (default `~/.claude/projects`). Sources, all read-only:

- the state of each lot, `<wave>/<project>--<lot>.json`: start and end of every step, tokens counted, `estimate`;
- `<wave>/journal.log`: the slot waits obtained (`créneau de session obtenu après …`) and the `intégré` line;
- the transcript of every `implement` and `fix` session, found by the `sessionId` of its step (`~/.claude/projects/*/<sessionId>.jsonl`), whose tool calls carry timestamps;
- `cadence corrections --json` for the cause of the correction passes (the classification is cached by that command, not redone here).

How the figures are drawn:

- **Lot view.** Wall of a step = `ended − started` minus the slot wait obtained during it (the step is stamped before it has its slot). The gap between two steps is the wave's **gate and orchestration** (the gate replays the tests and the build after every writing session). A gap over 30 minutes is a **suspension** (question to the lead, budget, night): out of the wall, reported on its own. From the last step to the `intégré` line: **integration**. Tokens are the `counted` of the steps (input, output, cache written; the cache read is not counted).
- **Session view.** For each tool call of a writing session: the time of the model before the call (reading, thinking, writing the call) plus the time of the tool until its result is one **round trip**, put in the item of the tool: tests (`vitest`, `jest`, `pytest`, `npm test`), build (`tsc`, `qualite`, `eslint`, `knip`, `jscpd`), news (`cadence news`, files under `nouveautes/`), captures (Playwright), writing (`Edit`, `Write`, `sed -i`, heredocs, Python that writes), reading (`Read`, `grep`, `sed -n`, `cat`, `git log/show/diff`, …), `git`, waiting (`sleep`), other. Before the first call: **cold start**. From the last result to the end, and the final `StructuredOutput` report: **model alone**. Output tokens and the context re-read (input + cache read + cache written) of an assistant message go to the item of its first tool call, once per message. A *full suite* is a test command that names no file, filter or `src/` path.
- **Cross with the estimate.** Lots are bucketed by the `estimate` of the plan at the time of the wave (days).
- Only lots with at least one successful writing session are counted.

Known limits, so that the figures are not over-read:

- the gate replays are not timed one by one: their cost is the inter-step gap, which also holds the verdict bookkeeping (median 0.1 min, 90th percentile about 6 min for implement → review);
- delivery is not in the figures: `deliveries.log` holds one date and one sha per delivery, no duration, and the step journal of `deliver` (`deliveries-steps.log`, L516) exists only for deliveries after 2026-11-01;
- a failing test run and a passing one are not told apart; a test run in the background followed by `sleep` is split between « tests » and « attente »;
- the correction passes of `cadence corrections` (580) and the successful `fix` steps counted here (620) differ: the first counts a pass once classified and attached to a review, the second every `fix` step with status ok;
- the item of a tool call is read from its command text: a command that mixes a test and a build counts as tests, and a git command followed by tests or a build (`git add … && npx vitest run`) counts as those tests or that build, not as git; calls issued in parallel share their common tool time, counted once, so that the items of a session never add up to more than its wall.

## Figures

All the tables below are the output of the command above (the labels are the script's, in French), taken on 2026-11-01.

730 lots avec une session d'écriture aboutie ; mur cumulé 18327,7 min, 193 661 k jetons comptés (entrée, sortie, cache écrit ; hors cache lu) ; hors 14328,0 min de suspension (trous de plus de 30 min entre deux pas : question au lead, budget, nuit).

| Poste (vue du lot) | Mur cumulé (min) | Part | Mur moyen par lot (min) | Jetons comptés | Part |
|---|---|---|---|---|---|
| préparation | 362,1 | 2 % | 0,5 | 13 585 k | 7 % |
| implémentation | 6215,7 | 34 % | 8,5 | 63 251 k | 33 % |
| sonde | 88,1 | 0 % | 0,1 | 775 k | 0 % |
| correction | 3501,4 | 19 % | 4,8 | 33 446 k | 17 % |
| revue | 4295,8 | 23 % | 5,9 | 81 265 k | 42 % |
| ux | 87,9 | 0 % | 0,1 | 1 243 k | 1 % |
| acceptation | 1,8 | 0 % | 0,0 | 95 k | 0 % |
| attente de créneau | 233,9 | 1 % | 0,3 | 0 k | 0 % |
| porte et orchestration | 3238,5 | 18 % | 4,4 | 0 k | 0 % |
| intégration | 302,6 | 2 % | 0,4 | 0 k | 0 % |

Détail des sessions d'écriture (implement + fix) — 1348 transcripts lus sur 1348 sessions (730 lots), 9541,0 min :

| Poste (vue de la session) | Mur (min) | Part | Appels d'outil (démarrage : sessions) | Jetons de sortie | Contexte relu (k) |
|---|---|---|---|---|---|
| démarrage | 98,1 | 1 % | 1348 | 0 | 0 k |
| lectures | 1263,9 | 13 % | 9746 | 3138866 | 732 515 k |
| écriture | 540,6 | 6 % | 2032 | 2409749 | 197 315 k |
| tests | 5917,0 | 62 % | 5987 | 4738399 | 524 386 k |
| build | 294,3 | 3 % | 787 | 594811 | 82 933 k |
| Nouveautés | 151,5 | 2 % | 1161 | 566399 | 100 016 k |
| captures | 143,8 | 2 % | 1255 | 383898 | 75 023 k |
| git | 152,5 | 2 % | 760 | 305347 | 67 942 k |
| attente | 298,0 | 3 % | 215 | 41307 | 23 156 k |
| autre outil | 223,7 | 2 % | 736 | 167519 | 57 741 k |
| modèle seul | 457,6 | 5 % | 1430 | 2293391 | 120 850 k |

Rejeux des tests : 5987 commandes de tests dans les sessions d'écriture, dont 1985 suites complètes (2,7 par lot, médiane 2) ; la porte de la vague rejoue la suite après chaque session d'écriture : 1348 rejeux (1,8 par lot).

Suites complètes dans les sessions : 3516,3 min cumulées (1,8 min par rejeu, 442 jetons de sortie et 86 k de contexte relu par rejeu) contre 2404,5 min de tests ciblés.

Coût d'une passe de correction (correction + porte + revue qui la suit) : 11,9 min et 126 k jetons comptés en moyenne sur 620 passes.

Passes de correction par lot : 0 → 401 · 1 → 137 · ≥ 2 → 192 (26 %).

| Estimate | Lots | Mur moyen (min) | Mur médian (min) | Jetons moyens | Passes moyennes | Lots à ≥ 2 passes |
|---|---|---|---|---|---|---|
| ≤ 0,1 j | 48 | 15,5 | 10,2 | 116 k | 0,31 | 2 |
| 0,1–0,5 j | 297 | 35,4 | 27,8 | 288 k | 0,98 | 90 |
| 0,5–1 j | 58 | 34,7 | 26,5 | 375 k | 1,71 | 27 |
| > 1 j | 7 | 26,5 | 11,3 | 303 k | 1,14 | 3 |
| sans estimate | 320 | 15,3 | 11,0 | 245 k | 0,65 | 70 |

Mur moyen par poste (min) selon l'estimate :

| Estimate | préparation | implémentation | sonde | correction | revue | ux | acceptation | attente de créneau | porte et orchestration | intégration |
|---|---|---|---|---|---|---|---|---|---|---|
| ≤ 0,1 j | 0,3 | 6,7 | 0,0 | 2,2 | 2,5 | 0,0 | 0,0 | 0,1 | 3,1 | 0,6 |
| 0,1–0,5 j | 0,5 | 11,3 | 0,2 | 7,4 | 6,1 | 0,0 | 0,0 | 0,5 | 8,4 | 0,9 |
| 0,5–1 j | 0,1 | 8,6 | 0,4 | 8,5 | 7,4 | 0,6 | 0,0 | 1,4 | 7,5 | 0,2 |
| > 1 j | 0,0 | 8,5 | 0,0 | 6,0 | 4,6 | 2,0 | 0,0 | 0,2 | 5,1 | 0,0 |
| sans estimate | 0,6 | 6,1 | 0,0 | 2,1 | 6,0 | 0,1 | 0,0 | 0,0 | 0,4 | 0,0 |

Cause des 580 passes classées (cadence corrections) :

| Cause | Passes | Part |
|---|---|---|
| bug-code | 301 | 52 % |
| sans-constat | 73 | 13 % |
| derive-architecture | 58 | 10 % |
| non-classe | 56 | 10 % |
| spec-floue | 46 | 8 % |
| test-manquant | 40 | 7 % |
| regle-inventee | 6 | 1 % |

## Reading

A lot costs 25 minutes of wave wall on average (18 328 min over 730 lots) and 265 k counted tokens, to which 14 328 min of suspension are added (20 min per lot, out of the wall: the lot waits for the lead, the budget or the night — the largest single wait, and not one of the levers below).

1. **Tests are the first cost of a writing session: 62 % of its wall** (5 917 of 9 541 min). 3 516 min are full suites (1 985 replays of 1.8 min, 2.7 per lot, median 2; 618 lots play at least one), 2 405 min targeted runs (4 002 calls). The suite is then played **again by the gate of the wave after every writing session** (1 348 replays): a lot's suite runs 4.5 times on average. The motivating case reproduces: `ol-companion` L239 (one UI separator) = 253 s of implementation, of which 162 s of tests (8 runs, 5 of them full suites), 14 s of news, 13 s of captures, 35 s over 6 read round trips, then 54 s of review and 53 s of gate.
2. **Reading is the second one, in round trips, not in seconds**: 13 % of the session wall (1 264 min) but 9 746 calls, 13.4 per lot, each re-reading the whole context (733 M tokens of re-read context — input, cache read and cache written —, 37 % of the 1 982 M of all the writing sessions). News (152 min, 2 %), captures (144 min, 2 %), cold start (98 min, 4.4 s per session, 1 %) and writing itself (541 min, 6 %) are small: **writing the code is 6 % of a writing session**.
3. **Review is the first cost in tokens**: 23 % of the wall but 42 % of the counted tokens (81 M of 193 M), against 33 % for implementation and 17 % for corrections.
4. **Correction passes are the third**: 620 passes, each costing **11.9 min and 126 k counted tokens** (correction, gate, and the review that follows) — 7 380 min and 78 M tokens, 40 % of the counted tokens of the window. 26 % of the lots (192 of 730) have two passes or more (the 30 % of the 01-11 measure is another window; `cadence corrections` over the same 15 days gives 180 lots of 708, 25 %). Of the 580 classified passes, 301 (52 %) are `bug-code`, and of those 223 (74 %, 38 % of all passes) are edge cases.
5. **The estimate predicts the passes, not the wall.** Lots of 0.1–0.5 day and of 0.5–1 day last the same (35.4 and 34.7 min), but the second ones have 1.71 passes against 0.98. Lots of at most 0.1 day cost 15.5 min and 116 k tokens, 44 % of which in review and preparation (51 k); lots without an estimate (320) are as short (15.3 min).
6. Slot wait is 234 min (1 %), integration 303 min (0.4 min per lot): not levers in this window.

## Three levers

| Lever | Cut | Minutes saved | Tokens saved |
|---|---|---|---|
| **1. Full suite once, by the gate** (L518): the writing session runs only targeted tests | the 1 985 in-session full suites | 3 516 min = **4.8 min per lot** (−19 % of 25.1). At most 1 480 min more (2 min per lot) if the gate itself runs once per lot instead of after each writing session: 618 replays × 2.4 min, the mean gap before a step | 0.87 M output tokens (0.45 % of the counted ones) and **171 M re-read context** (8.6 % of the re-read context) — a wall lever, hardly a counted-token one |
| **2. Express lane for touch-ups** (L519): no precheck, probe nor separate review (the lead reads the diff), no news entry per lot, one gate | review (2.5 min), preparation (0.3), about half the gate (1.5), news (0.6) for a lot of at most 0.1 day | **≈ 4.9 min of 15.5** (−32 %) per lot: 235 min on the 48 lots labelled in the window, 1 800 min if the 368 short lots (the 320 without estimate included) qualify | **≈ 51 k of 116 k counted tokens** per lot (−44 %): 2.4 M on the 48 lots, 19 M on 368. On L239: tests 162 → ~35 s, news −14 s, reads 6 → 3 trips (−15 s): **≈ 97 s of session**, 84 s if the lead takes the captures — under 90 s needs the three together |
| **3. Fewer correction passes on edge cases** (L447 already in the brief; measure, then sharpen) | the 223 `bug-code` passes that are edge cases: halving them is 111 passes | 111 × 11.9 = **1 321 min** (1.8 min per lot, −7 %) | 111 × 126 k = **14 M counted tokens** (−7 %) |

Reading the table: lever 1 is the largest in minutes and the surest (the gate already replays the suite: removing the in-session copy loses no check); lever 2 is the largest per lot but bounded by the number of lots the plan labels as touch-ups (48 of 730: it needs an `estimate` written, or a rule by diff size); lever 3 is the only one that cuts tokens at scale, and the least certain: the effect of the L447 block is still to be measured (protocol in [bug-code-2026-10-30.md](bug-code-2026-10-30.md)). The 48 of the 73 passes on red tests that ended without a commit ([tests-sans-code-2026-11-01.md](tests-sans-code-2026-11-01.md)) are L510's, not counted in lever 3.

The figures are to be replayed on the window after L518 and L519 are in service: the same command, with `--since` at the date of the service, and lever 1 shows as « full suites » falling from 2.7 per lot to 0 in the session table.
