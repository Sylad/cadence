Work in `{{chemin}}` on lot `{{lot}}` — "{{titre}}" — of its plan
(`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`; read the lot, its notes and sub-tasks, and the project's CLAUDE.md first).
Goal: {{objectif}}
Rules: test first; commit each sub-part as soon as its tests pass, with explicit paths (never
`git add -A` or `commit -a`), and a message that cites the lot (`feat({{lot}}): …`); run the project's
full test suite and build before reporting; do not push, deliver, run `raf done`, `raf ux` or
`raf review`.
If something is ambiguous or needs a decision, stop and report the question instead of guessing.
Report: commits (sha + subject), tests and build results with their numbers, what you could not
verify, open questions.

You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output, not as free text. If the plan is kept by the project's own tool
(read-only for `raf`), use that tool's commands named in the project's CLAUDE.md, never `raf start|done|note`.
{{commits}}
{{reponse}}
