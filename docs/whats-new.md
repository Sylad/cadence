[← cadence](../README.md)

# What's new, version by version

## In two lines

- **1.11.0**: a new `orchestrate` skill gives the command line of a wave without `/lead`; the `deliver` skill says how to deliver a commit that is not `HEAD` (push that sha alone first, never forced).
- **1.10.0**: the worktree mode of `cadence orchestrate` needs only the `orchestrate.worktrees` key and is on for cadence itself; the gate plays `orchestrate.build` before the tests, and `lead tour` flags a missing `orchestrate.test`.
  A lot waiting for a slot obeys `--drop` and `--stop-after-current`, the pre-check is back on Sonnet, `cadence perf` classes red deliveries, and the README is a short home page again.
- **1.9.0**: the plan lives at `.cadence/raf.yaml` (`raf migrate`); `cadence ref` reads reference documents; `doc-keeper` agent, `orchestrate.testGate`, `cadence lead hold` shown by `cadence-hud`.
- **1.8.0**: `cadence perf` shows the speed of the workflow next to its quality (cost in euros per delivered lot, red deliveries, blocking QA findings), and `cadence lead tour` opens with a perf header.
- **1.7.0**: `cadence orchestrate` no longer replays `accept` on a green sealed acceptation and refuses `--resume --dry-run`; `spec reseal --porteur` accepts a sheet amended by a delivered lot; the README becomes a short home page.
- **1.6.0**: the mockup review sweeps everything in its first report and runs up to `orchestrate.maquetteReviews` times (3 by default); the acceptance lock names the first offending commit.
- **1.5.1**: publishes 1.5.0 (tagged, never published): one UX review per lot, replay of a lot handed back for its budget, a self-check list in the briefs, a `tests.yml` workflow.
- **1.5.0**: `gate: { count: N, … }` makes a lot wait for N done lots of a kind; `raf todo <id>` puts a started lot without work commits back to `todo`.
- **1.4.0**: `cadence spec reseal` accepts a sheet amended by the lot's commits; wave budgets recalibrated; a `git checkout` in a session no longer stops the wave.
- **1.3.0**: the spec step narrows to `screen: page`; `cadence spec reseal … --porteur` re-seals an unstable test; `cadence orchestrate --waits`; a third correction pass when the review converges.
- **1.2.0**: the spec step reaches lots without a screen (`spec: true`), `orchestrate.accept` may be a list of runners, `lead.ux: lead`, and the code in service is a separate worktree.
- **1.1.0**: the spec step of `cadence orchestrate`: screen sheet, reviewed mockup, red locked acceptance tests, and briefs that carry rule → test → green.
- **1.0.0**: the first major release, a stable contract that follows semantic versioning; the [stability page](stabilite.md) lists what is guaranteed.

<details>
<summary>Older versions (0.10.0 to 0.28.0)</summary>

Each is a paragraph in [docs/whats-new.md](whats-new.md) and a full section in [CHANGELOG.md](../CHANGELOG.md): `cadence-hud` (0.12.0 to 0.25.0), `cadence orchestrate --continue` and `--status --watch`, `cadence lead tour`, `hook.autostart`, `docs.sync` and `docs.articles`, neighbouring repositories, `raf ignore`.

</details>

## Version by version

The long form of « In two lines » above (the README no longer carries a « What's new » section since L326: it links here). The full history, with the date of each version, is in [CHANGELOG.md](../CHANGELOG.md).

**1.11.0**: the plugin eval of 1.10.0 found two gaps in the skills, both closed and replayed at 1.00. A new `orchestrate` skill (L335, `docs/skills.md`) carries the command line of `cadence orchestrate` — `<project>:<lot>[@<model>]`, a lot id with « / » kept as is, `--resume` with or without `--wave` — so that an agent reaches it without `/lead` instead of inventing `--lot` and `--model`. The `deliver` skill (L334, `docs/deliver.md`) says how to deliver a commit that is not `HEAD`: push that sha alone (`git push origin <sha>:main`), then `cadence deliver --dry-run --sha <sha>` and `cadence deliver --sha <sha>`, because with `ci: github` the wait is for the run of that exact sha and GitHub only builds the tip of a push; skip the push when the sha is already on a remote branch, and never force a push refused as non-fast-forward.

**1.10.0**: the worktree mode of `cadence orchestrate` (one git worktree per lot, independent lots of one repository in parallel) is no longer behind `CADENCE_EXPERIMENTAL_WORKTREES=1`: the `orchestrate.worktrees` key alone is the switch, on start and on `--resume`, `--integrate`, `--replay` and `--continue`, and cadence's own `cadence.yaml` turns it on after the trials L310 and L316 (L320); a red at the integrated tip is played once more before the lot is handed back, and the refusal names the red tests (L328); a union of the `CHANGELOG.md` entries of parallel lots, which accepts that a lot rewrites its own entry (L314, L323), and a kept branch recovered without the pre-check (L311). The gate of the wave plays `orchestrate.build` before `orchestrate.test`, a red build handing the lot back as a « build » finding (L333); `cadence lead tour` and `cadence orchestrate --dry-run` flag a project without `orchestrate.test` and name the probable command (L327). The pre-check is back on Sonnet in cadence's own configuration after the local model failed on about one lot in three, skips a lot created after the last code commit of the repository, and `cadence perf` measures it per lot (L322, L328). A lot waiting for a session slot obeys `--drop` and `--stop-after-current` (L332); `--resume` without a wave resumes the only unfinished one and is refused when several are (L309). `cadence perf` classes the red deliveries written before the class from their text (L331) and names the step that carries a rise of the tokens per lot (L312). `npm run service` purges the old copies put in service (L330), `cadence deliver` keeps a Ctrl-C (L325, L329), and `raf docs-ok` acknowledges a `docs.sync` gap (L317); `raf check` no longer reports two false drifts (L321). `cadence ref analyse` reads a reference document, `cadence ref diff` reconciles two readings and `--double` reads twice, an option (L265, L266); `cadence ref add` cites a range of figures and no longer reads « code figure n » as a citation (L274, L313); a failing PDF tool is a refusal, not a stack trace (L275). The README is a short home page again, the detail having moved to `docs/overview.md` (L326). Details: [CHANGELOG.md](../CHANGELOG.md).

**1.9.0**: the default plan is `.cadence/raf.yaml`, a hidden folder git versions and `docs/` never publishes (L246), and `raf migrate [--dry-run]` moves a legacy plan and the readers of the old path (L284, L305); `raf title`, `raf visible`, `uses:` resources shown by `lead tour` and the lot `goal:` (L244, L273, L251–L253, L258). `cadence ref add|measure|check|corpus|eval` registers reference documents outside the repository, measures a rendered zone, validates the inventory schema and scores a reading against a known truth (L261–L264). In `cadence orchestrate`: the `doc-keeper` agent and `docs.articles` (L306, L308), the mechanical `orchestrate.testGate` before the review (L287), `precheck: local` on every lot with no commit (L296), a write-step time limit proportioned to the lot (L298), sessions that no longer hold their slot after their report (L285), the real weekly-limit message recognised (L286), and an experimental worktree mode with `--resume --integrate|--replay` and `--remove-worktree` (L279, L299–L304). `cadence lead hold|release` counts the lead's hand-started sessions, an expired one is flagged by `lead tour`, `--status` and the `cadence-hud` band (0.5.0; L255, L276, L278). `cadence deliver --sha` is accepted while a wave runs (L277), `CADENCE_DEPLOYED_FILE` names the deployed sha (L277, L281) and `deliveries-failed.log` keeps the class and last lines of a red delivery, secrets masked (L282, L289, L294). `cadence perf` breaks red deliveries down and counts the `review-small` UX (L282, L283). Details: [CHANGELOG.md](../CHANGELOG.md).

**1.8.0**: `cadence perf [folder] [--since date] [--json]` is the permanent dashboard of the workflow, without a model: the last 7 days against the 7 before, read in `.cadence/runs`, with a `⚠` on a trend or a bottleneck (L225); `perf.prices` prices the lots in euros (L226); `cadence deliver` writes `deliveries-failed.log` and `cadence lead tour` opens with a perf header (L227). The measure of the back-end spec step on 10 lots is in `docs/mesures` (L190). The release was blocked by a test that required an entry under `[Unreleased]` (L235). Details: [docs/perf.md](perf.md).

**1.7.0**: `cadence orchestrate` no longer replays the `accept` step of a lot whose acceptation is green and sealed, e.g. after a `cadence spec reseal`, and the `accept` brief and the `acceptance-writer` agent may no longer rewrite a green oracle (L233); `cadence orchestrate --resume … --dry-run` is refused before anything is written instead of resuming the wave for real (L228); `cadence spec reseal <delivered lot> … --porteur` accepts a sheet amended by commits of another delivered lot, and its refusal names the commit and the way out (L229); the README is a short home page (about 5 kB instead of 208 kB in the package), the rest moved unchanged to `docs/` pages checked by `scripts/check-links.mjs`, and a commit that touches only the version fields, the CHANGELOG, « What's new » and `docs/whats-new.md` is a version commit for `raf check` and `raf done` (L232).

**1.6.0**: the mockup review sweeps everything in its first report and runs up to `orchestrate.maquetteReviews` times (new key, default 3 instead of 2), and a review may mark a finding `inchange` (L230); the acceptance lock opens its exception only through a commit of the lot in progress that amends the sheet after the red commit, and names the first offending commit (L231).

**1.5.1**: 1.5.0 was tagged but never published (a test of `session --all` was red on the GitHub runner, a fault of the test and not of the tool, L224); 1.5.1 publishes it with what followed: one UX review per lot (L221), the replay of a lot handed back for its budget (L223), a self-check list in the briefs (L222), and a `tests.yml` workflow that plays the suite on the publish job's environment.

**1.5.0**: `gate: { count: N, spec: true }` or `{ count: N, screen: page }` on a lot is a drawing condition added to `after`: until N `done` lots carry the criterion, `raf now`, `session start` and `lead tour` show the lot as waiting with its progress, `cadence orchestrate` refuses it and `--continue` never draws it (L219); `raf todo <id> [--reason]` puts a started lot without work commits back to `todo` with a dated note (L220).

**1.4.0**: `cadence spec reseal` accepts a sheet amended by commits of the lot, in progress or delivered, and records `ficheAmendee` (L217); the budget of a wave keeps 155 k for a fix pass plus a short review, the floor of an ordinary lot goes to 540 k and the spec allocation to 450 k, and a refused fix says `correction non jouée (budget)` in the final table (L218); a session that runs `git checkout` no longer stops the wave with a false « push détecté » (L214, L216); tests already red at the start sha no longer hand a lot back (L213, L215).

**1.3.0**: the spec step's threshold is narrowed to `screen: page` after the measure of 2026-10-12 (no row of the success table reached, about 570 k tokens per lot): `component` and `journey` lots follow the ordinary path again (L176, L209, L210); `cadence spec reseal … --porteur <lot>` re-seals the unstable sealed test of a delivered lot whose contract does not change (L212); the session cap shown and followed is the human's (`CADENCE_MAX_SESSIONS`, L208); `cadence orchestrate --waits` measures slot waits (L206); a third correction pass when the review converges (L205); `"e2e": true` acceptations stay out of the unit runner (L203); a dropped lot fully reverted no longer blocks `npm run service` (L207).

**1.2.0**: the spec step reaches lots without a screen: a lot that declares `spec: true` (`raf add --spec`, `raf spec`) gets a back-end sheet of cases, rules, contracts and data (`cadence spec check`), reviewed before any code, then acceptance tests locked before the implementation, and `raf screen` lets a plan already written adopt the step; `orchestrate.accept` may be a list of runners (front and back), each run under its own root; `cadence spec reseal <lot> <test> --reason` is the lead's way out when a sealed test contradicts its unchanged sheet; `lead.ux: lead` lets the lead form the UX verdict itself; `cadence lead tour --depth n` looks for projects deeper in the folder; the budgets of a wave are recalibrated on the measured runs (750 k for an ordinary lot of 0.5 to 1 day, 1.3 M for a lot with a screen); the code in service on the cadence repository is a separate worktree, updated only by `npm run service`, so a wave can no longer put unreviewed code in service (L185–L189, L191, L192, L194–L198, L200, L201).

**1.1.0**: the spec step of `cadence orchestrate`: a lot that declares `screen:` gets a machine-readable screen sheet (`cadence spec check|qa`), a mockup reviewed against it, acceptance tests committed red and locked before the implementation, and briefs that carry the sheet and rule → test → green to `implement`, `fix` and the code review; the news entry gains a *Hypothèses* section (L166, L169–L174, L177–L184).

**1.0.0**: the first major release, a stable contract: the commands and options, the keys of `cadence.yaml`, the plan file and the names of the skills and agents follow semantic versioning, and the [stability page](stabilite.md) lists what is guaranteed and what is not (L164).

**0.28.0**: `orchestrate.precheck: local` runs the « deliverable already present? » pre-check of `cadence orchestrate` on the local model (`claude-local`, Ollama), off the Anthropic quota, Sonnet staying the default and the fallback (L146); the `qa-reviewer` agent walks only the pages a lot touched, with a **Scope** line in its report (L123); the sub-tasks a review closes are also read in a lot's neighbouring repositories (L156) and a commit's sub-task list is read with the plan's left guard (L155); an unstable test is fixed (L90).

**0.27.1**: `cadence orchestrate` no longer leaves a session's child processes alive: a dev server started in its own process group, or orphaned by a shell that exits (`nohup srv &`), is killed with the session through its process tree and its `CADENCE_SESSION` mark, a tmux server, `screen`, `gpg-agent` or `dirmngr` started on demand being spared; a session that exits with code 0 while a descendant holds its output open is no longer reported as « délai dépassé » (L83); the `ux-reviewer` and `qa-reviewer` agents carry the briefs' Playwright rule outside `cadence orchestrate` (L84).

**0.27.0**: a compliant review of `cadence orchestrate` settles the open sub-tasks that commits of the lot cite (`feat(L3/t2): …`, comma lists included), closed in the same plan commit as the verdict or, on a read-only plan, returned as `[sous-tâche clore]` proposals, so `raf done` no longer refuses a lot over sub-tasks whose work is done; on a foreign-format plan the ids are read as the plan reads them (L82); the test suite stays green with two full suites running in parallel (L150).

**0.26.0**: `cadence orchestrate` raises the floor of a lot's budget from 200 k to 450 k tokens, enough to pay a write pass, its review, one fix pass and the short review that follows, so a lot of 0.5 or 1 day is no longer handed back at its second or third pass; a `--continue` wave draws fewer lots as a result (L128).

**0.25.0**: the project line of the plans' progress in the `cadence-hud` band names the lots in progress after their count, three at most then `…` (L153, `cadence-hud` 0.4.2); the progress follows the folder the session was launched from, so a `cd` into a sub-project no longer shrinks the band, and the session context keeps the `session.start` folder (L154).

**0.24.0**: `cadence orchestrate --drop <project:lot>` and `--stop-after-current` steer a live wave from another terminal, `--resume --drop` removes a lot before replaying a stopped wave (L79); the final table of a wave says « livrable jusqu'à <sha> » for a ready lot stacked under a lot handed back, with `git push origin <sha>:main && cadence deliver --sha <sha>` (L76); a version commit (version fields, `CHANGELOG.md`, the README's « What's new ») no longer asks for a new code review (L72).

**0.23.0**: the progress bar of each project in the `cadence-hud` band is coloured by the share of lots done, red below 33 %, orange below 66 %, green beyond (L152, `cadence-hud` 0.4.1); `cadence deliver` under a wave lock refuses only when a lot of the wave still works in that very repository, a linked worktree included (L127).

**0.22.0**: `cadence orchestrate --continue` draws the next ready lot of the plan itself, in the declared priority, until the budget, the time window or a question stops it (L147); `cadence session context` prints the context of the session, which the `cadence-hud` band publishes, and the `lead` skill chains lots without the human while it stays under 60 % (L148); the band shows the progress of each project's plan, and `cadence lead tour --json` gains `progress` (L149, `cadence-hud` 0.4.0); the final review of a lot is always played, the lot's own budget bounding the writing passes only, with 65 k tokens reserved for it (L145); the cause « tests rouges après … » names the pass whose tests were red (L151).

**0.21.0**: `cadence orchestrate --status` and `cadence lead tour` print the free session slots, which the `lead` skill reads (L141); `orchestrate.effort` sets the effort level of each pass of a wave (L137); `docs.sync` makes `raf check`, `lead tour` and the review brief report a document that does not follow the code (L143); `docs.articles` opens, after a green `cadence deliver`, a lot `Article <project> à rafraîchir` in the neighbouring repository (L144).

**0.20.0**: `cadence-hud` no longer misleads once the work is over: `/hud cmd` lists the background commands it counts (id, tool, origin, age, name), any other argument answers `argument inconnu` instead of hiding the band, commands with no end seen for an hour or no record go to a grey `N cmd sans fin vue`, a finished subagent takes its commands with it, two races that left a `1 cmd` counted forever are closed, and a finished wave shows grey without its budget then disappears after 30 minutes (L142); the `qa-reviewer` and `ux-reviewer` agents are read-only for real, their frontmatter listing Read, Grep, Glob, Bash and the Playwright tools (L140).

**0.19.1**: `cadence-hud`'s `N cmd` counter goes back down when a Monitor expires, when the background commands a subagent started end with it, and at session start or plugin reload (L135); its `tool.call` and `prompt.submit` guard hooks carry a `.catch` on registration, which clears the `claude plugin validate` warning (L136).

**0.19.0**: `cadence orchestrate` lifts a repository's lock and `pre-push` guard as soon as every lot of the wave that touches it is finished, so `cadence deliver` works there while the wave continues elsewhere (L132); a review that leaves a repository dirty hands back that lot only, suspends the lots still queued in that repository and keeps the other repositories running, its verdict reported instead of lost (L133); `cadence session close` re-run without a `session start` keeps the window since the last opening (L131); `cadence-hud` draws the lot rows of a wave in aligned columns on every surface (L134).

**0.18.0**: `cadence session next` prints what it records (issue #6); `cadence session close` covers the period since the last `session start` (or the last close) and says so in its title, `--since` still wins (issue #7).

**0.17.0**: `cadence-hud` shows an `N cmd` segment next to the agents, the background commands of the session (Bash run in the background and Monitor, subagents' included), tracked from the tool results and ended by the task's notification or `TaskStop`.

**0.16.0**: a lot can declare **neighbouring repositories** (`repos:` key of the lot, `{ path, cite }` for a repository shared between projects): `cadence orchestrate` refuses, locks and guards them, gives them to every session as `--add-dir`, and `raf commits`, `raf show` and the review verdict read the commits that cite the lot there too.

**0.15.0**: `hook.autostart` in `cadence.yaml` (`warn` by default, `refuse` or `start`): a pre-commit hook that refuses, or starts in the same commit, a lot still todo that the commit cites; `cadence session start|close --all [--depth n]`, one section per project under a folder.

**0.14.0**: `cadence lead tour`, the lead's morning table of every project in a folder, printed by a program (one line per project: lots in progress, gaps, last notes, next ready lot, repository) in place of one subagent per project; the `lead` skill calls it.

**0.13.1**: `cadence-hud` takes back the segments that fit once a big one has dropped (reset times, then the per-model consumption, now short: `opus 1.2M sonnet 800k`); `CADENCE_HUD_AMBIGUOUS=1` for a terminal that draws `▰ ▱ ⚙ │ ↻` in one cell.

**0.13.0**: `cadence orchestrate --status --watch` (a wave's table redrawn in the terminal, which
stops with the wave) and the lead skill that names the wave and follows its journal; lot ids with `/`
(sub-tasks of a read-only plan) accepted by `orchestrate`; `cadence-hud`'s first line measured in
terminal cells and kept to ASCII; `publish.yml` on the v5 actions.

**0.12.0**: the `cadence-hud` plugin (a status band above the Claude Code prompt),
`raf ignore` to acknowledge a commit without a lot, waves that size the review to the lot,
hand back a lot whose deliverable is already there and start the app themselves for the UX
review (`orchestrate.ux`), and briefs that require the README to follow the change.

**0.11.0**: waves on different repositories run side by side under a shared cap of
simultaneous sessions (`--max-sessions`, 2 by default), and every release now has its
changelog section and GitHub release.

**0.10.1**: the QA expectations file (`docs/qa/expectations.md`) is kept with the plan —
a commit that only touches it no longer has to cite a lot.

**0.10.0**: `cadence orchestrate`
sends an already-committed lot straight to review, and sessions only ask questions that
name what they would change.

