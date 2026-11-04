[← cadence](../../README.md)

# The sheet review converges (L572)

Before: two sheet reviews at most, then the lot goes back to the lead, even when the second review is down to one single major. Measure **before**, read on the lot states of `~/projects/developpeur/.cadence/runs` (waves from 2026-10-27 to 2026-11-04, a lot counted once per wave, `fiche` of the lot state):

| | Sheets reviewed | With 2 reviews | Reviews played | Handed back `fiche non conforme après 2 revues` | Of which one single major, no blocking one |
|---|---|---|---|---|---|
| 27-10 → 04-11 | 37 | 33 | 70 | 14 | 12 |

Read: 14 of the 37 sheets (38 %) were handed back after two reviews, 12 of those 14 with a single major left (L558 four times in four waves, L563 twice, L512 twice, …) — the lead fixed each in one line. The lot state of those waves kept no per-review count, so how many of these 12 had also dropped from the first review to the second (the condition of the third review) cannot be read back: the figure is the upper bound of the sheets the third review can save.

**After**: to measure on the first waves that run this change. The lot state now keeps `ficheCounts` (blocking + major of each non-conforming sheet review): the same read of the states gives the number of third reviews played and of sheets saved by them (`fiche.passes` = 3 and `conforme`), against the sheets handed back `après 3 revues`.
