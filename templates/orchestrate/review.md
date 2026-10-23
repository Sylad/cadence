Review lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, following your agent instructions.
You are given the repository path and the lot id only: read the diff yourself from the commits that
cite the lot (`raf commits {{lot}}`, or `git log`), run the checks, report real defects only.
Goal of the lot (it takes precedence over the title in the plan): {{objectif}}
{{repos}}
{{fiche}}
{{checks}}
{{docs}}
{{choix}}
A lot with a sealed acceptation (an `acceptation-<lot>.json` next to its spec file): re-read each assertion of its sealed tests against the sentence of the rule it cites. An assertion with no cited sentence, or that asserts more than that sentence, is a *major* finding ("sealed test stronger than its rule"): only the lead corrects it (`cadence spec reseal`), never the session.
A proposed sub-task describes an observable bug (a wrong output, a crash, a measured regression); any other minor finding stays a note of this lot, not a sub-task.
You are read-only: do not modify, commit, push or run `raf review|ux|done`. Do not launch subagents.
Give your report as the structured output: counts of blocking / major / minor findings, each finding
(severity, file, line, text), proposed sub-tasks, what you could not verify, and the one-line verdict
for `raf review {{lot}}`.
{{tmp}}
