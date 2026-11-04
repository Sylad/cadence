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
Rules: write the tests in NEW test files only (never edit an existing test), named after the rule they attack when the lot has a fiche. A test file is committed only if it is played by the project's gate (the commands below: put it where the test runner and `testGate` pick it up) and if it is green at the lot's last commit; otherwise do not commit it: delete it (`rm`), the working tree keeps only the files you committed (a file left uncommitted is removed by the program, with a warning). Play your files with that gate before committing.
- An expectation that fails because the code breaks a rule of the lot (a rule of the fiche or of the goal above) is the defect you are here to find: commit its test, red; the correction pass that follows turns it green.
- An expectation that is not a rule of the lot (a wrong type, a blank name, a value the API server or the framework already refuses, a behaviour the goal does not state) is not committed, red or skipped, and its file is deleted: write it in `horsRegle`, one entry « test — edge — expected », the program hands it to the lead as a proposed sub-task.
- The file respects the linters of the repository (shellcheck for a shell script, eslint, the repository's lint target or CI): run them on your files before committing, a probe that turns them red leaves them red on the main branch once the lot is delivered.
Commit with explicit paths (never `git add -A` or `commit -a`) and a message that cites the lot (`probe({{lot}}): …`). Do not modify the application code: you find defects, you do not fix them. Do not modify any existing test, and never an `acceptation-<lot>.json` or the tests it seals. Do not push, deliver, run `raf done`, `raf ux` or `raf review`. Read the project's CLAUDE.md first.
Report in `echecs` one entry per committed test of yours that fails, written « <test name> — <the edge tried> — <what was expected> »; a test that passes is not listed. Leave `echecs` empty when none fails. What you could not try goes under `nonVerifie`. A question is only for a real blocker: the program writes it down and does not wait for an answer.
{{gate}}
{{workers}}
{{tmp}}
