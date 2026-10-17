Work in `{{chemin}}` on lot `{{lot}}` — "{{titre}}" — of its plan
(`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`; read the lot, its notes and sub-tasks, and the project's CLAUDE.md first).
Goal: {{objectif}}
{{repos}}
{{fiche}}
Rules: test first; commit each sub-part as soon as its tests pass, with explicit paths (never
`git add -A` or `commit -a`), and a message that cites the lot (`feat({{lot}}): …`); run the project's
full test suite and build before reporting; do not push, deliver, run `raf done`, `raf ux` or
`raf review`.
Sealed test of ANOTHER lot: if what your own sealed tests require contradicts a sealed acceptance test of another lot (an `acceptation-<lot>.json` that is not yours), it is a question to the lead naming both tests (file and `Rn — …` name of each): never modify, rewrite or reseal it and never pick a side. Stop there and put the question in your report. The program compares the fingerprints of the sealed tests of every other lot at the end of each session and hands your lot back, naming the first offending commit, before any review.
Never run `git checkout` or `git switch` to another commit or branch in this repository: the orchestrator watches it and a moved HEAD breaks the other sessions of the wave. To look at another sha, use a throwaway `git worktree add --detach <tmp> <sha>`, removed afterwards.
Documentation: the project's README (and its usage documentation) describes the behaviour you deliver, updated in the same commits, like the CHANGELOG — a README that does not follow your change is a major finding of the review.
Self-check before handing back (the recurring findings of the reviews). Go through this list point by point on your own commits before you report, and fix what is missing:
- documentation: the README and the architecture documentation describe the behaviour, updated in the same commits as the behaviour (and the CHANGELOG);
- tests: one test per rule of the fiche, named « Rn — … »; with no fiche, one test per business rule of the lot, named after it;
- no dead code, and no test that cannot fail: a test whose assertion is always true, or that does not exercise the rule it names;
- screens: for a modified screen, the capture due of each state, at 1440 and 390 px, with a relative file name; a lot with no modified screen owes none, and says so;
- no false comment: a comment, a docstring or a message never describes a behaviour the code no longer has or does not have.
A point you cannot hold is written under "choix" or "nonVerifie" of your report, not left unsaid.

Auto-verification once the tests are green, before the review: when the full test suite and the build pass, re-read the complete diff of the lot, commit by commit (the commits `raf commits {{lot}}` lists, each with `git show <sha>`; never a `git diff` range, which would take in the commits of other lots) against the grid of the code-reviewer agent: code bug (wrong result, unhandled error, input trusted); architecture drift (a responsibility put in the wrong module, a duplicated block, a layer skipped); docs/architecture.md (or the project's architecture documentation) up to date; edge cases (empty, absent, twice, wrong order, refused); one test per changed behaviour. What you find, fix it at once (test first, a `fix({{lot}}): …` commit) and rerun the suite and the build. Then write in "resume" a paragraph that starts with « auto-vérification »: what you re-read, what you found and fixed, what you could not hold. It is one reading of the diff, not a second review: no subagent, no new exploration, no re-reading of files the diff does not touch.

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
Tests already red before the lot: if the suite is red, check whether the same tests are red at the sha the lot started from (the parent of the oldest work commit that cites {{lot}}, plan-only commits left out, or the `HEAD` before this session if the lot has none: a throwaway `git worktree add --detach <tmp> <sha>`, removed afterwards). Failures already there are not a defect of this lot: do not try to fix them and do not report your tests as red for them; list their names under "echecsDeBase" in your report (one test per entry, as the runner prints it), list under "nouveauxEchecs" the tests that are red now and were NOT red at that sha (an empty list when there are none: with `vert: false`, a non-empty "echecsDeBase" and an empty "nouveauxEchecs" the lot goes to review without a correction pass; any entry in "nouveauxEchecs" with `vert: false` triggers one), and say under "nonVerifie" if you could not check. The program replays the suite itself and compares to the same baseline.
Report: commits (sha + subject), tests and build results with their numbers, what you could not
verify, choices made, open questions.

You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output, not as free text. If the plan is kept by the project's own tool
(read-only for `raf`), use that tool's commands named in the project's CLAUDE.md, never `raf start|done|note`.
{{news}}
{{commits}}
{{reponse}}
Browser (Playwright): if a Playwright MCP server is available in this session (only in an orchestrated wave: a brief delegated by hand has none), the orchestrator launched it with its own output directory, in the orchestrator's run directory outside the repository: give screenshots, snapshots and traces a relative file name only (e.g. `page-home.png`), they land there. Never an absolute path, never the `--output-dir` option (the server's launch argument, which a session cannot set). If no such server is available, do not install or start one; if you use the Playwright CLI, write its outputs under the OS temp directory (or the temporary folder the project's CLAUDE.md names), never inside the repository, which must stay clean.
