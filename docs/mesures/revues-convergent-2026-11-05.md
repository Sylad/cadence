[← cadence](../../README.md)

# Reviews that converge: first-time compliance and passes per lot (L622, issue #41)

What the lot changes is described in [docs/orchestrate.md](../orchestrate.md#reviews-converge-follow-ups-and-a-wall-cap-l622): from the second code review a major on a point the lot did not touch goes to the follow-ups (`[suite code]`) instead of buying a correction pass, and a lot above twice its expected wall is handed back with its findings instead of a new pass.

## Two indicators

- **First-time compliance**: the share of lots with no correction pass (`Passes de correction par lot : 0 → …` of `temps-d-un-lot.mjs`).
- **Passes per lot**: correction passes divided by lots with a successful write session.

## Before (read, not recomputed by this lot)

Window of the 15 days 2026-10-17 → 2026-11-01, 721 lots, the figures of [temps-d-un-lot.md](temps-d-un-lot.md):

| Indicator | Before |
|---|---|
| Lots with 0 correction pass (first-time compliance) | 392 of 721 (54 %) |
| Lots with 1 pass | 137 (19 %) |
| Lots with 2 passes or more | 192 (27 %) |
| Correction passes | 620, i.e. 0.86 per lot |
| Wall of a pass (correction + gate + the review after it) | 11.9 min, 126 k tokens counted |

## After: to measure

The « after » is **not measured here**: the change has just been written and no wave has run with it. It is measured on the first window of waves created after the release that carries L622, with the same two commands as `temps-d-un-lot.md` (section « Method ») on a window of the same length, then the two indicators above are compared with the table. What to read there:

- the share of `Passes de correction par lot : 0 →` must rise and the passes per lot fall;
- `grep -h "suite code" <folder>/.cadence/runs/<wave>/*.json` (or the proposals of the lots) counts the majors set aside: each one is a pass not bought, to be read by hand to check that it was not a real defect of the lot (a major wrongly marked `inchange: true` is the risk of the rule);
- the lots whose outcome contains `plafond de mur` are the ones the wall cap stopped: their number against the lots handed back at the cap of passes says whether the cap cuts anything the pass cap did not.
