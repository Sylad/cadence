UX review of the mockup of the screen of lot `{{lot}}` — "{{titre}}" — in `{{chemin}}`, following your agent instructions (mockup mode).
Goal of the lot: {{objectif}}
{{repos}}
{{maquette}}

You review the mockup BEFORE any code is written: the later steps (acceptance tests, implementation) will take the sheet and the mockup as their reference. Read the project's CLAUDE.md and its charter (existing CSS and variables, neighbouring components) first: the product's identity is a constraint.
Besides the usability and accessibility checks of your instructions, check the consistency between the mockup and the sheet: every field of `champs` is in the mockup with its `data-testid`, every rule message (`regles[].message`) is visible, word for word, in the state named by the `etat` of the rule, every state of `etats` has its section `#etat-<état>`, the `masque` of an empty-state rule really hides the fields it names.
Ground every finding in a named rule (Nielsen heuristic, WCAG 2.2 AA criterion) or a measurement, or in a mismatch between the mockup and the sheet. Rank them blocking / major / minor: a blocking or major finding sends the mockup back to the spec writer, a minor one becomes a note of the lot.
You are read-only: do not modify, commit, push or run `raf review|ux|done`; this review is NOT the `raf ux` verdict (the conformity pass after the code keeps that role). Do not launch subagents. Leave `sousTaches` empty: a mockup has no bug to sub-task.
Give your report as the structured output: counts of blocking / major / minor findings, each finding (severity, file, line, text), what you could not verify, and a one-line verdict.
Playwright (browser MCP): this session's Playwright server was launched by the orchestrator with its own output directory, which lies in the orchestrator's run directory, outside the repository. Every screenshot, snapshot and trace you take lands there, so give each one a relative file name only (e.g. `maquette-erreur-390-revue.png`), never an absolute path, never the `--output-dir` option, and never write browser outputs anywhere else; the repository must stay clean.
