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
- Only lots with at least one **successful** writing session are counted: an `implement` or `fix` step with status `ok`. A writing step that did not succeed (`failed`, `interrupted`, …) is not a session: its transcript is not read, it is not counted as a gate replay, and a lot whose writing steps all failed is left out; but its wall and its tokens stay in the lot view (the lot paid for them), and the header line of the figures says how many such steps the kept lots hold.

Known limits, so that the figures are not over-read:

- the gate replays are not timed one by one: their cost is the inter-step gap, which also holds the verdict bookkeeping (median 0.1 min, 90th percentile about 6 min for implement → review);
- delivery is not in the figures: `deliveries.log` holds one date and one sha per delivery, no duration, and the step journal of `deliver` (`deliveries-steps.log`, L516) exists only for deliveries after 2026-11-01;
- a failing test run and a passing one are not told apart; a test run in the background followed by `sleep` is split between « tests » and « attente »;
- the correction passes of `cadence corrections` (580) and the successful `fix` steps counted here (620) differ: the first counts a pass once classified and attached to a review, the second every `fix` step with status ok;
- the item of a tool call is read from its command text: a command that mixes a test and a build counts as tests, and a git command followed by tests or a build (`git add … && npx vitest run`) counts as those tests or that build, not as git; calls issued in parallel share their common tool time, counted once, so that the items of a session never add up to more than its wall.

## Figures

All the tables below are the output of the command above (the labels are the script's, in French), taken on 2026-11-01.

721 lots avec une session d'écriture aboutie ; mur cumulé 18022,3 min, 191 602 k jetons comptés (entrée, sortie, cache écrit ; hors cache lu) ; hors 13972,2 min de suspension (trous de plus de 30 min entre deux pas : question au lead, budget, nuit) ; 2 pas d'écriture non aboutis (failed, interrupted…) gardés dans le mur et les jetons du lot, hors vue de la session.

| Poste (vue du lot) | Mur cumulé (min) | Part | Mur moyen par lot (min) | Jetons comptés | Part |
|---|---|---|---|---|---|
| préparation | 359,8 | 2 % | 0,5 | 13 450 k | 7 % |
| implémentation | 5919,6 | 33 % | 8,2 | 61 353 k | 32 % |
| sonde | 88,1 | 0 % | 0,1 | 775 k | 0 % |
| correction | 3501,4 | 19 % | 4,9 | 33 446 k | 17 % |
| revue | 4294,6 | 24 % | 6,0 | 81 239 k | 42 % |
| ux | 87,9 | 0 % | 0,1 | 1 243 k | 1 % |
| acceptation | 1,8 | 0 % | 0,0 | 95 k | 0 % |
| attente de créneau | 228,2 | 1 % | 0,3 | 0 k | 0 % |
| porte et orchestration | 3238,4 | 18 % | 4,5 | 0 k | 0 % |
| intégration | 302,6 | 2 % | 0,4 | 0 k | 0 % |

Détail des sessions d'écriture (implement + fix) — 1337 transcripts lus sur 1337 sessions (721 lots), 9240,7 min :

| Poste (vue de la session) | Mur (min) | Part | Appels d'outil (démarrage : sessions) | Jetons de sortie | Contexte relu (k) |
|---|---|---|---|---|---|
| démarrage | 97,5 | 1 % | 1337 | 0 | 0 k |
| lectures | 1222,2 | 13 % | 9536 | 3003560 | 696 843 k |
| écriture | 524,7 | 6 % | 1977 | 2305816 | 187 178 k |
| tests | 5723,4 | 62 % | 5852 | 4586734 | 500 203 k |
| build | 281,9 | 3 % | 744 | 520023 | 68 405 k |
| Nouveautés | 149,0 | 2 % | 1147 | 553135 | 98 795 k |
| captures | 142,5 | 2 % | 1230 | 379390 | 73 616 k |
| git | 150,8 | 2 % | 744 | 298497 | 64 451 k |
| attente | 283,7 | 3 % | 209 | 30025 | 22 188 k |
| autre outil | 208,9 | 2 % | 716 | 163099 | 55 671 k |
| modèle seul | 456,0 | 5 % | 1424 | 2280069 | 120 062 k |

Rejeux des tests : 5852 commandes de tests dans les sessions d'écriture, dont 1945 suites complètes (2,7 par lot, médiane 2) ; la porte de la vague rejoue la suite après chaque session d'écriture : 1337 rejeux (1,9 par lot).

Suites complètes dans les sessions : 3423,4 min cumulées (1,8 min par rejeu, 437 jetons de sortie et 85 k de contexte relu par rejeu) contre 2303,7 min de tests ciblés.

Coût d'une passe de correction (correction + porte + revue qui la suit) : 11,9 min et 126 k jetons comptés en moyenne sur 620 passes.

Passes de correction par lot : 0 → 392 · 1 → 137 · ≥ 2 → 192 (27 %).

| Estimate | Lots | Mur moyen (min) | Mur médian (min) | Jetons moyens | Passes moyennes | Lots à ≥ 2 passes |
|---|---|---|---|---|---|---|
| ≤ 0,1 j | 48 | 15,5 | 10,2 | 116 k | 0,31 | 2 |
| 0,1–0,5 j | 293 | 35,4 | 27,8 | 291 k | 0,99 | 90 |
| 0,5–1 j | 57 | 34,8 | 26,6 | 377 k | 1,74 | 27 |
| > 1 j | 6 | 29,1 | 21,3 | 327 k | 1,33 | 3 |
| sans estimate | 317 | 15,0 | 10,6 | 244 k | 0,66 | 70 |

Mur moyen par poste (min) selon l'estimate :

| Estimate | préparation | implémentation | sonde | correction | revue | ux | acceptation | attente de créneau | porte et orchestration | intégration |
|---|---|---|---|---|---|---|---|---|---|---|
| ≤ 0,1 j | 0,3 | 6,7 | 0,0 | 2,2 | 2,5 | 0,0 | 0,0 | 0,1 | 3,1 | 0,6 |
| 0,1–0,5 j | 0,5 | 11,1 | 0,2 | 7,5 | 6,1 | 0,0 | 0,0 | 0,5 | 8,5 | 0,9 |
| 0,5–1 j | 0,1 | 8,3 | 0,4 | 8,6 | 7,5 | 0,6 | 0,0 | 1,4 | 7,6 | 0,2 |
| > 1 j | 0,0 | 8,1 | 0,0 | 7,0 | 5,4 | 2,3 | 0,0 | 0,2 | 6,0 | 0,0 |
| sans estimate | 0,6 | 5,7 | 0,0 | 2,1 | 6,0 | 0,1 | 0,0 | 0,0 | 0,4 | 0,0 |

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

A lot costs 25 minutes of wave wall on average (18 022 min over 721 lots) and 266 k counted tokens, to which 13 972 min of suspension are added (19 min per lot, out of the wall: the lot waits for the lead, the budget or the night — the largest single wait, and not one of the levers below).

1. **Tests are the first cost of a writing session: 62 % of its wall** (5 723 of 9 241 min). 3 423 min are full suites (1 945 replays of 1.8 min, 2.7 per lot, median 2; 611 lots play at least one), 2 304 min targeted runs (3 907 calls). The suite is then played **again by the gate of the wave after every writing session** (1 337 replays): a lot's suite runs 4.6 times on average. The motivating case reproduces: `ol-companion` L239 (one UI separator) = 253 s of implementation, of which 162 s of tests (8 runs, 5 of them full suites), 14 s of news, 13 s of captures, 35 s over 6 read round trips, then 54 s of review and 53 s of gate.
2. **Reading is the second one, in round trips, not in seconds**: 13 % of the session wall (1 222 min) but 9 536 calls, 13.2 per lot, each re-reading the whole context (697 M tokens of re-read context — input, cache read and cache written —, 37 % of the 1 887 M of all the writing sessions). News (149 min, 2 %), captures (143 min, 2 %), cold start (98 min, 4.4 s per session, 1 %) and writing itself (525 min, 6 %) are small: **writing the code is 6 % of a writing session**.
3. **Review is the first cost in tokens**: 24 % of the wall but 42 % of the counted tokens (81 M of 192 M), against 32 % for implementation and 17 % for corrections.
4. **Correction passes are the third**: 620 passes, each costing **11.9 min and 126 k counted tokens** (correction, gate, and the review that follows) — 7 366 min and 78 M tokens, 41 % of the counted tokens of the window. 27 % of the lots (192 of 721) have two passes or more (the 30 % of the 01-11 measure is another window; `cadence corrections` over the same 15 days gives 180 lots of 707, 25 %). Of the 580 classified passes, 301 (52 %) are `bug-code`, and of those 223 (74 %, 38 % of all passes) are edge cases.
5. **The estimate predicts the passes, not the wall.** Lots of 0.1–0.5 day and of 0.5–1 day last the same (35.4 and 34.8 min), but the second ones have 1.74 passes against 0.99. Lots of at most 0.1 day cost 15.5 min and 116 k tokens, 44 % of which in review and preparation (51 k); lots without an estimate (317) are as short (15.0 min).
6. Slot wait is 228 min (1 %), integration 303 min (0.4 min per lot): not levers in this window.

## Three levers

| Lever | Cut | Minutes saved | Tokens saved |
|---|---|---|---|
| **1. Full suite once, by the gate** (L518): the writing session runs only targeted tests | the 1 945 in-session full suites | 3 423 min = **4.7 min per lot** (−19 % of 25.0). At most about 1 300 min more (1.8 min per lot) if the gate itself runs once per lot instead of after each writing session: 616 replays × 2.1 min, the mean gap after a writing session | 0.85 M output tokens (0.44 % of the counted ones) and **165 M re-read context** (8.7 % of the re-read context) — a wall lever, hardly a counted-token one |
| **2. Express lane for touch-ups** (L519): no precheck, probe nor separate review (the lead reads the diff), no news entry per lot, one gate | review (2.5 min), preparation (0.3), about half the gate (1.5), news (0.6) for a lot of at most 0.1 day | **≈ 4.9 min of 15.5** (−32 %) per lot: 235 min on the 48 lots labelled in the window, 1 790 min if the 365 short lots (the 317 without estimate included) qualify | **≈ 51 k of 116 k counted tokens** per lot (−44 %): 2.4 M on the 48 lots, 19 M on 365. On L239: tests 162 → ~35 s, news −14 s, reads 6 → 3 trips (−15 s): **≈ 97 s of session**, 84 s if the lead takes the captures — under 90 s needs the three together |
| **3. Fewer correction passes on edge cases** (L447 already in the brief; measure, then sharpen) | the 223 `bug-code` passes that are edge cases: halving them is 111 passes | 111 × 11.9 = **1 319 min** (1.8 min per lot, −7 %) | 111 × 126 k = **14 M counted tokens** (−7 %) |

Reading the table: lever 1 is the largest in minutes and the surest (the gate already replays the suite: removing the in-session copy loses no check); lever 2 is the largest per lot but bounded by the number of lots the plan labels as touch-ups (48 of 721: it needs an `estimate` written, or a rule by diff size); lever 3 is the only one that cuts tokens at scale, and the least certain: the effect of the L447 block is still to be measured (protocol in [bug-code-2026-10-30.md](bug-code-2026-10-30.md)). The 48 of the 73 passes on red tests that ended without a commit ([tests-sans-code-2026-11-01.md](tests-sans-code-2026-11-01.md)) are L510's, not counted in lever 3.

The figures are to be replayed on the window after L518 and L519 are in service: the same command, with `--since` at the date of the service, and lever 1 shows as « full suites » falling from 2.7 per lot to 0 in the session table.
