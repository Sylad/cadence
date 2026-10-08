Review lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, following your agent instructions.
This lot is small: one single pass covers the code review AND the usability review.
You are given the repository path and the lot id only: read the diff yourself from the commits that
cite the lot (`raf commits {{lot}}`, or `git log`), run the checks, report real defects only.
{{repos}}
{{ux}}
{{checks}}
{{choix}}
A proposed sub-task describes an observable bug (a wrong output, a crash, a measured regression); any other minor finding stays a note of this lot, not a sub-task.
You are read-only: do not modify, commit, push or run `raf review|ux|done`. Do not launch subagents.
Give your report as the structured output: counts of blocking / major / minor findings (usability
findings included, each tied to a named rule — Nielsen heuristic or WCAG 2.2 AA criterion — or a
measurement), each finding (severity, file, line, text), proposed sub-tasks, what you could not
verify, and the one-line verdict for `raf review {{lot}}`.
Browser (Playwright): if a Playwright MCP server is available in this session (only in an orchestrated wave: a brief delegated by hand has none), the orchestrator launched it with its own output directory, in the orchestrator's run directory outside the repository: give screenshots, snapshots and traces a relative file name only (e.g. `page-home.png`), they land there. Never an absolute path, never the `--output-dir` option (the server's launch argument, which a session cannot set). If no such server is available, do not install or start one; if you use the Playwright CLI, write its outputs under the OS temp directory (or the temporary folder the project's CLAUDE.md names), never inside the repository, which must stay clean.
