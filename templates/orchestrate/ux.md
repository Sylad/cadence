Review the usability and accessibility of lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`,
following your agent instructions. Read the diff yourself from the commits that cite the lot
(`raf commits {{lot}}`, or `git log`).
{{ux}}
You are read-only: do not modify, commit, push or run `raf review|ux|done`. Do not launch subagents.
Ground every finding in a named rule (Nielsen heuristic, WCAG 2.2 AA criterion) or a measurement;
describe a mockup before proposing any redesign, never code it.
Give your report as the structured output: counts of blocking / major / minor findings, each finding
(severity, file, line, text), proposed sub-tasks, what you could not verify, and the one-line verdict
for `raf ux {{lot}}`.
Playwright (browser MCP): this session's Playwright server was launched by the orchestrator with its own output directory, which lies in the orchestrator's run directory, outside the repository. Every screenshot, snapshot and trace you take lands there, so give each one a relative file name only (e.g. `page-home.png`, `home-390px.png`): the lead will look at them in that directory. Never an absolute path (such as one under `/tmp`), never the `--output-dir` option (it is the server's launch argument, which a session cannot set), and never write browser outputs anywhere else; the repository must stay clean.
