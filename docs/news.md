[← cadence](../README.md)

# news

What changed *for the user*, one entry per visible lot, each with a screenshot.

- Mark a lot as user-facing with `raf add … --visible` (or `visible: true` in
  the YAML). `raf done` and the post-commit hook remind you to write its entry;
  `raf check` fails while a visible lot is done without one.
- An entry is a Markdown file in `docs/nouveautes/`, with a YAML header.
  Screenshots are files you take yourself, stored next to the entries.
- `cadence news build` writes `nouveautes.json` for your app to display, a
  self-contained `index.html`, and copies the screenshots.

```sh
raf add "Amounts like 3.000 read as three thousand" --visible   # → L8
raf start L8 && git commit -m "fix(L8): thousands separator" && raf done L8
cadence news new L8          # docs/nouveautes/2026-09-29-amounts-like-3-000-….md (title: the lot's public title if any)
# add docs/nouveautes/captures/l8.png, list it under `captures:`, write the text
cadence news check           # exit 1 on drift (also part of raf check)
cadence news build -o frontend/public/nouveautes
```

```markdown
---
title: Amounts like 3.000 read as three thousand
date: 2026-09-29
created: 2026-09-29T14:32+02:00
lots: [L8]
captures: [captures/l8.png]
# nocapture: reason, when a screenshot makes no sense
---
Imported statements now read **3.000** as three thousand, not three.
```

A screenshot can say what it shows: write it as `{ file, alt }` instead of a
bare path, one text per screenshot.

```yaml
captures:
  - { file: captures/l8-before.png, alt: "Statement total read as 3 instead of 3,000" }
  - captures/l8-after.png          # a bare path still works: no alternative text
```

| Command | Effect |
|---|---|
| `cadence news new <lot…> [--title t]` | entry skeleton, dated and timed now (`date`, `created`), titled after the lot's public title (`public`), else its title; `--title` wins |
| `cadence news list` | entries, newest first (see *Order* below) |
| `cadence news check` | visible lots done without entry, unknown lots, missing or undeclared screenshots, entries without creation time, bad headers, a lot whose screen sheet has hypotheses and whose entry lacks the `## Hypothèses` section (or a line for one of them) |
| `cadence news stamp` | migration: writes `created:` into entries without one (or with an empty one), from the author date of the commit that added the file under its current name (now if not committed yet) |
| `cadence news build [-o dir]` | `nouveautes.json` + `index.html` + screenshots (default `docs/nouveautes/site`) |

`--dir` changes the entries folder (default `docs/nouveautes` at the git root).
The Markdown is deliberately small: headings (`#` to `######`, rendered one level lower, `<h2>` to `<h6>`; a heading takes its own line and cuts the paragraph or list around it), paragraphs, `-` lists (a bullet may continue on the next lines, indented), `**bold**`,
`` `code` ``, `[links](../url)`; everything else is escaped text. The JSON holds
`{ project, generated, entries: [{ slug, title, date, lots, captures, html }] }`,
with screenshot paths relative to the JSON file. `captures` is always a list of
paths; an entry that gives at least one alternative text also carries `alts`,
the texts in the same order (`""` for a screenshot without one) — an entry
without any keeps exactly the shape above. The built page puts the text in the
image's `alt`, and falls back to "Capture : <title>".

**Order.** Everywhere (`list`, `build`, the JSON), entries are strictly newest
first: by `date`, then, on the same day, by creation time. Every entry carries
it to the minute in its `created` header, which `cadence news new` writes as
local time with an explicit offset (`2026-09-29T14:32+02:00`, or `Z`). The
offset is required, so the order does not depend on the machine's time zone:
`news check` (and `raf check`) flags a value without it, an impossible one, an
empty `created:`, and an entry without `created`. `cadence news stamp` fills
it in older entries (or replaces an empty one) from the author date of the
commit that added the file under its current name; until then, that date is
used for sorting (an entry not committed yet counts as the newest). Renames
are not followed: a renamed entry counts as added on the day of the rename,
so stamp it before renaming it. The file name only breaks the remaining ties,
since it follows the title, not the chronology. The page and the JSON still
show the day only.

## UX review

```sh
raf ux enable                      # from today, a --visible lot needs a UX review before done
raf ux L4 "compliant after 2 fixes"   # record the verdict (from the ux-reviewer agent)
raf ux L8 "no screen: calculation fix"
```

With the rule on, `raf done` refuses a visible lot without a review (`--force`
to override) and `raf check` reports visible lots finished after the `uxSince`
day without one. An empty verdict is refused, and one left empty or blank by hand
in the YAML counts as no review. Plans without `uxSince` are not affected.

## Code review

```sh
raf review enable                  # from today, a lot with commits needs a code review before done
raf commits L4                     # what there is to review: the commits the gate counts for the lot
raf review L4 "compliant after 2 fixes"   # record the verdict (from the code-reviewer agent)
```

The counterpart of the UX review, off by default. With the rule on, `raf done`
refuses a lot that has at least one commit citing it and no recorded verdict
(`--force` to override), and `raf check` reports such lots finished after the
`reviewSince` day. A lot with no commit has nothing to review; neither does a
lot whose only commits touch plan files alone (the plan, a file listed under
`plan.files`, or the QA expectations file), are version commits (see [Releasing](releasing.md#releasing)), predate the plan's `since` or match an `ignore:` pattern — `raf commits <id>` prints exactly the counted set.

The verdict is tied to what was reviewed: `raf review` stores it on the lot with
the sha of the lot's latest counted commit (`review: { date, verdict, commit }`,
`commit: null` when the lot had none). A counted commit made after that one
makes the review stale: `raf done` refuses (`--force` to override), and
`raf check` reports a finished lot, until the lot is reviewed again and
`raf review` is rerun. A verdict
written by hand without a `commit` field is not checked for staleness. An empty
verdict is refused, and one left empty or blank by hand in the YAML counts as no
review. Plans without `reviewSince` are not affected.

A lot that works in neighbouring repositories (`repos:`, see [orchestrate](orchestrate.md#a-lot-whose-work-is-in-a-neighbouring-repository))
has its verdict tied to each of them: `raf review` also stores, under `repos`, the sha of the latest counted commit of the
lot in each neighbour (the one `raf commits` lists last: it cites the lot, falls within the lot's period and contains the `cite:` string if any) (`review: { date, verdict, commit, repos: { ../aetherwx-gitops: <sha> } }`, `null` when a
neighbour has none), and refuses to record when a listed repository cannot be read. `raf check` does not audit the
neighbours: their staleness is not checked, only the project's own commits are.

## Documentation that follows the code

A stale README misleads. `cadence.yaml` can declare which documents must follow which code:

```yaml
docs:
  sync:
    - paths: [src/**, bin/*.js]        # what changes…
      docs: [README.md, docs/usage.md]  # …must change one of these, in the same lot
    - paths: [templates/]
      docs: [CLAUDE.md]
    - paths: [frontend/src/**, '!**/*.test.tsx']   # a pattern starting with ! leaves files out
      docs: [README.md]
  since: 2026-10-09                    # optional: also audit lots finished on or after this day
```

A pattern is an exact path, with `*` (inside a folder), `**` (across folders), `?`, or a trailing `/` for
a whole folder. `raf check` takes the **work commits** of every lot in progress (plan-only commits and
version commits do not count — so a "What's new" line written in the version commit is not documentation; a lot finished on or after `docs.since` is audited too) and, for each pair, reports the lot when
those commits touch `paths` without any of them touching a file of `docs`:

```
✗ L7 : documentation en retard — src/a.ts, src/b.ts sans toucher README.md ou docs/usage.md (docs.sync)
```

It counts as drift: exit code 1, shown in the `dérive` column of `cadence lead tour`, and the review
brief of `cadence orchestrate` (`review` and `review-small`) carries the list the program computed,
to be reported as one **major** finding per line — a stale document is not left to the reviewer's
memory of a sentence. Touching a document is what the program checks; whether its text is true is
still the review's reading. The commits of neighbouring repositories (`repos:`) are not audited.

### The librarian: `doc-keeper`

`docs.sync` says *that* a document is behind; the `doc-keeper` agent (L306, `agents/doc-keeper.md`, generic: it knows no
folder and no project) says *which* passage and writes it. Given a repository and a lot, it reads the diff of the lot
(the commits that cite it), draws the map of the project's documents (the `docs.sync` rules, the README, the pages of
`docs/`, the CHANGELOG, the news entries, the architecture document), lists the documents the change makes false or leaves
out, then:

- **writing session**: updates them and commits with explicit paths and `docs(<lot>): …`;
- **read-only session** (no write tool, or a brief that says so): changes nothing and lists, document by document, the
  passage to write.

`cadence orchestrate` calls it by itself when `docs.sync` reports a document behind the commits of the lot, **before the
review** (see « Librarian before the review » in [orchestrate](orchestrate.md)); the lead calls it by hand otherwise
([lead](lead.md)).

A document **outside the repository** is the librarian's only when the configuration names it, with the key that already
names the project's article elsewhere, `docs.articles` (see below; absent by default): « this project is also described
by this file of that repository ». The librarian reads that file (its repository is opened to the session for reading, and
the brief gives its absolute path) and, when the change makes it false, **proposes a lot** for the plan of that repository
(a title, then the file, the passage and the sentence to change) in the `resume` of its report, starting with
« lot proposé ». It never edits that file and never writes to that plan: the lead decides whether the lot enters it.

### An article elsewhere that follows the delivery

A case study that lives in a neighbouring repository (the project's article on a showcase site) goes stale
the same way. `docs.articles` names it (`repo` absolute, or relative to the project):

```yaml
docs:
  articles:
    - repo: ../claude-code-codex          # neighbouring repository, relative to the project
      file: src/pages/cas/demo.md         # the article in it
      name: demo                          # optional: the name in the lot title (default: the plan's project)
```

After a **green** `cadence deliver`, for the lots it lists as delivered **that have a public title** (`public:`, or
the title of their Nouveautés entry), cadence opens in this repository's plan the lot
`Article demo à rafraîchir` (todo, estimate 0.5, `repos: [{ path: ../claude-code-codex, cite: demo }]`), with a note
that quotes the delivery, the public titles delivered, the article and the **sections to read again**: the headings
(`#` lines, or `<h1>`…`<h6>` of an Astro page) that share a word of five letters or more with a delivered title,
else all the `##` headings. The lot is then played like any other, in an ordinary wave (`cadence orchestrate`: an
implementer rewrites the article in the neighbouring repository, the review checks it against the note). If a lot
of that title is still open, it receives a note instead of a duplicate. Two entries with the same name (the same
project told in two neighbouring repositories) share one lot, which declares both repositories in `repos:`. Internal lots (no public title) open nothing;
a red delivery opens nothing; `cadence deliver --dry-run` announces the articles. The plan is written but **not
committed** (`deliver` never commits): the line `article à rafraîchir : L9 …` says so. With a plan kept by another
tool (read-only), the same line carries the instruction to open the lot with that tool. This replaces the manual
`sync-site-docs` skill.

## QA review

No gate and no command here: the QA review comes **after** a delivery, and
`raf done` does not wait for it. It follows any delivery that changes what a
page shows or what it is served (screen, API, data source, configuration of
either) — in practice every delivery except docs-, plan- or tests-only ones: a
backend-only lot can empty a page without touching a screen, and the agent then
walks the pages that call the changed endpoints. It also walks the pages that consume the services the lot changed; when the diff changes no route and no screen, or cannot be linked to pages, it walks every page and says so. The `qa-reviewer` agent
opens each page of the running app in a real browser and judges it from the
user's side. A page can be empty while everything else is green — no code
changed, a data source went down upstream, the unit tests replace the network,
`/api/health` answers ok, and the "nothing found" on screen is the message the
code was written to show.

The agent cannot tell such an empty state from a normal one by itself: the
project says what each page must show, in `docs/qa/expectations.md` — one
`## <route>` section per page, three kinds of lines:

```markdown
# QA expectations

## *
- shows: the header and the navigation links
- never: "Loading failed", "Too Many Requests"
- api: /api/live/current — may be empty when no match is within 24 hours

## /players
- shows: the squad of the last match — at least 11 players
- shows: the season statistics table, 8 columns — 1440 only
- never: "No recent line-up found"
- api: /api/squad/last — a non-empty list

## /fixtures/:id   (the first match linked from /fixtures)
- shows: both team names, the date, the score once the match is played
- never: "Unknown match"
- api: /api/fixtures/:id
```

- `shows:` — content that must be present and non-empty, with a count where one exists;
- `never:` — texts that must not appear: error messages, and empty-state messages that mean
  missing data;
- `api:` — the calls the page depends on: each must answer 2xx with a non-empty body (a 200 with
  `[]`, `{}` or `null` is a failure, unless its line says `may be empty when …`).

An optional `## *` section holds what every page must show, never show and call. A line may end
with a condition in plain words, which the agent honours: `may be empty when …`, `1440 only`,
`390 only` (a line without a width holds at both). Content hidden on the phone by design is not a
defect unless a `shows:` line requires it at 390; content pushed outside the visible area (it
needs a sideways scroll) is reported as suspect and handed to `ux-reviewer` in one line.

The rest is free text, written for a reader: a line can be repeated, and a route with a parameter
names a real value to visit or says where to find one. The file can live elsewhere:

```yaml
# cadence.yaml
qa:
  expectations: docs/quality/pages.md
```

The agent reads that key, and so does `raf check`: a commit touching only that file is plan upkeep (no lot to cite, see above). Without an expectations file the agent walks
the routes it discovers and still runs its universal checks: an error shown, a failed API call
whose content is missing on screen, a broken or missing content image are defects with or without a
file; an empty 2xx body, like whatever else would need an expectation to judge, is suspect at most
(it may be a normal absence). For a route with a
parameter, it finds a real value in the app's links or its API responses and says how it built the
URL. The agent then returns a draft for you to correct — it never writes the file itself.
