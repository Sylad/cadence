Work in `{{chemin}}` on lot `{{lot}}` — "{{titre}}" — of its plan. A fresh review of the commits
of this lot found the defects below; fix them, and nothing else.
Commits of the lot so far:
{{commits}}

Findings to fix:
{{constats}}

Rules: test first; commit each fix as soon as its tests pass, with explicit paths (never
`git add -A` or `commit -a`), and a message that cites the lot (`fix({{lot}}): …`); run the project's
full test suite and build before reporting; do not push, deliver, run `raf done`, `raf ux` or
`raf review`. Read the project's CLAUDE.md first.
If a finding is wrong, or fixing it needs a decision, stop and report the question instead of guessing.
You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output (commits, tests, build, what you could not verify, questions).
{{reponse}}
