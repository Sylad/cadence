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
