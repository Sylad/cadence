Pre-check for lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, as the read-only pre-check reader.
Question: is the deliverable of this lot ALREADY in the repository (done by another lot, or by a correction)?
Goal of the lot: {{objectif}}
{{repos}}
{{lecture}}
then look for the deliverable in the code and tests (`git log`, `grep`, reading the files the lot names). Do not
implement anything and do not run the full test suite: this is a quick look.
Answer `oui` only when every part of the lot is present, with a proof for each (file:line or commit sha); `partiel` when
some parts are present (say which); `non` otherwise. When in doubt, answer `non`: an implementation session follows.
You are read-only: do not modify, commit, push or run `raf start|done|note|review|ux`. Do not launch subagents.
Give your report as the structured output: `dejaPresent` (oui | partiel | non), `preuves` (the proofs), `resume` (one sentence).
Also give, in the optional `lu` field, what you read to look: the files the lot concerns (`path:line`), the neighbouring code to imitate and the existing tests you opened, one line each (a few lines, not a copy of the code). The implementation session (or the spec session, for a lot with a spec step, L666) starts from it instead of searching again; leave `lu` out when you read nothing of use.
End `lu` with a line `Edge cases of the rule:` (L666) that lists the edge cases of the rule the lot states, before anyone writes its spec: the absent base (nothing to read from), the lossless copy on the source side (what the copy keeps or drops of the source), the empty, the twice, the refused. One line each, with where the code decides it (`path:line`) or `not decided`.
{{tmp}}
