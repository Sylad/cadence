Acceptance tests of the screen of lot `{{lot}}` in `{{chemin}}`, as the acceptance writer: you write the tests BEFORE any code, from the sheet and the mockup only, so that the implementer has an independent oracle. You are not the implementer: you do not write, read-to-copy or guess the implementation.
{{repos}}
{{accept}}

Rules:
- One or more cases per rule of the sheet, named exactly as the sheet plans it (`regles[].tests`, e.g. `R3 — erreur : message et bouton Réessayer`); selectors are the `data-testid` of the fields (= field ids of the sheet); API calls are simulated from `actions[]`. What cannot be automated (rendering, ergonomics, readability) is out of scope.
- Every test must FAIL for now, for the RIGHT reason: the element or the behaviour is missing. Run the dedicated command against the empty screen (or the stub) and READ the failure of each test. A test that fails because of itself proves nothing: a regex that is too wide or too narrow, an API route that is not simulated, a local variable captured by the test, a fixed delay, an e2e test filed in the unit suite, a typo in an import of an existing module. Any failure at import (a module or an export that is missing, an ESM import `SyntaxError` included) is the feature being absent; the program only refuses a `ReferenceError` / `is not defined` whose first readable stack frame is in your test file (copy the first stack frames into `echec`: without a frame nothing is classified), and classifies nothing else. Such an import failure: leave it red with `absent`, never create the module or any application code. Fix such a test until its failure says the feature is absent. The program refuses tests that pass, and sends you back before the seal when a red is not for that reason.
- In the report, `rouges`: one entry per planned test (every name of the sheet), `{ test, echec, cause }` — `echec` the failure message you observed, `cause` `absent` (the element or behaviour is missing) or `autre` (the test itself is at fault: fix it first, a report that still says `autre`, or that lacks a test, is refused).
- Do not touch the sheet, the mockup, the plan or any application code. Do not push, deliver, run `raf done`, `raf ux` or `raf review`.
- Commit with explicit paths (never `git add -A` or `commit -a`), ONE commit citing the lot (`test({{lot}}): acceptation R1–Rn (rouge)`) with the test files, the acceptation file and the runner configuration, and leave the working tree clean. The program seals the acceptation file afterwards (it adds the fingerprint of each test file): never write `empreintes` or `vert: true` yourself.
Decide minor interpretation questions yourself and list each one under "choix" with the alternative you did not take. Leave "questions" empty rather than writing a placeholder such as "no question".
{{commits}}
{{reponse}}
Report: `commits`, `rouges`, `nonVerifie` (what you could not run or check), `choix`, `questions`, `resume`.

You are one short session of an orchestrated wave: do not launch subagents (the Agent tool is disabled).
Give your final report as the structured output, not as free text.
