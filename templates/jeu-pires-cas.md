# Worst-case data set

A second data set for the product, next to its demo data, that the screen steps (spec, mockup review, ux, qa) load to see every
state with extreme data. It is declared in `cadence.yaml` (`qa.worstData`, one line: the parameter or the path that loads it,
for example `?data=worst`) and found only there, never in the CLAUDE.md. Without the key, the briefs say nothing about it.

## Rules

- **Realistic**: the data looks like what a real user holds (plausible names, dates, amounts), only pushed to the edge. No
  `aaaa…` or `lorem ipsum` placeholders.
- **Set once, next to the demo data, and wired in the same place**: one data file beside the demo data, loaded by the same code
  path (the same seed, mock or fixture loader), so every screen that works with the demo data works with the worst-case data.
- **Dev mode only**: the switch (for example `?data=worst`) is read in dev mode only and has no effect in production.
  Production ignores it and shows the real data.

## Families to cover

The set holds at least one case of each of these eight families:

1. very long name (a first word and a whole sentence with no space to break on)
2. one-letter name
3. count of 0 (an empty list, a zero total)
4. count of 1 (a singular where the text says plural)
5. missing optional field (absent, `null` and empty string)
6. large number (more digits than the layout expects, with its separators and unit)
7. non-Latin text (Arabic, Chinese, Cyrillic, emoji; right-to-left included)
8. long list (hundreds of rows, to see paging, scrolling and performance)

## Regression test

Keep a regression test in the product that loads the set through the same loader as the demo data, checks that each of the
eight families is present, and fails when a family is missing: a later edit of the set cannot drop a case silently.
(Idea: the `break-ui` skill of emilkowalski/skills, MIT.)
