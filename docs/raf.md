[← cadence](../README.md)

# raf

- The plan is a YAML file in the repo, edited by the CLI: `.cadence/raf.yaml` by default (versioned by git, never published with `docs/`),
  with its notes in `.cadence/notes/`. Your comments and hand edits are preserved. A project that still has `docs/plan/raf.yaml` keeps it:
  see [Where the plan is](#where-the-plan-is).
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
  touches is a plan file**: the plan itself, its Gantt page (only at its default place, `gantt.html` next to the plan — written elsewhere with `raf gantt -o`, declare it under `plan.files`), with the default plan `.cadence/raf.yaml`, also the legacy `docs/plan/raf.yaml` and `docs/plan/gantt.html` (so that the old commits of the plan stay plan upkeep after the `git mv`), the `plan:` key of the config file in use (`cadence.yaml`, or
  the `--config` file; a change to `deliver:`/`session:` is work), or a file the
  project lists under `plan.files` in `cadence.yaml` (a page it generates from
  the plan, a journal), or the QA expectations file (`docs/qa/expectations.md`,
  or the file named by `qa.expectations`; the lead commits the `qa-reviewer`'s draft of it). Such a commit is never a "commit without a lot", and it
  does not count as work on the lots it cites: it is absent from `raf commits`,
  does not start a `todo` lot, does not make a code review stale, is not in the commit
  count that `raf now`, `cadence lead tour` and `cadence session start` show for a lot in
  progress (the same count as `raf commits` and `raf show`: after `plan: L1 démarré` alone,
  `raf now` prints no commit and the tour `L1 (0 commit)`, L379; the commit column and the tooltip of `raf gantt` read the same count, L381), and
  `cadence deliver` does not announce the lots it cites as delivered. The files
  decide, never the subject: a `chore(plan): …` commit that touches a source
  file is a commit like any other.
- `raf gantt` writes a single self-contained HTML page (no server, no CDN).

```sh
npm install -g @sylad/cadence    # or: npx -p @sylad/cadence raf …

raf init                          # .cadence/raf.yaml + .cadence/notes/.gitkeep + post-commit hook + .playwright-mcp/ in .gitignore
raf add "Monthly dedup on merge" --estimate 2
raf add "Typo in footer" --quickwin
raf add "Loan cache" --after L1
raf add "write the migration" --parent L1     # → L1/t1
raf start L1
git commit -m "feat(L1): dedup by calendar month"
raf now                           # in progress, next up (quickwins first), recently done
raf done L1/t1 && raf done L1
raf check                         # exit 1 on drift
raf gantt                         # .cadence/gantt.html (next to the plan)
```

## Commands

| Command | Effect |
|---|---|
| `raf --version` · `raf -v` | print the version of the package, as `cadence --version` does (L376); only as the first argument, `raf show --version` stays an unknown option |
| `raf init [--project name] [--prefix L] [--no-hook]` | create the plan, install the hook, add `.playwright-mcp/` to `.gitignore` |
| `raf add "title" [--estimate d] [--quickwin] [--visible [--screen page\|component\|journey]] [--spec] [--public "title"] [--after L2,L4] [--uses banc,passerelle] [--parent L3]` | add a lot or a sub-task, print its id (`--public`: the lot's title in the public's words, written as `public:` right after `title:`; `--screen`: the screen a visible lot creates or changes — a new `page`, a new `component` or a modified `journey` — written as `screen:` right after `visible:`, shown by `raf show`; it requires `--visible`, and `raf check` reports a `screen:` without `visible:` or with another value as an error. Only `page` triggers the spec step of `orchestrate` (L209), never inferred from the title; `--spec`: the lot changes a behaviour (something a user, an API client or another service can observe), written as `spec: true` right after `screen:`, `visible:`, `quickwin:` or `estimate:` (whichever comes last), shown by `raf show`, refused on a sub-task. Also set by the lead at planning time, never inferred from the title); `--uses`: the shared resources the lot occupies, written as `uses: [banc, passerelle]` after `after:` and before `created:` ([shared resources](#shared-resources-uses-and-resources), L251), refused on a sub-task) |
| `raf add "title" --every <days>` · `raf did <id> ["text"]` | recurring lot: `every` (days) and `last` (last time done) fields; the lot stays `todo`, `raf now` and `session start` list it under « Récurrent » with « dû depuis N j » / « prochain dans N j »; `raf did` resets the count (spec: `docs/superpowers/specs/2026-10-04-L11-tache-recurrente.md`) |
| `raf screen <id> page\|component\|journey\|none` | set, replace or remove `screen:` on an existing lot, to adopt the [spec step](orchestrate.md#the-spec-step-of-a-lot-with-screen) on a plan already written (only `page` adopts the [spec step](orchestrate.md#the-spec-step-of-a-lot-with-screen); `component` and `journey` do not); refused on a lot without `visible:` (like `raf add --screen`) and on a sub-task; `none` removes the key and leaves `visible:` alone |
| `raf visible <id> on\|off` | set or remove `visible:` on an existing lot (a user-facing change: a news entry is expected, and `cadence orchestrate` adds its UX step), written right after `quickwin:`, `estimate:` or `status:` (whichever comes last); `on` on a visible lot changes nothing, `off` on a lot without the key neither; refused on a sub-task, and `off` is refused while the lot has a `screen:` (`raf screen <id> none` first: a screen is a visible change). It is the fix `raf check` points to for an open « Revue UX — » lot without `visible:` (L273) |
| `raf spec <id> on\|off` | set or remove `spec:` on an existing lot (a lot that changes a behaviour, for the back-end spec step of `cadence orchestrate`, see [The spec step of a lot with `spec: true`](orchestrate.md#the-spec-step-of-a-lot-with-spec-true)); refused on a sub-task; `off` is refused on a lot that has `screen: page` (the page implies the spec: remove `screen:` first) and `on` there only says so and changes nothing; on `component` and `journey` (ordinary path since L209) both work and set or remove the back-end `spec:`. `raf spec` only takes `on`/`off`: `cadence spec check\|qa <fiche.yaml>` keeps its own subcommands. `raf check` reports a `spec:` that is neither `true` nor `false` (`spec : true ou false attendu`) |
| `raf uses <lot> [<resource>…]` | replace the `uses:` list of a lot of any status (`done` and `dropped` included) by the names given (duplicates removed, order kept); with no name, remove the key. Prints nothing. A name is a word of lowercase letters, digits, `-` and `_` (else `ressource invalide : <name> (lettres minuscules, chiffres, - et _)`, plan unchanged); a sub-task is refused (`uses se pose sur un lot, pas sur une sous-tâche : L1/t1`); an unknown lot is `lot inconnu : <id>`. A name not yet declared is accepted: `raf check` refuses it (L251) |
| `raf public <id> "title"` · `raf public <id> --clear` | set, replace or remove the public title of a lot |
| `raf start <id>` · `raf done <id> [--force]` · `raf drop <id> [--reason text]` | dated transitions (`done` refuses open sub-tasks unless `--force`, and a lot whose `acceptation-<lot>.json` is still `vert: false`, L366: closed like that it would lock every later wave of the repository, see `cadence spec green`; with `--force` it only warns on stderr. Like every `raf` command it only writes the plan file and **never commits** it: when the plan or a file `plan.onWrite` produces is left with changes, `done` prints the `git add` / `git commit` command that takes them, the subject from the `plan.commit` template, L371) |
| `cadence spec green <lot>` | L366: run the dedicated acceptance command (`orchestrate.accept`) on a lot driven or closed by hand; green, set `vert: true` in its `acceptation-<lot>.json` and commit that file alone (subject `chore(<lot>): acceptation verte, vert: true posé par cadence spec green` or the `plan.commit` template; the resealed tests are listed in the commit body, never in the subject), resealing the fingerprints of the listed tests refined since the red commit (journal `resceaux`) so the lock goes quiet; a listed test changed but not committed is refused. Red: exit 1, nothing changed. Refused for a `todo` lot, during a wave, and while an unfinished wave keeps a lot of the repository open; see [orchestrate](orchestrate.md) |
| `raf todo <id> [--reason text]` | put a started lot back to `todo` (`doing` → `todo`, `started:` removed, dated note « remis en attente : reason »): refused when work commits cite the lot (plan-only and version commits do not count, as `raf commits`), when the lot is not `doing` (a `done` or `dropped` lot is reopened by hand), or on a sub-task; sub-tasks and other keys are left as they are |
| `raf migrate [--dry-run]` | move `docs/plan/raf.yaml` to `.cadence/raf.yaml` and rewrite the readers of the old path in the repository, see [Moving the plan: `raf migrate`](#moving-the-plan-raf-migrate) |
| `raf note <id> "text"` | dated note — keep decisions next to the work |
| `raf title <id> "new title"` | replace the title of a lot of any status (`done` included) and add a dated note « titre remplacé : « old title » »; `raf now`, `raf show`, `raf list`, `session start` and the proposals read the new one. Refused on an empty or identical title, an unknown lot or a sub-task |
| `raf show <id> [--notes]` | one lot: status, dates, `goal : …` right after the title when the lot has a `goal:` (native key or `plan.fields.goal`, L272: the objective that replaces the title in the `orchestrate` briefs), `after`, public title, `screen` and `spec`, `uses : banc, passerelle` when the lot has `uses:`, dated notes in order, then the counted commits (as `raf commits`, neighbouring repositories included); `--notes` prints the notes alone |
| `raf commits <id>` | the commits counted for a lot (the set the code review gate uses), one `<sha> <subject>` per line, oldest first; a lot that declares `repos:` ([neighbouring repositories](orchestrate.md#a-lot-whose-work-is-in-a-neighbouring-repository)) gets, after them, one `dépôt <path> :` section per neighbour with the commits there that cite the lot and fall within the lot's period (`started` to `finished`) and, when the lot declares a `cite:` for that neighbour, contain that string (`aucun commit du lot`, or `introuvable` for a path that is not there) |
| `raf now` | what to do next |
| `raf list [--status s]` | flat list |
| `raf docs-ok <lot> --reason text` | acknowledge the `docs.sync` gap of a lot (a document behind its commits, `raf check` red) when the documentation really stays true: a `docs_ok: { date, reason }` key on the lot, **the reason is required** (refused without it, for an unknown lot or for a sub-task); `raf check` and `cadence lead tour` no longer count the lot, `raf show` prints it, and `cadence orchestrate` neither calls the librarian nor holds the lot back for it. Commit the plan with it |
| `raf ignore <sha> \| "exact subject" [--reason text]` | acknowledge a commit without a lot (tooling chore, a plan commit citing an unknown id) or a commit that cites known lots without working on them (a lead's plan commit creating lots, a setting cited in parentheses): it then counts for none of them — not started, not active, not to review (`raf commits` omits it) — without rewriting history: a dated, reasoned line in the plan's `acknowledged:` section; a sha is exact, a subject covers every commit carrying it; exactly one commit argument, the reason goes through `--reason "text"` (`raf ignore 1a2b3c4 "tooling"` is refused with « un seul commit attendu ; la raison se passe par --reason "texte" », exit 2) |
| `raf check --ignored` | list the acknowledged commits with their date and reason |
| `raf check [--since date] [--idle 7]` | since the plan's adoption date by default (a visible lot without a public title is only a `⚠` warning: it never changes the exit code): commits without a lot (commits touching only plan files, or only version fields, `CHANGELOG.md`, the README's « What's new » section and `docs/whats-new.md` are exempt), unknown ids, `todo` lots that already have commits, idle lots (an open lot whose sub-lots, entries carrying `parent:` in a plan kept by another tool, have a recent commit or are in progress is not idle: L321), `done` lots with open sub-tasks, bad or circular dependencies, and an open lot titled « Revue UX — <screen> » without `visible: true` (`ux-review-not-visible`, an error: such a lot goes through precheck → implement → review with no UX step, so the screen is never reviewed — finance L32 on 2026-10-23; L271; the message names the fix, `raf visible <id> on`, L273; on a read-only plan, plan kept by another tool, it never names a `raf` command, which would refuse: with `plan.fields.visible` mapped it says to set `visible:` with the project's tool, without it it says the plan carries no `visible`, to map the field in `cadence.yaml` (`plan.fields.visible`) if the project's tool writes it, and that otherwise the UX review of that screen happens outside orchestrate, L321) |
| `raf gantt [-o file]` | standalone Gantt page |
| `raf hook install` | add the post-commit hook (read-only, never blocks) and the pre-commit hook (does nothing unless `hook.autostart` says so, see below) |

### A commit on a lot that is still `todo`

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
  no amend afterwards, no dirty plan left behind. Only when the plan is identical to `HEAD` (no
  uncommitted change to the plan, staged or not): otherwise nothing is started, the hook says why
  (`plan modifié non commité : démarrage automatique sauté, raf start <id> à la main`) and behaves like `warn`.

The pre-commit hook reads the message from the command line of the `git commit` that runs it (`-m`, `-am`,
`--message`, `-F`; Linux, through `/proc`) or from `CADENCE_COMMIT_MESSAGE`. When the message is not known yet
(editor, `--amend`) it does nothing and the post-commit warning stays. Run `raf hook install` again to add the
pre-commit block to an existing repository. A read-only plan is never started by the hook. Only a refusal (exit code 3 of `raf hook pre-commit`) stops a commit: an older or broken `raf` lets it through.

Global options: `--file path` or `RAF_FILE`; `RAF_TODAY=YYYY-MM-DD` to freeze
the date. `cadence raf …` is the same as `raf …`.

## Shared resources: `uses:` and `resources:`

Some projects of a folder share one thing that only one lot at a time can use (a test bench, a gateway, a
device). L251 (GitHub issue #13, 1/3) lets the plan **declare** it; nothing locks on it yet (`raf start` and
`cadence orchestrate` ignore `uses:`).

- The folder that holds the projects lists the resources in its `cadence.yaml`, next to `depth:` and `priority:`:
  `resources: [banc, passerelle]`. A name is a word of lowercase letters, digits, `-` and `_`.
- A lot says which ones it occupies with `uses: [banc]` (a flow list; optional): `raf add "title" --uses banc,passerelle`, or on an existing lot
  `raf uses L3 banc passerelle` (`raf uses L3` removes the key). `uses:` belongs to a lot, never to a sub-task, and `raf show` prints it.
  It is a native key of raf's own plan; a plan kept by another tool is read-only and has no `uses` mapping.
- The list is read from the nearest `cadence.yaml` that carries the `resources:` key, starting at the parent of the project's root and going up
  (a project at `depth: 2`, `folder/group/project`, reads `folder/cadence.yaml` when `group` carries none): the first file that has the key
  wins, even with `resources: []` or with no value (`resources:`), and the search goes no higher. No file carries it: nothing is declared. Duplicates in the list are ignored.
  The search is not bounded: without a nearer file it goes up to the root of the file system.
- `raf check` reads that file only when an open lot (`todo`, `doing`) carries `uses:`, and writes one gap per name it does not declare:
  `✗ L3 utilise la ressource « banc », non déclarée dans <folder>/cadence.yaml (resources:)` (exit code 1). Without a declaring file the
  gap names the `cadence.yaml` of the parent folder. `done` and `dropped` lots are not checked, so removing a resource from the list does not
  fail the history. A `uses:` that is not a list of valid names is a gap of the lot (`✗ L3 : uses doit être une liste de noms de ressources`);
  an unreadable `cadence.yaml`, or a `resources:` that is not a list of valid names, is a gap naming the file
  (`<file> : resources doit être une liste de noms de ressources`), never an empty list. A plan where no open lot carries `uses:` gets the same
  `raf check` as before.

## Where the plan is

The plan is resolved in this order: `--file`, then `RAF_FILE`, then the `plan:` key of `cadence.yaml`, then `.cadence/raf.yaml`,
then the legacy `docs/plan/raf.yaml`.

- `raf init` creates `.cadence/raf.yaml` and `.cadence/notes/` (with a `.gitkeep`, so git tracks the empty folder). It refuses
  when a plan already exists where it would create one, a legacy `docs/plan/raf.yaml` included: it never creates a second plan
  beside it. With `plan: path` in `cadence.yaml`, or `--file`, the plan and nothing else is created there.
  The commit that follows `raf init` opens no « commit sans lot » gap (L377): the plan, `.cadence/notes/.gitkeep`, the
  `.playwright-mcp/` line of `.gitignore` and a `cadence.yaml` created in the same commit with only `plan:` and `orchestrate:` keys are plan files, so such a commit is
  a plan-only commit for `raf check`, the hook and the tour. Any other file in it, another `.gitignore` line, a `deliver:` or `session:` key
  in a new `cadence.yaml` or a later edit of it keeps it a commit like any other.
- A project that still has `docs/plan/raf.yaml` (and no `.cadence/raf.yaml`) keeps working, read and written as before. Every command
  that loads the plan prints one line on **stderr** (standard output, `--json` included, is unchanged) with the move to do —
  `cd <repository root> && mkdir -p .cadence && git mv docs/plan/raf.yaml .cadence/raf.yaml` (`mv` outside a git repository or when git does not track the file, where `git mv` would fail; the root is spelled out, quoted if
  needed, so the line runs as is from any folder and, under `session --all`, names its project). `raf` never moves the file itself on its own: `raf migrate` does it, with the readers of the path. The line is not
  printed when the path comes from `--file`, `RAF_FILE` or `plan:`.
- When both files exist, `.cadence/raf.yaml` is read and a stderr warning says that `docs/plan/raf.yaml` is ignored; nothing is written
  or deleted.
- `.cadence/` is versioned, except `.cadence/runs/` (the state of the waves) and `.cadence/corrections.json` (the cache of
  `cadence corrections`): `cadence orchestrate` adds those two to `.git/info/exclude` (it replaces the `/.cadence/` line an older
  version wrote there) and the clean-tree guard ignores them, but a change to `.cadence/raf.yaml` or `.cadence/notes/` counts.
- `raf gantt` writes `gantt.html` next to the plan, so `.cadence/gantt.html` by default.
- `cadence lead tour`, `session --all` and `cadence orchestrate` recognise a project by `.cadence/raf.yaml`, `docs/plan/raf.yaml` or a
  `cadence.yaml` with `plan:`.

## The subject of the plan commits: `plan.commit` (L343)

`cadence orchestrate` (the lot started, the code review recorded or noted, the hypotheses and minors of a lot noted) and `cadence spec reseal` (the lot's note) commit
the plan on their own. Their subject has always been `plan: <lot> <action> (orchestrate <wave>)` (`plan: <lot> <action>` outside a wave), which a `commit-msg` hook
that enforces Conventional Commits (commitlint with `config-conventional`, husky) refuses: `plan` is not one of its types, the lot failed before any session and the next one
was handed back with the plan left staged (GitHub issue #15). `plan.commit` in `cadence.yaml` sets the subject of **all** of them:

```yaml
plan:
  commit: 'chore({lot}): {action} (orchestrate {vague})'
```

- `raf done <lot>` does not commit the plan (it never does, see below) but prints the command that would, with this template: `{action}` is `terminé` and, outside a wave, the group holding `{vague}` is dropped (`chore(L12): terminé`). Without a template: `plan: L12 terminé`.
- `{lot}` is required (a commit must cite its lot); `{action}` is what was done (`démarré`, `revue de code enregistrée`, `revue de code notée`, `hypothèses de la fiche <sujet> notées`, `mineurs de la revue de <revue> notés`, `règles R1, R2 sourcées par la réponse du lead`, `test d'acceptation rescellé (<test>)`);
  `{vague}` is the wave id. A word between braces that is none of these, an empty template or one on several lines is refused when the config is read.
- Outside a wave (`spec reseal`) there is no wave: the parenthesised group that holds `{vague}` is dropped, so the template above gives `chore(L17): test d'acceptation rescellé (…)`.
- Absent, the subject is the one above, unchanged. The key needs `plan:` to be an object (`plan: .cadence/raf.yaml` as a plain path has nowhere to put it: write `plan: { path: …, commit: … }`).
- `cadence spec green` (L366) commits its `acceptation-<lot>.json` with the template too when there is one (`{action}` = `acceptation verte, vert: true posé par cadence spec green`); without one its subject stays `chore(<lot>): …`. The tests it reseals are listed in the commit body, never in the subject, which therefore does not grow with them.
- The commit of the fiche sourced by the lead's answer takes the template too (its default, `docs(<lot>): règle R3 sourcée par la réponse du lead (orchestrate <wave>)`, is already Conventional but can exceed `header-max-length` with several rules and a wave id). The `test(<lot>): …` and `chore(<lot>): …` commits of the cycle (acceptation sealed, `vert: true` set) and the work commits are already Conventional and are not templated.
- `cadence orchestrate … --dry-run` runs every plan subject each lot would write through the repository's real `commit-msg` hook (found as git finds it: `core.hooksPath` and husky included), the sheet subjects measured with a subject of real length (the lot's sheet, or the longest of the folder) and the lead's answer with the costly hypotheses it would source, and names the one it would refuse — see [docs/orchestrate.md](orchestrate.md#the-subject-of-the-plan-commits-plancommit-l343).

## Moving the plan: `raf migrate`

`raf migrate [--dry-run]` moves a legacy `docs/plan/raf.yaml` to `.cadence/raf.yaml` and updates what reads the old path, so the
« ancien emplacement » line stops appearing in every session. It is the one command that works on the files of the repository
rather than on the plan; it prints no legacy warning and never commits (review the result with `git status`, then commit).

- **The plan** moves with `git mv` (`mv` outside a git repository, or when git does not track the file), `.cadence/` created if needed.
- **The readers** are the files that cite `docs/plan/raf.yaml` — plan-data scripts, tests, CI workflows, skills, documentation: git's
  tracked and not-ignored files (the whole folder, without `.git` and `node_modules`, outside a repository). Every occurrence is
  rewritten to `.cadence/raf.yaml`. The history is not a reader and is left alone: `CHANGELOG*`, `*.ndjson` journals and `.cadence/`.
- **`--dry-run`** prints the move and every file it would touch, with its number of references, and changes nothing.
- **It refuses** (code 2, nothing moved or written) while a reader is *not handled*: a file that cites `docs/plan` in a way a text
  replacement cannot follow — another file of the folder (`docs/plan/journal.ndjson`), the folder itself, a path built piece by piece
  (`join(root, 'docs', 'plan', 'raf.yaml')`, even split over several lines, `Path("docs") / "plan"`; reported at the line where it starts), a binary file, a text file that is not UTF-8 (rewriting it would alter its bytes), or a file over 2 MiB that cites the path (too big to rewrite; a big file that does not cite it is ignored). Without `--dry-run`, a refusal prints nothing on stdout: nothing is announced as done. Each one is listed as `file:line`. Fix it by hand and run the command again, or
  declare a file that cites the path without reading the plan (a fixture, a document about the old place) under `migrate.keep` in
  `cadence.yaml`: a list of paths or patterns (`*`, `**`, `?`, as `docs.sync`), whose matches are listed as left as they are. A document that names the legacy place next to the new one (a stability contract, a description of the fallback) belongs there too: a line citing both would otherwise be rewritten to cite `.cadence/raf.yaml` twice.
- **It refuses** when `docs/plan/raf.yaml` and `.cadence/raf.yaml` both exist, and when neither does.
- **It can be run again**: with the plan already at `.cadence/raf.yaml` (moved by hand, or by a first run that stopped), it only handles the
  readers that remain, and says `rien à migrer` when there is none.

```yaml
migrate:
  keep: [docs/specs/**, test/legacy-plan.test.ts]   # cite docs/plan/raf.yaml without reading the plan
```

## Plan file

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
    goal: Dedup on merge, bank line kept   # optional (L258): replaces the title as the objective of the `orchestrate` briefs when the title is stale
    after: [L0]
    gate: { count: 8, spec: true }   # optional: not before 8 lots with `spec: true` are done (or `screen: page`)
    created: 2026-09-28
    started: 2026-09-29
    notes:
      - { date: 2026-09-29, text: "keep the bank line when both sources exist" }
    tasks:
      - { id: t1, title: write the migration, status: done }
```

## A plan elsewhere, or in another format

`cadence.yaml`, at the repository root, can say where the plan is. The short form keeps raf's own
format, and the plan stays writable:

```yaml
plan: planning/todo.yaml
```

A relative `plan:` path is read from the repository root, whatever folder you run `raf` from; `--file` and `RAF_FILE` are read from the current folder.

A project that publishes its plan (a JSON generated from it and committed with it)
declares that file, so a commit touching only the plan and its published copy is
plan upkeep; the plan keeps raf's format and stays writable:

```yaml
plan:
  files: [frontend/public/plan-data/plan.json]
```

### Regenerate the published copy on every write (`plan.onWrite`, L346)

Declaring the published file is not enough when it is generated: a hand-regenerated
`plan.json` that drifts from the plan (a flag forgotten) turns the project's
« published plan up to date » check red. `plan.onWrite` makes the program run the
generator itself, after **every** write of the plan:

```yaml
plan:
  onWrite: { command: npm run plan, files: [frontend/public/plan-data/plan.json] }
```

- `command` runs through `sh -c` at the repository root (the folder of `cadence.yaml`, whatever folder `raf` is run from), with a
  2-minute limit. It runs after `raf add|start|done|drop|todo|note|did|title|uses|public|screen|visible|spec|ux|review|ignore|docs-ok`, after the writes of `cadence orchestrate`
  (start of the lot, notes of the review and of the sheet, review recorded), after the plan note of `cadence spec reseal`, after `cadence deliver` opens an article lot, and after the config lot
  of `cadence config set --all`. There is one code path for all of them, so a new command that writes the plan gets it for free.
- `files` (optional list of files, relative to the repository, never outside it; a folder is refused with `plan.onWrite.files « <path> » est un dossier`) are the files the command produces. They are **kept with the plan**, like `plan.files`: a commit that touches only
  them and the plan is plan upkeep, and they go **in the same commit as the plan** everywhere the program commits the plan (`cadence orchestrate`, `cadence config set`, `cadence spec reseal`, the
  `hook.autostart: start` pre-commit). A produced file that is not tracked yet is added. `raf` itself never commits: for its commands, `git add` the plan and the produced files together.
- A command that fails (non-zero code, cannot start, time limit) **refuses the write**: the plan and the declared files are put back as they were, the command stops with
  `plan.onWrite en échec (<command>, code 7) : <last lines of its output> — écriture refusée, plan inchangé`, and in a wave the lot is handed back with that message. With `hook.autostart: start`, the pre-commit hook says `démarrage automatique refusé : plan.onWrite en échec …`, the lot stays todo and the commit goes through without the plan (never the « raf start fait par le hook » line).
  `cadence spec reseal` commits the reseal before writing its note: if `plan.onWrite` then fails, the error says `le rescellé a eu lieu (commit <sha>) mais la note du lot n’a pas été écrite` (exit 2, plan unchanged); running the command again answers « rien à resceller », so add the note by hand with `raf note` once the generator works.
  A command that succeeds without producing a declared file (a wrong path in `files`) does not refuse the write, but says `raf: plan.onWrite a réussi mais le fichier déclaré est absent : <path>` on stderr — the file it really wrote would otherwise stay out of the plan's commit.
- A read-only plan (kept by another tool) never runs the command: the project's tool owns the write.

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
    screen: ecran               # page, component or journey; only on a visible lot (only `page` enters the spec step)
    spec: fiche                 # true or false: the lot changes a behaviour
    status: etat
    estimate: effort
    created: cree_le
    started: demarre_le
    finished: [livre_le, ferme_le]
    notes: note
    repos: depots               # the lot's neighbouring repositories (a list of paths and/or { path, cite }, or one of them)
    parent: parent
  add: 'mytool add {title}'      # optional: the command that creates a lot here (L342: `cadence config set --all` uses it; {title} is replaced by the quoted title)
  commit: 'chore({lot}): {action}'   # optional (L343): the subject of the plan commits cadence writes — see « The subject of the plan commits » below
  statuses:                     # raf status: their states
    todo: [prevu, specifie]
    doing: [en_cours, teste]
    done: [deploye, valide]
    dropped: caduc
  estimates: { S: 0.5, M: 1, L: 3 }   # their effort labels, in working days
```

- Fields: `id`, `title`, `status`, `estimate`, `quickwin`, `visible`, `screen`, `spec`, `public`, `every`, `last`, `after`, `created`, `started`,
  `finished`, `notes`, `repos`, `parent`, `gate`, `goal` (L258: the objective that replaces the title in the `orchestrate` briefs); one left out is read under its own name. A timestamp counts for
  its day; a note written as plain text is one note.
- `gate` (L219) is a drawing condition added to `after`: `gate: { count: N, spec: true }` or `gate: { count: N, screen: page }` (N an integer ≥ 1, one criterion). It is written by hand in the plan (no `raf add` option). The count is the number of `done` lots of the same plan that carry the criterion (`todo`, `doing`, `dropped` lots and sub-tasks do not count; recurring lots do). Until the count reaches N, a `todo` lot is *waiting*, never *ready*: `raf now` lists it on a line `en attente de condition de tirage : L190 (2/8 lots spec: true faits)` (the existing `en attente de dépendances : …` line stays for lots waiting on `after`), `cadence session start` adds an `En attente` section (nothing when no lot is gated) and leaves the lot out of `À suivre` and of the proposals, `cadence lead tour` skips it for `prochain` and adds `attend L190` to the project's line (and `waiting` to `--json`, only when a lot waits), `cadence orchestrate` refuses it before any action (`a:L190 : condition de tirage non remplie : 2/8 lots spec: true faits`) and `--continue` never draws it, and `raf show` prints `gate : 8 lots spec: true faits`. Once the count is reached the lot is ready like any other (the field stays in the plan); a lot already `doing` is not refused for its condition. A malformed `gate` is reported by `raf check` (`gate invalide : …`) and the lot is never drawable. A plan without `gate` behaves exactly as before; `after` read by the Gantt scheduling is unchanged.
- `spec` is the exception to « a left-out field is read under its own name »: a read-only plan's `spec:` is often the path of a spec document, so it is read only when `plan.fields.spec` maps it, and then only `true` counts (any other value is neither an error nor a spec step). Natively, `spec:` stays `true` or `false` (L198). Consequence for a `gate: { count: N, spec: true }` in a read-only plan: it counts only lots whose `spec` is mapped by `plan.fields.spec`; without that mapping the count stays 0 and the lot waits for good, with no `raf check` problem. `gate: { count: N, screen: page }` has no such condition.
- `parent`: an entry `B33/t1-fusion` whose parent is `B33` becomes the sub-task `t1-fusion` of `B33`.
- Ids need no prefix: a commit belongs to a lot when its message cites one of the plan's ids as a
  whole word (`E-A2`, `NC2.4`, `B33/t1-fusion`).
  An id that is not in the plan cannot be told from ordinary text: such a commit counts as
  "without a lot", never as an unknown reference.
- A state missing from `statuses`, or an effort label missing from `estimates`, is reported by
  `raf check`.

## Gantt scheduling

One lane of work. Finished lots use their real dates (or their commits' dates);
lots in progress run until `max(start + estimate, today)`; lots to do follow in
file order, after their dependencies, on working days.
