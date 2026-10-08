# cadence

A small working method that lives in your repository. Solo developers and
AI-assisted sessions lose track of *what is left to do* and *what each commit
was for*; cadence keeps both in plain files next to the code.

Four tools:

- **raf** (French *reste à faire*, "what is left to do"): the plan, linked to your commits;
- **news**: a user-facing changelog with screenshots, tied to the plan;
- **session**: the facts to start and to close a work session;
- **deliver**: wait for the CI of the pushed commit, deploy, then **verify the effect**.

And four [Claude Code](https://claude.com/claude-code) skills that turn them
into rituals — `session-start`, `session-close`, `deliver`, and `lead` to pilot
several projects through subagents — plus three reviewer agents: `ux-reviewer`
(no user-facing change is done before its usability review) and `code-reviewer`
(no lot with commits is done before its code review), each behind an opt-in
gate, and `qa-reviewer`, which walks the delivered app in a real browser and
reports a page left empty or in error.

And a second plugin, [`cadence-hud`](#cadence-hud): a status band above the Claude
Code prompt that shows the session's context, quota, cost and the orchestrate waves running.

## What's new

**0.13.1**: `cadence-hud` takes back the segments that fit once a big one has dropped (reset times, then the per-model consumption, now short: `opus 1.2M sonnet 800k`); `CADENCE_HUD_AMBIGUOUS=1` for a terminal that draws `▰ ▱ ⚙ │ ↻` in one cell. **0.13.0**: `cadence orchestrate --status --watch` (a wave's table redrawn in the terminal, which
stops with the wave) and the lead skill that names the wave and follows its journal; lot ids with `/`
(sub-tasks of a read-only plan) accepted by `orchestrate`; `cadence-hud`'s first line measured in
terminal cells and kept to ASCII; `publish.yml` on the v5 actions. **0.12.0**: the `cadence-hud` plugin (a status band above the Claude Code prompt),
`raf ignore` to acknowledge a commit without a lot, waves that size the review to the lot,
hand back a lot whose deliverable is already there and start the app themselves for the UX
review (`orchestrate.ux`), and briefs that require the README to follow the change. **0.11.0**: waves on different repositories run side by side under a shared cap of
simultaneous sessions (`--max-sessions`, 2 by default), and every release now has its
changelog section and GitHub release. **0.10.1**: the QA expectations file (`docs/qa/expectations.md`) is kept with the plan —
a commit that only touches it no longer has to cite a lot. **0.10.0**: `cadence orchestrate`
sends an already-committed lot straight to review, and sessions only ask questions that
name what they would change.

Every version, with what it brings and since when: [CHANGELOG.md](CHANGELOG.md).

## raf

- The plan is a YAML file in the repo (`docs/plan/raf.yaml`), edited by the CLI.
  Your comments and hand edits are preserved.
- A commit belongs to a lot when its message cites the id: `feat(L3): …`,
  `fix: L3/t1 …`. The link is **computed from `git log`**, never stored, so
  committing never dirties the plan. The id is read as a whole word: `XL3`,
  `L3x` and `L3.4` do not cite `L3`, while `L3.` at the end of a sentence does.
  When the subject has a scope that cites lots (`feat(L3): …`,
  `chore(L31,L32): …`), **the scope alone decides**: a passing mention
  (`page équipe (L27)`), a range (`L28–L31`, `L45 à L48`) or the body does not
  count. Without a scope citing a lot, the whole message is read as before.
- `raf check` audits drift between the plan and the history.
- Plan upkeep needs no lot. A commit is plan upkeep when **every file it
  touches is a plan file**: the plan itself, its Gantt page (only at its default place, `gantt.html` next to the plan — written elsewhere with `raf gantt -o`, declare it under `plan.files`), the `plan:` key of the config file in use (`cadence.yaml`, or
  the `--config` file; a change to `deliver:`/`session:` is work), or a file the
  project lists under `plan.files` in `cadence.yaml` (a page it generates from
  the plan, a journal), or the QA expectations file (`docs/qa/expectations.md`,
  or the file named by `qa.expectations`; the lead commits the `qa-reviewer`'s draft of it). Such a commit is never a "commit without a lot", and it
  does not count as work on the lots it cites: it is absent from `raf commits`,
  does not start a `todo` lot, does not make a code review stale, and
  `cadence deliver` does not announce the lots it cites as delivered. The files
  decide, never the subject: a `chore(plan): …` commit that touches a source
  file is a commit like any other.
- `raf gantt` writes a single self-contained HTML page (no server, no CDN).

```sh
npm install -g @sylad/cadence    # or: npx -p @sylad/cadence raf …

raf init                          # docs/plan/raf.yaml + post-commit hook + .playwright-mcp/ in .gitignore
raf add "Monthly dedup on merge" --estimate 2
raf add "Typo in footer" --quickwin
raf add "Loan cache" --after L1
raf add "write the migration" --parent L1     # → L1/t1
raf start L1
git commit -m "feat(L1): dedup by calendar month"
raf now                           # in progress, next up (quickwins first), recently done
raf done L1/t1 && raf done L1
raf check                         # exit 1 on drift
raf gantt                         # docs/plan/gantt.html
```

### Commands

| Command | Effect |
|---|---|
| `raf init [--project name] [--prefix L] [--no-hook]` | create the plan, install the hook, add `.playwright-mcp/` to `.gitignore` |
| `raf add "title" [--estimate d] [--quickwin] [--visible] [--public "title"] [--after L2,L4] [--parent L3]` | add a lot or a sub-task, print its id (`--public`: the lot's title in the public's words, written as `public:` right after `title:`) |
| `raf add "title" --every <days>` · `raf did <id> ["text"]` | recurring lot: `every` (days) and `last` (last time done) fields; the lot stays `todo`, `raf now` and `session start` list it under « Récurrent » with « dû depuis N j » / « prochain dans N j »; `raf did` resets the count (spec: `docs/superpowers/specs/2026-10-04-L11-tache-recurrente.md`) |
| `raf public <id> "title"` · `raf public <id> --clear` | set, replace or remove the public title of a lot |
| `raf start <id>` · `raf done <id> [--force]` · `raf drop <id> [--reason text]` | dated transitions (`done` refuses open sub-tasks unless `--force`) |
| `raf note <id> "text"` | dated note — keep decisions next to the work |
| `raf show <id> [--notes]` | one lot: status, dates, `after`, public title, dated notes in order, then the counted commits (as `raf commits`); `--notes` prints the notes alone |
| `raf commits <id>` | the commits counted for a lot (the set the code review gate uses), one `<sha> <subject>` per line, oldest first |
| `raf now` | what to do next |
| `raf list [--status s]` | flat list |
| `raf ignore <sha> \| "exact subject" [--reason text]` | acknowledge a commit without a lot (tooling chore, a plan commit citing an unknown id) without rewriting history: a dated, reasoned line in the plan's `acknowledged:` section; a sha is exact, a subject covers every commit carrying it |
| `raf check --ignored` | list the acknowledged commits with their date and reason |
| `raf check [--since date] [--idle 7]` | since the plan's adoption date by default (a visible lot without a public title is only a `⚠` warning: it never changes the exit code): commits without a lot (commits touching only plan files are exempt), unknown ids, `todo` lots that already have commits, idle lots, `done` lots with open sub-tasks, bad or circular dependencies |
| `raf gantt [-o file]` | standalone Gantt page |
| `raf hook install` | add the (non-blocking, read-only) post-commit hook |

Global options: `--file path` or `RAF_FILE`; `RAF_TODAY=YYYY-MM-DD` to freeze
the date. `cadence raf …` is the same as `raf …`.

### Plan file

```yaml
version: 1
project: my-app
prefix: L
since: 2026-09-28     # commits before this date are not audited
ignore: ['^chore\(batch\):']   # optional: subjects of automated commits, neither audited nor counted for a lot
lots:
  - id: L1
    title: Monthly dedup on merge
    status: doing        # todo | doing | done | dropped
    estimate: 2          # working days
    quickwin: false
    visible: true        # user-facing: a news entry is expected when done
    after: [L0]
    created: 2026-09-28
    started: 2026-09-29
    notes:
      - { date: 2026-09-29, text: "keep the bank line when both sources exist" }
    tasks:
      - { id: t1, title: write the migration, status: done }
```

### A plan elsewhere, or in another format

`cadence.yaml`, at the repository root, can say where the plan is. The short form keeps raf's own
format, and the plan stays writable:

```yaml
plan: planning/todo.yaml
```

A project that publishes its plan (a JSON generated from it and committed with it)
declares that file, so a commit touching only the plan and its published copy is
plan upkeep; the plan keeps raf's format and stays writable:

```yaml
plan:
  files: [frontend/public/plan-data/plan.json]
```

Until the file is declared, such a commit is reported as a "commit without a
lot" when it cites none, and counts as work on the lots it cites.

A project that already keeps its plan with its own tool is read **without migrating it**: describe
the file, and `raf now`, `raf list`, `raf commits`, `raf check`, `raf gantt` and
`cadence session start|close` work on it. Such a plan is **read-only** —
`raf add|start|done|note|ux|review` refuse and leave the file to the project's tool, and the two
review gates do not apply to it (a `uxSince` or `reviewSince` written in it is ignored).

```yaml
plan:
  path: docs/plan/taches.yaml
  project: my-app               # what the file does not say itself: project, since, ignore
  since: 2026-10-02
  ignore: ['^plan: ']
  files: [docs/plan/journal.ndjson]   # kept with the plan: a commit touching only these is a plan commit
  lots: taches                  # root key holding the list (default: lots)
  fields:                       # raf field: key in the file (a list = first one present)
    title: titre
    public: titre_public        # the lot's title for the public; read when it is text, else ignored
    status: etat
    estimate: effort
    created: cree_le
    started: demarre_le
    finished: [livre_le, ferme_le]
    notes: note
    parent: parent
  statuses:                     # raf status: their states
    todo: [prevu, specifie]
    doing: [en_cours, teste]
    done: [deploye, valide]
    dropped: caduc
  estimates: { S: 0.5, M: 1, L: 3 }   # their effort labels, in working days
```

- Fields: `id`, `title`, `status`, `estimate`, `quickwin`, `visible`, `public`, `every`, `last`, `after`, `created`, `started`,
  `finished`, `notes`, `parent`; one left out is read under its own name. A timestamp counts for
  its day; a note written as plain text is one note.
- `parent`: an entry `B33/t1-fusion` whose parent is `B33` becomes the sub-task `t1-fusion` of `B33`.
- Ids need no prefix: a commit belongs to a lot when its message cites one of the plan's ids as a
  whole word (`E-A2`, `NC2.4`, `B33/t1-fusion`).
  An id that is not in the plan cannot be told from ordinary text: such a commit counts as
  "without a lot", never as an unknown reference.
- A state missing from `statuses`, or an effort label missing from `estimates`, is reported by
  `raf check`.

### Gantt scheduling

One lane of work. Finished lots use their real dates (or their commits' dates);
lots in progress run until `max(start + estimate, today)`; lots to do follow in
file order, after their dependencies, on working days.

## news

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
| `cadence news check` | visible lots done without entry, unknown lots, missing or undeclared screenshots, entries without creation time, bad headers |
| `cadence news stamp` | migration: writes `created:` into entries without one (or with an empty one), from the author date of the commit that added the file under its current name (now if not committed yet) |
| `cadence news build [-o dir]` | `nouveautes.json` + `index.html` + screenshots (default `docs/nouveautes/site`) |

`--dir` changes the entries folder (default `docs/nouveautes` at the git root).
The Markdown is deliberately small: paragraphs, `-` lists, `**bold**`,
`` `code` ``, `[links](url)`; everything else is escaped text. The JSON holds
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

### UX review

```sh
raf ux enable                      # from today, a --visible lot needs a UX review before done
raf ux L4 "compliant after 2 fixes"   # record the verdict (from the ux-reviewer agent)
raf ux L8 "no screen: calculation fix"
```

With the rule on, `raf done` refuses a visible lot without a review (`--force`
to override) and `raf check` reports visible lots finished after the `uxSince`
day without one. An empty verdict is refused, and one left empty or blank by hand
in the YAML counts as no review. Plans without `uxSince` are not affected.

### Code review

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
`plan.files`, or the QA expectations file), predate the plan's `since` or match an `ignore:` pattern — `raf commits <id>` prints exactly the counted set.

The verdict is tied to what was reviewed: `raf review` stores it on the lot with
the sha of the lot's latest counted commit (`review: { date, verdict, commit }`,
`commit: null` when the lot had none). A counted commit made after that one
makes the review stale: `raf done` refuses (`--force` to override), and
`raf check` reports a finished lot, until the lot is reviewed again and
`raf review` is rerun. A verdict
written by hand without a `commit` field is not checked for staleness. An empty
verdict is refused, and one left empty or blank by hand in the YAML counts as no
review. Plans without `reviewSince` are not affected.

### QA review

No gate and no command here: the QA review comes **after** a delivery, and
`raf done` does not wait for it. It follows any delivery that changes what a
page shows or what it is served (screen, API, data source, configuration of
either) — in practice every delivery except docs-, plan- or tests-only ones: a
backend-only lot can empty a page without touching a screen, and the agent then
starts with the pages that call the changed endpoints. The `qa-reviewer` agent
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

## session

```sh
cadence session start              # notes from the last close, lots in progress (silent ones flagged),
                                   # work done since yesterday by lot, drift, repo state, 3 proposals
cadence session start --since "3 days ago" --idle 2
cadence session close              # today's commits by lot, commits without a lot, lots in progress
                                   # with no commit today, drift, uncommitted / unpushed work
                                   # exit 1 while something is still open
cadence session next "finish L3" "review L4"    # shown by the next session start; replaces the previous notes
cadence session next --clear       # erase those notes, on purpose
```

`cadence session next` without a line refuses (exit 2) and leaves the notes of the
last close as they are — it used to erase them silently; erasing is `--clear`.

Proposals come from the plan only: lots in progress, then ready lots (dependencies
done), quick wins first. Local state lives in the git directory, never committed:
the close notes per worktree, the delivery lock and log in `.git/cadence/`, shared
by all the worktrees of a clone.

A project that already has its own morning and evening scripts keeps them: name
them in `cadence.yaml` and their output is added to the report, under "Faits
propres au projet", before the proposals (start) or the verdict (close).

```yaml
session:
  start: ./scripts/morning.sh "$CADENCE_SINCE"    # sh, at the repo root, 120 s at most
  close: ./scripts/evening.sh "$CADENCE_SINCE"
```

```yaml
session:
  clean: [ "~/projects/tmp/*", "tmp/*", "test-output-*" ]   # working files to propose for removal at close
  cleanDays: 7                                              # older than this many days (default 7)
```

`cadence session close` then lists, under "Nettoyage proposé", the entries matching these
patterns (`*` stands for part of a name and never crosses a `/`; `~` is the home folder, a
relative pattern starts at the repo root) that were not modified for more than `cleanDays`
days, oldest first — a folder's age is that of the most recent entry it contains, at any depth,
and an entry's age runs from the later of its modification time and its status-change time (ctime):
what `tar xf`, `cp -a` or `rsync -a` just brought in with an old modification time is not old.

An entry is proposed only if it could be measured entirely. Never proposed:

- a git repository, a folder that contains one at any depth, and anything under a `.git` folder;
- a git directory without a `.git` entry — a bare repository (`git init --bare`, `git clone
  --mirror`, `backup.git/`), a `--separate-git-dir`, a worktree's admin folder —, recognised by
  its content as git does (`HEAD` with `objects` and `refs`, or `HEAD` with `commondir`): neither
  it, nor anything inside it, nor a folder that contains one;
- anything `git` tracks, in any repository that has a `.git` entry above it. One limit, stated
  plainly: a bare repository driven with an external work tree (`git --git-dir=~/.dotfiles
  --work-tree=~`) leaves no `.git` beside the files, so its tracked files cannot be recognised and
  can be proposed — never point a pattern at such a work tree;
- a name starting with `.` unless the pattern itself starts that name with `.` (as in the
  shell, `tmp/*` does not match `tmp/.env`; `tmp/.cache-*` does);
- anything reached through a symbolic link matched by a `*` segment: unlike the shell, the walk
  never descends into such a link (`tmp/*/*` lists nothing behind `tmp/link → ../outside`), and a
  folder's age never looks behind a link; the link itself can be proposed, as a link — removing it
  leaves its target alone. Only segments written in full *before* the first `*` follow a link, as
  `cd` would (`~/shared/*` with `~/shared` a link lists the target's entries); once a `*` has been
  crossed no link is followed any more, even on a segment written in full (`tmp/*/out/*` with
  `tmp/run1/out → /elsewhere` lists nothing behind `out`);
- anything that could not be read entirely: a folder that cannot be listed — nor anything
  inside it, even named in full —, an entry that cannot be examined or vanished during the
  walk, an entry under a `.git` that `git` could not answer for. These are listed apart,
  under "Nettoyage : N élément(s) illisible(s), jamais proposé(s)";
- the repository itself, or a folder that contains it.

The command deletes nothing, never fails on the cleanup and does not change the exit code: the
`session-close` skill shows the list and removes the entries only after the human agrees.

The commands get `CADENCE_SINCE` (the `--since` in effect) and `CADENCE_TODAY`. They
add facts and decide nothing: a failing command is reported and changes neither
the exit code nor the verdict.

## lead tour

`cadence lead tour [folder] [--idle 3] [--json]` is the lead's morning table, with no model in
the loop. From a parent folder (default: the current one) it takes every direct sub-folder that
holds `docs/plan/raf.yaml`, or a `cadence.yaml` with a `plan:` key (a plan kept by another tool
included), and for each one reads the same facts as `cadence session start` — in-process, no
sub-process, no call to `claude` — then prints **one line per project**:

```
alpha · en cours L1 (silencieux 4j) · dérive 1 (✗ L2 a 1 commit(s) mais est encore todo) · notes : finir L1 puis livrer · prochain L3 Typo · dépôt non commité, non poussé
beta · en cours rien · dérive aucune · notes : aucune · prochain T2 Second · dépôt propre
```

| Column | Content |
|---|---|
| `en cours` | ids of the lots in progress; `(aucune activité)` when it has none at all, `(silencieux Nj)` when the lot's last activity (commit, note or start) is more than `--idle` days old (default 3) |
| `dérive` | the gaps `raf check` reports, counted and the first two shown |
| `notes` | the notes left by the last `session close`, joined with ` / ` and cut at 120 characters |
| `prochain` | the first ready lot (quick wins first) — id and title cut at 60 characters |
| `dépôt` | `non commité` (modified or untracked files), `non poussé` (commits ahead of the upstream), `livraison en cours` (live delivery lock); `propre` otherwise |

`--json` prints the same content as an array of objects (`project`, `doing`, `drift`, `notes`,
`next`, `repo`, and `error` when the project could not be read). The tour is read-only: it changes
no plan. It exits 0 even when a project is in error — that project's line reads
`beta · ✗ erreur : <cause>`. The `lead` skill runs it instead of one subagent per project.

## deliver

A delivery is done when its checks pass, not when a tool says "success".

```yaml
# cadence.yaml, at the repository root
deliver:
  ci: github              # github | none | { command: "…" }   (default: none)
  ciTimeout: 1800         # seconds
  deploy:                 # sh commands, in order, at the repo root
    - ./scripts/deploy.sh "$CADENCE_SHORT"
  verify:                 # at least one; retried every 10 s until verifyTimeout
    - url: https://app.example.com/api/health
      status: 200         # default 200
    - url: https://app.example.com/version.txt
      contains: "${SHORT}"
    - command: kubectl rollout status deploy/app --timeout=60s
  verifyTimeout: 300
  deployTimeout: 1800     # seconds, per deploy command
```

A public title (`public:`) longer than the site's Plan page accepts fails its build. Declare the limit
in `cadence.yaml` and it is caught before the push:

```yaml
news:
  publicTitleMax: 80      # characters; without the key, `raf check` warns at 80 in a project that has a news directory
```

`raf check` also warns (`⚠`, not an error: exit code 0 if nothing else is wrong) about every visible lot, dropped ones excepted, that has no public title: the site would show its technical title (a done lot cited by a News entry is spared: the site reuses that entry's title). Fix it with `raf public <id> "…"`. On a plan kept by another tool (read-only), the warning only applies if `plan.fields` maps a `public` field, or if some lot already carries a literal `public:` key (a field left out is read under its own name): without either there is no public title to set, so it would come back at every session.

With the key, `raf public`, `raf add --public`, `raf done` (on a lot whose public title is too long) and
`cadence news new` (its title) refuse above it; without it, only `raf check` warns.

```sh
cadence deliver --dry-run    # preconditions, then the resolved steps; nothing runs
cadence deliver              # 0 delivered and verified · 1 a step failed · 2 refused before acting
```

- **Preconditions**: no modified tracked file; `HEAD` is on a remote branch (the
  CI can only build what was pushed); no other delivery running (a lock whose
  process died is removed with a warning); with `ci: github`, `gh` installed and
  logged in.
- Every command is killed when it exceeds its budget (CI, `deployTimeout`, what is
  left of `verifyTimeout`) and reported as "délai dépassé". Killed means the
  whole tree, followed while the command runs: every 200 ms cadence lists the
  command's descendants and remembers each process it has seen with its start
  time, so a process whose parent exits (re-parented to init — a background
  child of a script, `sh`'s fork for each command) stays known. To kill, cadence
  takes every remembered process still alive with the same start time (never a
  recycled pid) plus all its current descendants, stops each one first
  (`SIGSTOP`, the tree is re-read until nothing new appears), then kills them
  (`SIGKILL`). This happens on a delay overrun, and at once when cadence
  receives `SIGTERM`. On Ctrl-C or a hangup the tree has already received the
  signal from the terminal: cadence gives the whole followed set, not just the
  command, up to 2 seconds to finish (a script's `trap`, git removing its
  `index.lock`), carries on the moment none of it is alive, and kills what is
  left after the 2 seconds, a background child that ignores Ctrl-C included. If
  the command was never listed (process list unreadable from the start), the
  grace lasts as long as the command itself is alive, and what remains after
  2 seconds is killed through the same fallback (the command itself only). The
  same fallback applies when the process list fails while the command runs and
  is still failing when the kill comes (the last listing is not trusted after
  1 second): only the command is killed, its descendants survive, and cadence
  says so once on stderr.
  A delay overrun and `SIGTERM` give no grace: a script's own `trap` does not
  get to finish there. The lock is held until the followed set is empty: when
  cadence dies of the signal it dies after the tree, and its stale lock, which
  the next delivery removes, leaves nothing of the first delivery running.
  What can still outlive cadence and run concurrently with the next delivery:
  a process that leaves the tree before cadence first sees it (a daemon's
  double fork, `setsid`, `nohup … &` from a shell that exits, all within less
  than 200 ms), a process of another user that cadence may not signal (`sudo`),
  a background process still running when the command returns normally (it is
  neither waited for nor killed), and everything if cadence itself is killed
  with `SIGKILL` (`kill -9`, the OOM killer).
  Where the process list cannot be read (no `/proc` and `ps` failing), cadence
  can only kill the root command (`sh`): it leads no group of its own, since it
  is deliberately kept in cadence's group, so its descendants are not killed and
  survive it. A list that fails for more than a second is no longer
  trusted (a followed pid may have been recycled): nothing is signalled from it.
  cadence says so once on stderr when the list is unavailable.
- Commands run in cadence's own process group and session, attached to the
  terminal: `ssh`, `sudo` or `pinentry` can prompt on `/dev/tty`, and Ctrl-C or
  closing the terminal stops the running command together with cadence (within
  the limits above).
- **CI** `github`: polls `gh run list --commit <sha>` every 15 s; no run after
  5 minutes is a failure (you probably pushed another commit than the one you
  deliver); every run must end `success`, `skipped` or `neutral`. `gh` errors
  are retried, and reported with their cause after 5 minutes.
- Commands get `CADENCE_SHA`, `CADENCE_SHORT` (7 characters) and `CADENCE_BRANCH`;
  `${SHA}` and `${SHORT}` are replaced in `url` and `contains`.
- On success the lots cited by the commits since the previous delivery are
  listed, so you can `raf done` those whose effect you have seen. With a
  read-only plan, only the lots that were in progress when the delivery started
  are listed: an id quoted in a message for context (a finished lot, a
  reservation number that looks like one) is not a delivered lot. Plan upkeep
  commits (see "Plan upkeep needs no lot") are skipped in that list: they cite
  lots without delivering anything.

### A project with its own delivery script

A project that already delivers with its own script (CI wait, deploy, business
checks) plugs it in instead of rewriting it as `ci` / `deploy` / `verify`:

```yaml
deliver:
  script: ./scripts/ship.sh "$CADENCE_SHORT"   # replaces ci and deploy
  allowDirty: true                             # optional: a modified tree is reported, not refused
  deployTimeout: 3600                          # seconds, for the whole script
  verify: []                                   # optional here: the script's own checks count
```

```sh
cadence deliver -- api frontend --news docs/changelog/x.md -- map    # everything after the first « -- » goes to the script
cadence deliver --dry-run -- api                                      # shows the full command, runs nothing
cadence deliver --sha 6b0d9aa -- api                                  # an earlier pushed commit instead of HEAD
```

`--sha` (any mode) delivers a pushed commit other than `HEAD` — for a CI that
builds each service only on the commit that touched it. `allowDirty` suits a
working tree shared by several sessions when the delivery starts from a pushed
sha and never from local files; without it a modified tree is refused.

cadence keeps what the script usually lacks: the preconditions (clean tree, pushed
`HEAD`), the lock (never two deliveries at once), the delivery log and the lots
delivered. Arguments are quoted for `sh`, so spaces and quotes reach the script
intact. If the script commits and pushes during the delivery (stamping a
changelog entry, say), the new `HEAD` is the sha recorded as delivered. Exit code
0 of the script means delivered; `verify` checks, if any, run after it.

### verify: replay the effect checks, outside a delivery

A green delivery says the effect was right *then*. `cadence verify` replays the
`deliver.verify` checks of `cadence.yaml` at any time — no CI, no deploy, no lock,
no journal entry, nothing written.

```sh
cadence verify                # one pass, one line per check, then a one-line summary
cadence verify --retry 60     # retry each failing check for up to 60 s (deliver's 300 s is not applied)
cadence verify --sha 6b0d9aa  # the sha that replaces ${SHA} / ${SHORT} (default: see below)
```

```
✓ GET https://ol.example/api/health → 200
✗ GET https://ol.example/api/lineup → 200, contient « "starters" » — « "starters" » absent de la réponse
verify : 1 effet rouge sur 2 vérifications
```

Exit code: **0** every check green · **1** at least one red effect · **2** nothing
to verify or invalid configuration.

**Which sha is expected.** By default `${SHA}` / `${SHORT}` is the last recorded
delivery (else `HEAD`). One case differs: a project with `ci: none` (the default) and
**neither** deploy commands (`deliver.deploy`) nor a delivery script — a host that
builds every push, like Cloudflare Pages — delivers by pushing, and every push counts,
plan-maintenance commits included. The expected sha is then the head of the tracked
upstream branch (`origin/<branch>`, as last fetched — `verify` does no network git),
**provided that upstream is the remote's production branch**: read without network from
`refs/remotes/origin/HEAD` (set by `git clone` or `git remote set-head origin <branch>`);
when that reference does not exist locally (repository created with `git init` + push),
`main` then `master` are taken as the production branch. A work branch pushed with `-u`
is not published by such a host, so it keeps the default rule. A project with `ci: github`
or a `ci.command` and no deploy also keeps the last delivery. When local `HEAD` is ahead
of the upstream, the report says so first — `2 commit(s) non poussé(s) — l'effet vérifié
est celui de origin/main` — so a red there reads "waiting for a push", not "broken
effect". `session start` uses the same rule; `--sha` always wins.

Time limits differ from deliver's. `verify` runs all the checks **in parallel**,
each try with the whole 120 s limit (a `url` request gives up after 20 s; a slow
check is killed at its limit, "délai dépassé", and takes nothing from the others); results are printed in the order
of `cadence.yaml`. Retries repeat every 10 s (deliver's interval) up to `--retry`
seconds for each check on its own, so a run lasts at most `--retry` + 120 s.
deliver, by contrast, runs its checks one after the other, retries each until
`verifyTimeout` (300 s by default) is spent, and stops at the first check that
never turns green. The check code is deliver's own (`url` / `status` /
`contains` / `command`, same messages). A project with
a delivery script (`deliver.script`) and no `verify` declares no effect checks —
`verify` says so and exits 2 (its script's own checks stay its business); add
`deliver.verify` to replay some.

Each `command` check of `verify` (and of `session start`) runs in a process group
of its own, detached from the terminal (no `/dev/tty`: a check must not prompt).
At its time limit the whole group is killed, so no child survives it; Ctrl-C,
`SIGTERM` or a closed terminal is passed on to the running checks before cadence
exits. As the checks run together, the output of their commands may interleave;
the result lines come after it, in order.

Make `verify` count: a health endpoint stays green while the data is wrong (a
lineup served empty for 38 h behind a green `/api/health`). Add a check on the
content that matters, e.g. `url: …/api/lineup` with `contains: '"starters"'`.

`cadence session start` runs the same checks in parallel (one try each, command
output muted), each with a 10 s limit, so the whole step takes about 10 s at worst;
it is not deliver's `verifyTimeout`, and there is no retry. It adds an
**"Effets en production"** section to the morning report: a single `✓` line when
everything is green, the red effects and the summary otherwise. It is a fact like
the others: it never changes the exit code, and an unreachable network shows up
as red lines ("erreur réseau") without blocking the session. No section for a
project without `deliver.verify`.

## orchestrate

`cadence orchestrate` is a program above `/lead`, not a conversation: for each lot you choose, it runs
a **fresh** `claude -p` session per step with a short brief, reads the result, writes the state in
files and moves on. The lead session keeps only the decision (which lots), the final table and the
questions. Nothing is resumed: a correction is a new session, never the author's reopened. The one
exception is a **formatting retry** (below).

```sh
cadence orchestrate finance-tracker:L41 ol-companion:L22 cadence:L18@haiku
cadence orchestrate L18                      # from inside a project
cadence orchestrate maritime-atlas:Q4/accueil-4-ux12@haiku   # a lot id may contain "/" (sub-tasks of read-only plans)
cadence orchestrate … --budget 1.5M          # 1500000, 1.5M, 800k; default 2M
cadence orchestrate … --max-sessions 3       # sessions running at the same moment, all waves together; default 2
cadence orchestrate … --dry-run              # preconditions + the plan of the wave; nothing is started
cadence orchestrate --status [<wave>]        # the live waves and the repositories they hold, then the table (default: the last wave of this folder)
cadence orchestrate --status [<wave>] --watch [--interval 10]   # the same, redrawn every 10 s (--interval in seconds); stops by itself when no wave is running (with an explicit `<wave>`: when that wave is no longer running)
cadence orchestrate --resume [<wave>] [--budget 1M] [--answer ol-companion:L22 "reply"]
```

**Lot ids containing `/` (L120)**: the first `:` separates the project from the lot, a final `@` the model, and the lot
keeps its `/` (`maritime-atlas:Q4/accueil-4-ux12@haiku`); this holds for `--dry-run`, `--status`, `--resume` and
`--answer` too. In `.cadence/runs/<wave>/` the `/` of the lot becomes `__` (`maritime-atlas--Q4__accueil-4-ux12.json`,
same for the lot folder and the dry-run briefs); ids without `/` are unchanged.

You choose the lots; the order is the order given (one queue per repository, as many repositories at the
same time as the session cap allows — 2 by default). `@haiku|@sonnet|@opus` sets the model of the implementation and corrections of that
lot (default Sonnet; reviews are Opus, except the light review below; Haiku only when you write it, for a mechanical lot). Run it
in the background and read `--status`: it prints one line per transition and the final table.

**Following a wave (L49)**: `--status --watch` clears the screen and redraws the live waves and the table every
`--interval` seconds (default 10), then stops by itself, leaving the last render, as soon as no wave is running
(exit code 0, like `--status`; a wave already finished gives a single render). The `cadence-lead` skill names the background
task « vague `<id>` : `<project>:<lot>`, … », starts the wave with `--wave <id>` and arms a follow-up on
`.cadence/runs/<id>/journal.log` that pushes each transition (lot → state, question, ready, handed back) into the conversation.
The Claude Code status band is the `cadence-hud` plugin.

**Cycle of a lot**: preconditions (clean tracked files, lot `todo` or `doing`, dependencies met) →
`raf start` (committed alone) → implementation → **UX review** if the lot is `visible` and the app is
declared → **code review**, which always comes last (a UX fix changes code) → compliant (no blocking, no
major finding) → `raf review` is recorded by the orchestrator with the sha the review read, then
"ready to deliver". Not compliant → a correction in a new session, then a new review (the UX review of a
visible lot is replayed too, the code having changed), **two passes at most**, then the lot goes back to
you with the findings. A small lot (`estimate` ≤ 0.5 or `quickwin`) gets one single Opus pass for code and
usability (code only when the lot is not `visible`). Failing tests (reported red, or red when
`orchestrate.test` is run) go straight to a correction.

**Review sized to the lot (L108)**: a lot whose `estimate` is ≤ `orchestrate.review.threshold` (0.25 day by default)
is *light*: one single review (Sonnet by default, `code-reviewer` agent, same criteria), no minors pass — the minors are
returned to the lead as notes (proposals). A blocking or major finding on a light lot still triggers a correction, and
the review that follows is the full one (Opus); the cap of two correction passes is unchanged. A bigger lot keeps the
chain described above (Opus, two corrections, minors pass). `--dry-run` shows « revue légère » on a light lot.

```yaml
orchestrate:
  review: { threshold: 0.25, light: sonnet, full: opus }   # defaults; threshold in days (0 = no light lot), models haiku|sonnet|opus
```

`full` is also the model of the UX review and of the single pass of a small lot that is not light.

**Pre-check « deliverable already present? »** (L77). Before the first implementation of a lot that has no commit yet, a
short read-only session (Sonnet, `precheck` step, brief `templates/orchestrate/precheck.md`) looks in the repository for
what the lot asks for (another lot, or a correction, may have done it already). It answers `oui` (everything is there,
with proofs), `partiel` or `non`: on `oui` no implementation session is opened and the lot is handed back
(`livrable déjà présent : <résumé> (<preuves>)`) for the lead to drop or close it; on `partiel` the finding goes into the
implementation brief and a warning; on `non` — or an unreadable report, which only adds a warning — the wave goes on. A
lot that already has commits is never pre-checked (resuming it is legitimate). `orchestrate.precheck: false` turns it off.

**A lot that already has commits** (a spec commit, an interrupted wave, a lot committed by hand, a lot sent back after a
review) still starts with the implementation session: its brief tells it to read the lot, its notes and its open
sub-tasks, which carry the findings of any earlier review. If that session ends without a new commit on a lot that
already has commits, the wave goes on to the review (warning `implement sans nouveau commit`) instead of handing the
lot back; with no commit on the lot at all it is handed back as `implement sans commit`. The same goes for a
correction pass: a `fix` session that adds no commit to a lot that already has work commits goes on to a fresh review
(warning `fix sans nouveau commit : revue lancée sur les commits du lot`), the pass still counted — the cap of two
correction passes stays the guard against a loop; with no commit on the lot it is handed back as `fix sans commit`.

**Compliant with minor findings**: the minors are not left for a follow-up lot. One **minors pass** runs
before concluding: a new Sonnet session with its own brief (`fix-minors.md`) fixes the minors that are right
and lists in `choix`, with the reason, the ones it rejects (it never stops to ask); it does not count among the
two defect passes. A short code re-review follows (for a visible lot, after the UX review replayed), and
concludes even when it finds new minors, which are returned to you as proposals (no second minors pass).
When the pass makes no commit (every minor judged wrong) and HEAD has not moved since the compliant review,
the lot concludes on that original review (if HEAD moved, e.g. a resume after a cut-off session that had
committed, a short re-review of that commit runs instead): `ready`, verdict recorded with the sha that review read (`… + passe des mineurs sans commit`),
the untreated minors returned as proposals. Same when the budget is exhausted right after a compliant
review with minors: it concludes on that review instead of staying suspended.

**Choices, not questions**: the author brief tells the session to decide minor interpretation questions itself and to list them under `choix` in its report; the reviewer receives that list to re-read, and the final table prints each one (`choix fait : …`). A session stops with a question only on a real blocker: a decision that changes the scope or the architecture or is costly to undo, AND that the plan, its notes and CLAUDE.md do not settle; everything else is a choice.

**Frozen copy of the tool (L61)**: at the real start of a wave (not with `--dry-run` or `--status`), cadence copies the
parts of its package that run the wave (`bin/`, `dist/`, `templates/`, `agents/`, `skills/`, `package.json`; `node_modules`
is linked, not copied) into `.cadence/runs/<wave>/tool/` and relaunches the orchestrate process from that copy (the
parent process waits, relays the signals and exits with the same code or signal). Code, brief templates and agents
therefore come from the snapshot: a wave can orchestrate cadence itself, and a session of the wave may edit
`templates/` or rebuild `dist/` without touching the wave running. `--resume` relaunches from the snapshot of the
resumed wave, never from the current `dist/`; a wave without a snapshot (started before L61) resumes with the current
package and a warning. The copy is removed with the wave folder. The wave's pid in `--status` is the relaunched process.
The sessions of the wave also get `.cadence/runs/<wave>/tool/bin` (the `raf` and `cadence` entries of the snapshot) **first in their
`PATH`**, ahead of the per-project Node below and of the usual `PATH`: the `raf` a reviewer runs (`raf commits`…) is the
snapshot's, not the installed one. A wave without a snapshot leaves the `PATH` as it is.

**What stays with you**: choosing the lots, the questions raised (`--resume --answer`), re-verifying
after the wave (`git log`, tests, `raf check`), `raf done`, **`raf ux`** (the orchestrator reports the UX
verdict and screenshots, it does not record it), the push and the deliveries, one project at a time.

**Several waves at once**: the lock is per **repository** (a lock in the repository's shared state,
`orchestrate.lock`, which also makes `cadence deliver` refuse that repository), not per folder. A wave is
refused only when one of its repositories is held by a live wave (`<repo> : une orchestration y est déjà en
cours`; the lock of a dead process is detected and cleared); two waves on different repositories run side by
side, even when started from the same parent folder. They share a **cap on simultaneous sessions**, counted
across all live waves: 2 by default, `--max-sessions N` (or `CADENCE_MAX_SESSIONS=N`) to change it — give
every wave the same value: each wave counts ALL live sessions, whatever their slot, and waits while that
count has reached ITS OWN cap, so with different caps the highest one can push the total past the lowest
(which then waits). A session that finds no free slot **waits** (the wave is not refused; the journal says
`en attente d'un créneau de session depuis …`, repeated every minute, then `créneau de session obtenu après …`).
A slot or a registry entry is owned by a pid **and** its start time: a reused pid is a dead owner. Wave
identifiers are reserved atomically (`-2`, `-3` suffix when two waves start in the same minute; an existing
`--wave` is refused). The registry of live waves and the slots live under `~/.cadence/orchestrate/` (`CADENCE_HOME`
to move it): `cadence orchestrate --status` lists, from any folder, the live waves, the repositories each
holds, the cap of each wave and the slots in use.

**Guards, imposed by the code**: a global cap of simultaneous sessions, one wave per repository at
a time (above); `Agent`, `git push`, `cadence deliver`, `raf done|review|ux` are denied to the sessions; a
temporary `pre-push` hook, installed for the duration of the wave and removed at its end, refuses any push
from a session (`CADENCE_ORCHESTRATED` is in their environment; a repository that already has another
`pre-push` hook is refused before anything starts — `pushurl` is never touched); after every session the
upstream ref and `git ls-remote` are compared with the "before", and a review that changed `HEAD` or the
tree is an incident that stops the wave. `raf done|ux|review` and `cadence deliver` refuse when
`CADENCE_ORCHESTRATED` is set.

**Budget**: the wave counts input + cache writes + output tokens (default 2 M); cache reads are kept and
shown apart. Each lot also has its own budget derived from its estimate (400 k tokens per day, floor 200 k, shown by
`--dry-run`): a lot that spent it gets no further session and is handed back to the lead, the wave budget stays for
the others. When the budget (or the usage limit) is reached no new session starts, the running ones
finish, the wave is *suspended* (exit code 3) and `--resume --budget …` continues. A session that returns
nothing readable, times out (45 min for work, 25 for a review) or fails is not retried; the lot is handed
back with the cause. Exit codes: 0 every lot ready · 1 at least one lot handed back (question, failure,
review still not compliant after two passes) · 2 refused before acting · 3 wave suspended.

**Formatting retry** (the only `--resume` of a session): when a session ends successfully but in plain text,
without the `structured_output` the schema asks for (the verdict is there, not in the required shape), the
orchestrator resumes **that same session once** (`claude -p --resume <session-id> --json-schema <same schema>`,
same model, permission mode and denied tools) with a short prompt that only asks for the report in the required
format. It applies to every step that has a schema (implementation, correction, reviews). The tokens of the
retry count in the wave budget and in the step (`formatRetry: true`); if the output is still missing after it,
the step fails as usual — never a second retry.

State is in `.cadence/runs/<wave>/` of the folder where the command is run (added to `.git/info/exclude`
when that folder is in a repository; `.cadence/` and `.playwright-mcp/`, where the Playwright MCP writes its
output, never count as a dirty repository, even when `.gitignore` does not list them): `wave.json`, one `<project>--<lot>.json` per lot (steps, tokens
kept apart, session ids, commits, verdicts), the JSON output of every session and a `journal.log`. After a
cut (Ctrl-C, WSL closed) `--resume` replays an interrupted step entirely in a new session whose brief
lists the commits already present; finished steps are never replayed.

Briefs are the templates of `templates/orchestrate/` (`implement.md` is the `lead` skill's standard
brief; `--dry-run` writes the rendered ones). The `implement` brief of a `visible` lot also carries the
News instruction (`cadence news new <lot>`, factual user-side text, a screenshot in `docs/nouveautes/captures/` or
`nocapture:`, `cadence news check` green); the brief gives the absolute path of the wave's Playwright output directory and the `implement` session gets `--add-dir` on it, to copy the capture into the repository; the `fix` and `fix-minors` briefs of a `visible` lot give the same folder (and their sessions the same `--add-dir`), to fetch a screenshot a finding asks for; a lot that is not `visible` gets nothing. A `--dry-run` brief of a `visible` lot has no wave folder (the wave does not exist yet), nor does a brief delegated by hand: the News instruction then says to save the screenshot under the OS temp directory, never inside the repository, then copy it into `docs/nouveautes/captures/`. A project can declare, in `cadence.yaml`:

```yaml
orchestrate:
  test: npm test                         # run by the orchestrator after a work step (optional)
  build: npm run build                   # run after the tests; both results go to the reviewer, who does not redo them (optional)
  precheck: true                         # default: before the first implementation of a lot with no commit, a read-only Sonnet session checks whether the deliverable is already in the repository (see below); false skips it
  ux: http://localhost:4200              # a URL, a launch command, or { command, url, timeout? } — for the UX review (see below)
  permissionMode: auto                   # default
  addDirs: [/home/me/projects/tmp]       # extra directories the sessions may use
  timeouts: { implement: 45, review: 25 }   # minutes
  # a plan kept by the project's own tool is read-only for raf: the orchestrator calls these instead
  start: python3 scripts/raf.py start {lot}
  verdict: python3 scripts/raf.py note {lot} "revue de code : {verdict}"
```

**`orchestrate.ux`, who starts the app**: a string is a URL if it starts with `http://` or `https://`, a launch
command otherwise; both forms behave as before (the `ux` brief gives the URL, or tells the session to start the app
with the command and stop it). The object form `{ command, url, timeout? }` makes **the program** start the app, not
the UX session. Before the `ux` step (and before the `review-small` single pass of a small `visible` lot, which follows
the same rule) the orchestrator:

0. takes a lock on the `host:port` of `url` (a file `cadence-ux-<host>-<port>.lock` in the OS temp folder, created
   exclusively, containing the pid of the orchestrator; a lock whose pid is dead is taken over). Another wave — in
   this process or another — that declares the same URL waits for it, and the wait counts in `timeout`; past it the
   note is « UX non vérifiée : url tenue par une autre vague » and nothing is started. The lock is given back after
   the app is stopped. Declaring **distinct ports per project** is still recommended: the lock serialises two waves
   on one URL, it does not make them fast;
1. probes `url`; if it already answers it does **not** start anything, notes « port occupé » (`uxNote`: the UX is not
   verified) and the lot goes on;
2. starts `command` with `sh -c` from the repository root, in its own detached process group, its output in
   `<wave>/<project>--<lot>/ux-app.log` (the command carries its own prefixes, e.g. `cd web && PORT=4300 npm start`;
   there is no `env`, `cwd` or account/PIN key);
3. probes `url` until an HTTP status below 500, for `timeout` seconds (default 300); the answer only counts while
   the process group it started is still alive. A command that exits early, or
   no answer in time, means « UX not verified » with the end of the log in the note: the UX session is skipped,
   the lot goes on to the code review — it is never a failure of the wave (the single pass of a small lot still runs,
   on the code alone, its brief saying the app could not be verified);
4. gives the session « The running app is at `<url>` », with no instruction to start anything;
5. at the end of the step — success, error or SIGTERM of the wave — kills the group: SIGTERM, then SIGKILL after 10 s.

```yaml
orchestrate:
  ux: { command: 'cd web && PORT=4300 npm start', url: 'http://localhost:4300', timeout: 120 }
```

In the object form `url` must start with `http://` or `https://`, and `timeout` is only accepted together with both
`command` and `url` (the program only waits when it starts the app). A wave stopped (incident, quota, budget) before
the step suspends the lot without starting the app.

**Node per project (`.nvmrc`)**: when a project has a `.nvmrc` at its root, every session the
orchestrator launches for it (implementation, UX and code reviews, corrections) runs with the matching Node
first in its `PATH`, so `node`, `npm` and `npx` resolve to it (Astro needs 22 while the default may be 20) — and so does
the app the program starts for the UX review (`ux.command`): same links directory first in its `PATH`, no
`. ~/.nvm/nvm.sh && nvm use` prefix needed (it exits with code 3 under `sh`). Only
those four names (`node`, `npm`, `npx`, `corepack`) are exposed, through symlinks in
`.cadence/runs/<wave>/node-bin/<version>/` (recreated at start and at every `--resume`): the rest of that Node's
`bin` (globally installed `raf`, `cadence`, `claude`…) is never exposed, so it does not shadow the tools in the usual `PATH`;
only the snapshot's `tool/bin` (above) comes first, ahead of this Node directory. `--resume` resolves
the `.nvmrc` again for every live lot and refuses it like at start if it can no longer be resolved.
The file is read trimmed (`22`, `v22`, `22.22`, `v22.22.3`); the highest matching version installed under
`$NVM_DIR/versions/node` (default `~/.nvm/versions/node`) **that has an executable `bin/node`** is used: a higher
version with an empty or broken `bin` is skipped for a lower valid one (and `--dry-run` says so); if none is valid
the lot is refused. Only the sessions' environment changes,
never the orchestrator's own. No `.nvmrc` → nothing changes. A `.nvmrc` that cannot be resolved (`lts/*`, an
alias, a version not installed) refuses the lot before anything is started (exit 2), naming the requested
version and the folder searched — there is no silent fallback to the default Node. `--dry-run` prints
`node : v22.22.3 (.nvmrc 22)` under each lot that has one, with the skipped versions when it happens
(`node : v22.9.0 (.nvmrc 22 ; v22.22.3 écartée : pas de node exécutable)`).

**Minimal MCP servers per step**: every session the orchestrator launches gets `--strict-mcp-config --mcp-config
<file>`, with the file written by the orchestrator in the lot's folder of the wave
(`.cadence/runs/<wave>/<project>--<lot>/mcp-<step>.json`). `--strict-mcp-config` makes `claude` ignore every other
source (user, project, plugin servers: Serena, context7, Cloudflare…), so a session no longer starts a handful of
`npx`/`uvx` servers it does not use. `review` and `review-recheck` always get an empty set
(`{"mcpServers":{}}`); so do `implement`, `fix` and `fix-minors` on a lot without a screen. Playwright, launched as
`npx -y @playwright/mcp@latest --output-dir <wave>/<project>--<lot>/playwright`, is loaded for the `ux` step and, on a
`visible` lot, for `implement` and `fix` (`fix-minors` included) and, on a small `visible` lot, for `review-small` (its only
usability review; `review-small` of a small lot without a screen loads nothing), so the screenshots and snapshots of the work and of
the review stay with the wave, outside the repository, where the lead can look at them; the final table prints that
folder whenever Playwright was loaded for the lot, even if no `ux` step ran
(`<project>:<lot> — captures Playwright : <dir>`; `uxCaptures` in the wave state). The `implement`, `fix`,
`fix-minors`, `review-small` and `ux` briefs tell the session to give relative file names if a Playwright server is available, and
otherwise to keep any Playwright CLI output outside the repository.
`--dry-run` prints, under each step, `mcp : aucun` or `mcp : playwright (…)`. There is no per-project override in
`cadence.yaml` yet.

Without `start`, a read-only plan's `todo` lot is refused (start it with the project's tool); without
`verdict`, the review verdict stays in the wave's state and you report it. Only the plan's files
(`plan.path`, `plan.files`, the QA expectations file) are committed from those commands; anything else dirty stops the lot (`.cadence/` and `.playwright-mcp/` excepted, as above).

## Claude Code skills

As a plugin:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence@cadence
```

gives `/cadence:session-start`, `/cadence:session-close`, `/cadence:deliver`,
`/cadence:lead` and the `ux-reviewer`, `code-reviewer` and `qa-reviewer` agents. Or copy them into the
repository with `cadence skills install` (to `.claude/skills/cadence-*` and
`.claude/agents/cadence-*.md`; `--dir` for another `.claude` folder,
`--force` to overwrite local edits).

- **session-start**: reports the facts briefly, proposes three lots from the
  plan, then waits for your priority — nothing starts before your answer.
- **session-close**: plan hygiene, clean repository, a cleanup proposal for stale
  working files (`session.clean` patterns, older than `session.cleanDays`; never
  anything git tracks, a git repository or a folder holding one, anything under
  `.git`, a bare repository or separate git directory or anything inside one,
  anything behind a symbolic link a `*` matched (only the link itself), a hidden `.xxx` name a `*` would not match, nor anything it could not
  read entirely — it asks before deleting), memory limited to what the
  repository does not say, new skills or agents proposed but never created, three
  lines for next time.
- A project with its own tooling keeps it: its plan is read where it is (`plan:`),
  its delivery script is called by `cadence deliver` (`deliver.script`), its
  morning and evening scripts feed the session report (`session:`), and its own
  skills can become one-line aliases of `session-start` / `session-close`.
- **deliver**: dry run, delivery, and on failure the cause fixed rather than a
  blind retry; after a green delivery that changes what a page shows or what it
  is served, the `qa-reviewer` agent walks the delivered app.
- **lead**: from a folder holding several projects, `cadence lead tour` (a program,
  no model: see [lead tour](#lead-tour)) prints one line of facts per project, you choose the priorities, the lots are delegated with
  `cadence orchestrate` (fresh short sessions with a standard brief — test first,
  README and usage documentation updated with the change, commits citing the lot, no push — reviewed by the `code-reviewer` agent, see
  [orchestrate](#orchestrate)), re-verified by the lead, then delivered
  one project at a time; a delivery that changes what a page shows or what it is
  served is then checked in the running app by the `qa-reviewer` agent, whose
  blocking findings come back to you. Two
  subagents at most, never two in the same repository.
- **ux-reviewer** (agent): captures at 1440 and 390 px, findings grounded in a
  named rule (Nielsen, WCAG 2.2 AA) or a measurement, ranked, turned into
  `raf add --parent` sub-tasks, and a one-line verdict for `raf ux`. It never
  edits code.
- **code-reviewer** (agent): any stack; given a repository and a lot id, it reads
  the diff itself from the commits that cite the lot — not the author's summary —
  and the project's CLAUDE.md, when there is one, for its conventions; findings grounded in a
  measurement (a failing command, changed code without a test, a duplicated
  block, dead code) or a named rule, each with `file:line` and a concrete
  scenario; real defects only, ranked, what it could not verify, and a one-line
  verdict for `raf review`. It takes the lot's commits from `raf commits`, never
  runs a build whose output is used live, and never edits code. A README or usage
  documentation that does not follow the lot's change is a *major* finding.
- **qa-reviewer** (agent): any web app; given a repository and a base URL (and
  optionally a lot id, to start with the pages it touched — for a backend-only
  lot, those that call the changed endpoints), it opens each page of
  the project's expectations file in a real browser at 1440 and 390 px and
  measures: expected content present and non-empty, no error or missing-data
  message, every API call answered 2xx with a non-empty body, no console error,
  no broken content image. Findings are defects (a line of the expectations
  broken, or a universal check failing with a visible effect, with or without an
  expectations file), suspects (it looks like missing or wrong data and no
  expectation settles it) or noise (a console error or a failed request with no
  visible effect, ranked minor) or already planned (an open lot covers it: returned in one line, the lot id and its title), ranked, each with
  the route, what was expected, what was measured and the evidence; pages checked
  N/N, follow-ups as `raf add` lines, what it could not verify, a one-line
  verdict. Read-only: GET only, no login, nothing submitted; it stops at a PIN.

## cadence-hud

A band above the Claude Code prompt (terminal and desktop app), refreshed every 5 s:

```
ctx ▰▰▰▰▱▱▱▱▱▱  42 % 84k/200k  │  5h  23 % ↻ 2 h 10  │  7j  61 % ↻ 6 j 15 h  │  $1.23  │  fable 410k sonnet 85k  │  ⚙ 2 agents
⟳ cadence · 2026-10-07-2131 en cours  │  budget ▱▱▱▱▱▱▱▱▱▱   1 % 14k/2M  │  1 session/2
  L112  implémente  implement@sonnet 34 s         global-setup coupe le cache de compilation de Node...
```

Context of the session (green / orange / red at 50 and 75 %), the 5-hour and 7-day quota
windows with the time to their reset, the cost of the session and its split per model, the
subagents of this session, and every live `cadence orchestrate` wave: budget, sessions, one
aligned line per active lot (status, step, model, elapsed, start of the title), the lots still
waiting. When no wave is running, the last finished one stays on a grey line until the next
starts. Waves are read from disk (`~/.cadence/orchestrate/waves/`, then `.cadence/runs/`); no
cadence command is run, and the CLI is not required.

Install it as a plugin from the same marketplace:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence-hud@cadence
```

`/hud` hides or shows the band. The source lives in [`plugins/cadence-hud`](plugins/cadence-hud/README.md)
(its own README has the details of every cell); it is not part of the npm package. To work on it:
`claude plugin validate plugins/cadence-hud`, `claude plugin test plugins/cadence-hud`, and
`tsc -p plugins/cadence-hud` once Claude Code has loaded the plugin at least once (it generates
the `.claude-plugin/types` the tsconfig extends).

## Releasing

A version exists in three places and is published in two; a release does all of it, in this order:

1. Bump `version` in `package.json` (then `npm install` to refresh `package-lock.json`),
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, in the commit that closes the lot.
   Write the version's section of `CHANGELOG.md` (`## [x.y.z] - date`, what changes for the user, lots cited)
   and refresh the « What's new » summary of this README in that same commit.
2. `git tag v<version> && git push origin main v<version>` — the tag starts `.github/workflows/publish.yml`,
   which publishes to npm through Trusted Publishing (OIDC, no token stored anywhere): it checks the tag
   matches `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` and that `CHANGELOG.md` has a `## [x.y.z]` section for it (no section, no publication), then `npm publish --provenance`, where `prepublishOnly` runs the type-check and the
   tests and `prepare` builds `dist/`; a red suite stops the publication; then it creates the GitHub release with that CHANGELOG section as its text. The trusted publisher is declared
   once on npmjs.com (package settings → Trusted Publisher → GitHub Actions, `Sylad/cadence`, `publish.yml`).
3. Watch the run: `gh run watch` (or `gh run list --workflow publish.yml`).
4. Check the effect: `npm view @sylad/cadence version` answers the new version.
   A run is safe to re-run, and two runs for one tag queue instead of racing (`concurrency` per ref, never cancelling the one that publishes):
   a version already on npm skips `npm publish`, and a GitHub release that is missing is created (`--verify-tag`)
   while an existing one is left alone. If the package is on npm but the release is still missing, re-run the job;
   the by-hand fallback is `gh release create v<version> --title v<version> --notes-file <the section of CHANGELOG.md> --verify-tag`.

The Claude Code plugin is read from the repository, so pushing `main` is what updates it; npm is what
`npx @sylad/cadence` and a global install read, and only the tag publishes there. A missing tag, or a red
publish run, leaves npm behind without any other error — 0.3.0 and 0.4.0 were never published — hence
step 4.

## License

MIT
