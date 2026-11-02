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
  file is a commit like any other. `raf check`, `raf now` and `cadence session start` read the files of all the commits in one `git log` call, not one `git diff-tree` per commit (L394: 16.5 s down to 3.4 s for `raf check` on 2,764 commits, `docs/mesures/fichiers-des-commits-2026-10-28.md`).
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
| `raf add "title" [--estimate d] [--quickwin] [--visible [--screen page\|component\|journey]] [--spec] [--local] [--public "title"] [--after L2,L4] [--uses banc,passerelle] [--set field=value]… [--parent L3] [--id AB-1.2 [--under AB-1]]` | add a lot or a sub-task, print its id (`--set`: the value of an [extension field](#extension-fields-planextras-l464) declared by `plan.extras`, refused on a sub-task; `--public`: the lot's title in the public's words, written as `public:` right after `title:`; `--screen`: the screen a visible lot creates or changes — a new `page`, a new `component` or a modified `journey` — written as `screen:` right after `visible:`, shown by `raf show`; it requires `--visible`, and `raf check` reports a `screen:` without `visible:` or with another value as an error. Only `page` triggers the full spec step of `orchestrate` (L209), never inferred from the title; a visible lot above 0.1 day with `component`, `journey` or no `screen:` plays the light mockup (L459); `--spec`: the lot changes a behaviour (something a user, an API client or another service can observe), written as `spec: true` right after `screen:`, `visible:`, `quickwin:` or `estimate:` (whichever comes last), shown by `raf show`, refused on a sub-task. Also set by the lead at planning time, never inferred from the title); `--local`: the lead edits this repository by hand for this lot, written as `local: true` right after `spec:` (or the last key before it), refused on a sub-task ([a lot of the lead](#a-lot-of-the-lead-local-l519)); `--uses`: the shared resources the lot occupies, written as `uses: [banc, passerelle]` after `after:` and before `created:` ([shared resources](#shared-resources-uses-and-resources), L251), refused on a sub-task) |
| `raf add "title" --id <id> [--under <lot>]` · `raf estimate <id> <days>` | free identifiers and flat sub-lots in a writable plan (L465, `plan.idPattern`, below). `--id` gives the lot an identifier of the project's own (`AB-1.2`) instead of the generated `L<n>`; `--under` makes it a sub-lot (`parent: <lot>` written after `title:`; the parent must exist, archived included: `lot parent inconnu : <id>`). Both are refused with `--parent` (which adds a sub-task) and `--id` without `plan.idPattern`. `raf estimate` replaces `estimate:` of a lot of any status, archived included (days > 0 written in decimal, else `estimation invalide : <value typed>`: `0x10`, `1e1`, `abc`, `.5` are refused, and the message quotes what was typed (L535); a sub-task is refused) |
| `raf add "title" --every <days>` · `raf did <id> ["text"]` | recurring lot: `every` (days) and `last` (last time done) fields; the lot stays `todo`, `raf now` and `session start` list it under « Récurrent » with « dû depuis N j » / « prochain dans N j »; `raf did` resets the count (spec: `docs/superpowers/specs/2026-10-04-L11-tache-recurrente.md`) |
| `raf screen <id> page\|component\|journey\|none` | set, replace or remove `screen:` on an existing lot, to adopt the [spec step](orchestrate.md#the-spec-step-of-a-lot-with-screen) on a plan already written (only `page` adopts the [spec step](orchestrate.md#the-spec-step-of-a-lot-with-screen) in full; `component` and `journey` get the [light mockup](orchestrate.md#the-light-mockup-l459) when the lot is visible and above 0.1 day); refused on a lot without `visible:` (like `raf add --screen`) and on a sub-task; `none` removes the key and leaves `visible:` alone |
| `raf visible <id> on\|off` | set or remove `visible:` on an existing lot (a user-facing change: a news entry is expected, and `cadence orchestrate` adds its UX step), written right after `quickwin:`, `estimate:` or `status:` (whichever comes last); `on` on a visible lot changes nothing, `off` on a lot without the key neither; refused on a sub-task, and `off` is refused while the lot has a `screen:` (`raf screen <id> none` first: a screen is a visible change). It is the fix `raf check` points to for an open « Revue UX — » lot without `visible:` (L273) |
| `raf spec <id> on\|off` | set or remove `spec:` on an existing lot (a lot that changes a behaviour, for the back-end spec step of `cadence orchestrate`, see [The spec step of a lot with `spec: true`](orchestrate.md#the-spec-step-of-a-lot-with-spec-true)); refused on a sub-task; `off` is refused on a lot that has `screen: page` (the page implies the spec: remove `screen:` first) and `on` there only says so and changes nothing; on `component` and `journey` both work and set or remove the back-end `spec:` (with `spec: true` the lot plays the back-end spec chain, without it a visible lot above 0.1 day plays the [light mockup](orchestrate.md#the-light-mockup-l459), L459). `raf spec` only takes `on`/`off`: `cadence spec check\|qa <fiche.yaml>` keeps its own subcommands. `raf check` reports a `spec:` that is neither `true` nor `false` (`spec : true ou false attendu`) |
| `raf plan <lot> J1..J2` · `raf plan <lot> --clear` · `raf plan --propose [--per-day n] [--from J] [--apply]` · `raf add --planned J1..J2` | the planned window of a lot, and its proposal for the lots that have none (L466, `plan.requirePlanned`, [below](#planned-window-planned-raf-plan-l466)) |
| `raf uses <lot> [<resource>…]` | replace the `uses:` list of a lot of any status (`done` and `dropped` included) by the names given (duplicates removed, order kept); with no name, remove the key. Prints nothing. A name is a word of lowercase letters, digits, `-` and `_` (else `ressource invalide : <name> (lettres minuscules, chiffres, - et _)`, plan unchanged); a sub-task is refused (`uses se pose sur un lot, pas sur une sous-tâche : L1/t1`); an unknown lot is `lot inconnu : <id>`. A name not yet declared is accepted: `raf check` refuses it (L251) |
| `raf move <id> --before\|--after <id>` | reorder a lot in the plan file (L400): `<id>` is placed right before or right after the other lot, the others keep their order, and the lot travels with all its keys, its sub-tasks and its comments. Only among siblings: a lot among lots, a sub-task (`L1/t1`) among the sub-tasks of its own lot (`move : L2 et L1/t1 n'ont pas le même parent …`, plan unchanged). Exactly one of `--before` / `--after`, one id (else `usage : raf move <id> --before <id> \| raf move <id> --after <id>`); a lot placed where it already is, or an unknown id (`lot inconnu : <id>`), changes nothing. **Refused** on a read-only plan, plan kept by another tool (`plan en lecture seule : … — le modifier avec l'outil du projet`: reorder it with the project's own tool), on an archived lot (`move : L1 est archivé …`: the archive is presented in its former order and the order of the plan file never moves, see `raf archive`) and while a wave holds the repository (`move : orchestration en cours (vague …, pid …) — attendre …`: the lots of the wave rely on the order they read; the lock falls as soon as all of them are ready or handed back). The order is the order of the file, so it is the order `raf list`, `raf now`, the Gantt page and the draw of `cadence orchestrate` follow; the command only writes the plan, it does not commit it (`plan.commit` prints the command, as for every plan write) |
| `raf add`, `raf note`, `raf done` during an integration (L425) | while a wave integrates a lot of the repository (the integration lock is held by a live process), these three commands write the plan as usual and print on stderr `avertissement : intégration en cours (vague …, pid …) — …`: the plan is a tracked file of the main tree, and an integration that sees it modified refuses its lot (`arbre du dépôt modifié`, 2026-10-29: a `raf add` of the lead during the integration of L416). Commit the plan right away. Exit code 0; nothing is printed in a lot's worktree (its plan is not the tree the integration checks) nor when the lock belongs to a dead process |
| `raf add`, `raf note`, `raf done` while a wave works in the main tree (L475) | when the repository's orchestration lock is held by a live wave and one of its lots is in `implementing`, `reviewing` or `fixing` **without a worktree** (a wave without worktrees, or a lot whose worktree folder does not exist), these commands write the plan as usual and print on stderr `avertissement : la vague … travaille dans l'arbre principal de ce dépôt (projet:lot) — …`: a plan commit of the lead then hands the lot back at review (2026-10-30: cadence L458 handed back by a plan commit during its review). Write the plan without committing it, or commit once the step ends. Exit code 0; nothing is printed for lots that are queued, in question, ready, handed back, failed or suspended, for lots playing in their worktree, from a worktree of the repository, from a session of the wave itself (`CADENCE_ORCHESTRATED` set), when the lock belongs to a dead process, or when the wave's state is unreadable |
| `raf public <id> "title"` · `raf public <id> --clear` | set, replace or remove the public title of a lot |
| `raf start <id>` · `raf done <id> [--force]` · `raf drop <id> [--reason text]` | dated transitions (`done` refuses open sub-tasks unless `--force`, with the code-review gate active (`raf review enable`) a lot whose commits its review does not cover, **and a lot whose recorded review verdict says `non conforme` / `not compliant` even when it covers every commit** (L476: `non conforme : 1 bloquant` at the last commit no longer closes; `conforme après 1 correction` is compliant; redo the review with `raf review <id> "verdict"` after the fix, or `--force`), and a lot whose `acceptation-<lot>.json` is still `vert: false`, L366: closed like that it would lock every later wave of the repository, see `cadence spec green`; with `--force` it only warns on stderr. Like every `raf` command it only writes the plan file and **never commits** it: when the plan or a file `plan.onWrite` produces is left with changes, `done`, `ux <lot>` and `review <lot>` print the `git add` / `git commit` command that takes them, the subject from the `plan.commit` template, L371) |
| `cadence spec green <lot>` | L366: run the dedicated acceptance command (`orchestrate.accept`) on a lot driven or closed by hand; green, set `vert: true` in its `acceptation-<lot>.json` and commit that file alone (subject `chore(<lot>): acceptation verte, vert: true posé par cadence spec green` or the `plan.commit` template; the resealed tests are listed in the commit body, never in the subject), resealing the fingerprints of the listed tests refined since the red commit (journal `resceaux`) so the lock goes quiet; a listed test changed but not committed is refused. Red: exit 1, nothing changed. A lot already `vert: true` whose tests lack fingerprints (L526) is replayed and, green, sealed (subject `chore(<lot>): empreintes de l'acceptation posées par cadence spec green`). Refused for a `todo` lot, during a wave, and while an unfinished wave keeps a lot of the repository open; see [orchestrate](orchestrate.md) |
| `raf status [<id> <state> ["message"] \| <id> --back ["message"]]` | the project's **detailed states** (L463, `plan.states`, [below](#detailed-states-planstates-l463)): sets the `state:` of a lot under the guard of `plan.transitions` and notes the message (`état bloque : attend la passerelle`); the base status is derived from the state — a `todo` lot moved to a `doing` state starts (`started:` set), `doing` → `todo` is done here too (so a blocked state of base `todo`, or the return `--back` to a `todo` state, works; `started:` is removed) under the gate of `raf todo`: refused as soon as work commits cite the lot (`L1 a 1 commit(s) qui le citent : le remettre en attente perdrait leur lien — un état doing (raf status L1 <état>), ou raf drop L1`), so a lot with work never goes back to `todo`, where `raf check` would refuse it and a wave could take it again; any other change of base status goes through its own command and gates (`raf done`, `drop`, `todo`; refused with the command to use). Entering the `plan.blockedState` remembers the state before in `state_before:`, `--back` returns to it; with no argument it lists the states with their base status, their number of lots and their transitions. Refused without `plan.states`, on a sub-task, on an unknown state, on the state the lot already has |
| `raf todo <id> [--reason text]` | put a started lot back to `todo` (`doing` → `todo`, `started:` removed, dated note « remis en attente : reason »): refused when work commits cite the lot (plan-only and version commits do not count, as `raf commits`), or on a sub-task; sub-tasks and other keys are left as they are. **Reopening** (L396): on a `done` or `dropped` lot, `raf todo` is THE command — never the YAML — that reopens it (`→ todo`, `finished:` removed, `started:` kept so its commits stay its own, dated note « rouvert (était done) : reason »); `raf start`/`raf done`/`raf drop` on a closed lot say so (`L3 est done ; le rouvrir si c'est voulu : raf todo L3`). An archived lot reopened this way comes back into the plan file at that write |
| `raf migrate [--dry-run]` | move `docs/plan/raf.yaml` to `.cadence/raf.yaml` and rewrite the readers of the old path in the repository, see [Moving the plan: `raf migrate`](#moving-the-plan-raf-migrate) |
| `raf note <id> "text"` | dated note — keep decisions next to the work |
| `--verbose` on `raf done`, `ux`, `review`, `note`, `move`, `public` · `raf hook post-commit --verbose` (L453) | those commands print no title of the lot they touch (nothing in the lead's context but `L12 → done` and the `plan non commité` command, which is unchanged); `--verbose` adds one line `L12  doing  <full title>` (nothing for a sub-task). The post-commit hook warning `raf: L12 (doing) <title>` cuts the title at 60 characters (59 and `…` beyond; a title of 60 stays whole), `--verbose` on the hook gives it whole. `raf show`, `raf list`, `raf now` and the session tables are not concerned |
| `raf title <id> "new title"` | replace the title of a lot of any status (`done` included) and add a dated note « titre remplacé : « old title » »; `raf now`, `raf show`, `raf list`, `session start` and the proposals read the new one. Refused on an empty or identical title, an unknown lot or a sub-task |
| `raf archive [--before date] [--dry-run]` | move the `done` and `dropped` lots (those finished strictly before `--before`, when given; a lot with no `finished:` date stays then) out of the FILE `.cadence/raf.yaml` into `.cadence/archive/<year>.yaml`, the year of their end (L396). **The archive is a storage detail, invisible to every reader**: the loaded plan presents all the lots, active and archived, **in the order they had before the archiving** — each archived lot takes its place by number among the lots of the plan file (just before the first active lot with a greater number), the order of the plan file itself never moves; under `plan.idPattern` (free ids such as `AB-1`, `X3.4`: the final number says nothing of the order) every archived lot, whatever its id (`L7` included), is archived with a `place:` key, the id of the lot that preceded it in the plan as presented, archived lots included (empty: it was first), so lots archived in different runs keep the plan's order, and comes back right after that lot (`place:` is removed when the lot is reopened, and the archived lots whose `place:` named it are re-pointed to the lot that preceded it: only the reopened lot moves, to the end of the plan). `place` is thus a key cadence writes on a lot: `plan.extras.place` is refused — so `raf show`, `raf list`, `raf commits`, `raf check`, `raf now`, `raf gantt`, `cadence news`, `cadence perf`, `session start`, `lead tour`, `cadence ref coverage`, `cadence deliver`, the post-commit hook and `cadence orchestrate` print exactly what they printed before the archiving — nothing has to « also look in the archive », a lot id is never reused, and a commit or a News entry citing an archived lot is not « inconnu ». What changes is the file: the plan the sessions open stays short (the cadence plan weighed 559 KB, ≈ 150 k tokens) and the briefs of the implementation, the sheets, the code review and the pre-check tell the sessions never to open `.cadence/archive/`. **Writing**: every lot goes back to the file it came from — `raf note`, `raf review`, `raf ux`, `raf title`… on an archived lot rewrite its year file, the plan file is untouched; a lot reopened (`raf todo <id>`, or `status: doing` set by hand in a year file) comes back to the end of the plan file at the next write, so the archive only ever holds `done` and `dropped` lots. **Lossless, whatever fails**: the year files are written before the plan file (should the plan then fail to write, a moved lot is at worst duplicated — which the next load refuses by name — never lost), and any exception during the write (`EACCES` on a read-only file, a full disk, a `plan.onWrite` command that fails) puts the plan, the year files and the declared files back as they were — a year file born of that write disappears — and the error says so (`écriture du plan refusée (EACCES, …) — plan et archive inchangés`). **Guards**: a closed lot with an open gap (what `raf check` signals — code review, UX review, docs.sync, News entry…) stays in the plan with the gap as its printed reason (`L1 reste dans le plan : écart ouvert — L1 est visible et terminé sans entrée Nouveautés …`); a lot named in `after:` by another, or counted by a `gate:`, is archived like any other — the readers see the archive, so the dependency and the count read the same. A same id found in two files (plan and archive, or two years) is a named error that stops every command (`identifiant en double : L1 est dans .cadence/archive/2025.yaml et dans .cadence/raf.yaml`) until one copy is removed by hand — never a silent choice of one copy. `--dry-run` lists without writing; `--before` takes `YYYY-MM-DD`; refused on a read-only plan (its tool keeps its own history) and while the plan is still at the legacy `docs/plan/raf.yaml` (the archive would land under `docs/`, published, and `raf migrate` would not move it: `raf migrate` first, the refusal says so). For `cadence orchestrate`, the year files are plan files like `.cadence/raf.yaml`: a session that commits one has « touché le plan ». Like every plan write, it is not committed: the command to commit the plan and the archive files together, at explicit paths, is printed (`plan.commit` template, action `N lot(s) archivé(s)`); replaying moves nothing twice. The archive files are kept with the plan: touching them is not working on a lot. **The published plan**: a generator run by `plan.onWrite` (below) that reads only the file `.cadence/raf.yaml` publishes a plan without the archived lots; `raf archive` says so on stderr when `plan.onWrite` is declared, the generator must also read `.cadence/archive/*.yaml` (key `lots`, same lot format as the plan) |
| `raf show <id> [--notes]` | one lot: status, dates, `goal : …` right after the title when the lot has a `goal:` (native key or `plan.fields.goal`, L272: the objective that replaces the title in the `orchestrate` briefs), `after`, public title, then for a visible lot two stable lines — `visible : oui` (followed by `screen : …` when the lot has one) and `ux : <verdict>` or `ux : absent` (the `raf ux` verdict, L439: what the `livreur` agent reads before closing a visible lot; a lot that is not visible prints neither line), `spec`, `uses : banc, passerelle` when the lot has `uses:`, dated notes in order, then the counted commits (as `raf commits`, neighbouring repositories included); `--notes` prints the notes alone |
| `raf commits <id>` | the commits counted for a lot (the set the code review gate uses), one `<sha> <subject>` per line, oldest first; a lot that declares `repos:` ([neighbouring repositories](orchestrate.md#a-lot-whose-work-is-in-a-neighbouring-repository)) gets, after them, one `dépôt <path> :` section per neighbour with the commits there that cite the lot and fall within the lot's period (`started` to `finished`) and, when the lot declares a `cite:` for that neighbour, contain that string (`aucun commit du lot`, or `introuvable` for a path that is not there) |
| `raf now` | what to do next |
| `raf list [--status s] [--json]` | flat list; `--json` prints the lots as a JSON array (L464, [extension fields](#extension-fields-planextras-l464)) |
| `raf docs-ok <lot> --reason text` | acknowledge the `docs.sync` gap of a lot (a document behind its commits, `raf check` red) when the documentation really stays true: a `docs_ok: { date, reason }` key on the lot, **the reason is required** (refused without it, for an unknown lot or for a sub-task); `raf check` and `cadence lead tour` no longer count the lot, `raf show` prints it, and `cadence orchestrate` neither calls the librarian nor holds the lot back for it. Commit the plan with it; on a read-only plan (kept by another tool) the key goes to `.cadence/docs-ok.yaml` instead, and that file is committed (L386) |
| `raf ignore <sha> \| "exact subject" [--reason text]` | acknowledge a commit without a lot (tooling chore, a plan commit citing an unknown id) or a commit that cites known lots without working on them (a lead's plan commit creating lots, a setting cited in parentheses): it then counts for none of them — not started, not active, not to review (`raf commits` omits it) — without rewriting history: a dated, reasoned line in the plan's `acknowledged:` section; a sha is exact, a subject covers every commit carrying it; exactly one commit argument, the reason goes through `--reason "text"` (`raf ignore 1a2b3c4 "tooling"` is refused with « un seul commit attendu ; la raison se passe par --reason "texte" », exit 2) |
| `raf check --ignored` | list the acknowledged commits with their date and reason |
| `raf check [--since date] [--idle 7]` | since the plan's adoption date by default (a visible lot without a public title is only a `⚠` warning: it never changes the exit code): commits without a lot (commits touching only plan files, or only version fields, `CHANGELOG.md`, the README's « What's new » section and `docs/whats-new.md` are exempt), unknown ids, `todo` lots that already have commits, idle lots (an open lot whose sub-lots, entries carrying `parent:` (native plan, `raf add --under`, L465, or a plan kept by another tool), have a recent commit or are in progress is not idle: L321), `done` lots with open sub-tasks, bad or circular dependencies, and an open lot titled « Revue UX — <screen> » without `visible: true` (`ux-review-not-visible`, an error: such a lot goes through precheck → implement → review with no UX step, so the screen is never reviewed — finance L32 on 2026-10-23; L271; the message names the fix, `raf visible <id> on`, L273; on a read-only plan, plan kept by another tool, it never names a `raf` command, which would refuse: with `plan.fields.visible` mapped it says to set `visible:` with the project's tool, without it it says the plan carries no `visible`, to map the field in `cadence.yaml` (`plan.fields.visible`) if the project's tool writes it, and that otherwise the UX review of that screen happens outside orchestrate, L321) |
| `raf gantt [-o file]` | standalone Gantt page |
| `raf hook pre-push` | called by the temporary `pre-push` hook that `cadence orchestrate` installs (not by `raf hook install`): reads git's lines on the standard input and exits 3 when the push carries a commit of a lot of the live wave that is not ready, naming the lot and the safe `git push <remote> <sha>:<remote branch>`, or when the commits of a not-ready lot cannot be read (the guard of `deliver --sha`: the push is then unverifiable, the lot is named); exits 3 as well, with or without a live wave, when the project declares a gate (`orchestrate.test` or `orchestrate.build`) and the local sha of a pushed branch has no green verdict of `cadence verify --gate` (L426; a commit that changes only the plan takes the verdict of its parent, L432: « aucun verdict de la porte » or red, naming `cadence verify --gate --sha <sha>`; `CADENCE_PUSH_UNGATED=1` in the environment of the `git push` lets it through and says so); exits 0 when nothing is to refuse |
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

## A lot of the lead (local, L519)

`raf add "…" --local` marks a lot (`local: true`) that the lead does by hand in this repository instead of giving it to a wave (a touch-up the lead would rather see in the editor, a change that needs the lead's eyes all along). Two commands carry it:

| Command | What it does |
|---|---|
| `cadence local start <lot> [--ttl minutes]` | locks the repository as a wave does (`orchestrate.lock`, under the name `local:<lot>`): no wave starts in it, `orchestrate --resume` and `orchestrate --add` are refused with « une tâche locale du lead y est en cours (<lot>, depuis …) », and `deliver` and `raf move` are refused with the same message (the task is named with its exit `local done` / `local abort`; no `--sha` advice, a local task has no wave lots). The lot goes to `doing`. The lock is **declared**, like `cadence lead hold`: no process carries it (the shell that runs the command dies with the Bash tool call, and the lead's session has no stable process name), it holds until `local done` or `local abort`, and `--ttl` (60 min by default) is only the announced duration — past it, the lock still holds and `cadence lead tour` and `orchestrate --status` print « ⚠ tâche locale échue : <lot> … » until the lead finishes or aborts it; it never lapses silently. Refused, with nothing locked or written, when the lot is unknown, not marked `local`, `done` or `dropped`, when a wave or another local task holds the repository, or when another lot of the plan is `doing` (it is named). |
| `cadence local done <lot>` | plays the project's gate **once** (`orchestrate.build`, then `orchestrate.test`, at `HEAD`, as `cadence verify --gate`) and, if it is green, frees the repository. Red (code 1) or nothing to replay (code 2): the lock stays, fix and run it again. Refused when this lot's local task does not hold the lock. |
| `cadence local abort <lot>` | frees the repository without playing the gate (the task is given up or will be resumed later); the plan is not touched — the lot stays `doing`, `raf todo <lot>` puts it back. Refused when this lot's local task does not hold the lock. |

`local start` writes the plan (the lot goes to `doing`): commit it with the first commit of the lot. After `local done`: take the capture of a visible lot, read the lot's diff and record the verdict yourself (`raf review <lot> "…"` — on a plan with `reviewSince`, `raf done` refuses a lot with commits and no verdict; the express lane records its own verdict because a session did the work and the lead reads the diff at delivery, here the lead did the work, so the verdict is the lead's own reading and is written by hand), `cadence deliver`, then `raf done <lot>` — the lot is traced in the plan like any other (its commits cite it, `feat(L12): …`). A local lot is never played by a wave: `cadence orchestrate <project>:<lot>` (launch, `--add`, `--continue`) refuses it by name. During the task the pre-push hook sees the lock as a local task, not as a wave: no wave check, no « état illisible » warning; the gate check (`CADENCE_PUSH_UNGATED`) applies as usual.

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

- `raf done <lot>`, `raf ux <lot> "verdict"` and `raf review <lot> "verdict"` (L509) do not commit the plan (raf never does, see below) but print the command that would — the plan and the files `plan.onWrite` regenerated, so a published `plan.json` is never left behind — with this template: `{action}` is `terminé` (`verdict UX enregistré` for `ux`, `revue de code enregistrée` for `review`) and, outside a wave, the parenthesised or bracketed group holding `{vague}` is dropped (`chore(L12): terminé`). Without a template: `plan: L12 terminé`.
- `{lot}` is required (a commit must cite its lot); `{action}` is what was done (`démarré`, `revue de code enregistrée`, `revue de code notée`, `hypothèses de la fiche <sujet> notées`, `mineurs de la revue de <revue> notés`, `règles R1, R2 sourcées par la réponse du lead`, `test d'acceptation rescellé (<test>)`);
  `{vague}` is the wave id. A word between braces that is none of these, an empty template or one on several lines is refused when the config is read.
- Outside a wave (`spec reseal`) there is no wave: the parenthesised or square-bracketed group that holds `{vague}` is dropped, so the template above gives `chore(L17): test d'acceptation rescellé (…)`.
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

## Detailed states: `plan.states` (L463)

A project that tracks more than `todo`, `doing`, `done` and `dropped` (« tested », « delivered », « blocked »…) declares its own states in `cadence.yaml`. The base status stays the four above — every gate of cadence (`raf done`, reviews, UX, `raf now`, the Gantt) reads only it — and each state names the base status it belongs to:

```yaml
plan:
  states: { a_faire: todo, en_cours: doing, bloque: doing, termine: done, livre: done, abandonne: dropped }
  transitions:                       # optional: without it nothing is guarded
    a_faire: [en_cours, bloque, abandonne]
    en_cours: [bloque, termine, abandonne]
    bloque: [en_cours, abandonne]
    termine: [livre]                 # a state with no entry is terminal once `transitions` is declared
  doneState: termine                 # what `raf done` sets (default: the first done state)
  blockedState: bloque               # `raf status <lot> --back` returns from it
```

`states` is an ordered object, state → base status, and must hold at least one `todo`, one `doing` and one `done` state. The state is written as `state:` right after `status:` (and `state_before:` while blocked). `raf start`, `raf done`, `raf drop` and `raf todo` set the state of their status themselves (`doing` → the first `doing` state, `done` → `doneState`, …) and obey `plan.transitions` too — refused with the allowed states, `--force` passes (`raf todo`, the reopening, is not guarded). A lot with no `state:` (written before the declaration) is read in the default state of its status. `raf check` reports a `state:` that is not declared or whose base status contradicts `status:`. `raf show` prints `état :`. `plan.states` does not go with a plan held by another tool (`lots`, `fields`, `statuses`, `estimates`): its states are its own.

## Extension fields: `plan.extras` (L464)

A project that sorts its lots by something cadence does not know (a theme, an owner, the path of a sheet) declares the field in `cadence.yaml`, and cadence then keeps it, checks it and shows it:

```yaml
plan:
  extras:
    theme: { enum: [infra, ui, data] }   # only these values
    owner: { default: claude }           # what a lot without the key is read as
    fiche: {}                            # any non-empty text
```

- **Declaration.** A name is lowercase letters, digits and `_`, starting with a letter, and is not a key cadence uses on a lot (`status`, `estimate`, `after`, `notes`, `tasks`, `uses`, `repos`, `place`…). `enum` is a non-empty list of distinct texts; `default` is a non-empty text, one of the `enum` values when there is one. Anything else is refused, naming the key (`cadence.yaml : plan.extras.theme.color inconnu`). `plan.extras` is refused together with a plan kept by another tool (`plan.lots`, `plan.fields`…, read-only): cadence writes no field there.
- **On the lot.** The field is a plain key of the lot, a text (`theme: ui`). A key that is **not** declared is neither read nor checked, and stays in the file as written, as do the declared ones: every `raf` write (start, note, done, title, archive…) edits the lot in place.
- **`raf check`.** A declared field whose value is not a non-empty text or is outside `enum` is a `bad-field`: `L12 : theme « zzz » hors de enum (infra, ui, data)`. A lot without the key is fine; with a `default` it is read with the default (nothing is written to the file, so changing the `default` changes every lot that does not carry the key).
- **`raf add "title" --set theme=ui`** writes the key on the new lot (before `created:`); `--set` can be repeated, the value is cut at the first `=` (`--set fiche=docs/a=b.md`). Refused, with nothing written: a field that is not declared (the message lists the declared ones; without `plan.extras`, it says so), a value outside `enum`, `--set theme` or `--set theme=` without a value, the same field twice, and `--set` with `--parent` (a sub-task has no field).
- **`raf show`** prints one `field : value` line per field the lot carries or receives by default. **`raf list --json`** prints the lots (filtered by `--status`) as one JSON array with the fields of the lot under the names of the plan file (`docs_ok`, not `docsOk`; `problems`, the diagnostics of `raf check`, is not exported), the extension fields under `extras` (absent when the plan declares none or the lot has none). A field is set on an existing lot by editing the file; there is no `raf` command for it yet.

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
    planned: { from: 2026-10-05, to: 2026-10-07 }   # optional (L466): planned window, set by `raf plan`
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

### Free identifiers and flat sub-lots (`plan.idPattern`, L465)

A plan that keeps raf's format can use identifiers of its own (`AB-1.2`, `X3.4`, `E-GL5`) next to the generated `L<n>`.
The project declares their shape in `cadence.yaml`, as a regular expression **without anchors** (raf anchors it):

```yaml
plan:
  idPattern: '[A-Z]{1,3}-?\d+(?:\.\d+)*'
```

- The key is refused at read time when it is not a text, is empty, starts with `^` or ends with `$`, accepts the empty identifier, is not a valid expression, or uses the reserved group names `id` and `sub`; the error names `plan.idPattern`.
- `raf add "title" --id AB-1.2` writes that identifier. It must match the pattern in full, contain no `/` (reserved to sub-tasks) and not exist yet, archived lots included. Without `--id`, ids stay `<prefix><n+1>`, whatever the free ids in the plan.
- `raf add "title" --id AB-1.2 --under AB-1` writes `parent: AB-1` on the lot: a sub-lot **laid flat** in `lots:`, whose id does not start with its parent's. It keeps its own dates, notes, estimate and status; `raf check` counts its commits for the idleness of a parent in progress.
- Commit messages: with the key, the ids cited in a message are `<prefix>\d+` **or** the pattern, point and digits included (`AB-1.2`, not `AB-1`), with an optional sub-id after a slash: `X7/t2` is the sub-task `t2` of `X7`; any other sub-id (`X7/t1-fusion`) cites the lot `X7`. An id is not read inside a word, after a `/`, or when followed by a dot and a word character (`X3.x`); a closing dot (« see X3. ») is fine. A `<prefix>\d+` id keeps the guard it has without the key (`feat(L3-L5)` cites L3 and L5, `release-L3` cites L3); an id that comes from the pattern is stricter and is not read after a `-` or a `.`, nor before a `-` (`AB-1-x`). So `raf commits`, the review gate and `raf check` see the work of lots with free ids. Without the key nothing changes: only `<prefix>\d+` and `/t<n>` are recognised.
- `raf estimate <id> <days>` is the command that changes the estimate of an existing lot.
- A `parent:` written by hand that is not a text is ignored and reported among the lot's problems; an unknown parent is not checked.

### Regenerate the published copy on every write (`plan.onWrite`, L346)

Declaring the published file is not enough when it is generated: a hand-regenerated
`plan.json` that drifts from the plan (a flag forgotten) turns the project's
« published plan up to date » check red. `plan.onWrite` makes the program run the
generator itself, after **every** write of the plan:

```yaml
plan:
  onWrite: { command: npm run plan, files: [frontend/public/plan-data/plan.json] }
```

- After `raf archive` (L396) the command sees only the file `.cadence/raf.yaml`: the generator must read `.cadence/archive/*.yaml` (key `lots`) too, or the published copy loses the archived lots; `raf archive` warns of it on stderr. `raf` itself needs nothing: its loaded plan already presents the archived lots.
- `command` runs through `sh -c` at the repository root (the folder of `cadence.yaml`, whatever folder `raf` is run from), with a
  2-minute limit. It runs after `raf add|start|done|drop|todo|note|did|title|uses|public|screen|visible|spec|ux|review|ignore|docs-ok`, after the writes of `cadence orchestrate`
  (start of the lot, notes of the review and of the sheet, review recorded), after the plan note of `cadence spec reseal`, after `cadence deliver` opens an article lot, and after the config lot
  of `cadence config set --all`. There is one code path for all of them, so a new command that writes the plan gets it for free.
- `files` (optional list of files, relative to the repository, never outside it; a folder is refused with `plan.onWrite.files « <path> » est un dossier`) are the files the command produces. They are **kept with the plan**, like `plan.files`: a commit that touches only
  them and the plan is plan upkeep, and they go **in the same commit as the plan** everywhere the program commits the plan (`cadence orchestrate`, `cadence config set`, `cadence spec reseal`, the
  `hook.autostart: start` pre-commit). A produced file that is not tracked yet is added. `raf` itself never commits: for its commands, `git add` the plan and the produced files together.
- A command that fails (non-zero code, cannot start, time limit) **refuses the write**: the plan and the declared files are put back as they were, the command stops with
  `plan.onWrite en échec (<command>, code 7) : <reason> — écriture refusée, plan inchangé`, where the reason is one line: the first `Error: …` line of the command's error output (a Node script that throws prints the file, the faulty line, then the reason, then the stack: the reason is what shows, e.g. `titre public … non conforme (93 caractères > 80)`, L429), else the first line of its error output, else of its standard output, and in a wave the lot is handed back with that message. With `hook.autostart: start`, the pre-commit hook says `démarrage automatique refusé : plan.onWrite en échec …`, the lot stays todo and the commit goes through without the plan (never the « raf start fait par le hook » line).
  `cadence spec reseal` commits the reseal before writing its note: if `plan.onWrite` then fails, the error says `le rescellé a eu lieu (commit <sha>) mais la note du lot n’a pas été écrite` (exit 2, plan unchanged); running the command again answers « rien à resceller », so add the note by hand with `raf note` once the generator works.
  A command that succeeds without producing a declared file (a wrong path in `files`) does not refuse the write, but says `raf: plan.onWrite a réussi mais le fichier déclaré est absent : <path>` on stderr — the file it really wrote would otherwise stay out of the plan's commit.
  A command that writes a file **not listed** in `files` (an incomplete declaration, L436) does not escape the commit either: `raf` compares the files git sees as modified before and after the command, so the `git add` / `git commit` it prints and the pre-commit hook's staging include what the command really changed, and stderr says `raf: plan.onWrite a écrit <path>, absent de plan.onWrite.files — l'ajouter dans cadence.yaml`. A file the lead had already modified and the command did not touch is not cited; a failed command cites nothing (the write is refused). The list lives for the process that wrote the plan, so declare the file to have it cited everywhere (deliver, the wave).
- A read-only plan (kept by another tool) never runs the command: the project's tool owns the write.

Until the file is declared, such a commit is reported as a "commit without a
lot" when it cites none, and counts as work on the lots it cites.

A project that already keeps its plan with its own tool is read **without migrating it**: describe
the file, and `raf now`, `raf list`, `raf commits`, `raf check`, `raf gantt` and
`cadence session start|close` work on it. Such a plan is **read-only** —
`raf add|start|done|note|ux|review` refuse and leave the file to the project's tool, and the two
review gates do not apply to it (a `uxSince` or `reviewSince` written in it is ignored).
One acknowledgement is kept outside the plan so it works here too: `raf docs-ok <lot> --reason "…"`
writes `.cadence/docs-ok.yaml` (next to `cadence.yaml`, one line `L12: { date: 2026-10-27, reason: … }` per lot),
never the plan; commit that file. `raf check`, `raf show`, `cadence lead tour` and `cadence orchestrate` read it
(an entry without a reason acknowledges nothing, an unreadable file is an error that names it) (L386).

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
    screen: ecran               # page, component or journey; only on a visible lot (only `page` enters the full spec step; the others, if visible and above 0.1 day, the light mockup)
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
file order, after their dependencies, on working days. A lot to do that carries a planned window
([below](#planned-window-planned-raf-plan-l466)) takes its bounds instead, and the lots without a window
queue as before; a lot that follows it starts after its end.

## Planned window: `planned:`, `raf plan` (L466)

A lot (or a flat sub-lot) can say **when** it is planned, apart from how long it takes: `planned: { from: 2026-11-03, to: 2026-11-05 }`
in the plan file (native plans only; a plan kept by another tool is read-only and has no window).

- **Reading.** Both keys are calendar days (`AAAA-MM-JJ`, `2026-02-30` is refused), `from` ≤ `to`, no other key. Any other form is a problem of the lot, reported by `raf check` as an error (`✗ L1 : planned : …`), and the lot has no window.
- **Inheritance.** A sub-lot (`parent:`, [free identifiers](#free-identifiers-and-flat-sub-lots-planidpattern-l465)) without a window of its own has the one of its nearest ancestor that has one; `raf show` says `prévu : 2026-11-03..2026-11-05 (hérité de L1)`. An unknown parent, or parents in a loop, give nothing.
- **`raf plan <lot> J1..J2`** sets or replaces the window of a lot of any status, archived included (a single day `J` is the window of one day); `raf plan <lot> --clear` removes it. Refused: an unknown lot, a sub-task (`L1/t1`), a malformed or reversed window, a read-only plan. Like every write of the plan it is not committed.
- **`raf add "title" --planned J1..J2`** writes the window with the lot (refused on a sub-task, `--parent`).
- **`plan.requirePlanned: true`** in `cadence.yaml` (a boolean; refused with a plan kept by another tool) makes `raf add` refuse a lot with no window — its own `--planned`, or one inherited through `--under` from a parent that has one. A recurring lot (`--every`) is exempt. Without the key, nothing is required.
- **`raf plan --propose [--per-day n] [--from J]`** prints a window for every lot `todo` that has none (own or inherited), recurring lots excepted, and writes nothing. The lots are laid on one lane of **working days** starting at `--from` (today by default; a Saturday starts on the Monday); `--per-day n` days of estimate fit in one working day (1 by default, `0.5` doubles every duration, `2` fits two one-day lots in a day). Ready lots come first: a lot that waits for another lot still to be placed (`after:`) comes after it, then the plan order; a lot that follows a lot already planned starts the working day after its end (a window already past delays nobody). The windows already written are not counted as load: the proposal is a starting point. **`--apply`** writes them all in one plan write and prints the one `git add … && git commit …` command that commits them (action `N fenêtre(s) prévue(s) posée(s)`, `plan.commit` template): raf never commits the plan itself. Played again, `--propose` finds nothing (`rien à proposer`). `--apply`, `--per-day` and `--from` without `--propose` are refused, and so is a lot name with `--propose`.
- **`raf check`** warns (`⚠`, exit code unchanged) when a sub-lot's own window is not inside the one of its parent (`AB-1 : fenêtre prévue … hors de celle de L1 (…)`).
- **`session start`** has a « Fenêtres prévues » section for the lots `todo` or `doing` (recurring excepted) — first the late ones (`en retard de 3 j (prévu jusqu'au …)`, the longest first), then the lots `todo` whose window began (`devait démarrer le …`), then the deadlines of the next 7 days (`échéance aujourd'hui`, `échéance dans 3 j`); nothing when no lot is concerned.
- **`raf gantt`** draws a lot `todo` with a window between its bounds (tooltip « fenêtre prévue »). A lot `doing`, `done` or `dropped` keeps its real dates.
- **`raf list --json`** exports the window under the file's key `planned`.
