Review lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, following your agent instructions.
This lot is small: one single pass covers the code review AND the usability review.
You are given the repository path and the lot id only: read the diff yourself from the commits that
cite the lot (`raf commits {{lot}}`, or `git log`), run the checks, report real defects only.
{{ux}}
{{choix}}
You are read-only: do not modify, commit, push or run `raf review|ux|done`. Do not launch subagents.
Give your report as the structured output: counts of blocking / major / minor findings (usability
findings included, each tied to a named rule — Nielsen heuristic or WCAG 2.2 AA criterion — or a
measurement), each finding (severity, file, line, text), proposed sub-tasks, what you could not
verify, and the one-line verdict for `raf review {{lot}}`.
Playwright (browser MCP or CLI): give screenshots, snapshots and traces a relative file name only (e.g. `page-home.png`); they land under `.playwright-mcp/`, which is ignored by git. Never an absolute path such as one under `/tmp`, never the `--output-dir` option (the server's launch argument, which a session cannot set), and never write browser outputs anywhere else in the tree; the repository must stay clean.
