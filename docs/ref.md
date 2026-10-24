[← cadence](../README.md)

# `cadence ref`: reference documents (specs, norms, mock-ups)

A spec delivered as a PDF often keeps part of its information in images: screen mock-ups,
tables drawn as pictures, message templates, figures of a norm (WMO, ICAO…). `cadence ref`
turns such a document into files a session can read without losing the pictures. The whole
design is in
[`docs/superpowers/specs/2026-10-23-ref-documents-de-reference-design.md`](superpowers/specs/2026-10-23-ref-documents-de-reference-design.md)
(issue #14); this page describes what is delivered so far: **`cadence ref add`** (lot 1 of 10), **`cadence ref measure`** (lot 2 of 10) **`cadence ref check`** with the inventory schema (lot 3 of 10), and **`cadence ref eval`** (lot 4 of 10, with the synthetic corpus `cadence ref corpus`).

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
  its **text**: every colour carried by at least 10 % of the non-background pixels is a text colour
  (an anti-aliased edge is spread over many shades and stays under that share), and the verdict is the
  one of the **least contrasted** text colour, never a mean of several (a red and a blue text do not
  make a purple that is not in the image). The one exception is a zone where no colour reaches that share (a gradient, text over a photo): the text is then the mean of the pixels furthest from the background, a colour that may not exist in the image, and the answer says so (`texte.moyenne: true` in JSON, a note on the `contraste` line). The three thresholds are read on the unrounded ratio: AA (4.5), AA large text and interface
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

## `cadence ref check <inventaire.json | lecture.json>`

Validates an **inventory** (`genre: "inventaire"`) or a **reading** (`genre: "lecture"`): the JSON file in which the
reference analysis lists what the document shows. The model to copy is
[`templates/inventaire.json`](../templates/inventaire.json) (one element of each of the eleven types, slug `exemple`).
`check` validates the **form**, never the truth of a measure; it calls no system tool (it works with an empty `PATH`), does not read
`references.dir` and writes no file.

```
$ cadence ref check inventaire.json
✗ elements[3].libelle : champ du type texte manquant ou invalide
✗ elements[5].ecran : exemple#texte-1 ne désigne aucun élément de type ecran
2 écart(s)
$ cadence ref check templates/inventaire.json
inventaire valide : 11 éléments (ecran: 1, composant: 1, etat: 1, texte: 1, jeton: 1, table: 1, gabarit: 1, schema: 1, lien: 1, statut: 1, silence: 1)
```

Exit codes: **0** valid (summary on the standard output; « lecture valide » for a reading), **1** deviations (one
`✗ <path> : <reason>` line per deviation then `N écart(s)`, **on the standard output**), **2** wrong call (not exactly one
argument) or unreadable file (absent, a folder, empty, not JSON, UTF-8 BOM included): the reason goes to the error output. A
duplicated JSON key is not detected (the last one wins, as with `JSON.parse`). An unknown key, at the root or in an element, is ignored.

**Root**: `version` (1), `genre`, `document` `{ slug (kebab-case), sha256 (64 lowercase hex) }`, `elements` (non-empty array).

**Every element**: `type` (`ecran`, `composant`, `etat`, `texte`, `jeton`, `table`, `gabarit`, `schema`, `lien`, `statut`, `silence`);
`id` = `<slug of document>#<type>-<n>` (n ≥ 1, no leading zero; the slug is compared as it is, even invalid, and two elements never share an id);
`source` `{ page ≥ 1, zone { x, y, l, h } }` in pixels of the page rendered at 200 dpi (x, y ≥ 0, l, h ≥ 1; the zone is optional only for a `silence`);
`citations` (optional) `[{ page, ligne, extrait }]`; `confiance` (`mesure`, `lu`, `incertain`); `cause` (non-empty, **only** on an
`incertain` element); `ocr` (optional boolean; in a reading an `ocr: true` element is never `lu`).

| Type | Own keys |
|---|---|
| `ecran` | `largeur_reference` (integer > 0, 1440 in the model), `zones` (non-empty) `[{ nom, x, y, l, h, pct { x, y, l, h } }]`: pixels at that width, `pct` numbers from 0 to 100 |
| `composant` | `role`, `position { x, y }` (≥ 0), `taille { l, h }` (≥ 1), `contenu` (text, may be empty), `ecran` (id of an `ecran`) |
| `etat` | `nom` (non-empty, open list), `cible` (id of a `composant` or an `ecran`) |
| `texte` | `libelle` (non-empty, no leading or trailing blank), `role` |
| `jeton` | `categorie` (`couleur`, `taille_police`, `espacement`, `rayon`, `opacite`), `valeur` (non-empty string or finite number), `point` (`{ x, y }` or a zone `{ x, y, l, h }`; required when `confiance` is `mesure`), `contraste` (optional) `{ texte, fond, ratio 1 to 21 }` |
| `table` | `colonnes` (non-empty array of texts), `lignes` (non-empty, each row has as many text cells as columns) |
| `gabarit` | `nom`, `champs` (non-empty, ordered) `[{ nom, obligatoire (boolean), format, min?, max? }]`, `min ≤ max` |
| `schema` | `noeuds` (non-empty) `[{ id, libelle }]` (unique ids), `flux` `[{ de, vers, libelle, direction }]` (`de`, `vers` = node ids; `direction` = `de_vers` or `bidirectionnel`) |
| `lien` | `figure`, `passage { page, ligne, extrait }`, `constat` (`confirme`, `precise`, `contredit`); `precise` adds `lecture_ambigue`, `interpretation`, `raison`; `contredit` adds `enonces` (exactly two texts) and carries no `interpretation` |
| `statut` | `libelle`, `couvre` (non-empty array of ids of any type, itself included) |
| `silence` | `question` (non-empty, ends with `?`) |

References (`ecran`, `cible`, `couvre`, flux nodes) are resolved on the whole list of ids, wherever the element is. Every slug and id
deviation (R6/R9) is listed, none masks another; elsewhere a deviation can hide others (a non-object element only reports its
`type`, an invalid `confiance` skips the `cause` check, an invalid `elements` validates no element). The key names of `ecran` and the values of `direction` are a format shared with the later lots
(they are hypotheses of the sheet `docs/specs/ref-inventaire-schema/fiche.yaml`).

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

## `cadence ref eval <attendu> <lecture> [--json]`

Scores a reading against the inventory that is known to be true (the evaluation of the design, §« Mesure »). `attendu` is an
inventory (`genre: "inventaire"`), `lecture` a reading or an inventory of the same document; both go through the checks of
`ref check` first. Two folders work too: `attendu` holds `<cas>/attendu.json` (what `ref corpus` writes) and `lecture`
`<cas>/lecture.json`; a case without a reading counts as read with nothing (recall 0) and is named under `sans lecture`.

An element read is matched to an expected one **by type and identity**, never by id or zone (two independent readings number
their elements their own way; case and blanks inside a text do not count): `texte` and `statut` by `libelle`, `composant` by
`role` and `contenu`, `etat` by `nom` and the identity of its target, `jeton` by `categorie` and `valeur` (a colour is compared as
written), `table` by `colonnes`, `gabarit` by `nom`, `schema` by the labels of its nodes, `lien` by `figure`, `silence` by
`question`, `ecran` (one per document). An expected element is matched once. The matched element is **juste** if it also says the
same thing: the `role` of a `texte`, the `lignes` of a `table`, the `champs` of a `gabarit` (name, mandatory, format, bounds, in
order), the `flux` of a `schema`, the `constat` of a `lien` (the interpretation of a `precise` is not compared), the elements
covered by a `statut`, the `largeur_reference` of an `ecran`.

- **rappel** = juste / expected, **précision** = juste / read, both by type and overall;
- **faux lu** = read elements marked `lu` or `mesure` (« sûrs ») that are not juste, over the sûrs: an invented element, a wrong
  cell, a `lien` that confirms what the figure contradicts. An `incertain` element is never a faux lu (it lowers the precision);
- **pièges**: an expected element carries `piege: "<name>"`; a piège is found when all its elements are juste (`✓ nom : 1/1`);
- **tokens par page**: the `usage: { tokens }` of the reading divided by the `pages` of the expected document, for the cases that
  have one; without `usage`, « non mesurés » (`null` in `--json`), never a zero.

```
$ cadence ref eval evals/ref/corpus lectures/
7 cas · 48 éléments attendus · 46 lus
rappel : 91.7 % (44/48) · précision : 95.7 % (44/46)
faux lu : 2.2 % (1/45 sûrs)
tokens par page : non mesurés
```

A reading whose `document.slug` or `document.sha256` differs from the expected one is refused (never a measure over two versions
mixed). Exit codes: **0** done, **2** refusal (wrong call, file absent or unreadable, invalid reading, other document, folder with
no `attendu.json`). `--json` prints one object: `total`, `types`, `pieges`, `tokens`, `cas`.

## `cadence ref corpus <dossier> [--sans-rendu]`

Writes the **synthetic corpus with a known truth** that `ref eval` scores against (design §« Évaluation »): seven small documents,
one per trap taken from a real defect, each with the inventory that is true of what is drawn.

| Case (= trap) | What it draws | Expected `piege` element |
|---|---|---|
| `texte-ambigu-leve-par-figure` | « written beside the arrow » (head or tail?), the figure puts `120 KT` over the tail | `lien` `precise` |
| `figure-contredit-texte` | text says 80 kt, the figure draws the threshold at 100 kt | `lien` `contredit` |
| `table-en-image` | a code table rasterised at render time: its cells are not in the PDF text layer | `table` |
| `gabarit-type-bufr` | BUFR section 1: ordered fields, mandatory or optional, format, bounds | `gabarit` |
| `controle-translucide` | a white button at 25 % opacity on a striped gradient, next to an opaque one | `jeton` `opacite` |
| `page-proposal` | page 1 requirements, page 2 a panel mock-up carrying a « Proposal » badge | `statut` |
| `scan-bruite` | a station sheet rasterised, grainy and blurred: the PDF has no text layer, expected texts are `ocr` | `texte` (`ocr`) |

Each case folder holds `document.html` (one 8.5×11 in `section.page` per page, deterministic), `attendu.json` (an inventory that
passes `ref check`, slug `corpus-<case>`, `sha256` of the HTML, `pages`, zones in pixels at 200 dpi, `piege` on the trap elements), and,
unless `--sans-rendu`, `document.pdf` and `page-<n>.png` (1700×2200, 200 dpi) written by **Playwright** (Chromium). Texts of a table,
a template or a schema belong to it and are not listed as `texte`; labels of a figure are. Playwright is not a dependency of cadence:
install it (`npm i -D playwright`, `npx playwright install chromium`) or point `CADENCE_PLAYWRIGHT` to the folder of the package;
without it the command exits **2** and writes nothing (`--sans-rendu` still writes HTML and expected files). An existing folder is
refused (exit 2). The corpus is written where you say, not in `evals/`, which `claude plugin eval` reads as case folders.

```
$ cadence ref corpus tmp/corpus-ref
$ cadence ref eval tmp/corpus-ref lectures/     # lectures/<case>/lecture.json
```
