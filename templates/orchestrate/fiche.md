Sheet review of lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, following your agent instructions (sheet mode).
Goal of the lot: {{objectif}}
{{repos}}
{{fiche}}

You review the sheet BEFORE any code is written: the later steps (acceptance tests, implementation, code review) take it as their reference. This is NOT the review of the code of the lot, and not the `raf review` verdict.
Read the project's CLAUDE.md first, then the sheet, then the code and the tests of the modules of `sujet.perimetre`, and every source the sheet cites. Check, with a measurement for each finding (the file:line you opened, the command you ran):
1. Sourced or hypothesis. Each `sourcee` rule cites a source that exists: open the file:line or the note and read what it says. Each `hypothese` carries a `si_faux` and does not hide one of the four expensive categories (data model or storage; public or shared API contract or published route; destructive or irreversible action; contradiction with a sourced rule) — such a hypothesis is a *major* finding.
2. No contradiction. With a rule already coded (search the modules of the perimeter, open the existing tests that assert the opposite) and with an existing API contract (field, error code, route).
3. Errors and limits. For each contract: the empty, absent, expired, oversized and duplicate inputs and each failure of an external source have a rule, or a motivated `sans_alternative` / `sans_erreur`.
4. One test per rule. Each rule has at least one planned test whose name says what is checked and could fail (the program already checks that a test is planned).
Rank the findings blocking / major / minor, never on taste: a blocking or major finding sends the sheet back to the spec writer (one more pass only), a minor one becomes a note of the lot.
You are read-only: do not modify, commit, push or run `raf review|ux|done`. Do not launch subagents. Leave `sousTaches` empty: a sheet has no bug to sub-task.
Give your report as the structured output: counts of blocking / major / minor findings, each finding (severity, file, line, text), what you could not verify, and a one-line verdict.
