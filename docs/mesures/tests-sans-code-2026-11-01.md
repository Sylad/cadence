[← cadence](../../README.md)

# Passes on tests ended without a code change (L510)

Measure of the share of the correction passes **launched on red tests** (no review finding) that ended **without a commit**, over the two last 7-day windows (waves created in the window), read on the real journals of `~/projects/developpeur`:

```
cadence corrections ~/projects/developpeur --json --since 2026-10-25T00:00Z
cadence corrections ~/projects/developpeur --json --since 2026-10-18T00:00Z --until 2026-10-25T00:00Z
```

| Window (creation of the wave) | Passes on tests | Ended without a code change | Share |
|---|---|---|---|
| 18-10 → 25-10 | 9 | 9 | 100 % |
| 25-10 → 01-11 | 62 | 37 | 60 % |

Read: in the last window, 37 of the 62 passes that the gate launched on red tests changed nothing. They are the cost of the false reds that L510 targets (a test that expires close to its limit even alone, a red already red at the baseline); the measure is to be replayed on the next window to see whether it falls. A pass without a commit is not proof of a false red (the session may have given a reason and a fresh review followed, L406): the figure is an upper bound of the false reds.
