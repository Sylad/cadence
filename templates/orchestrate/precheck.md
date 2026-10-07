Pre-check for lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`, as the read-only pre-check reader.
Question: is the deliverable of this lot ALREADY in the repository (done by another lot, or by a correction)?
Goal of the lot: {{objectif}}
Read the lot, its notes and sub-tasks in the plan (`docs/plan/raf.yaml`, or the file named by `plan:` in `cadence.yaml`),
then look for the deliverable in the code and tests (`git log`, `grep`, reading the files the lot names). Do not
implement anything and do not run the full test suite: this is a quick look.
Answer `oui` only when every part of the lot is present, with a proof for each (file:line or commit sha); `partiel` when
some parts are present (say which); `non` otherwise. When in doubt, answer `non`: an implementation session follows.
You are read-only: do not modify, commit, push or run `raf start|done|note|review|ux`. Do not launch subagents.
Give your report as the structured output: `dejaPresent` (oui | partiel | non), `preuves` (the proofs), `resume` (one sentence).
