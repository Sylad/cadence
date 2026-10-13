Spec of the screen of lot `{{lot}}` — "{{titre}}" — in `{{chemin}}`, as the spec writer: you write a static mockup and a machine-readable sheet BEFORE any code, so that the later steps (UX review of the mockup, acceptance tests, implementation) share one reference.
Goal of the lot: {{objectif}}
{{repos}}
Read the lot, its notes and sub-tasks in the plan (`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`), the project's CLAUDE.md, its charter (existing CSS and variables, neighbouring components, `docs/qa/expectations.md`) and the routes and API contracts already present.
{{spec}}

What you produce, in `<dir>/<écran>/`:
1. `maquette.html`: static HTML + CSS, to the project's charter (reuse its variables, fonts and components; invent no style when an equivalent exists), no business JavaScript. Every state is an addressable section: `<section id="etat-vide">`, `etat-chargement`, `etat-erreur`, and `etat-charge` when the screen has data. Every field of the sheet carries `data-testid="<id of the field>"`.
2. The captures described above, one per state and per width, copied from the Playwright output directory of this wave into the folder (a Playwright capture lands outside the repository: give it a relative file name only, then copy it).
3. `fiche.yaml`, in the format of the template below. Check it with `cadence spec check <fiche>` until it is valid, and derive the QA expectations with `cadence spec qa <fiche>` only if the lot asks for it.

Sheet rules:
- Every rule is `sourcee` (it says where it comes from: a line of the lot, a note, `expectations.md`, a rule already coded, an API contract) or `hypothese` (you chose it for lack of a source; `si_faux` says what would change if it were wrong). Never present a guess as sourced.
- Check every date in the sample data of the mockup before keeping it: compute its weekday (a command such as `date -d 2026-09-03 +%A`, or a script), never write it from memory — a « Wed 03/09 » that is a Thursday sends the mockup back for nothing. The same goes for any figure that must add up (a score and its result, a total and its parts).
- Expose the messages exactly as the screen shows them; the message of a rule is visible in the state its `etat` names.
- A rule you invent is not a free choice: **a hypothesis whose `si_faux` involves an expensive-to-undo choice is a question, not a hypothesis.** The four expensive categories: a data model or storage (key, migration, user data created once shipped); a public or shared API contract, or an already published route / URL; a destructive or irreversible action (deletion, sending, payment); a rule that contradicts an existing sourced rule. In those cases do not write the hypothesis: stop and put the question under "questions" (the lead answers and the step is resumed). Everything else (wording, order of the fields, error state, spacing) is a written hypothesis, cheap to correct later.
- If, after reading the lot and the code, you find that the lot changes NO screen (no new page), write one line with the reason in `sousSeuil`, create no mockup and no sheet, and finish: the lot then follows the usual path.

Commit the spec with explicit paths (never `git add -A` or `commit -a`), a message that cites the lot (`spec({{lot}}): …`), the sheet, the mockup and the captures together, and leave the working tree clean. Do not implement the screen, do not write application code or tests, do not push, deliver, run `raf done`, `raf ux` or `raf review`.
Never run `git checkout` or `git switch` to another commit or branch in this repository: the orchestrator watches it and a moved HEAD breaks the other sessions of the wave. To look at another sha, use a throwaway `git worktree add --detach <tmp> <sha>`, removed afterwards.
Decide minor interpretation questions yourself and list each one under "choix" with the alternative you did not take. Leave "questions" empty rather than writing a placeholder such as "no question".
{{commits}}
{{reponse}}
Report: `fiche` (path of the sheet relative to the repository, e.g. `docs/specs/<screen>/fiche.yaml`, or empty under the threshold), `sousSeuil` (the reason, or empty), `commits`, `nonVerifie` (what you could not render or check), `choix`, `questions`, `resume`.

You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output, not as free text.
Browser (Playwright): the orchestrator launched the Playwright MCP server with its own output directory, in the orchestrator's run directory outside the repository: give screenshots, snapshots and traces a relative file name only (e.g. `maquette-vide-1440.png`), they land there. Never an absolute path, never the `--output-dir` option (the server's launch argument, which a session cannot set).
{{captures}}
