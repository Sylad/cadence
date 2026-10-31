Edge-case probe for lot `{{lot}}` — "{{titre}}" — of the repository `{{chemin}}`. You are a fresh session: you did not write this code, and the review that follows reads it as it stands. Your job is to try to break it, with tests at its edges, before that review.
Goal of the lot: {{objectif}}
{{repos}}
{{fiche}}
Commits of the lot:
{{commits}}
The diff of the lot is not pasted here: read it with `{{diff}}` (add `--stat` first for a large lot, then read it file by file), and open the code around each change.
For every function, parser, pattern, threshold or command the diff adds or changes, try the inputs at its edge:
- empty (empty string, list, object, file, zero);
- absent (missing key, null, undefined, a file that does not exist);
- twice (the same item or the same call twice, a duplicate, a repeat);
- wrong type (a string where a number is expected, an object for a list);
- refused (a rejected input, a failing dependency, the error path: the exact message and code the lot or its fiche states);
- the real shape of the data (a real file or a real call, never only a fixture you built to fit the code);
- other callers of what the diff changed (find them with `grep`; each must still work).
Rules: write the tests in NEW test files only (never edit an existing test), named after the rule they attack when the lot has a fiche. Run them, and commit them all, the ones that pass and the ones that fail, with explicit paths (never `git add -A` or `commit -a`) and a message that cites the lot (`probe({{lot}}): …`). Do not modify the application code: you find defects, you do not fix them. Do not modify any existing test, and never an `acceptation-<lot>.json` or the tests it seals. Do not push, deliver, run `raf done`, `raf ux` or `raf review`. Read the project's CLAUDE.md first.
Report in `echecs` one entry per test of yours that fails, written « <test name> — <the edge tried> — <what was expected> »; a test that passes is not listed. Leave `echecs` empty when none fails. What you could not try goes under `nonVerifie`. A question is only for a real blocker: the program writes it down and does not wait for an answer.
{{gate}}
{{workers}}
{{tmp}}
