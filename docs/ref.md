[← cadence](../README.md)

# `cadence ref`: reference documents (specs, norms, mock-ups)

A spec delivered as a PDF often keeps part of its information in images: screen mock-ups,
tables drawn as pictures, message templates, figures of a norm (WMO, ICAO…). `cadence ref`
turns such a document into files a session can read without losing the pictures. The whole
design is in
[`docs/superpowers/specs/2026-10-23-ref-documents-de-reference-design.md`](superpowers/specs/2026-10-23-ref-documents-de-reference-design.md)
(issue #14); this page describes what is delivered so far: **`cadence ref add`** (lot 1 of 10) and **`cadence ref measure`** (lot 2 of 10).

## `cadence ref add <document.pdf> [--sections 3-5,9] [--slug name]`

Registers a PDF and builds, for it:

- **pages rendered at 200 dpi** (`pages/page-<n>.png`, `pdftoppm`);
- **positioned text** of every page (`pdftotext -bbox-layout`): each line with its box
  `x, y, l, h` in pixels of the rendered page (200 dpi);
- **embedded images** (`pdfimages`, `images/p<page>-<n>.png`) with their region in the same
  pixels (`pdftohtml -xml`);
- **the figure index**: one entry per caption at the start of a line (`Figure n`, `Fig. n`,
  `Table n`, `Tableau n`, `Planche n`). After a separator (`—`, `–`, `:`, `.`, `-`) the line is a
  caption whatever the case of the title (`Figure 1 — map of stations`); without one,
  `Figure 3 shows…`, `Figure 5, which…` and `Figure 5 (page 4) and…` cite the figure. One exception:
  a line made only of the number and one closed parenthesis (`Table IV.3 (in accordance with
  4.3.11)`, WMO-No. 49 vol. II) is a caption when no other line looks like the caption of that
  number; with another one, or open (`Table 11 (see Example…`), it cites. A separator
  followed by nothing (`figure 24.` ending a sentence) is not a caption either. A
  table-of-contents entry (dot leaders on its line or on the next one, or any line of a contents
  page: one where at least two lines, and more than half, have dot leaders or end with a possible
  page number) is neither a caption nor a citation, so a figure that only the contents list names
  comes out as « nothing cites it ». A trailing number alone never makes an entry:
  `Table 4.1. … presented in Chapter 4` among prose is a caption. When several lines look like the
  caption of one figure, those with a title are kept (`Figure 5 Jet speed` rather than a bare `Figure 5`), if any; among them
  the first on a page that holds an image wins, then the first with a separator, then the first. Each entry has its page, line, box, its images, and **the passages that cite it** (page,
  line, exact line; `nommee` when the text names the figure, `designee` for « as shown
  below » / « ci-dessous », attached to the nearest caption of the page). Plurals count one citation per figure
  (`Figures 2 and 3`, `Tables 4 to 6`, `Figs. 2.1 et 2.2`); a number keeps the letters of an annex numbering (`Figure 1.B.1`, `Table 12.B.3`). Listed under **`unresolved`**
  (« lien non résolu »): a citation of a figure with no caption, a figure that nothing cites,
  and an image on a page that has no caption (`image sans légende`).

- **thumbnails of every page** (`thumbs/page-<n>.png`, 40 dpi) and the **pages without text**:
  a page with fewer than 20 characters of text is taken for scanned and reported
  (`pages sans texte : 30 (1-4, 6-31)`), so a scanned norm does not look indexed while its index
  is empty; the thumbnails tell which pages to render with `--sections`. (Both recipes come from
  the `norme-etude` skill of maritime-atlas: `refdoc.py index`.)

Without `--sections`, a document of 30 pages or fewer is rendered whole; a larger one only gets
its index (text and figures), no page is rendered. With `--sections`, the pages asked for are
rendered **plus the pages of the figures they name**, wherever they are in the document. Running
`add` again on the same document (same sha256) keeps the pages rendered before and adds the new
ones; a slug taken by another document is refused (`--slug` picks another name).

A PDF that asks for a password, forbids copying, is damaged, is not a PDF or has no page is refused with the reason. Image
documents (PNG, JPG) are not read yet.

## `cadence ref measure <slug> <page> <zone> [--quoi couleurs|contraste|boites|texte] [--largeur 1440] [--json]`

Measures a zone of a **rendered** page of a document registered by `add` (a page `add` did not render
is refused with the command that renders it). The zone is `page` (the whole page), `x,y` (one
point) or `x,y,l,h` (a rectangle), in pixels of the rendered page (200 dpi: the unit of the boxes in
`document.json`). Every length in the answer is brought back to a **reference width** of 1440 px
(`--largeur`), the width of a screen, whatever the resolution of the page: the first line says the
factor. Without `--quoi`, the four measures; a point only has colours.

- **`couleurs`**: the exact colour of a point (`#c81e28`, `rgb(200, 30, 40)`); for a rectangle the
  mean (rounded) and the **dominant colours** with their share of the zone (grouped by 8 levels per
  channel, at most 5, none under 1 %).
- **`contraste`**: WCAG 2.2 contrast ratio between the zone's **background** (its dominant colour) and
  its **text** (the mean of the pixels farthest from the background: the anti-aliased edge is left out),
  with the three thresholds read on the unrounded ratio: AA (4.5), AA large text and interface
  components (3), AAA (7). `#767676` on white gives 4.54, `#777777` 4.48. A zone of one colour has no
  contrast to measure.
- **`boites`**: the connected shapes that differ from the background (8 neighbours), the 20 largest first, and the
  bounding box of all the content; coordinates are those of the page, not of the zone. A pixel belongs to a shape from a distance of 24 (RGB, Euclidean) to the background, the threshold under which a zone is flat: a pale card (`#eeeeee` on white) is a shape.
  Shapes under 16 pixels are dust.
- **`texte`**: the words tesseract reads (English model, `--psm 6`) with their box and confidence, and the
  **estimated font size**: the median height of the words that have no descender and a letter as tall
  as a capital (`Hello`, `2026`, not `gap`) read with confidence ≥ 60, divided by 0.72 (the cap height
  of Helvetica / Arial in em). The size is the one of the reference width.

**Declared tolerance** (last line, and `tolerance` in `--json`): colours ±1/255 per channel (mean
rounded), boxes ±1 pixel of the page, i.e. ±⌈factor⌉ px at the reference width, font size ±5 % (the cap
height of a face is 0.70 to 0.73 em) plus one pixel of cap height, given with the measure
(`police : ≈ 28.2 px (±10 %, 4 mot(s) …)`). The image is read as it is: an alpha channel is composed over white.
Only 8-bit, non-interlaced PNG (what `pdftoppm` writes) is read; another kind is refused with the reason.

```
$ cadence ref measure norme 2 page --quoi contraste
norme p.2 · zone 0,0,1700,2200 px de la page · ramené à 1440 px (×0.85)
contraste : 4.54:1 (texte #767676 sur fond #ffffff) · AA ✓ · AA grand texte et composants ✓ · AAA ✗
tolérance : couleurs ±1/255 par canal, boîtes ±1 px, police ±5 % plus un pixel de hauteur de capitale
```

`--json` prints one object (`document`, `page`, `zone`, `echelle`, `tolerance`, then `couleurs`,
`contraste`, `boites`, `texte` as asked). Exit codes: 0 done, 2 refusal (tool, unknown document,
page absent or not rendered, invalid zone or option).

### Where the files go

Outside the repository: `references.dir` of `cadence.yaml` (relative to that file), by default
`$XDG_DATA_HOME/cadence/references` (`~/.local/share/cadence/references`). A `references.dir`
inside a Git repository is refused: the documents may be private. One folder per document:

```
<references.dir>/<slug>/document.json   source, sha256, pages (lines, boxes), images, figures, unresolved
<references.dir>/<slug>/pages/          page-<n>.png, 200 dpi
<references.dir>/<slug>/images/         p<page>-<n>.png
<references.dir>/<slug>/thumbs/         page-<n>.png, 40 dpi, every page
```

### System tools

`cadence ref` calls poppler (`pdftoppm`, `pdftotext`, `pdfimages`, `pdfinfo`, `pdftohtml`),
ImageMagick (`magick`, or `convert` for version 6) and tesseract. They are looked up in the
`PATH` before the document is read; each one missing is named with its install command and the
command exits **2**, writing nothing and installing nothing:

```
ref : outil absent du PATH, à installer (rien n'est installé d'office) :
  magick ou convert : sudo apt install imagemagick
```

(`poppler-utils`, `imagemagick`, `tesseract-ocr`.) `add` does not call ImageMagick or tesseract, `measure` calls tesseract (and only for the text); both check all the tools at the first call, as the design asks.
ImageMagick is not called by either: `measure` decodes the rendered PNG pages itself. The rest of cadence depends on none of them.

Exit codes: 0 done, 2 refusal (tool, file, option, slug, folder).
