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

### Spec step (design, first steps delivered)

For a visible lot that adds a page, a component or changes a journey, `orchestrate` gets a step
before the code: a static HTML mockup in the project's own style (1440 and 390 px; empty, loading and
error states) and a machine-readable screen sheet (fields, numbered rules `R1…` each marked *sourced*
or *hypothesis*, actions → API calls). The `ux-reviewer` agent reads the mockup before any code; the
acceptance tests are written from the sheet, red, by a session other than the implementer's; the
implementation gets the sheet, the code review checks rule → test → green, the hypotheses go into the
lot's news entry, and a human is asked only about a choice that is costly to undo. The design is in
`docs/superpowers/specs/2026-10-10-etape-spec-design.md` (with an example sheet and the plan of the
lots that deliver it). Delivered so far: the sheet templates `templates/fiche.yaml` (screen) and `templates/fiche-back.yaml` (a lot without a screen: `sujet`, `cas`, `regles`, `contrats`, `donnees`), `cadence spec check`
(the sheet's invariants) and `cadence spec qa` (the screen's `docs/qa/expectations.md` section, derived
from the sheet), see [spec](#spec) below, and the `spec` step of `orchestrate` itself (the `spec-writer` agent, the
render at 1440 and 390 px, the commit of the spec), see [The spec step](#the-spec-step-of-a-lot-with-screen) in `orchestrate`; the `accept` step (red acceptance tests and the lock that protects them), see [The accept step](#the-accept-step-red-acceptance-tests-and-their-lock); the UX review of
the mockup (the `ux-reviewer` agent in mockup mode), see [The mockup review](#the-mockup-review-before-any-code); and the downstream briefs (the sheet given to `implement`, rule → test → green in the code review, a light UX conformity pass, the `## Hypothèses` section of the news entry), see [The downstream briefs](#the-downstream-briefs-sheet-rule--test--green-conformity-hypothèses).

## What's new

**1.1.0**: the spec step of `cadence orchestrate`: a lot that declares `screen:` gets a machine-readable screen sheet (`cadence spec check|qa`), a mockup reviewed against it, acceptance tests committed red and locked before the implementation, and briefs that carry the sheet and rule → test → green to `implement`, `fix` and the code review; the news entry gains a *Hypothèses* section (L166, L169–L174, L177–L184). **1.0.0**: the first major release, a stable contract: the commands and options, the keys of `cadence.yaml`, the plan file and the names of the skills and agents follow semantic versioning, and the README's *Stability* section lists what is guaranteed and what is not (L164). **0.28.0**: `orchestrate.precheck: local` runs the « deliverable already present? » pre-check of `cadence orchestrate` on the local model (`claude-local`, Ollama), off the Anthropic quota, Sonnet staying the default and the fallback (L146); the `qa-reviewer` agent walks only the pages a lot touched, with a **Scope** line in its report (L123); the sub-tasks a review closes are also read in a lot's neighbouring repositories (L156) and a commit's sub-task list is read with the plan's left guard (L155); an unstable test is fixed (L90). **0.27.1**: `cadence orchestrate` no longer leaves a session's child processes alive: a dev server started in its own process group, or orphaned by a shell that exits (`nohup srv &`), is killed with the session through its process tree and its `CADENCE_SESSION` mark, a tmux server, `screen`, `gpg-agent` or `dirmngr` started on demand being spared; a session that exits with code 0 while a descendant holds its output open is no longer reported as « délai dépassé » (L83); the `ux-reviewer` and `qa-reviewer` agents carry the briefs' Playwright rule outside `cadence orchestrate` (L84). **0.27.0**: a compliant review of `cadence orchestrate` settles the open sub-tasks that commits of the lot cite (`feat(L3/t2): …`, comma lists included), closed in the same plan commit as the verdict or, on a read-only plan, returned as `[sous-tâche clore]` proposals, so `raf done` no longer refuses a lot over sub-tasks whose work is done; on a foreign-format plan the ids are read as the plan reads them (L82); the test suite stays green with two full suites running in parallel (L150). **0.26.0**: `cadence orchestrate` raises the floor of a lot's budget from 200 k to 450 k tokens, enough to pay a write pass, its review, one fix pass and the short review that follows, so a lot of 0.5 or 1 day is no longer handed back at its second or third pass; a `--continue` wave draws fewer lots as a result (L128). **0.25.0**: the project line of the plans' progress in the `cadence-hud` band names the lots in progress after their count, three at most then `…` (L153, `cadence-hud` 0.4.2); the progress follows the folder the session was launched from, so a `cd` into a sub-project no longer shrinks the band, and the session context keeps the `session.start` folder (L154). **0.24.0**: `cadence orchestrate --drop <project:lot>` and `--stop-after-current` steer a live wave from another terminal, `--resume --drop` removes a lot before replaying a stopped wave (L79); the final table of a wave says « livrable jusqu'à <sha> » for a ready lot stacked under a lot handed back, with `git push origin <sha>:main && cadence deliver --sha <sha>` (L76); a version commit (version fields, `CHANGELOG.md`, the README's « What's new ») no longer asks for a new code review (L72). **0.23.0**: the progress bar of each project in the `cadence-hud` band is coloured by the share of lots done, red below 33 %, orange below 66 %, green beyond (L152, `cadence-hud` 0.4.1); `cadence deliver` under a wave lock refuses only when a lot of the wave still works in that very repository, a linked worktree included (L127). **0.22.0**: `cadence orchestrate --continue` draws the next ready lot of the plan itself, in the declared priority, until the budget, the time window or a question stops it (L147); `cadence session context` prints the context of the session, which the `cadence-hud` band publishes, and the `lead` skill chains lots without the human while it stays under 60 % (L148); the band shows the progress of each project's plan, and `cadence lead tour --json` gains `progress` (L149, `cadence-hud` 0.4.0); the final review of a lot is always played, the lot's own budget bounding the writing passes only, with 65 k tokens reserved for it (L145); the cause « tests rouges après … » names the pass whose tests were red (L151). **0.21.0**: `cadence orchestrate --status` and `cadence lead tour` print the free session slots, which the `lead` skill reads (L141); `orchestrate.effort` sets the effort level of each pass of a wave (L137); `docs.sync` makes `raf check`, `lead tour` and the review brief report a document that does not follow the code (L143); `docs.articles` opens, after a green `cadence deliver`, a lot `Article <project> à rafraîchir` in the neighbouring repository (L144). **0.20.0**: `cadence-hud` no longer misleads once the work is over: `/hud cmd` lists the background commands it counts (id, tool, origin, age, name), any other argument answers `argument inconnu` instead of hiding the band, commands with no end seen for an hour or no record go to a grey `N cmd sans fin vue`, a finished subagent takes its commands with it, two races that left a `1 cmd` counted forever are closed, and a finished wave shows grey without its budget then disappears after 30 minutes (L142); the `qa-reviewer` and `ux-reviewer` agents are read-only for real, their frontmatter listing Read, Grep, Glob, Bash and the Playwright tools (L140). **0.19.1**: `cadence-hud`'s `N cmd` counter goes back down when a Monitor expires, when the background commands a subagent started end with it, and at session start or plugin reload (L135); its `tool.call` and `prompt.submit` guard hooks carry a `.catch` on registration, which clears the `claude plugin validate` warning (L136). **0.19.0**: `cadence orchestrate` lifts a repository's lock and `pre-push` guard as soon as every lot of the wave that touches it is finished, so `cadence deliver` works there while the wave continues elsewhere (L132); a review that leaves a repository dirty hands back that lot only, suspends the lots still queued in that repository and keeps the other repositories running, its verdict reported instead of lost (L133); `cadence session close` re-run without a `session start` keeps the window since the last opening (L131); `cadence-hud` draws the lot rows of a wave in aligned columns on every surface (L134). **0.18.0**: `cadence session next` prints what it records (issue #6); `cadence session close` covers the period since the last `session start` (or the last close) and says so in its title, `--since` still wins (issue #7). **0.17.0**: `cadence-hud` shows an `N cmd` segment next to the agents, the background commands of the session (Bash run in the background and Monitor, subagents' included), tracked from the tool results and ended by the task's notification or `TaskStop`. **0.16.0**: a lot can declare **neighbouring repositories** (`repos:` key of the lot, `{ path, cite }` for a repository shared between projects): `cadence orchestrate` refuses, locks and guards them, gives them to every session as `--add-dir`, and `raf commits`, `raf show` and the review verdict read the commits that cite the lot there too. **0.15.0**: `hook.autostart` in `cadence.yaml` (`warn` by default, `refuse` or `start`): a pre-commit hook that refuses, or starts in the same commit, a lot still todo that the commit cites; `cadence session start|close --all [--depth n]`, one section per project under a folder. **0.14.0**: `cadence lead tour`, the lead's morning table of every project in a folder, printed by a program (one line per project: lots in progress, gaps, last notes, next ready lot, repository) in place of one subagent per project; the `lead` skill calls it. **0.13.1**: `cadence-hud` takes back the segments that fit once a big one has dropped (reset times, then the per-model consumption, now short: `opus 1.2M sonnet 800k`); `CADENCE_HUD_AMBIGUOUS=1` for a terminal that draws `▰ ▱ ⚙ │ ↻` in one cell. **0.13.0**: `cadence orchestrate --status --watch` (a wave's table redrawn in the terminal, which
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
| `raf add "title" [--estimate d] [--quickwin] [--visible [--screen page\|component\|journey]] [--spec] [--public "title"] [--after L2,L4] [--parent L3]` | add a lot or a sub-task, print its id (`--public`: the lot's title in the public's words, written as `public:` right after `title:`; `--screen`: the screen a visible lot creates or changes — a new `page`, a new `component` or a modified `journey` — written as `screen:` right after `visible:`, shown by `raf show`; it requires `--visible`, and `raf check` reports a `screen:` without `visible:` or with another value as an error. It is what will trigger the spec step of `orchestrate`, never inferred from the title; `--spec`: the lot changes a behaviour (something a user, an API client or another service can observe), written as `spec: true` right after `screen:`, `visible:`, `quickwin:` or `estimate:` (whichever comes last), shown by `raf show`, refused on a sub-task. Also set by the lead at planning time, never inferred from the title) |
| `raf add "title" --every <days>` · `raf did <id> ["text"]` | recurring lot: `every` (days) and `last` (last time done) fields; the lot stays `todo`, `raf now` and `session start` list it under « Récurrent » with « dû depuis N j » / « prochain dans N j »; `raf did` resets the count (spec: `docs/superpowers/specs/2026-10-04-L11-tache-recurrente.md`) |
| `raf screen <id> page\|component\|journey\|none` | set, replace or remove `screen:` on an existing lot, to adopt the [spec step](#the-spec-step-of-a-lot-with-screen) on a plan already written; refused on a lot without `visible:` (like `raf add --screen`) and on a sub-task; `none` removes the key and leaves `visible:` alone |
| `raf spec <id> on\|off` | set or remove `spec:` on an existing lot (a lot that changes a behaviour, for the back-end spec step of `cadence orchestrate`, see [The spec step of a lot with `spec: true`](#the-spec-step-of-a-lot-with-spec-true)); refused on a sub-task; `off` is refused on a lot that has `screen:` (the screen implies the spec: remove `screen:` first) and `on` there only says so and changes nothing. `raf spec` only takes `on`/`off`: `cadence spec check\|qa <fiche.yaml>` keeps its own subcommands. `raf check` reports a `spec:` that is neither `true` nor `false` (`spec : true ou false attendu`) |
| `raf public <id> "title"` · `raf public <id> --clear` | set, replace or remove the public title of a lot |
| `raf start <id>` · `raf done <id> [--force]` · `raf drop <id> [--reason text]` | dated transitions (`done` refuses open sub-tasks unless `--force`) |
| `raf note <id> "text"` | dated note — keep decisions next to the work |
| `raf show <id> [--notes]` | one lot: status, dates, `after`, public title, dated notes in order, then the counted commits (as `raf commits`, neighbouring repositories included); `--notes` prints the notes alone |
| `raf commits <id>` | the commits counted for a lot (the set the code review gate uses), one `<sha> <subject>` per line, oldest first; a lot that declares `repos:` ([neighbouring repositories](#a-lot-whose-work-is-in-a-neighbouring-repository)) gets, after them, one `dépôt <path> :` section per neighbour with the commits there that cite the lot and fall within the lot's period (`started` to `finished`) and, when the lot declares a `cite:` for that neighbour, contain that string (`aucun commit du lot`, or `introuvable` for a path that is not there) |
| `raf now` | what to do next |
| `raf list [--status s]` | flat list |
| `raf ignore <sha> \| "exact subject" [--reason text]` | acknowledge a commit without a lot (tooling chore, a plan commit citing an unknown id) without rewriting history: a dated, reasoned line in the plan's `acknowledged:` section; a sha is exact, a subject covers every commit carrying it |
| `raf check --ignored` | list the acknowledged commits with their date and reason |
| `raf check [--since date] [--idle 7]` | since the plan's adoption date by default (a visible lot without a public title is only a `⚠` warning: it never changes the exit code): commits without a lot (commits touching only plan files, or only version fields, `CHANGELOG.md` and the README's « What's new » section, are exempt), unknown ids, `todo` lots that already have commits, idle lots, `done` lots with open sub-tasks, bad or circular dependencies |
| `raf gantt [-o file]` | standalone Gantt page |
| `raf hook install` | add the post-commit hook (read-only, never blocks) and the pre-commit hook (does nothing unless `hook.autostart` says so, see below) |

#### A commit on a lot that is still `todo`

By default the post-commit hook only warns (`L1 est encore todo — raf start L1`). The `hook.autostart`
key of `cadence.yaml` changes what the **pre-commit** hook does when the message cites a `todo` lot
(a recurring lot, a lot already `doing`, a commit without a lot and a plan-upkeep commit are never concerned):

```yaml
hook:
  autostart: refuse   # warn (default) | refuse | start
```

- `warn`: today's behaviour, the commit goes through, the post-commit hook warns.
- `refuse`: the commit fails, loudly, with `raf start <id>` in the message (`--no-verify` still bypasses it).
- `start`: the hook runs `raf start <id>` and stages the plan, so the plan change is **in the same commit** —
  no amend afterwards, no dirty plan left behind. Only when `docs/plan/raf.yaml` is identical to `HEAD` (no
  uncommitted change to the plan, staged or not): otherwise nothing is started, the hook says why
  (`plan modifié non commité : démarrage automatique sauté, raf start <id> à la main`) and behaves like `warn`.

The pre-commit hook reads the message from the command line of the `git commit` that runs it (`-m`, `-am`,
`--message`, `-F`; Linux, through `/proc`) or from `CADENCE_COMMIT_MESSAGE`. When the message is not known yet
(editor, `--amend`) it does nothing and the post-commit warning stays. Run `raf hook install` again to add the
pre-commit block to an existing repository. A read-only plan is never started by the hook. Only a refusal (exit code 3 of `raf hook pre-commit`) stops a commit: an older or broken `raf` lets it through.

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
    screen: ecran               # page, component or journey; only on a visible lot
    spec: fiche                 # true or false: the lot changes a behaviour
    status: etat
    estimate: effort
    created: cree_le
    started: demarre_le
    finished: [livre_le, ferme_le]
    notes: note
    repos: depots               # the lot's neighbouring repositories (a list of paths and/or { path, cite }, or one of them)
    parent: parent
  statuses:                     # raf status: their states
    todo: [prevu, specifie]
    doing: [en_cours, teste]
    done: [deploye, valide]
    dropped: caduc
  estimates: { S: 0.5, M: 1, L: 3 }   # their effort labels, in working days
```

- Fields: `id`, `title`, `status`, `estimate`, `quickwin`, `visible`, `screen`, `spec`, `public`, `every`, `last`, `after`, `created`, `started`,
  `finished`, `notes`, `repos`, `parent`; one left out is read under its own name. A timestamp counts for
  its day; a note written as plain text is one note.
- `spec` is the exception to « a left-out field is read under its own name »: a read-only plan's `spec:` is often the path of a spec document, so it is read only when `plan.fields.spec` maps it, and then only `true` counts (any other value is neither an error nor a spec step). Natively, `spec:` stays `true` or `false` (L198).
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
| `cadence news check` | visible lots done without entry, unknown lots, missing or undeclared screenshots, entries without creation time, bad headers, a lot whose screen sheet has hypotheses and whose entry lacks the `## Hypothèses` section (or a line for one of them) |
| `cadence news stamp` | migration: writes `created:` into entries without one (or with an empty one), from the author date of the commit that added the file under its current name (now if not committed yet) |
| `cadence news build [-o dir]` | `nouveautes.json` + `index.html` + screenshots (default `docs/nouveautes/site`) |

`--dir` changes the entries folder (default `docs/nouveautes` at the git root).
The Markdown is deliberately small: headings (`#` to `######`, rendered one level lower, `<h2>` to `<h6>`; a heading takes its own line and cuts the paragraph or list around it), paragraphs, `-` lists (a bullet may continue on the next lines, indented), `**bold**`,
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
`plan.files`, or the QA expectations file), are version commits (see [Releasing](#releasing)), predate the plan's `since` or match an `ignore:` pattern — `raf commits <id>` prints exactly the counted set.

The verdict is tied to what was reviewed: `raf review` stores it on the lot with
the sha of the lot's latest counted commit (`review: { date, verdict, commit }`,
`commit: null` when the lot had none). A counted commit made after that one
makes the review stale: `raf done` refuses (`--force` to override), and
`raf check` reports a finished lot, until the lot is reviewed again and
`raf review` is rerun. A verdict
written by hand without a `commit` field is not checked for staleness. An empty
verdict is refused, and one left empty or blank by hand in the YAML counts as no
review. Plans without `reviewSince` are not affected.

A lot that works in neighbouring repositories (`repos:`, see [orchestrate](#a-lot-whose-work-is-in-a-neighbouring-repository))
has its verdict tied to each of them: `raf review` also stores, under `repos`, the sha of the latest counted commit of the
lot in each neighbour (the one `raf commits` lists last: it cites the lot, falls within the lot's period and contains the `cite:` string if any) (`review: { date, verdict, commit, repos: { ../aetherwx-gitops: <sha> } }`, `null` when a
neighbour has none), and refuses to record when a listed repository cannot be read. `raf check` does not audit the
neighbours: their staleness is not checked, only the project's own commits are.

### Documentation that follows the code

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

#### An article elsewhere that follows the delivery

A case study that lives in a neighbouring repository (the project's article on a showcase site) goes stale
the same way. `docs.articles` names it:

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

### QA review

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

## session

```sh
cadence session start              # notes from the last close, lots in progress (silent ones flagged),
                                   # work done since yesterday by lot, drift, repo state, 3 proposals
cadence session start --since "3 days ago" --idle 2
cadence session close              # commits by lot since the last `session start`,
                                   # commits without a lot, lots in progress with no commit in that window,
                                   # drift, uncommitted / unpushed work; exit 1 while something is still open
cadence session close --since "2 days ago"   # --since overrides the window
cadence session start --all        # from a folder that is not a repository: one "## project" section per
cadence session close --all --depth 2   # sub-folder holding a plan (--depth n: n levels down, 1 by default);
                                   # exit = the worst code of the projects (2 error, 1 open, 0 closed)
cadence session next "finish L3" "review L4"    # shown by the next session start; replaces the previous notes
cadence session next --clear       # erase those notes, on purpose
cadence session context            # `ctx 42 % (84000/200000)`: the context of YOUR session, as the cadence-hud band publishes
                                   # it: the one named by $CLAUDE_CODE_SESSION_ID (set in Claude Code's Bash); --session <id>
                                   # overrides it; with no variable, the folder decides only if a single session publishes for it
                                   # (two sessions in one folder = exit 2, "pass --session"); exit 2 too when no fresh figure
                                   # (band not loaded) = treat as at the threshold
```

`session start` records its time in the worktree's state (`session.json`, under the git dir); the next
`session close` takes it as its window and names it in the section title: `Commits de la période (depuis
l'ouverture de 09:12)` (with the date when it is not today). A close never moves the boundary, refused
or not: run again without a `session start` in between (the `session-close` skill does, after fixing a
point), it still reports since that opening instead of an empty period. With no recorded opening, or an
unreadable file, the window is the current day, said as such (`depuis 2026-09-28 00:00`); `--since` is
quoted as given. (A `session.json` written by 0.18.0 after a close, `depuis la clôture de …`, is still read.)

On success `cadence session next` prints what it recorded (`2 lignes enregistrées pour la prochaine
ouverture`, then the lines as written, blank ones dropped), so `session-close` can report
them without running `session start` again.

`--all` runs the same command inside each project found under the current folder —
`docs/plan/raf.yaml`, or a `cadence.yaml` with `plan:` — and never enters a project
to look for another. `--since` and `--idle` go to every project; an error in one
project is printed in its section and the others still run. It replaces the shell
loop over the sub-folders. A project that is not the root of its own git repository gets a `✗` line
(and exit 2) instead of the parent repository's plan. `--all` and `--depth` are refused outside `session` (`--depth` is also read by `cadence lead tour`),
and `--all` refuses `--file`, `--config` and `RAF_FILE`: each project reads its own plan. For a one-line-per-project overview, `cadence lead tour`.

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

The commands get `CADENCE_SINCE` and `CADENCE_TODAY`. `CADENCE_SINCE` is the `--since` as given; on `session close` without `--since` it is the instant of the last `session start` as an ISO 8601 UTC string (`2026-09-28T07:12:00.000Z`), or `<today> 00:00` when no mark exists.
The commands add facts and decide nothing: a failing command is reported and changes neither
the exit code nor the verdict.

## lead tour

`cadence lead tour [folder] [--idle 3] [--depth n] [--json]` is the lead's morning table, with no model in
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
| `dérive` | the gaps `raf check` reports (a lot whose commits leave a document behind, [`docs.sync`](#documentation-that-follows-the-code), included), counted and the first two shown |
| `notes` | the notes left by the last `session close`, joined with ` / ` and cut at 120 characters |
| `prochain` | the first ready lot (quick wins first) — id and title cut at 60 characters |
| `dépôt` | `non commité` (modified or untracked files), `non poussé` (commits ahead of the upstream), `livraison en cours` (live delivery lock); `propre` otherwise |

When an orchestrated wave is live, one more line closes the tour (not part of `--json`): `vagues en cours : 1 · sessions en cours : 0 · créneaux libres : 1 sur 2` — the lead reads the free slots there instead of computing them (L141).

`--json` prints the same content as an array of objects (`project`, `doing`, `drift`, `notes`,
`next`, `repo`, and `error` when the project could not be read), plus `progress` — `{ done, doing, todo, added7 }`,
the lots done / in progress / to do (dropped and recurring lots left out) and those created in the last 7 days (L149), which
[`cadence-hud`](plugins/cadence-hud/README.md) draws as one progress bar per project. Projects come in the order of the
`priority:` key of the folder's `cadence.yaml` (the one `orchestrate --continue` reads), the others after, alphabetically; an unreadable `cadence.yaml` or
a `priority:` that is not a list of names (`priority: ol`, `priority: []`) keeps the alphabetical order and adds a first row `cadence.yaml · ✗ erreur : <cause>` (`project: "cadence.yaml"` with `error` in `--json`).
Sub-projects are looked for one level down by default. `--depth n` goes `n` levels down (same meaning as in `cadence session start --all --depth n`:
a folder that is a project is not entered; an integer ≥ 1, otherwise refused), and the `depth:` key of the folder's `cadence.yaml`, next to `priority:`, sets it once for all
(`depth: 2`); `--depth` wins over the key, and a `depth:` that is not an integer ≥ 1 adds the same first row `cadence.yaml · ✗ erreur : …` and leaves one level read.
`cadence-hud` asks the tour from the folder of the session, so it follows the key with no change. A project is named by its folder's name, wherever it sits.
"Created in the last 7 days" means today and the six days before. When the folder has no sub-project but is itself a project, the tour is that project's single line
(this is what `cadence-hud` asks from a session opened inside a project). The tour is read-only: it changes
no plan. It exits 0 even when a project is in error — that project's line reads
`beta · ✗ erreur : <cause>`. The `lead` skill runs it instead of one subagent per project.

## corrections

`cadence corrections [folder] [--classify [--model m]] [--cache file] [--sample n] [--until date] [--json]` measures how often a wave
has to correct itself. From the folder a wave was launched from (default: the current one) it reads the journals
`<folder>/.cadence/runs/<wave>/<project>--<lot>.json` of **every project** and prints:

- the **lots with a correction**: of the lots that went through a successful write session, the share with at least one
  and at least two `fix` passes, per project and for visible versus non-visible lots (`61 %` and `29 %` of 263 lots in the 10-10 baseline);
- the **passes by cause**, in total and per project. The cause of a pass is read from the findings of the review that
  precedes it, among: unclear spec or missing criterion (`spec-floue`), invented business rule (`regle-inventee`),
  architecture drift (`derive-architecture`), data / SQL (`donnees-sql`), code bug (`bug-code`), missing test
  (`test-manquant`), false review finding (`faux-constat`). One cause per pass: the root of what forced the fix. A pass with no review finding to read (triggered by red tests right after the write session) is counted apart as `sans-constat` and never sent to the model.

Without `--classify` the command calls no model: the passes not yet classified count as `non classé`. With `--classify`
each pass is classified by a **local model served by Ollama** (`OLLAMA_HOST`, default `http://localhost:11434`;
`--model`, default `mistral-small3.2:24b`; temperature 0, output constrained to the seven causes), off the Anthropic quota.
The classification is cached in `<folder>/.cadence/corrections.json` (or `--cache file`): a re-run classifies only the
new passes, and a pass the model could not answer stays out of the cache. `--sample n` prints `n` passes with findings spread
evenly over the sorted keys, with their findings and the model's cause, to be read by hand; a `manual` field written
beside a pass in the cache file (one of the seven causes, else the command refuses the file) overrides the model's cause in every table and gives the **agreement rate** of the model
on the reviewed sample. `--until date` (ISO, e.g. `2026-10-10T18:31Z`) reads only the waves created up to then (`created` in the wave's `wave.json`) and, in them, only the steps ended by then (`ended`), so that neither later waves nor a wave still running at that time change a published baseline; a wave or a step with no readable date is left out. `--json` prints the measure as data. The command reads the journals and writes nothing but the cache.
The first baseline is in [docs/mesures/corrections-2026-10-10.md](docs/mesures/corrections-2026-10-10.md); `test/corrections-mesure.test.ts` replays its command on the journals and checks the document's results word for word (skipped when the journals are not there).

## spec

`cadence spec check <fiche.yaml>` checks a **sheet** (`fiche.yaml`, the machine-readable output of the spec step): a **screen sheet** (a lot with `screen:`), a **back-end sheet** (a lot that changes a behaviour without a screen) or a **mixed sheet** with both parts. The screen part is designed in
[docs/superpowers/specs/2026-10-10-etape-spec-design.md](docs/superpowers/specs/2026-10-10-etape-spec-design.md)). Start from the template
[`templates/fiche.yaml`](templates/fiche.yaml) (it passes the check as is), a worked example sits next to the design. It prints one
`✗ …` line per violation and exits **0** when the sheet is valid, **1** with violations, **2** when the file is missing, is not YAML or the usage is wrong. The invariants:

- `ecran` has `id`, `titre`, `route` (starts with `/`), `lot`, `maquette`, and `largeurs: [1440, 390]`; `etats` holds at least `vide`, `chargement`, `erreur`, none twice;
- `champs[]`: a unique kebab-case `id` (it is also the mockup's `data-testid`), `libelle`, `type`, `source`, and a boolean `obligatoire`;
- `regles[]` are numbered `R1`, `R2`… in order with no gap; each has an `etat` that is one of `etats`, an `enonce`, a `message` (the exact text on screen, or `null`),
  a `statut` — `sourcee` with the `source` it comes from, or `hypothese` with the `si_faux` that says what would change — and at least one planned test, named `Rn — …`;
- `masque` (optional, only on a rule of state `vide`) lists the fields the rule makes disappear: every id must be a field of the sheet and none may be one the rule shows in `champs`;
- `actions[]` are numbered `A1`… in order, their `declencheur` is a field id (or `null` for the page load), their `appel` reads `VERB /path`, and the `regles` they carry exist.

**Back-end sheet** (L187; design: [docs/superpowers/specs/2026-10-11-etape-spec-back-design.md](docs/superpowers/specs/2026-10-11-etape-spec-back-design.md)). Start from [`templates/fiche-back.yaml`](templates/fiche-back.yaml) (it passes the check as is); a worked example, a real lot of ol-companion, sits next to the design. The sheet has `sujet` instead of `ecran` (no `etats`, `champs`, mockup), and the same `regles`. The back-end invariants, one `✗ …` line each:

- `sujet` has `id` (kebab-case, the folder name `docs/specs/<id>/`), `titre`, `lot`, and a `perimetre` with `modules`, `endpoints` and `jobs` (lists of texts, at least one entry in the three) and an optional `hors_perimetre`;
- `cas[]` are numbered `C1`, `C2`… with no gap, each with `titre`, `acteur`, `declencheur`, `preconditions`, `nominal` (a non-empty list of steps), `resultat`, and `alternatives` — a list of `{ si, alors, regles }`, each citing at least one existing rule — or `alternatives: []` with its reason in `sans_alternative`; every case is cited by at least one rule;
- a back-end rule has `cas` (at least one existing case id) instead of `etat`, plus the screen rule's `enonce`, `statut` (`sourcee` + `source`, or `hypothese` + `si_faux`) and tests named `Rn — …`; `message`, `champs` and `masque` only make sense on a rule attached to a state;
- `contrats[]` are numbered `A1`… with no gap, each with an `appel` (`VERB /path`, `job <name>` or `commande <name>`), `entree`, `sortie`, `erreurs` — a list of `{ code, message }` where `code` is `HTTP <n>` or `log debug|log|warn|warning|error|info|critical|fatal|verbose` and `message` the exact text — or `erreurs: []` with its reason in `sans_erreur`, and the `regles` it carries exist;
- `donnees[]` are numbered `D1`…, each with `objet`, `note`, a boolean `existant` and a `modification` (`aucune`, `ajout` or `changement`); an existing object that is modified carries the `decision` of the lead (the answer to the targeted question). The list may be empty (`[]`: the lot touches no data).

**Mixed sheet** (a lot with `screen:` and a back-end part): `sujet` **and** `ecran` side by side, with the same `id` (the folder name) and the same `lot`. A rule is attached to a state (`etat`, a screen rule) or to cases (`cas`), at least one of the two. The `A` ids are shared: the actions of the screen and the `contrats` are numbered `A1…An` with no gap over the whole, and an action that calls an API already listed in `contrats` points to it with `contrat: Ax` instead of repeating its `appel`. An action that has its own `appel` equal to the `appel` of a contract is reported (it must point to the contract). A sheet without `ecran` refuses `actions`, `etats` and `champs` (they only make sense with a screen part), and a rule with `etat` there gets that single report. A sheet that only has `ecran` stays valid as it is (no migration); `sujet` is required as soon as the lot is back-end or mixed.

`cadence spec check` prints the same summary line for each kind (`N cas, N règles (N hypothèses), N contrats, N données` for a back-end sheet) and keeps its exit codes: 0 valid, 1 violations, 2 usage.

`cadence spec reseal <lot> <test> --reason texte` is the lead's way to correct one sealed acceptance test of the lot in progress that contradicts its (unchanged) sheet, see [The accept step](#the-accept-step-red-acceptance-tests-and-their-lock).

`cadence spec qa <fiche.yaml>` derives from a valid sheet the section of `docs/qa/expectations.md` for its screen and prints it on the standard output
(it never writes the file: you paste the section, and the lead commits it like the rest of the plan files). A sheet with violations prints them on the
error output, nothing on the standard one, and exits 1. The derivation is built so that the planned empty and error states are never reported as defects:

- `## <route>` is the screen's route;
- `shows:` — one line per mandatory field (its `libelle`), **except** the fields that belong to a state (listed in `champs` of a rule of state `vide` or `erreur`, like the empty-state message);
  the line of a field listed in the `masque` of a `sourcee` rule of state `vide` ends with `— unless <the rule's statement>`; the other fields (a static title) never get one;
- `never:` — the messages of the rules of state `erreur`, on one line; the message of a rule of state `vide` is a planned display and never goes there;
- `api:` — the load actions only (`declencheur: null`) in `GET` (the QA pass never sends a POST); the line ends with `may be empty when <the rule's statement>` when a `sourcee` rule of state `vide` carries the action.
  Actions triggered by a field stay with the acceptance tests.

`spec qa` only derives the **screen** part: a back-end sheet, which has no `ecran`, is refused (exit 2, « la fiche n'a pas de partie écran »); on a mixed sheet it reads the actions' calls through their `contrat`.


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
- With [`docs.articles`](#an-article-elsewhere-that-follows-the-delivery), a green delivery of lots with a
  public title also opens the lot `Article <project> à rafraîchir` in the plan.

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
cadence orchestrate --continue [--until 18:00] [--priority cadence,maritime]   # the wave draws the next ready lot itself (below)
cadence orchestrate --status [<wave>]        # the live waves and the repositories they hold, then the table (default: the last wave of this folder)
cadence orchestrate --status [<wave>] --watch [--interval 10]   # the same, redrawn every 10 s (--interval in seconds); stops by itself when no wave is running (with an explicit `<wave>`: when that wave is no longer running)
cadence orchestrate --resume [<wave>] [--budget 1M] [--answer ol-companion:L22 "reply"] [--drop ccc:L29]
cadence orchestrate --drop ccc:L29 [--wave <wave>]   # from another terminal: take a lot out of the running wave
cadence orchestrate --stop-after-current [--wave <wave>]   # from another terminal: let the running sessions finish, start nothing else
```

**`--drop` and `--stop-after-current` — steering a running wave (L79)**: both are run from the folder the wave was launched
from (`--wave <id>` when several waves run from it), and write a request in the wave's state folder
(`.cadence/runs/<wave>/control.log`, append-only), which the wave reads before each session — no signal, no edit of
`journal.log`. `--drop <project:lot>` (repeatable) takes a lot out of the wave: a lot not started yet never starts (no
`raf start`); a lot with a session running **lets that session finish** (it is not killed), then plays no other: it is
*handed back* (`retiré de la vague (--drop)`), its commits stay, and a lot that depended on it is handed back too. A lot
waiting for an answer (`question`) is handed back as well, at the end of the wave or on `--resume --drop`, instead of staying in
question forever. A lot that is unknown or already finished is refused (exit 2). `--stop-after-current` lets the sessions running finish, starts no
other session nor lot (`arrêt demandé (--stop-after-current)`), and leaves the wave **interrupted** and resumable
(`--resume`, which forgets the stop; `--continue` draws nothing more). Neither combines with lots to launch,
`--continue`, `--dry-run`, `--budget` or `--answer`, nor `--status`; without a live wave from that folder they are refused
(exit 2). A stopped wave is no longer live, so to take a lot out of it use **`--resume --drop <project:lot>`**: the lot is
handed back instead of being replayed (an unknown or finished lot is refused, exit 2, before anything runs). A lot taken out
this way is left out of the resume checks (repository lock, `.nvmrc` Node, dirty tree): only the lots that will be replayed can
refuse the resume, and a refusal writes nothing to `control.log`.
`--resume --stop-after-current` is refused (exit 2): resuming contradicts stopping.
A wave runs on its own snapshot of the tool: one launched before L79 never reads `control.log`, so the request is written but the
command warns `ne lit pas les demandes de contrôle` on the error output.

**`--continue` — idle time (L147)**: lots given on the command line open the wave (none: the first ones are drawn from the
plan too); then, each time the lots in play are finished, the wave **draws the next ready lots of the plan** — up to the
session cap — and plays them in the same wave (same budget, same state folder, journal line `continue : tire …`). A lot
is drawn when it is `todo`, its `after` is lifted, it is not recurring, neither its title nor a note says « à décider »
(« à décider avec … », « (à décider) »: a lot waiting for a human decision), it is not already in the wave, and its own budget (derived from its estimate; a lot with `screen:` is worth 1.3 M whatever its estimate, or its ordinary budget plus the 350 k spec-stage allocation if that is more, and a lot with `spec: true` gets that allocation on top of its ordinary budget)
fits in the budget left — otherwise the next one that fits is taken (a lot that does not fit in what is left of the current
round is not dropped: it is tried again at the next round, once the budget allows it). A round takes at most **one lot per
repository** while other repositories have ready lots — the pool plays the lots of one repository one after the other, so a
second one would leave a session idle — and is completed with the same repository when nothing else is ready. Projects are visited in the declared **priority**:
`--priority cadence,maritime`, or a `priority: [cadence, maritime]` list in the `cadence.yaml` of the folder you launch from
(the parent of the projects); a name also covers `name-…` (`maritime` → `maritime-atlas`), the other projects come after, in
alphabetical order. Launched from inside a project, only that project is drawn. A `priority:` key that cannot be read is refused before anything
starts, lots given or not. A candidate that preflight refuses (dirty tree, Node missing…) is skipped with its cause in the
journal (`continue : lot sauté — <cause>`; for the first draw also on the error output). Drawing stops — `continue : arrêt — <reason>` — at: the budget, the
time window (`--until HH:MM`, today's clock: nothing new is drawn from then on, a running lot is not cut), the usage limit,
a question asked (the wave stays resumable with `--answer`), two lots handed back in a row, an interrupted wave, a `--stop-after-current` request (`arrêt demandé`, even when the last running
lots finished cleanly), or no ready
lot whose estimate fits the budget left. `--resume … --continue` draws again after the resumed lots. `--dry-run --continue` replays the
draws round by round with the same function as the wave (one lot per repository per round, pre-check, budget counted on the estimates) and
names the candidates skipped with their cause: `tour 1 : a:L2, b:L2 · tour 2 : a:L3, a:L4`. Drawing happens between rounds: a round of up to `--max-sessions` lots must finish before the next draw.

**Chaining without the human (L148)**: the `lead` skill, once the human has chosen the first lots and the order, does not ask « next? »
after a lot that comes back ready: it re-verifies it, records `raf done`, pushes, delivers, has the `qa-reviewer` check the
delivered app, then starts the next wave with `--continue`, in the declared priority — one project at a time, within the two-session
limit. Before each new wave it reads the context of its own session with `cadence session context` (the figure of the `ctx` segment of the `cadence-hud` band, which publishes the context of each session to `~/.cadence/orchestrate/hud-context/<session id>.json`; the command picks the file named by `$CLAUDE_CODE_SESSION_ID`, set in the environment of the session's Bash, never "the latest file of the folder" — two sessions of one folder alternate; without the band loaded in that session the command exits with code 2, and a missing or stale figure counts as at the threshold); from
**60 %** upward it starts nothing: it runs `session-close` in each project touched, writes its memory and records three lines for next
time (`cadence session next`). Stays with the human: the first choice and the order, the questions a session raised, the UX
reservations; a lot that is not ready, a red delivery or a blocking QA finding is reported and not chained over.

**Who gives the UX verdict (L197)**: by default the human looks at the `ux-reviewer`'s captures and gives the verdict of a `visible`
lot (`raf ux`). A human who is not a UX judge can set, in the `cadence.yaml` of the folder the `lead` skill works from:

```yaml
lead:
  ux: lead     # lead | human — default human, nothing changes without the key
```

With `lead.ux: lead` the lead forms the verdict itself, from the reviewer's report and its own look at the captures, records
`raf ux` and goes on; the human is consulted only at the slightest doubt (a reservation it cannot settle, a capture it
cannot read, a matter of taste), and the chain goes on with the other lots meanwhile. `cadence lead tour` prints
`verdict UX : lead …` as a last line when the setting is on (not part of `--json`), and `cadence.yaml · ✗ erreur : lead.ux doit
être « lead » ou « human »` for any other value. The setting is read from the parent folder only: a project's own `cadence.yaml` ignores it.

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

**Effort level per pass** (L137). Each session is launched with `claude -p --effort <level>` (Claude Code 2.1.284; an
older `claude` is refused at launch unless every pass is `default`). Defaults: `precheck` low (it only reads),
`implement` and `fix` medium, `review` high (`review-small` follows `review`), `ux` high. A project overrides any of them
in `cadence.yaml`; the levels are `low`, `medium`, `high`, `xhigh`, `max`, and `default` sends no `--effort` (the
level of the session, as before this key). The format-retry session (`--resume`) keeps the level of its pass, and
`--dry-run` shows the flag in each command line, except for a `precheck: local` session: `claude-local` is launched
without `--effort` (see below), so `effort.precheck` has no effect on it and the `precheck (local)` line does not show it.

```yaml
orchestrate:
  effort: { precheck: low, spec: medium, maquette: high, fiche: medium, accept: medium, implement: medium, fix: medium, review: high, ux: high }   # defaults
```

To measure what a level costs, run the same kind of wave before and after changing the key: each step of
`<wave>/<project>--<lot>.json` records its `effort`, its `tokens` and its `started` / `ended` times (a step from a wave
older than L137, or with `default`, has no `effort`); compare the totals per `kind` between the two waves.

**Pre-check « deliverable already present? »** (L77). Before the first implementation of a lot that has no commit yet, a
short read-only session (Sonnet, `precheck` step, brief `templates/orchestrate/precheck.md`) looks in the repository for
what the lot asks for (another lot, or a correction, may have done it already). It answers `oui` (everything is there,
with proofs), `partiel` or `non`: on `oui` no implementation session is opened and the lot is handed back
(`livrable déjà présent : <résumé> (<preuves>)`) for the lead to drop or close it; on `partiel` the finding goes into the
implementation brief and a warning; on `non` — or an unreadable report, which only adds a warning — the wave goes on. A
lot that already has commits is never pre-checked (resuming it is legitimate). `orchestrate.precheck: false` turns it off.

### The spec step of a lot with `screen:`

A lot that declares `screen:` (`raf add … --visible --screen page|component|journey`, or `raf screen <id> page|component|journey` on a lot that already exists, see [raf](#raf)) gets one more session, `spec`, **after** the pre-check and **before**
the first implementation: `precheck → spec → maquette → accept → implement → ux → review` (`maquette` unless `orchestrate.maquette: false`, see [The mockup review](#the-mockup-review-before-any-code); `accept` only when the project declares `orchestrate.accept`, see below). A lot without `screen:` or `spec: true` follows the usual path, unchanged (a lot with `spec: true` and no screen has its own chain, see [The spec step of a lot with `spec: true`](#the-spec-step-of-a-lot-with-spec-true)). `--dry-run` lists the step
(`spec (sonnet)`), its command line and its brief `templates/orchestrate/spec.md`.

- **The session** (L171): Sonnet, the `spec-writer` agent (it writes only the spec folder, never application code), Playwright loaded like for `implement`. It reads the lot,
  the project's CLAUDE.md and its charter (CSS, neighbouring components, `docs/qa/expectations.md`, existing routes and API contracts), then writes in
  `<orchestrate.spec.dir>/<écran>/` (`docs/specs` by default): `maquette.html` (static HTML + CSS to the project's own style; one section `#etat-vide`, `#etat-chargement`,
  `#etat-erreur` and `#etat-charge` per state; every field of the sheet carries `data-testid="<field id>"`), one capture per state and per width
  `maquette-<état>-<largeur>.png` (1440 and 390), and `fiche.yaml` (the template `templates/fiche.yaml` is part of its brief). The mockup is rendered by
  `orchestrate.spec.render` when the project declares it (the session runs that command), otherwise with Playwright; the captures land in the wave's output directory and the session copies the
  kept ones into the folder. `effort.spec` (default `medium`) sets its effort level. It commits the whole spec in one commit that cites the lot (`spec(L7): …`).
- **What the program checks** afterwards, with no model: the sheet passes `cadence spec check`, is the lot's (`ecran.lot`) and sits in the folder named by `ecran.id`; `maquette.html` exists with a
  `#etat-<état>` section per state and a `data-testid` per field; every state has its capture at both widths; everything is committed and the tree is clean. Anything missing is listed back to **one second
  `spec` session** (a fresh session whose brief names the points); if the second spec is still not valid the lot is handed back (`spec non conforme après 2 passes : …`).
- **A costly choice is a question, not a hypothesis.** A rule marked `hypothese` whose `si_faux` involves a data model or storage, a public or shared API contract or an already published route,
  a destructive or irreversible action, or a contradiction with a sourced rule, puts the lot in `question` (the program recognises these by keywords as a safety net behind the agent's own
  judgement; a keyword right after a negation — « rien d'irréversible », « sans suppression », « pas de paiement » — does not count); `--resume --answer <lot> "…"` gives the answer to the resumed `spec` session. Every other hypothesis (wording, order of fields, error state, spacing) stays written in the sheet.
  The agent can also ask a question itself in its report.
- **Under the threshold**: if the session finds that the lot changes no screen, it gives the reason in one line (`sousSeuil`), writes no mockup, and the lot goes on to `implement` as before; the reason is
  kept as a warning of the lot. On resume the spec step is skipped only when a sheet of the lot (`ecran.lot` is the lot) already passes the program's checks (`cadence spec check`, mockup, captures) and carries no costly hypothesis; otherwise the spec is played again. The sheet path in the report is relative to the repository (an absolute or `./` path is normalised, a path outside the repository is a finding).

### The spec step of a lot with `spec: true`

A lot that changes a behaviour but has no screen (`raf add … --spec`, or `raf spec <id> on`, see [raf](#raf); L188, design: [docs/superpowers/specs/2026-10-11-etape-spec-back-design.md](docs/superpowers/specs/2026-10-11-etape-spec-back-design.md)) is specified **before** it is coded, on a sheet, like a screen:
`precheck → spec → fiche → accept → implement → review` (`fiche` unless `orchestrate.fiche: false`; `accept` only when the project declares `orchestrate.accept`). A lot with neither `screen:` nor `spec: true` keeps its path. `--dry-run` lists
`spec (sonnet)`, `fiche (sonnet)` and `accept (sonnet)` with their command lines and briefs `templates/orchestrate/spec-back.md`, `fiche.md` and `accept-back.md`; the lot's budget gets a 350 k allocation on top of its estimate-derived budget (the worst case measured on a screen lot's steps: the back chain has not been measured yet).

- **The spec session**: Sonnet, the `spec-writer` agent, no Playwright. It reads the lot, the project's CLAUDE.md and the code and tests of the modules the lot touches (a rule already coded is a source, cited `file:line`), then writes only
  `<orchestrate.spec.dir>/<sujet>/fiche.yaml` in the format of [`templates/fiche-back.yaml`](templates/fiche-back.yaml) (`sujet`, `cas`, `regles`, `contrats`, `donnees`; no mockup, no capture, no state) and commits it with a message that cites the lot.
  The same rules as for a screen: a rule is `sourcee` or `hypothese` with its `si_faux`, and a hypothesis that hides a costly choice is a question (a stored model, a published contract or route, an irreversible action, a contradiction with a sourced or coded rule — the program's keyword safety net applies as is).
  An optional field added to an existing response is not a break when a rule of the sheet proves the old response unchanged. A lot that changes no behaviour is reported under the threshold (`sousSeuil`, warning `étape spec : sous le seuil, aucune fiche — …`) and follows the usual path.
- **What the program checks**: the sheet passes `cadence spec check`, has a `sujet` block, is the lot's (`sujet.lot`), sits in the folder named by `sujet.id`, and is committed with a clean tree. Anything missing goes back to **one second `spec` session**; still invalid, the lot is handed back (`spec non conforme après 2 passes : …`).
  On a resume the step is skipped when a sheet of the lot (`sujet.lot`) already passes these checks and has no costly hypothesis.
- **The sheet review** (`fiche`): a fresh session of the `code-reviewer` agent in **sheet mode** (Sonnet, read-only, no Playwright; `effort.fiche`, default `medium`). It reads the sheet, then the code, tests and sources of the perimeter, and checks (1) every `sourcee` rule cites a source that exists (it opens the file:line) and no `hypothese` hides a costly choice,
  (2) no contradiction with a rule already coded or an existing contract, (3) every contract has its empty / absent / expired / oversized / duplicate inputs and the failures of its external sources covered by a rule or a motivated `sans_alternative` / `sans_erreur`, (4) every rule has a planned test whose name says what could fail.
  Findings are ranked blocking / major / minor, each with its measurement. A blocking or major one sends the sheet back for a **second `spec` session** (its brief carries the findings), then the sheet is reviewed again; still not conforming, the lot is handed back with what remains (`fiche non conforme après 2 revues : …`).
  The `spec` session has **one budget of two sessions**, shared by the program's check and the reviews: if the check already used the second one, a non-conforming review hands the lot back at once (`fiche non conforme et la spec a déjà joué 2 sessions`), with no second review. A question to the lead (the session's own, or a costly hypothesis) and its answer open a new budget.
  Minor findings become notes of the lot (`Revue de la fiche — mineur : …`, one per finding, committed with the plan; on a read-only plan they become `[note à poser]` proposals), not lines of the final table. This verdict is **not** `raf review`: the review of the code keeps that role. `orchestrate.fiche: false` skips the step.
- **A lot with a screen and a behaviour**: it is a lot with `screen:` whose **sheet** has a back part (a `sujet` block next to `ecran`, same folder), never a `spec: true` beside `screen:` (`raf spec <id> on` has no effect on a lot with a screen). The program reads the sheet, not the plan: as soon as the sheet has a `sujet` block (the contracts), the `code-reviewer` also reviews it,
  the chain is `spec → fiche → maquette → accept`, and the findings of the two reviews go together to a single second `spec` session. The brief of the spec of a lot with a screen offers the back part (and joins its template) without making it compulsory; a lot whose sheet has no `sujet` keeps its chain, without `fiche`. `--dry-run` cannot list `fiche` for a lot with a screen (the sheet does not exist yet).
- **Acceptance and code**: `accept` is the screen's step, with a back brief (`accept-back.md`: cases call the contracts of `contrats[]` as close as possible, external sources simulated from `entree`; no `data-testid`). `implement`, `fix` and `review` receive the sheet (cases, rules, contracts) as for a screen, without mockup; the review also checks that each contract is held (output, exact codes and messages of the errors).
- **Hypotheses**: a lot without a screen has no News entry. Once the sheet is final — after its review and the second `spec` session if there was one, just before `accept` or `implement`, and also for a sheet already present on a resume — the program writes **one note of the lot per hypothesis** (`Hypothèses (fiche <sujet>) — R3 : … ; si faux : …`, not duplicated on a resume) and commits it with the plan; on a plan kept by another tool the lines become proposals (`[note à poser] …`). The end-of-wave table lists them under each lot (`hypothèse de la fiche : …`) for the lead to relay.

### The mockup review: before any code

After a valid spec, a lot with a sheet gets a UX review of its mockup, `maquette` (L172), unless `cadence.yaml` sets `orchestrate.maquette: false` (default `true`): `precheck → spec → maquette → accept → implement → ux → review`.
`--dry-run` lists the step (`maquette (opus)`, the `review.full` model), its `ux-reviewer` command line and its brief `templates/orchestrate/maquette.md`.

- **The session**: the `ux-reviewer` agent in **mockup mode**, read-only, Playwright loaded, a fresh session. It opens `maquette.html` as a local file (no application, no server), looks at the captures
  `maquette-<état>-<largeur>.png` (1440 and 390 px) of every state, reads `fiche.yaml`, and reports findings ranked blocking / major / minor, each grounded in a rule (Nielsen, WCAG 2.2 AA) or a measurement. On top of
  that it checks the **consistency mockup ↔ sheet**: every field of the sheet in the mockup with its `data-testid`, every rule message visible, word for word, in the state its `etat` names, every state with its
  `#etat-<état>` section, the `masque` of an empty-state rule really hiding the fields it names. `effort.maquette` (default `high`) sets its effort level. Its verdict is **not** `raf ux`: the conformity pass after the code keeps that role.
- **The loop, two reviews at most.** A blocking or major finding sends the mockup back to the spec writer: a **second `spec` session** (fresh, its brief carries the findings), then the mockup is reviewed again. If the second review is
  still not conforming, the lot is handed back with what remains (`maquette non conforme après 2 revues : …`) and nothing is implemented. The same budget of two `spec` sessions applies as for the sheet review: if the program's check already used the second one, a non-conforming review hands the lot back at once (`maquette non conforme et la spec a déjà joué 2 sessions`); an answer to a question of the lead opens a new budget. A conforming review goes on to `accept` (or `implement`). On a resume, a **sealed** `acceptation.json` (its `empreintes` set by the program), still red or already green (`vert: true`), proves the review was done and is not replayed; an unsealed one proves nothing. A `maquette` step with no sheet warns (`revue de la maquette ignorée : aucune fiche …`) and goes to `implement`.
- **Sample data** (L181): the spec brief asks the writer to compute the weekday of every date of the mockup (not to write it from memory), and the review recomputes them. A wrong sample datum (weekday, date, figure that does not add up) is a **minor** finding, never a major one, so it cannot by itself send the mockup back for a second review.
- **Minor findings** are not sent back: they are kept as proposals of the lot (`[mineur maquette] …`), like the minors of the other reviews. A report whose totals announce a major finding is not taken for conforming.
- **On resume**, a sheet already committed is reviewed before the next step, unless the lot already has a sealed, conforming `acceptation.json` (it can only have been written after the review), or already has code committed after the sheet (a commit citing the lot that touches a file outside the sheet's folder: `implement` only started once the review was done), including without `orchestrate.accept`.

### The accept step: red acceptance tests and their lock

After a valid spec, and only when `cadence.yaml` declares `orchestrate.accept` (the project's **dedicated command**, or a list of them, which run *only* the acceptance tests of one lot), a lot with a sheet gets one more
session, `accept` (L173): `precheck → spec → maquette → accept → implement → ux → review`. Without `orchestrate.accept` the step is skipped, with a warning on the lot (`étape accept ignorée …`), and the lot goes from `spec` to `implement` as before.
`--dry-run` lists the step (`accept (sonnet)`) and its brief `templates/orchestrate/accept.md`.

- **The session**: Sonnet, the `acceptance-writer` agent, a session other than the implementer's. Its brief gives it the sheet, the mockup and how to run the project's tests (the dedicated command, and the runner template below) — not the lot's objective, notes or
  sub-tasks, and no implementation. It writes one or more cases per rule, **named as the sheet plans them** (`regles[].tests`, e.g. `R3 — erreur : message et bouton Réessayer`), selectors = the `data-testid` of the fields, API calls simulated from `actions[]`,
  and commits them **red** in one commit (`test(L7): acceptation R1–Rn (rouge)`) with `<spec.dir>/<écran>/acceptation-<lot>.json` (**one file per lot**: two lots on the same screen never share a lock or a file; the id is reduced to `A-Za-z0-9._-`, so `app/L7` gives `acceptation-app-L7.json`; an older `acceptation.json` is still read, by its `lot` key) — `{ "lot", "fiche", "fichiers": [...], "vert": false }` — and the runner configuration. A second lot's tests that rewrite the first lot's test files hand the lot back, with the file named (the lock below). `effort.accept` (default `medium`) sets its effort.
- **One command or a list of runners** (L189). `orchestrate.accept` is a string or a **list** of commands, for a project with a front and a back runner (Vitest in `frontend/`, Jest in `backend/`):

  ```yaml
  orchestrate:
    accept:
      - cd frontend && npx vitest run -c vitest.acceptation.config.ts
      - cd backend && npx jest -c jest.acceptation.config.js
  ```

  The program runs **each** command from the repository root with `CADENCE_ACCEPTATION` (and `{acceptation}` substituted) and `CADENCE_ACCEPTATION_ROOT`, the command's **root**: the folder of its leading `cd <folder> &&`, else the repository (`.`). A command takes **only the files listed under its root**: `acceptationOnly()` of the runner template returns them relative to that root, where the runner starts. A command with **no listed file under its root is not run**; a listed file under **no root** is a deviation of the step (`fichiers listés … sous la racine d'aucune commande de orchestrate.accept`, one second pass, then `accept non conforme après 2 passes`). **Red check**: every command that is run must fail (the deviation names the one that passes); **green**: `vert: true` is set only when all of them pass, and a lot sent back to `fix` is told which commands are still red. A string keeps its behaviour: **it ignores its `cd` for the root** — the whole repository is its root and `CADENCE_ACCEPTATION_ROOT` is `.`, so `acceptationOnly()` returns paths relative to the repository; only a list derives a root from each command's leading `cd`. One lot per app wires its back runner (dedicated config, `exclude` in the ordinary one, a line in `cadence.yaml`): that is the app's plan, not cadence's.

  **Moving from a string to a list.** The two forms are not interchangeable: a string keeps the repository as its root, a list (even of **one** element) derives each root from the command's leading `cd <folder> &&` and sets `CADENCE_ACCEPTATION_ROOT` to it. The brief of the step and the cycle decide by the same test (a YAML list or not), so they always agree. To switch: (1) write the entries as `cd <folder> && <runner>`; (2) make the runner's config resolve from its own root (its `include` and `rootDir` relative to `<folder>`, since the runner starts there and `acceptationOnly()` returns the paths relative to that root); (3) **copy the runner template again** into the project (`templates/acceptation-runner.mjs` reads `CADENCE_ACCEPTATION_ROOT`; an older copy lists the repository-relative paths and matches nothing from a folder). A project that has not migrated stays on its string, unchanged.
- **Out of the ordinary test run and the CI while the lot is not green.** Red tests committed would fail `orchestrate.test` (after every `implement`/`fix`) and the project's CI (which `cadence deliver` waits for), for lots that are not theirs. So the
  runner configuration shared by `orchestrate.test` and the CI excludes the files listed in every acceptation file (`acceptation-<lot>.json`) whose `vert` is `false`, and only the dedicated command runs them. `templates/acceptation-runner.mjs` is the helper the session copies
  into the project: `acceptationIgnored()` (Vitest `exclude`; `acceptationIgnored(root, dir, 'regex')` for Jest `testPathIgnorePatterns`) and `acceptationOnly()` (the `include` of the dedicated config, which reads the environment variable `CADENCE_ACCEPTATION`:
  the program sets it to the absolute path of the lot's acceptation file when it runs `orchestrate.accept`, and also replaces `{acceptation}` in the command with that path — quote it if the path may hold spaces). If the CI or the test command do not use that config
  (paths hard-coded), the session must not commit red tests and puts the question in its report.
  **Run by hand, outside a wave**, the dedicated command fails: `acceptationOnly()` requires `CADENCE_ACCEPTATION`, which only the program sets. Set it yourself, to the path of the lot's acceptation file:
  `CADENCE_ACCEPTATION=<path of the acceptation file> <command>` (with a `{acceptation}` in the command, write the path there too). For a command of an `orchestrate.accept` **list**, also set its root, which `acceptationOnly()` uses to return the files relative to where the runner starts: `CADENCE_ACCEPTATION=<path of the acceptation file> CADENCE_ACCEPTATION_ROOT=<root of the command> <command>` (the folder of its leading `cd <folder> &&`; without the variable the root is the repository `.`, and the paths are relative to it, which no runner started in a folder will match). A single string needs no root. Once the lot's tests are green (`vert: true`), they join the ordinary runner and the CI, so the usual test command runs them without that variable.
- **What the program checks** afterwards, with no model: `acceptation.json` is the lot's (`lot`, `fiche`, listed files committed, `vert: false`), every test name planned in the sheet appears in the listed files, **each listed test file is new** (absent from the head before the first `accept` session: tests written into an existing test file would leave the ordinary run and the CI while the lot is red, so the check refuses `existait avant la session accept`), the other lots' acceptation tests are untouched, the dedicated command
  **fails** (a test green before the code proves nothing), `orchestrate.test` stays **green** with the red tests committed (proof that they are excluded; without `orchestrate.test` nothing proves it, and the step passes with a lot warning only), and the tree is clean. Anything missing goes to **one second `accept` session**; still not valid, the lot is handed back
  (`accept non conforme après 2 passes : …`). A question in the report puts the lot in `question`, like the other steps. The check that each listed test *individually* fails is not made: only the dedicated command's exit code is (it fails if any of them fails).
- **The seal.** Once the checks pass, **the program** (not the session) adds to `acceptation.json` the git fingerprint of each listed file (`empreintes`) and commits it (`test(L7): acceptation scellée …`): that commit is the **red commit**. Its sha is written nowhere in the file (a session could rewrite it): it is
  the latest commit in git history that changed the file otherwise than by its `vert` key, and the wave keeps it in the lot's state (`accept.rouge`) too.
- **The lock, for every session of the repository.** At the end of each `implement` and `fix` the cycle compares, for the acceptation files of **all** lots found under `orchestrate.spec.dir` (a repository has one queue: the next lot runs on the same branch), the listed test files with the red commit
  (`git diff <red commit> -- <files>`, empty expected, working tree included, and the fingerprints), and each `acceptation.json` with its version before the session. The only difference tolerated on `acceptation.json` is the `vert` key, and only **the cycle** sets it: a session that changes it, rewrites the
  file, deletes it, creates one outside the accept step, or modifies a locked test hands the lot back (`verrou des tests d'acceptation : …`) — a useful change is a question to the lead or a review finding, never a silent gesture. The lock does not depend on `orchestrate.accept` being declared. **Exception — a delivered lot (`vert: true`):** a later lot that makes the rule evolve may modify the listed tests of that acceptation when **the sheet of the screen changes in the commits of the same lot** (compared with the head before the lot's first session, working tree included, or in a commit that cites the lot, even made before the wave): the sheet is what evolves the rules, and tests and sheet change together. The exception never covers the acceptation of the lot in progress (its `vert: true` is set right after the implement): that one keeps the whole lock. Without a sheet change the difference is still a deviation — except one narrow case (L184): a listed file whose content is identical to what it was at the head before the lot's first **work** commit (commits found by the plan's refs) is not a deviation, the lot having taken its own addition back (a lot handed back for writing in a locked file and resumed in a new wave, which then removes that addition). This applies to every acceptation, `vert: false` included, but only to a file that **exists** at that head and now: a file absent at that head (e.g. created by the lot's own red commit) or deleted since is never exempted, so deleting a locked test stays a deviation; nor when the sheet of the screen has changed since that head (an evolution admitted for another lot: going back to the old content would cancel it, not the lot's addition); apart from that, with `vert: false` the whole lock applies, sheet change or not; `acceptation.json` itself stays locked (only its `vert` key moves).
- **A sealed test that contradicts the sheet: `cadence spec reseal` (L200).** The lock is total for the lot in progress (the delivered-lot exception above never covers it), so a test that is wrong against an unchanged sheet — e.g. the regex `/\d{1,2} /` of an acceptance test rejecting « T3 2027 annoncée », which the sheet allows — would leave the lot handed back with no way out. The way out is the lead's, outside any wave: correct the test in the working tree (**the sheet unchanged**), then `cadence spec reseal <lot> <test> --reason "why the test contradicts the sheet"`. The program checks that the lot is in progress (`doing`), that the test is listed in the lot's sealed `acceptation-<lot>.json`, that the sheet is unchanged since the red commit, that **no other listed test** changed (the lock keeps everything else) and that the test did change; it then redoes the fingerprint of that one test, appends `{ test, raison, date, avant, apres }` to the `resceaux` key of `acceptation.json`, commits the test and `acceptation.json` (`test(L35): acceptation rescellée, <test> : <reason>`, the new red commit) and the lot's note with the reason (`plan: …`). It is refused during an orchestrated wave (`CADENCE_ORCHESTRATED`, or the repository's wave lock while one of its lots still works, like `cadence deliver`), with no `--reason`, and on a lot that is not in progress. Then, depending on how the lot stands: a lot waiting on a `question` is continued by `--resume --answer` (the cycle moves its red-commit anchor to the resealed commit, a rewrite of `acceptation.json` without a `resceaux` entry still being a violation); a lot handed back with `verrou des tests d'acceptation` is finished for `--resume`, so it is replayed by a new wave `cadence orchestrate <project>:<lot>`, which starts again from the red commit. A session never does it, three guards: (1) `cadence spec reseal` is in the sessions' `--disallowedTools` (like `raf done`/`review`/`ux`); (2) a resealed commit is adopted as the new red commit only if it belongs to **no session of the wave** (commits listed in each `steps[].commits`, or in `headBefore..headAfter` of any session of any lot of the wave) — otherwise it stays a violation of the lock; (3) the lock is checked at the end of **every** work session, a session that ends with a question included, so a session that replaces the test, forges the fingerprint, commits and asks a question is handed back with `verrou des tests d'acceptation` without waiting for the lead's `--answer`. The reseal is atomic: if the commit fails (a `pre-commit` hook exiting 1, say) `acceptation.json` and the test are put back as they were before the command (the lead's correction in the working tree is kept, nothing staged) and a readable error says nothing was resealed. With a plan kept read-only by another tool, the reseal itself succeeds but the plan is not touched: the note of the lot is left to the lead (the reason stays in `acceptation.json` and in the commit message; the command only says a note is to be added). With a plan outside the repository or untracked, the note **is** written in the plan file but not committed (the command says `plan à commiter`); do not add it a second time. If the commit of the note is refused (a hook), the reseal stays done: the error gives its commit and says the note, already written, is to be committed by hand.
- **Back to green, set by the cycle.** At the end of each `implement`/`fix`, once the session reports green, the cycle runs the dedicated command. Red: the findings go to a `fix` pass (the tests are made green without editing the locked files). Green: the cycle sets `vert: true` and commits it (`chore(L7): acceptation verte …`;
  `commitPlan` may commit the `acceptation.json` files, otherwise the dirty tree would stop the lot). The files then join `orchestrate.test` and the CI, which keep the lot green from then on; the following lot, running with `vert: true`, is compared with the head before its own work, not with the red commit, only once the sheet has changed between the red commit and that head: after an admitted evolution (tests changed along with the sheet) it sees no difference either; only a test changed *during* that lot without the sheet is a deviation.
- **When the lot is handed back** (question, budget, passes exhausted) its tests stay red but excluded from the project's runner and CI: the next lots and `cadence deliver` do not see them; `--resume` continues with the same lock. On resume, the step is skipped when the lot already has a valid committed **and sealed** `acceptation.json` (its `empreintes` set by the program); a conforming file without them proves nothing and `accept` runs again. The fingerprints are keyed by normalised path, so a listed `./test/x.ts` is recognised like `test/x.ts`, on resume and by the lock (which compares it to its fingerprint).

### The downstream briefs: sheet, rule → test → green, conformity, Hypothèses

Once the sheet exists, the steps after it all read it (L174, `src/orchestrate/aval.ts`, the `{{fiche}}` marker of the templates `implement.md`, `fix.md`, `fix-minors.md`, `review.md`, `review-small.md` and `ux.md`). A lot without a sheet (no `screen:`, or under the threshold) keeps exactly the briefs it had.

- **`implement` and `fix`** get the path of the sheet and of the mockup, and **one line per rule** (`- R3 [erreur, hypothese] statement. Message: « … ». Tests: « R3 — … »`). The session makes the acceptance tests green **without modifying them** (they are named when the `accept` step ran; the lock above hands the lot back otherwise), **the tests it writes in addition cite the rule** in their name (`R2 — …`), and it **does not invent a rule**: a case the sheet does not cover is written in the report (`nonVerifie` or `choix`), not coded. In a `fix` the sheet stays the reference: a finding that contradicts it is contested under `choix`.
- **The code review (`review`, `review-small`) checks rule → test → green** (`règle → test → vert`). For each `Rn` of the sheet the reviewer checks that its test exists (named after the rule), that it is green, and that the behaviour is in the diff; when an acceptance file is named, that each listed test is unchanged since the red commit (`git diff <red commit> -- <file>` empty; the brief gives the red commit). A rule without a test, an acceptance test modified since the red commit, a rule coded that is not in the sheet, and a test that is green without exercising its rule are **major** findings. The reviewer no longer rebuilds the cases from the code.
- **The UX pass becomes a conformity pass.** For a lot with a sheet, the `ux` session (the `ux-reviewer` agent, **conformity mode**) no longer audits the whole screen: it compares the running app to the mockup and to its captures `maquette-<état>-<largeur>.png`, state by state, at 1440 and 390 px, and reports the differences of rendering and ergonomics the tests do not cover, each tied to a rule or a measure. The rules of the sheet are the tests' job. Its verdict feeds `raf ux`, which stays the lead's, decided on the captures. A small visible lot (single `review-small` pass) gets the conformity instruction in that pass.
- **The `## Hypothèses` section of the news entry.** The `implement` brief asks for an entry that ends with `## Hypothèses`: one line `- Rn — …` per rule whose status is `hypothese`, with what changes if it is wrong (its `si_faux`) — it is what the lead shows for the `raf ux` decision, the choices nobody validated.

  ```markdown
  ## Hypothèses
  - R3 — erreur de chargement : message « Impossible de charger le prochain match. » et bouton Réessayer. À confirmer ; sinon seul ce bloc change.
  ```

  **`cadence news check`** (not `build`) flags a lot whose sheet has hypotheses — found under `orchestrate.spec.dir` (default `docs/specs`), by `ecran.lot` — when none of its entries has the section, or when the section lacks a `- Rn` line for one of the rules (`L7 : la fiche a des hypothèses (R3, R4) mais l'entrée … n'a pas la section « ## Hypothèses »`). A lot without hypothesis needs no section.

**Production access of the sessions** (L168): a session of a wave (`implement`, `fix`, `precheck`, `spec`, `review`, `ux`) is
started with no *default* access to the production cluster (a guard against the ordinary path, not a barrier). What a session inherits was measured on the dev machine: `KUBECONFIG` (pointing at
`~/.kube/config`, the production cluster), the `kubectl` of the `PATH` (a link to `k3s`, which without `KUBECONFIG`
falls back on `/etc/rancher/k3s/k3s.yaml`) and the cloud and GitHub tokens of the environment. `cadence orchestrate` now
starts every session with `KUBECONFIG=/dev/null` (`kubectl get pods` answers « connection refused » on `localhost:8080`)
and without `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT`, `KUBE_TOKEN`, `ARGOCD_SERVER`, `ARGOCD_AUTH_TOKEN`, `ARGOCD_OPTS`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_TOKEN`, `CF_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (exactly these names: `AWS_PROFILE` or `AWS_WEB_IDENTITY_TOKEN_FILE` are kept), `GOOGLE_APPLICATION_CREDENTIALS`,
`AZURE_CLIENT_SECRET`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` (idea taken from the sandbox of docker/docker-agent,
closed by default). `HOME` is left alone, so the credential files `gh` keeps under `~/.config` stay readable (a session
can neither push nor deliver anyway) and so does `~/.kube/config`: a session that deliberately runs
`kubectl --kubeconfig ~/.kube/config …` or `KUBECONFIG=~/.kube/config kubectl …` still reaches the cluster. The restriction
stops the accidental access, not a deliberate workaround; making the file unreadable needs a filesystem sandbox
(a mount namespace, or the file sandbox of Claude Code), which cadence does not set up. `cadence deliver` and `cadence verify` are the lead's and keep their access; so do
the project's own `test`, `build` and `ux.command`, which the program launches. A lot that really needs the cluster is run in a
project with `orchestrate.prodAccess: true`: the restriction is lifted for all its sessions (default `false`).

`orchestrate.precheck: local` (L146) runs the pre-check on the local model of the dev machine instead of Sonnet: the
orchestrator launches `claude-local` with the same brief, the `precheck-reader` prompt and tools, no quota used and nothing counted in the
lot's budget (the step shows `local` as its model). `claude-local` is **not shipped with cadence**: it is a personal wrapper (a script on the `PATH`, `qwen3-coder:30b` by default) around
`claude` pointed at Ollama. `CADENCE_CLAUDE_LOCAL_BIN` names another binary, which must take the prompt as its **first argument**
and add itself `-p`, `--bare`, `--strict-mcp-config` and `--model` (cadence passes none of them), then accept `--output-format`,
`--json-schema`, `--tools`, `--session-id`, `--permission-mode`, `--add-dir` and `--disallowedTools`. A bare `claude` does not fit.
Without such a binary every local check fails and is replayed on Sonnet: keep `true`. Sonnet stays the safety net: a local session with no result (Ollama
down, timeout, no structured report) or an unreadable report is replayed on Sonnet with a warning, and a local `oui` — the
only answer that hands the lot back without an implementation — is confirmed by Sonnet before it counts. A local `partiel`
or `non` is taken as is. The default stays `true` (Sonnet): switch to `local` only after comparing verdicts and durations
against Sonnet on a few lots, and go back to `true` the first time the local model gets a `partiel` wrong. `--dry-run`
prints the step as `precheck (local)` with its `claude-local` arguments. Those arguments carry neither `--model` nor `--effort` nor `--agents`: `effort.precheck` applies only to the Sonnet
session (the fallback, or the confirmation of a local `oui`).

The `precheck-reader` agent does not set `omitClaudeMd` (Claude Code 2.1.271), on purpose: measured on a project with a
297-line `CLAUDE.md` (haiku, `--agents` + `--agent`, same prompt, with and without the flag), the session context is
identical (22 779 tokens, the project `CLAUDE.md` still answered when asked) — the flag only applies to an agent run as a
*subagent*, and cadence launches the step as the main agent of its own session. The same goes for `qa-reviewer`, which
is not launched by the wave: leave it as it is.

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

**Sub-tasks covered by commits (L82)**: when the review concludes compliant, the open sub-tasks of the lot that a work commit of the lot cites (`feat(L3/t2): …`, in the project or in one of the lot's neighbouring repositories; a commit that cites only the lot covers none) are closed in the same plan commit as the verdict, with the warning `sous-tâches closes : L3/t2 (sha)`, so `raf done` does not refuse the lot over finished work. A read-only plan is never written: each such sub-task is returned as a proposal `[sous-tâche clore] L3/t2 — couverte par <sha>`, for you to close with the project's tool. On a plan in a foreign format (read-only, `cadence.yaml` `plan:`), sub-task ids are read as the plan reads them: `B53/t4-ux1` covers `t4-ux1` only, not `t4`, and a list such as `feat(B53/t4-ux1,t5)` covers each of its sub-tasks. The lot id is not read inside another id (`fix(E-A2/t3,t4, A2/t1)` covers `A2/t1` only for lot `A2`), and a list may repeat the lot id (`fix(L1/t1, L1/t2,t3)` covers `t1`, `t2` and `t3`). A non-compliant review closes nothing.

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

**The code in service (L195)**: on cadence's own repository, `bin/raf.js` and `bin/cadence.js` load `dist/`, so the `raf` and `cadence` of your
`PATH` used to be whatever the working repository last built. The snapshot protects the wave running, not that installed tool, and a wave's
sessions run `npm run build`, `npm install`… The code in service now lives in a **separate copy**: a detached git worktree built there,
`<root>/releases/<sha12>`, with `<root>/service` pointing at the current one (`<root>` is `~/.local/share/cadence`), and `~/.local/bin/raf` and
`~/.local/bin/cadence` linked to `<root>/service/bin/`. Nothing in the working repository (`npm run build`, `prepare`, `npm install`, `npm ci`,
an uncommitted `src/` file) touches it. `npm run build` only type-checks, which is what a session of a wave runs, with the tests, before its report.

The lead updates the copy after the review, once the lot is accepted (`raf done`):

```
npm run service -- <sha>   # [--root dir] [--bin-dir dir] [--repo dir]
```

The script refuses a sha that is not an ancestor of HEAD, and a sha whose commits (since the one in service; only the sha itself the first time)
cite a lot whose status is not `done` (`plan:` commits are ignored). It builds the new copy aside (`npm ci --ignore-scripts`, then `tsc`) and switches
`service` and the two links only once the build succeeded (atomic renames): a failed install changes nothing. The previous copy is kept for a
rollback, the older ones are removed only once they are more than 7 days old, counted from the day they left service (a wave's snapshot links its `node_modules` to the copy that launched it). The first run is also what installs the links in `~/.local/bin`. It prints the fingerprint of the copy
(bin, dist, package.json).

### A lot whose work is in a neighbouring repository

Some lots are done in another repository that is not a cadence project (B64 of `maritime-atlas` lives in
`aetherwx-gitops`, a Helm chart repository). The lot declares it with the **lot key `repos:`** — a list of paths relative to
the project's repository, one path being enough as a string. There is no project-wide key: a neighbour belongs to a lot.

```yaml
lots:
  - id: B64
    title: …
    repos: [../aetherwx-gitops]
```

**Which commits count in a neighbour.** Nothing is inferred from the neighbour or from the project's name. A commit counts
when it cites the lot's id (as in the project: `feat(B64): …`, `maritime: … (B64)`) **and** is dated within the lot's period,
`started` to `finished` (an open end is open). That is all, whatever the prefix or scope of the subject says and whatever
the commit mentions. When a neighbour is shared between projects whose lots share an id prefix (`developpeur-gitops` holds
the charts of `finance-tracker`, `warhammer40k` and `ol-companion`, all `L…`), the lot says so with an **explicit key**: an
entry of `repos:` can be an object, and the list can mix both forms.

```yaml
    repos:
      - ../aetherwx-gitops                                  # id + period
      - { path: ../developpeur-gitops, cite: ol-companion } # id + period + this string
```

With `cite`, a commit must also contain that string (a substring, case-insensitive, searched in the subject and the body);
a commit of another app that cites the same id is dropped from `raf commits`, from the briefs, from the sha a review
records and from the orchestrator's « already has work » test. Without `cite`, in a shared neighbour, the commits of the
other apps that cite the same id **do** count: that is the default, so declare `cite` for such a neighbour. `cite` applies
to the neighbour it is written on, not to the project's own repository. The commits of the lot in the neighbour must carry the
string too (the briefs say so); one that does not is not counted.

A read-only plan declares it in `cadence.yaml` with `plan.fields.repos: <the file's key>` (a left-out field is read under
the name `repos`). The effect, for `cadence orchestrate`:

- **Preconditions** (refused before acting, exit code 2, like the project's own repository): every listed path exists and
  is inside a git repository, has no tracked file modified, has no `pre-push` hook of its own, and is not held by another
  live orchestration. `--dry-run` applies the same refusals and prints `dépôts voisins : <paths>`. The project's own
  repository and a duplicate listed twice are counted once.
- **Lock and guard**: the neighbour gets the repository lock (`orchestrate.lock`, so `cadence deliver` refuses it too, and no
  other wave can hold it), the temporary `pre-push` hook, and the same after-session checks (push, tampered hook, a review
  that changed it). Two lots that share a repository, as project or as neighbour, run one after the other, never two
  sessions in one repository; `--status` lists the neighbours among the repositories a wave still holds (a repository released once all its lots are finished no longer appears).
- **Sessions**: every session gets each neighbour as `--add-dir`, and the briefs name them: the implementation and the
  corrections must commit there too, with a message that cites the lot (`feat(B64): …`), and never push; the reviewers read
  the commits that cite the lot in the project **and** in each neighbour (`raf commits <lot>` lists them all; in a neighbour only the commits that cite the lot and are dated within the lot's period count, and also contain the `cite:` string when the lot declares one for it — a `fix(B64): …` outside the period, or one without the `cite:` string, is not listed.) A lot whose
  whole work is in the neighbour is not « without commit »; a commit there that does not cite the lot is a warning; a
  neighbour left with a tracked file modified hands the lot back.
- **Verdict**: `raf review` as recorded by the orchestrator stores the sha read in the project and in each neighbour
  (`review.repos`), and the verdict text ends with `dépôts relus : <path>@<sha>`. A commit made in a neighbour after the
  review hands the lot back, like one in the project.
- **Out of scope**: `raf check` does not audit the neighbours, and their delivery (push, CI, deploy) stays with the lead.

**What stays with you**: choosing the lots, the questions raised (`--resume --answer`), re-verifying
after the wave (`git log`, tests, `raf check`), `raf done`, **`raf ux`** (the orchestrator reports the UX
verdict and screenshots, it does not record it), the push and the deliveries, one project at a time.

**Several waves at once**: the lock is per **repository** (a lock in the repository's shared state,
`orchestrate.lock`, which also makes `cadence deliver` refuse that repository), not per folder. A wave is
refused only when one of its repositories is held by a live wave (`<repo> : une orchestration y est déjà en
cours`; the lock of a dead process is detected and cleared); two waves on different repositories run side by
side, even when started from the same parent folder. A repository is released **as soon as every lot of the wave that
touches it is finished** (ready, handed back or failed): its lock and its `pre-push` guard are lifted while the wave goes
on elsewhere, so `cadence deliver` accepts it (a repository with a lot still to play, a question or a suspended lot stays
held until the wave ends). `cadence deliver` also reads the wave's own state when a lock is still held: it refuses only if the wave still has a lot running, queued or suspended **in this repository**, and goes ahead when the lots left are elsewhere (an unreadable wave state still refuses). They share a **cap on simultaneous sessions**, counted
across all live waves: 2 by default, `--max-sessions N` (or `CADENCE_MAX_SESSIONS=N`) to change it — give
every wave the same value: each wave counts ALL live sessions, whatever their slot, and waits while that
count has reached ITS OWN cap, so with different caps the highest one can push the total past the lowest
(which then waits). A session that finds no free slot **waits** (the wave is not refused; the journal says
`en attente d'un créneau de session depuis …`, repeated every minute, then `créneau de session obtenu après …`).
A slot or a registry entry is owned by a pid **and** its start time: a reused pid is a dead owner. Wave
identifiers are reserved atomically (`-2`, `-3` suffix when two waves start in the same minute; an existing
`--wave` is refused). The registry of live waves and the slots live under `~/.cadence/orchestrate/` (`CADENCE_HOME`
to move it): `cadence orchestrate --status` lists, from any folder, the live waves, the repositories each
still holds (those not yet released), the cap of each wave, the slots in use and the **free slots** (`créneaux libres : N sur 2`: 2 minus, for each live wave, the smaller of its cap and the repositories it still holds — the figure the `lead` skill reads before starting a subagent). Without an identifier it then prints the table of the wave launched most recently from this folder (by launch time, not by alphabetical order of the identifier).

**Guards, imposed by the code**: a global cap of simultaneous sessions, one wave per repository at
a time (above); `Agent`, `git push`, `cadence deliver`, `raf done|review|ux` are denied to the sessions; a
temporary `pre-push` hook, installed for the duration of the wave and removed at its end (or, for a repository, as soon as all the lots that touch it are finished), refuses any push
from a session (`CADENCE_ORCHESTRATED` is in their environment; a repository that already has another
`pre-push` hook is refused before anything starts — `pushurl` is never touched); after every session the
upstream ref and `git ls-remote` are compared with the "before", and a read-only step that left only UNTRACKED files (screenshots written at the root by a script with a relative path) is not an incident: the files are moved to `.cadence/runs/<wave>/<project>--<lot>/stray/` (kept in their tree; for a neighbour repository, under `stray/<its relative path, `/` replaced by `_`>/`, e.g. `stray/.._gitops/`), a warning naming them goes to the lot's warnings and the wave log, the verdict is kept and the lot continues (L162; a move that is impossible, or an untracked file that vanished during the step, stays an incident); a review that changed `HEAD` or a tracked file (a commit, a modified file) is an incident of that lot only: the lot is handed back to the lead, the lots of the other repositories carry on while the lots still queued behind it in the same repository are suspended (resumable, nothing started on a dirty tree), and a verdict the review had already produced is reported in the outcome and the lot's warnings (never recorded in the plan). A push or a removed guard hook still stops the wave. `raf done|ux|review` and `cadence deliver` refuse when
`CADENCE_ORCHESTRATED` is set.

**Budget**: the wave counts input + cache writes + output tokens (default 2 M); cache reads are kept and
shown apart. Each lot also has its own budget, the 90th percentile of the *total* measured per lot on `.cadence/runs` (all the waves a lot went through, 250 lots) for its category (L194): an ordinary lot of up to 0.5 day gets 450 k (floor: a write pass, its review, one fix pass and the short review after it; measured p90 374 k), 0.5 to 1 day 750 k (p90 732 k), then 570 k per day of estimate, 750 k staying the floor until that exceeds it, i.e. up to 1.3 day (p90 1.14 M for 2 days); a lot with `screen:` gets 1.3 M whatever its estimate (p90 1.28 M: spec, mockup, accept, conformity UX and passes), or its ordinary budget plus 350 k beyond that; a lot with `spec: true` gets its ordinary budget plus 350 k (no such lot measured yet); shown by
`--dry-run` with its basis): it bounds the *writing* passes, never the reviews. A lot that spent it gets no further implementation or
fix and is handed back to the lead, but its review (and UX review) is played first; a fix pass starts only if
the remaining budget can also pay the review that follows it (65 k tokens reserved: a fixed amount close to the 90th
percentile of the full reviews, 62.7 k over 187 reviews; the short review after the minors pass has a higher p90, 67.6 k
over 114; measured on 2026-10-09 in the wave journals `.cadence/runs`, `tokens.counted`, 67 waves from 10-04 to 10-09).
Exception: when the tests are red after a write pass, the lot goes to a fix pass without a review; if that fix pass is
refused for lack of budget the lot is handed back to the lead without a review, with its findings, and the cause names
the red tests: the pass it names is the one whose tests were red, counted by its number (« la passe fix 2 », « l'implémentation »), and « la passe des mineurs » appears only when that pass was the one played. The wave budget stays for the others. When the budget (or the usage limit) is reached no new session starts, the running ones
finish, the wave is *suspended* (exit code 3) and `--resume --budget …` continues. A session that returns
nothing readable, times out (45 min for work, 25 for a review) or fails is not retried; the lot is handed
back with the cause. Exit codes: 0 every lot ready · 1 at least one lot handed back (question, failure,
review still not compliant after two passes) · 2 refused before acting · 3 wave suspended.

**Stacked lots** (L76): lots of one repository commit on top of each other on `main`. When a ready lot sits under a lot that
is not ready (handed back, failed…), the final table adds a line `<project>:<lot> — livrable jusqu'à <sha> … : git push origin <sha>:main && cadence deliver --sha <sha>`:
the last commit of the highest ready lot with no unfinished lot's commit beneath it. Ship it without the lot above by pushing
that sha alone, then delivering it: `git push origin <sha>:main && cadence deliver --sha <sha>` (with `ci: github` the CI wait
looks for the run of that exact sha, and GitHub only builds the tip of a push; pushing HEAD would also put the unreviewed lot
on `main`). A lot's commits are read from git (the commits that cite it, whatever session or wave made them; plan-only and
version commits do not count), not only from the sessions' reports, so a failed or timed-out session that committed still
bounds the line. Nothing is printed when every lot is ready or when the ready lots sit above the unfinished one.

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

When a session ends — success, error, time limit (`timeouts`) or interruption of the wave — nothing it started
survives it: besides its process group, the tree of its descendants is tracked while it runs and killed with it, and
every session carries a `CADENCE_SESSION=<id>` mark in its environment that all its descendants inherit, even those
re-parented to init (`nohup srv &` or `setsid srv &` from a shell that exits at once): at the end — as soon as the session's root process exits, not when its output closes, so a descendant holding stdout open cannot turn a session that exited with code 0 into a "time limit" failure — every process
bearing the mark is killed (read from `/proc/<pid>/environ`, or, where there is no `/proc`, from `ps -axEww` on macOS — `-E` is the BSD option that prints the environment, `-e` only means "all processes" there — and `ps axeww` with procps on Linux).

Limits of the mark, stated rather than hidden: it is read from the process environment, so a descendant that
dropped it (`env -i`, `env -u CADENCE_SESSION`) is only reached by the tree tracking, and only if it was seen under
the session between two samples (every 200 ms); a process whose environment is unreadable (another user) is never
found; a process started through a daemon that already ran before the session (`docker compose up -d` talks to the
Docker daemon, which owns the containers) is out of reach. **Shared daemons are spared**: a tmux server, `screen`,
`gpg-agent` or `dirmngr` started on demand by a session carries its mark and would pass it to clients and panes opened
later from elsewhere, so killing by mark would kill the lead's own tmux panes; those daemons (only when they carry the mark: the lead's own tmux, where cadence itself may run, does not, and spares nothing), and everything that
descends from them, are left alone (a dev server started inside a tmux pane therefore survives its session). Not in
that list, because their name does not tell them from an ordinary client: the ssh master (`ControlPersist`), the
Gradle daemon (java) and pm2 (node) — they are killed if they carry the mark.

Briefs are the templates of `templates/orchestrate/` (`implement.md` is the `lead` skill's standard
brief; `--dry-run` writes the rendered ones). The `implement` brief of a `visible` lot also carries the
News instruction (`cadence news new <lot>`, factual user-side text, a screenshot in `docs/nouveautes/captures/` or
`nocapture:`, `cadence news check` green); the brief gives the absolute path of the wave's Playwright output directory and the `implement` session gets `--add-dir` on it, to copy the capture into the repository; the `fix` and `fix-minors` briefs of a `visible` lot give the same folder (and their sessions the same `--add-dir`), to fetch a screenshot a finding asks for; a lot that is not `visible` gets nothing. A `--dry-run` brief of a `visible` lot has no wave folder (the wave does not exist yet), nor does a brief delegated by hand: the News instruction then says to save the screenshot under the OS temp directory, never inside the repository, then copy it into `docs/nouveautes/captures/`. A project can declare, in `cadence.yaml`:

```yaml
orchestrate:
  test: npm test                         # run by the orchestrator after a work step (optional)
  build: npm run build                   # run after the tests; both results go to the reviewer, who does not redo them (optional)
  precheck: true                         # default: before the first implementation of a lot with no commit, a read-only Sonnet session checks whether the deliverable is already in the repository (see below); false skips it, local runs it on claude-local (Ollama) with Sonnet as fallback
  accept: npx vitest run -c vitest.acceptation.config.ts   # accept step (see « The accept step »): the dedicated command that runs ONLY the acceptance tests of the lot (optional; without it the step is skipped with a warning)
  maquette: true                         # default: UX review of the mockup between spec and accept (see « The mockup review »); false skips it
  fiche: true                            # default: review of the back-end sheet of a lot with spec: true between spec and accept (see « The spec step of a lot with spec: true »); false skips it
  spec: { dir: docs/specs }              # spec step (see « The spec step of a lot with screen: »): folder of the screen specs, relative to the repository (default docs/specs); render: the command the spec session runs to render the mockups at 1440 and 390 px (optional, Playwright otherwise)
  prodAccess: false                      # default: wave sessions get no access to production (see « Production access of the sessions »); true lifts it for this project
  effort: { review: xhigh }              # effort level per pass (see « Effort level per pass »): precheck, spec, maquette, fiche, accept, implement, fix, review, ux
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
`npx -y @playwright/mcp@latest --output-dir <wave>/<project>--<lot>/playwright`, is loaded for the `ux` and `maquette` steps and, on a
`visible` lot, for `spec`, `implement` and `fix` (`fix-minors` included) and, on a small `visible` lot, for `review-small` (its only
usability review; `review-small` of a small lot without a screen loads nothing), so the screenshots and snapshots of the work and of
the review stay with the wave, outside the repository, where the lead can look at them; the final table prints that
folder whenever Playwright was loaded for the lot, even if no `ux` step ran
(`<project>:<lot> — captures Playwright : <dir>`; `uxCaptures` in the wave state). For `maquette` and `spec` the server also gets
`--allow-unrestricted-file-access`: the mockup is a local file, and by default the server blocks every `file://` URL. The `implement`, `fix`,
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
  [orchestrate](#orchestrate); a lot with a `screen:` first goes through the [spec, mockup review and accept steps](#the-spec-step-of-a-lot-with-screen)), re-verified by the lead, then delivered
  one project at a time; a delivery that changes what a page shows or what it is
  served is then checked in the running app by the `qa-reviewer` agent, whose
  blocking findings come back to you. Two
  subagents at most, never two in the same repository. The whole flow is drawn in
  [docs/lead.md](docs/lead.md).
- **ux-reviewer** (agent): captures at 1440 and 390 px, findings grounded in a
  named rule (Nielsen, WCAG 2.2 AA) or a measurement, ranked, turned into
  `raf add --parent` sub-tasks, and a one-line verdict for `raf ux`. It never
  edits code. Read-only for real: its `tools:` list is `Read, Grep, Glob, Bash` and the
  Playwright tools (`mcp__playwright`, and `mcp__plugin_playwright_playwright` when the
  browser comes from the Playwright plugin) — no `Edit`, no `Write`. Outside a wave it gives its captures a relative file name only, which the Playwright MCP writes under `.playwright-mcp/` (the same rule as the wave's briefs); `qa-reviewer` follows it too.
- **code-reviewer** (agent): any stack; given a repository and a lot id, it reads
  the diff itself from the commits that cite the lot — not the author's summary —
  and the project's CLAUDE.md, when there is one, for its conventions; findings grounded in a
  measurement (a failing command, changed code without a test, a duplicated
  block, dead code) or a named rule, each with `file:line` and a concrete
  scenario; real defects only, ranked, what it could not verify, and a one-line
  verdict for `raf review`. It takes the lot's commits from `raf commits`, never
  runs a build whose output is used live, and never edits code. A README or usage
  documentation that does not follow the lot's change is a *major* finding.
- **qa-reviewer** (agent): any web app (read-only like `ux-reviewer`: same tool list, no `Edit`, no `Write`); given a repository and a base URL (and
  optionally a lot id, to walk only the pages it touched — those that call the
  changed endpoints, those of the screens it changed, the pages that consume the services the lot changed,
  and the home page; a backend-only lot stays in scope, and when the lot changes no route
  and no screen, or the endpoints cannot be mapped to pages, every page is walked; the others are named « Not walked »), it opens each page of
  the project's expectations file in a real browser at 1440 and 390 px and
  measures: expected content present and non-empty, no error or missing-data
  message, every API call answered 2xx with a non-empty body, no console error,
  no broken content image. It reads the page as text first and takes a capture only for a gap. Findings are defects (a line of the expectations
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
ctx ▰▰▰▰▱▱▱▱▱▱  42 % 84k/200k  │  5h  23 % ↻ 2 h 10  │  7j  61 % ↻ 6 j 15 h  │  $1.23  │  fable 410k sonnet 85k  │  ⚙ 2 agents  │  2 cmd
⟳ cadence · 2026-10-07-2131 en cours  │  budget ▱▱▱▱▱▱▱▱▱▱   1 % 14k/2M  │  1 session/2
  L112  implémente  implement@sonnet 34 s         global-setup coupe le cache de compilation de Node...
```

Context of the session (green / orange / red at 50 and 75 %), the 5-hour and 7-day quota
windows with the time to their reset, the cost of the session and its split per model, the
subagents of this session, the background commands in progress (`2 cmd`: Bash run in the background and Monitor, subagents' included, as the app's "background commands" card counts them), and every live `cadence orchestrate` wave: budget, sessions, one
aligned line per active lot (status, step, model, elapsed, start of the title), the lots still
waiting. When no wave is running, the last finished one stays on a grey line for 30 minutes
after it ended, then disappears. A background command counted for more than an hour, or with no
record of when it started, is no longer shown as running: it moves to a grey `N cmd sans fin
vue` ("end never seen") right after `N cmd`, because its end notification may never have reached
the session. Waves are read from disk (`~/.cadence/orchestrate/waves/`, then `.cadence/runs/`); no
cadence command is run, and the CLI is not required for those. One more block needs it: the **progress of the plans**,
one line per active project (a project with open lots), in the order of `priority:`:

```
ol      ▮▮▮▮▮▯▯▯▯▯ 39/78 · 0 en cours · +3 cette semaine
cadence ▮▮▮▮▮▯▯▯▯▯ 10/20 · 2 en cours : L149 L153
```

The bar is lots done over lots done + in progress + to do (dropped and recurring lots left out); the count of lots in progress is followed by their ids (`2 en cours : L149 L153`), cut to three then `…` (`5 en cours : L1 L2 L3 …`), the count alone at zero;
`+N cette semaine` counts the lots created in the last 7 days (today and the six before) and is left out at zero. The source is
`cadence lead tour <folder> --json` (the folder a wave was launched from, otherwise the session's: a folder of projects gives one line per project, a project with no sub-project gives its own single line),
read again at every wave transition and otherwise every minute; without `cadence` on the PATH, the
lines are simply not drawn.

Install it as a plugin from the same marketplace:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence-hud@cadence
```

`/hud` hides or shows the band. `/hud cmd` lists the background commands being counted (id, tool,
origin `session` or `agent <id>`, age, name; `(sans fin vue)` on the ones above). Any other argument
`/hud projets` folds the project list to one line, and opens it again. Any other argument
answers `argument inconnu : … (attendu : cmd, projets)` and leaves the band as it is. The source lives in [`plugins/cadence-hud`](plugins/cadence-hud/README.md)
(its own README has the details of every cell); it is not part of the npm package. To work on it:
`claude plugin validate plugins/cadence-hud`, `claude plugin test plugins/cadence-hud`, and
`tsc -p plugins/cadence-hud` once Claude Code has loaded the plugin at least once (it generates
the `.claude-plugin/types` the tsconfig extends).

## Releasing

A version exists in three places and is published in two; a release does all of it, in this order:

1. Bump `version` in `package.json` (then `npm install` to refresh `package-lock.json`),
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and write the version's section of
   `CHANGELOG.md` (`## [x.y.z] - date`, what changes for the user, lots cited), in **one commit that holds
   only those files** (the version fields and the CHANGELOG, nothing else in the manifests, and the « What's new »
   section of this README, the one place of it a release rewrites). Such a commit is
   exempt from the code-review gate like a plan commit: it closes the lot after its review, and `raf check`
   does not ask for a new one (nor does it count it as a commit without a lot). The « What's new »
   summary is ordered by version, a number known only at the release and shared by several lots: write it
   in that commit, not before the review. A commit that touches any other file
   — or another field of a manifest, or a dependency in `package-lock.json` — is work like any other and has
   to be reviewed.
2. Run the plugin evaluation, `npm run eval:plugin` (billed, see [Evaluating the plugin](#evaluating-the-plugin-before-a-release)),
   on that version commit; a case below the threshold stops the release until you have read it in the report.
3. `git tag v<version> && git push origin main v<version>` — the tag starts `.github/workflows/publish.yml`,
   which publishes to npm through Trusted Publishing (OIDC, no token stored anywhere): it checks the tag
   matches `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` and that `CHANGELOG.md` has a `## [x.y.z]` section for it (no section, no publication), then `npm publish --provenance`, where `prepublishOnly` runs the type-check and the
   tests and `prepare` builds `dist/`; a red suite stops the publication; then it creates the GitHub release with that CHANGELOG section as its text. The trusted publisher is declared
   once on npmjs.com (package settings → Trusted Publisher → GitHub Actions, `Sylad/cadence`, `publish.yml`).
4. Watch the run: `gh run watch` (or `gh run list --workflow publish.yml`).
5. Check the effect: `npm view @sylad/cadence version` answers the new version.
   A run is safe to re-run, and two runs for one tag queue instead of racing (`concurrency` per ref, never cancelling the one that publishes):
   a version already on npm skips `npm publish`, and a GitHub release that is missing is created (`--verify-tag`)
   while an existing one is left alone. If the package is on npm but the release is still missing, re-run the job;
   the by-hand fallback is `gh release create v<version> --title v<version> --notes-file <the section of CHANGELOG.md> --verify-tag`.

The Claude Code plugin is read from the repository, so pushing `main` is what updates it; npm is what
`npx @sylad/cadence` and a global install read, and only the tag publishes there. A missing tag, or a red
publish run, leaves npm behind without any other error — 0.3.0 and 0.4.0 were never published — hence
step 5.

### Evaluating the plugin (before a release)

`evals/` holds an evaluation suite for the plugin itself, run by `claude plugin eval` (Claude Code 2.1.263 and later). Each case is
a folder with a `prompt.md` and `graders/*.md`, and replays a trap found by hand: `raf-done-sans-revue` (`raf done` refused on a lot whose
commits have no code review, with no `--force` to get round it), `deliver-sha` (`git push origin <sha>:main` then
`cadence deliver --sha <sha>` for a pushed commit that is not `HEAD`), `orchestrate-id-avec-slash` (`maritime-atlas:Q4/accueil-4-ux12@haiku`
keeps its `/`) and `livrer-sh-sans-bloc` (a `./livrer.sh` without a `deliver:` block in `cadence.yaml` is not
run by `cadence deliver`). Every case also runs a **baseline without the plugin**, so the report gives the score of each arm and the
difference: a trap the baseline already avoids proves nothing about the plugin. The cases are read-only questions (tools `Read`, `Glob`, `Grep`,
`Skill`, no scaffold script), each graded by a regular expression and by a model-judged criterion.

```sh
npm run eval:plugin              # claude plugin eval . --max-cost-usd 5 --no-publish; 4 cases × 3 runs × 2 arms = 24 runs
claude plugin eval . --case deliver-sha --runs 1 --trust-plugin --no-publish --max-cost-usd 1    # one case, one run (the first run asks to trust the plugin)
```

**Every run is billed** (a full `claude` session on your own credential, plus the judge): the suite is run at the release, once the
version commit is ready, never in `npm test`, in `prepublishOnly` or in CI, and `--max-cost-usd 5` aborts a runaway. A case below
the threshold (1.0 by default, `--threshold`) makes the command exit 1: read the case in the report before deciding it is the plugin
and not the wording of the case. `npm test` only checks that the
files are well formed (`test/plugin-evals.test.ts`); `evals/` is not part of the npm package.

## Stability

From 1.0.0 cadence follows [semantic versioning](https://semver.org): what is listed under
*Guaranteed* only changes incompatibly in a major version; a minor or a patch never breaks it.

**Guaranteed**

- **Commands and options** of `raf` and `cadence` (`cadence raf …` is `raf …`): `init`, `add`, `start`, `done`, `drop`,
  `note`, `did`, `public`, `screen`, `spec`, `ux`, `review`, `commits`, `show`, `list`, `now`, `ignore`, `check`, `gantt`, `hook`;
  `cadence news`, `session` (`start`, `close`, `next`, `context`), `lead tour`, `corrections`, `deliver`, `verify`, `orchestrate`,
  `skills`, `spec` (`cadence spec <lot> on|off` is `raf spec`; `check`, `qa`: exit **0** when the sheet is valid and the section is printed, **1** with violations, **2** on a missing or unreadable file or a wrong usage);
  their options and exit codes as this README documents them. A new command or option is a minor change.
- **The keys of `cadence.yaml`**: `plan`, `news`, `hook`, `session`, `deliver`, `orchestrate`, `docs`, `qa`, `priority`, `depth`, `lead` (`lead.ux`)
  and the keys each of them takes. A key is not renamed nor removed, nor does its meaning change; a new key is a minor change.
- **The plan file** (`docs/plan/raf.yaml`): `project`, `prefix`, `since`, `ignore`, `lots` (with their
  fields, `tasks`, `notes`, `repos`) and `acknowledged`, and the plan formats `plan:` in `cadence.yaml` can read.
  The `version` key is kept in the file but ignored (`src/plan.ts` does not read it): it is not a schema version.
- **The names of the skills** (`session-start`, `session-close`, `deliver`, `lead`) **and of the agents**
  (`ux-reviewer`, `code-reviewer`, `qa-reviewer`).

**Not guaranteed** (may change in any release)

- The **text of the outputs**: wording, layout, order of the lines and columns of every report, table and message
  (the `--json` outputs and the exit codes are part of the commands above). In a `--json` output a new field is a
  minor change, so consumers must tolerate unknown fields; removing or renaming a field is a major change.
- The **`precheck-reader`**, **`spec-writer`** and **`acceptance-writer`** agents, and the mockup and conformity modes of **`ux-reviewer`**: internal to `cadence orchestrate`, not meant to be called by hand.
- The **`cadence-hud` band**: its segments, colours and layout; it is versioned on its own.
- The **wave journals** under `.cadence/runs` and the files `cadence orchestrate` keeps there.
- The wording of the briefs and of the instructions inside the skills and the agents.
- The **format of the sheets** (`fiche.yaml`: the screen sheet `templates/fiche.yaml`, the back-end sheet `templates/fiche-back.yaml`, the mixed sheet) and so the invariants `cadence spec check` enforces: experimental while the next bricks of the spec step (S3–S6) still reshape it, a sheet that passes today may be refused by a later release. The `spec` commands and their exit codes are guaranteed, the keys they read are not yet.

There is no schema version and no migration: a file written by an earlier release keeps working, and a key a
release adds is optional.

## License

MIT
