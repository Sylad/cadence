# How cadence works

New to the vocabulary? Start with [the notions of cadence](concepts.md); this page is the mechanics.

A versioned plan (`raf`) tied to the commits, waves of fresh sessions driven by a program
(`cadence orchestrate`), a lead that decides and re-verifies, then deliveries proved by their effect.
Four figures go from the isolated lot to the tool itself. Dashed boxes are conditional steps; a
box with a blue outline is where the work is kept or checked.

## 1. The life of a lot in the plan

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="fonctionnement-lot-dark.svg">
  <img alt="A lot goes from todo to doing, receives commits that cite it, gets its review and UX verdicts, becomes done, then is delivered by cadence deliver" src="fonctionnement-lot-light.svg">
</picture>

The plan (`.cadence/raf.yaml`, the legacy `docs/plan/raf.yaml`, or the file `cadence.yaml` names) is the single source of truth:
`raf check` reports every commit that cites no lot (unless a motivated `raf ignore` covers it).
`hook.autostart` in `cadence.yaml` sets what the pre-commit hook does with a commit that cites a lot
still `todo`: `warn` (the default), `refuse`, or `start` it in the same commit. `raf done` is refused
while a sub-task is open. A delivery is finished only when its effect checks pass.

## 2. A lot inside a wave

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="fonctionnement-wave-dark.svg">
  <img alt="A lot without commits whose title cites a finding or another lot starts with a precheck (unless disabled), then by type through spec, mockup or sheet review and sealed acceptance tests, or straight to the implementation; then the UX pass if visible, the code review, corrections and an automatic raf review" src="fonctionnement-wave-light.svg">
</picture>

A lot without commits yet whose title cites a finding (`constat`, `revue`, `review`, `audit`) or another lot (its `goal:` counts like its title) starts with the **precheck** (unless `orchestrate.precheck: false`; a lot that already has commits, or whose title (or `goal:`) cites neither, is never pre-checked — L288; nor is a lot created after the last code commit of the repository whose title and `goal:` cite no lot that already has commits of its own, which has nothing to find — L322): is the deliverable already there? « Yes » hands the lot back
to the lead; « partial » passes what exists to the implementation. Then:

- `screen: page` only: **spec** (mockup and screen sheet), **mockup review** (`ux-reviewer`, two
  passes at most), then **accept**.
- a visible lot above 0.1 day with `screen: component`, `screen: journey` or no `screen:` (L459): **light
  mockup**, a `spec` session (current screen and target for the touched states) and the same mockup review,
  no **accept**; the `ux` pass after the code checks conformity to the mockup. Other lots take the ordinary
  path (`orchestrate.maquette: false` brings it back for these too).
- `spec: true` (a lot with a behaviour to pin down and no screen): **back-end spec** (cases, rules,
  contracts), **sheet review** (`code-reviewer` in sheet mode, two passes at most, a third when the review converges: blocking + major findings down and only one left), then **accept**.
  A mixed lot (a page whose sheet has a `sujet` block) gets both reviews and a single second spec pass.
- **accept** writes the acceptance tests from the sheet, committed red and locked, when the project
  declares `orchestrate.accept`.
- every other lot goes straight to the **implementation**: test first, commits that cite the lot.

After the implementation: the **code review** (Opus, Sonnet for a lot of 0.25 day or less, kept after a pass that only repaired red tests or a program check); a
**correction** in a fresh session if the review is not compliant, two passes at most, and a third
only when the review converges (the count of blocking + major findings dropped and only one is
left), each followed by a review. A compliant review makes the program record `raf review` itself;
for a `visible` lot whose project says how to see its app (`orchestrate.ux`), the **UX pass** comes
once, after the compliant code review (a blocking or major UX finding sends the lot to a correction,
then the code review, then the UX pass again).
A small lot (estimate of 0.5 day or less, or `quickwin`) has a single review pass, with no separate UX pass:
`review-small` covering code and usability when the lot is `visible`, a code `review` otherwise.

## 3. The lead drives the waves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="fonctionnement-lead-dark.svg">
  <img alt="Three lanes: the human chooses and decides, the lead starts, relays, re-verifies and delivers, the orchestrate program runs the lots and chains the next wave while the context stays under 60 percent" src="fonctionnement-lead-light.svg">
</picture>

The lead does not code and never commits where a wave runs. It re-verifies itself (git log, tests,
build, `raf check`) before `raf done`, delivers one project at a time, and never pushes above a
handed-back lot (only « livrable jusqu'à `<sha>` »). The UX verdict is the human's, or the lead's
when the parent folder's `cadence.yaml` says `lead.ux: lead`; the human is then asked only at the
slightest doubt. The step-by-step version, with its three lanes, is in [lead.md](lead.md).

## 4. Putting cadence itself in service

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="fonctionnement-service-dark.svg">
  <img alt="The cadence code on the PATH is a separate worktree, updated only by npm run service on a reviewed sha" src="fonctionnement-service-light.svg">
</picture>

On the cadence repository itself, the `raf` and `cadence` commands of the `PATH` do not read the
working repository's `dist/`: they read a separate worktree under `~/.local/share/cadence`, updated
only by `npm run service -- <sha>`. The command refuses a sha that is not an ancestor of `HEAD` and a
sha whose cited lots are not `done`, so a wave cannot put unreviewed code in service. In the
working repository, `npm run build` is a typecheck only. A `dropped` lot whose every commit is undone
by a `git revert` under the sha no longer blocks. The command keeps the copy in service and the 3 put in service before it (rollback), removes the older ones unless a live process still uses one, and says what it purged (number of copies, space freed). It also synchronises `plugins/cadence-hud` of the new copy into the local `cadence-hud` mod (`~/.claude/mods/cadence-hud`, `.claude-plugin/types` left alone), so the mod Claude Code loads is never an older release.

## Budget of a lot

The budget a wave gives a lot is derived from its estimate, measured on the runs of the project:

| Lot | Budget |
|---|---|
| up to 0.5 day | 600 k tokens |
| 0.5 to 1 day | 750 k |
| beyond | 570 k per day, 750 k at least |
| `screen: page` | 1.3 M at least, or the ordinary budget + 450 k if that is more |
| `spec: true` | ordinary budget + 450 k |
| visible, above 0.1 day, `screen: component` or `journey` or none (light mockup, L459) | ordinary budget + 450 k |
| fix pass and short review | 155 k reserved |
| escalation (`orchestrate.escalation` declared, L349) | + 175 k reserved (estimate: one correction and one fresh review on the escalation model) |
| last-pass top-up (L584) | a lot whose review converges (≤ 2 majors, falling) gets the shortfall of the 155 k, up to `orchestrate.budgetTopUp` (300 k by default), from the wave's budget |

These figures are the floor of the budget (L501): when `cadence perf` has rendered at least 5 lots of the same class (estimate, `+spec` for the spec chain) in the last 14 days, the default budget is their p90 of counted tokens rounded up to 50 k, between the figure above and twice that; `--dry-run` says where the number comes from ([docs/orchestrate.md](orchestrate.md), « Budget set by the measure »).

The final review is always played; the budget bounds the writing passes. A non-visible lot, or one of
0.1 day or less, with `screen: component`, `screen: journey` or none takes the ordinary budget; a visible one
above 0.1 day gets the light mockup budget of the table.

## Permanent rules

- **Session cap.** As many sessions or subagents running at once as the cap (2 by default, set by the
  human with `CADENCE_MAX_SESSIONS` or `--max-sessions`). The lead never raises it itself.
- Never two sessions in the same repository at the same time. (The worktree mode, `orchestrate.worktrees: true` — on in cadence's own `cadence.yaml`, off where the key is absent — lets two independent lots of one repository play at once, each in its own worktree — [docs/orchestrate.md](orchestrate.md#one-worktree-per-lot-orchestrateworktrees-l279).)
- A session cannot ask the human anything: it stops and reports, and the lead brings the question back.
- A sealed acceptance test that contradicts its sheet is corrected by the lead with
  `cadence spec reseal <lot> <test> --reason "…"`, never by editing `acceptation.json`; a lot closed by hand
  and left at `vert: false` is put back to green with `cadence spec green <lot>` (L366).
- Deliveries and the `raf ux` / `raf review` verdicts belong to the lead, one project at a time.

See also the [orchestrate](orchestrate.md#orchestrate) page and the
[lead tour](lead.md#lead-tour).
