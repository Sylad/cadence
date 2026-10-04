Work in `{{chemin}}` on lot `{{lot}}` — "{{titre}}" — of its plan.
A fresh review found only minor findings: the lot is compliant, and this is the one pass that treats them.
Commits of the lot so far:
{{commits}}

Minor findings:
{{constats}}

Fix each minor finding that is right, and nothing else. Rules: test first; commit each fix as soon as
its tests pass, with explicit paths (never `git add -A` or `commit -a`), and a message that cites the
lot (`fix({{lot}}): …`); run the project's full test suite and build before reporting; do not push,
deliver, run `raf done`, `raf ux` or `raf review`. Read the project's CLAUDE.md first.
Do not stop to ask. A finding that is wrong, or not worth its change, is not fixed: list it under
"choix" in your report with the reason — the reviewer re-reads it and the lead sees it. Leave
"questions" empty. Making no commit at all is a valid outcome when every finding is rejected.
You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output (commits, tests, build, what you could not verify, choices).
{{reponse}}
