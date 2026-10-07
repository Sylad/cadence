Work in `{{chemin}}` on lot `{{lot}}` — "{{titre}}" — of its plan
(`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`; read the lot, its notes and sub-tasks, and the project's CLAUDE.md first).
Goal: {{objectif}}
Rules: test first; commit each sub-part as soon as its tests pass, with explicit paths (never
`git add -A` or `commit -a`), and a message that cites the lot (`feat({{lot}}): …`); run the project's
full test suite and build before reporting; do not push, deliver, run `raf done`, `raf ux` or
`raf review`.
Decide minor interpretation questions yourself (the wording of a message, a name, a default, the
reading of an ambiguous line of the lot) and list each one under "choix" in your report, with the
alternative you did not take — the reviewer re-reads them. Stop and ask (under "questions") only on a real blocker.
A question is legitimate only if it names what it would change: the scope of the lot, the architecture, or a costly rollback (data, production, public API), AND the plan, its notes and the project's CLAUDE.md do not settle it;
otherwise it is a choice: decide, write the alternative you did not take, go on. Minor choices to settle yourself:
a spacing, colour or label value when a measurement or a rule justifies it; the URL of a link (the most general official page if a precise one is not certain);
a written rule of the project's CLAUDE.md (apply it); who launches the review or UX pass (never the session: the program and the lead do).
"not my job to touch the plan" is not a question: say it in the report.
Never stop to ask about how to organise your own work (split or squash a commit, order of the sub-parts, whether to continue, "I have no question"): decide, list it under "choix", go on. Leave "questions" empty rather than writing a placeholder such as "no question".
If the lot's commits already cover its open sub-tasks, do not ask whether to continue: make no commit and say so
in your report (the review that follows re-reads those commits). If they do not cover them all, implement the rest.
Report: commits (sha + subject), tests and build results with their numbers, what you could not
verify, choices made, open questions.

You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output, not as free text. If the plan is kept by the project's own tool
(read-only for `raf`), use that tool's commands named in the project's CLAUDE.md, never `raf start|done|note`.
{{news}}
{{commits}}
{{reponse}}
Browser (Playwright): if a Playwright MCP server is available in this session, it was launched by the orchestrator with its own output directory, in the orchestrator's run directory outside the repository: give screenshots, snapshots and traces a relative file name only (e.g. `page-home.png`), they land there. Never an absolute path, never the `--output-dir` option (the server's launch argument, which a session cannot set). If no such server is available, do not install or start one; if you use the Playwright CLI, write its outputs under the OS temp directory (or the temporary folder the project's CLAUDE.md names), never inside the repository, which must stay clean.
