[← cadence](../README.md)

# `cadence ref`: reference documents (specs, norms, mock-ups)

A spec delivered as a PDF often keeps part of its information in images: screen mock-ups,
tables drawn as pictures, message templates, figures of a norm (WMO, ICAO…). `cadence ref`
turns such a document into files a session can read without losing the pictures. The whole
design is in
[`docs/superpowers/specs/2026-10-23-ref-documents-de-reference-design.md`](superpowers/specs/2026-10-23-ref-documents-de-reference-design.md)
(issue #14); this page describes what is delivered so far: **`cadence ref add`** (lot 1 of 10).

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
  `Figure 3 shows…`, `Figure 5, which…` and `Figure 5 (page 4)` cite the figure. A
  table-of-contents entry (dot leaders on its line or on the next one, a trailing page number, or
  a page made mostly of such entries) is neither a caption nor a citation, so a figure that only
  the contents list names comes out as « nothing cites it ». When several lines look like the
  caption of one figure, the first on a page that holds an image wins, then the first with a
  separator, then the first. Each entry has its page, line, box, its images, and **the passages that cite it** (page,
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

(`poppler-utils`, `imagemagick`, `tesseract-ocr`.) `add` itself does not call ImageMagick or
tesseract — `cadence ref measure` will — but checks them at the first call, as the design asks.
The rest of cadence depends on none of them.

Exit codes: 0 done, 2 refusal (tool, file, option, slug, folder).
