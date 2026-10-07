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
Playwright (browser MCP or CLI): write every output (screenshots, snapshots, traces, downloads) outside the repository, never in `.playwright-mcp/` or anywhere in the tree — pass `--output-dir /tmp/<name>` (or the project's own tmp folder outside the repository) and give an absolute `/tmp/...` path to screenshots; the repository must stay clean.
