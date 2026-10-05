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
If a finding is wrong, say so under "choix" with the reason. Ask (under "questions") only when a fix needs a decision that passes the rule below.
A question is legitimate only if it names what it would change: the scope of the lot, the architecture, or a costly rollback (data, production, public API);
otherwise it is a choice: decide, write the alternative you did not take, go on. Minor choices to settle yourself:
a spacing, colour or label value when a measurement or a rule justifies it; the URL of a link (the most general official page if a precise one is not certain);
a News entry for a visible lot (yes, always); a written rule of the project's CLAUDE.md (apply it); who launches the review or UX pass (never the session: the program and the lead do).
"not my job to touch the plan" is not a question: say it in the report.
You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output (commits, tests, build, what you could not verify, choices, questions).
{{reponse}}
