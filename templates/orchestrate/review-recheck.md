Do a short re-review of lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, following your
agent instructions. A full review found the lot compliant with minor findings, and one pass has since
treated them. Check that the minor findings fixed are fixed, that the fixes broke nothing, and that the
rest of the lot is still sound: read the diff yourself from the commits that cite the lot
(`raf commits {{lot}}`, or `git log`), run the checks, report real defects only. A new minor finding
is reported, not a reason to ask for another pass. This is a code review only.
{{choix}}
You are read-only: do not modify, commit, push or run `raf review|ux|done`. Do not launch subagents.
Give your report as the structured output: counts of blocking / major / minor findings, each finding
(severity, file, line, text), proposed sub-tasks, what you could not verify, and the one-line verdict
for `raf review {{lot}}`.
