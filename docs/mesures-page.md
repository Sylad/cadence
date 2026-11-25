# Layout measures

A UX review used to measure a page click by click: resize, snapshot, screenshot, at each width. Each snapshot comes back into the
reviewer's context. On 24-11 the `ux-reviewer` cost 63.63 $ in 24 h at API prices, 16 % of the day; the review UXW-36 alone took
about 158 k tokens and 69 tool calls (D-34). `cadence mesures` measures the whole page in one pass, at every width and in every
state asked for, and returns the figures only. It is the **script mode** of the `ux-reviewer` ([skills](skills.md)).

The command is generic: nothing in it belongs to one project.

## Command

```bash
cadence mesures <url> [--largeurs 375,768,1024,1440] [--hauteur 900] [--charge 2000] [--max 5] \
  [--etat "<name> → cliquer <selector> ; attendre <ms> ; touche <key>"]… [--json file] [--captures folder]
```

| Code | Meaning |
|---|---|
| 0 | every pass measured, no finding |
| 1 | findings |
| 2 | not verified: usage error, no browser, or a pass not measured (page that does not load, a state whose selector is missing) |

The default widths are those of the delivery grid of the `ux-reviewer` (375, 768, 1024 and 1440 px). Each width opens the page once
for the base state and once for each `--etat`. A state uses the step syntax of the `parcours:` lines of the
[interaction probes](sondes-interaction.md): `cliquer <selector> [×N]`, `attendre <ms>`, `touche <key>`. A `file://` URL works,
so a static mockup (`docs/specs/<screen>/maquette.html`) is measured the same way.

## What is measured

One line of figures per width and state: the document width against the viewport, the horizontal scroll, the count of each family,
the smallest font size (and the texts under 12 px), the words read, and the landmarks (`header`, `nav`, `main`, `aside`, `footer`
and their ARIA roles) as left offset + width + right gutter.

The findings, one family each:

| Family | Measure | Rule the reviewer names |
|---|---|---|
| défilement horizontal | document wider than the viewport, in px | WCAG 1.4.10 (reflow) |
| déborde du bord droit | outermost visible elements past the right edge, not inside a scrolling or clipping box, not `position: fixed` | WCAG 1.4.10 |
| texte tronqué | an element with its own text, `overflow` not visible or `text-overflow: ellipsis`, content wider than its box | WCAG 1.4.4 / 1.4.10 when the text is lost |
| mot coupé sur deux lignes | a word of two letters or more whose letters sit on two lines; `après un trait` when the break follows a hyphen or a slash | French typography (Lexique de l'Imprimerie nationale) |
| valeur séparée de son unité | a number at the end of a line and a short word (unit, `%`, `°C`) at the start of the next | Lexique de l'Imprimerie nationale (non-breaking space) |
| libellé court sur plusieurs lignes | a button, label, tab, header cell, legend or lone link of 30 characters at most on two lines or more | Nielsen 4 and 8 |
| cible sous 24 × 24 px | a visible interactive element smaller than 24 px in one dimension; a link inside a sentence is exempt | WCAG 2.5.8 |

The script reports measures, not verdicts. The reviewer judges each one on the capture and the charter: an ellipsis on purpose with
the full title in a tooltip is not a defect. The spacing exception of WCAG 2.5.8 is judged on the capture too.

The text report lists the figures, then the findings **grouped**: the same element with the same text, seen at several widths or in
several states, is one line that says where (`— 375, 768 px (base, panneau)`), with the detail of the narrowest width, whatever the order of `--largeurs`. At most
`--max` groups per family are listed (5 by default), the rest is counted. `--json` writes every measure; `--captures` writes one
full-page screenshot per width and state (`mesures-<state>-<width>.png`), which the reviewer opens only when it needs to see one.

## Limits

- Words are read up to 20 000 per pass; past that, the line of figures says « plafond atteint ».
- HTTP requests other than GET and HEAD are answered with an empty 204 in the browser (a state clicks for real), counted as
  « écriture(s) coupée(s) ». It is not the read-only guard of the probes: WebSocket messages and workers are not cut, so a state
  never names a control that writes.
- What WebGL draws is not measured (a map canvas is one element). In software rendering the header says so.
- Contrast, focus, keyboard and motion are not measured here: the reviewer measures them with one script of its own (see the agent).
- Playwright is taken from the machine as for the probes, never installed.

## Bench

`node scripts/banc-ux-script.mjs <url>` estimates, with no model, the tokens each mode brings into the context for one page. The
full bench replays a review already done in both modes. Protocol, reduced case and commands:
[mesures/ux-mode-script-l839.md](mesures/ux-mode-script-l839.md).

Tests: `test/mesures-page-l839.test.ts` measures `test/fixtures/mesures/defauts.html` (seven known defects, all found) and
`propre.html` (none) in a real browser, skipped when no Playwright loads.
