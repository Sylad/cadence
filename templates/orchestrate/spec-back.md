Spec of the behaviour of lot `{{lot}}` — "{{titre}}" — in `{{chemin}}`, as the spec writer: you write a machine-readable sheet (use cases, rules, contracts, data) BEFORE any code, so that the later steps (review of the sheet, acceptance tests, implementation) share one reference. There is no screen part: only the sheet.
Goal of the lot: {{objectif}}
{{repos}}
Read the lot, its notes and sub-tasks in the plan (`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`), the project's CLAUDE.md, and the code and tests of the modules the lot touches (the services, controllers or jobs, their tests, the API contracts and error messages already present): the rules already coded are sources, and a new rule must not contradict them.
{{spec}}

What you produce, in `<dir>/<sujet>/`:
- `fiche.yaml`, in the format of the template below (`sujet`, `cas`, `regles`, `contrats`, `donnees`). Check it with `cadence spec check <fiche>` until it is valid.

Sheet rules:
- Every use case (`cas`) names its trigger (a contract call, a job, a command), its preconditions, its nominal steps, and its alternatives and error cases, each pointing to the rules that govern it — or says `alternatives: []` with its reason in `sans_alternative`.
- Every rule is `sourcee` (it says where it comes from: a line of the lot, a note, a rule already coded as **file:line** — the review opens it —, an existing API contract, an existing test, a requirement of a reference document) or `hypothese` (you chose it for lack of a source; `si_faux` says what would change if it were wrong). Never present a guess as sourced. Every rule is attached to at least one case and has at least one planned test, named `Rn — …`, whose name says what is checked and could fail.
- Every contract (`contrats`) gives the call (`VERBE /chemin`, `job <nom>` or `commande <nom>`), the input, the output and the errors with the exact code (`HTTP <n>` or `log <level>`) and the exact message; for each, think of the empty, absent, expired, oversized and duplicate inputs and of every failure of an external source, and give each a rule — or say `sans_erreur` with the reason.
- Every datum the lot touches is in `donnees`; an existing datum whose model changes needs the lead's `decision`: that is a question (below).
- A rule you invent is not a free choice: **a hypothesis whose `si_faux` involves an expensive-to-undo choice is a question, not a hypothesis.** The four expensive categories: a data model or storage (key, column, table, file or cache format, migration); a public or shared API contract, or an already published route or job name (renaming, removing or changing the type or the meaning of a field, an error code, a route); a destructive or irreversible action (deletion, purge, sending a mail or a notification, payment, one-way migration); a rule that contradicts an existing sourced rule or a rule already coded. In those cases do not write the hypothesis: stop and put the question under "questions" (the lead answers and the step is resumed). Everything else (wording, order, a default) is a written hypothesis, cheap to correct later. **An optional field added to an existing response is not a break** when the sheet proves the old response is unchanged (a rule says so): write it as a hypothesis with its `si_faux`.
- If, after reading the lot and the code, you find that the lot changes NO behaviour (nothing a user, an API client or another service can observe: a lint, a rename, a move, a doc, a CI or cache setting without observable effect), write one line with the reason in `sousSeuil`, create no sheet, and finish: the lot then follows the usual path.

Commit the sheet with explicit paths (never `git add -A` or `commit -a`), a message that cites the lot (`spec({{lot}}): …`), and leave the working tree clean. Do not implement the behaviour, do not write application code or tests, do not push, deliver, run `raf done`, `raf ux` or `raf review`.
Never run `git checkout` or `git switch` to another commit or branch in this repository: the orchestrator watches it and a moved HEAD breaks the other sessions of the wave. To look at another sha, use a throwaway `git worktree add --detach <tmp> <sha>`, removed afterwards.
Decide minor interpretation questions yourself and list each one under "choix" with the alternative you did not take. Leave "questions" empty rather than writing a placeholder such as "no question".
{{commits}}
{{reponse}}
Report: `fiche` (path of the sheet relative to the repository, e.g. `docs/specs/<sujet>/fiche.yaml`, or empty under the threshold), `sousSeuil` (the reason, or empty), `commits`, `nonVerifie` (what you could not check), `choix`, `questions`, `resume`.

You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output, not as free text.
{{tmp}}
