[← cadence](../README.md)

# Releasing

A version exists in three places and is published in two; a release does all of it, in this order:

1. Bump `version` in `package.json` (then `npm install` to refresh `package-lock.json`),
   `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and write the version's section of
   `CHANGELOG.md` (`## [x.y.z] - date`, what changes for the user, lots cited), in **one commit that holds
   only those files** (the version fields and the CHANGELOG, nothing else in the manifests, `docs/whats-new.md`: add the version to its « In two lines » list and its
   long form (the README no longer carries a « What's new » section, L326)). Such a commit is
   exempt from the code-review gate like a plan commit: it closes the lot after its review, and `raf check`
   does not ask for a new one (nor does it count it as a commit without a lot). The « What's new »
   summary (`docs/whats-new.md`) is ordered by version, a number known only at the release and shared by several lots: write it
   in that commit, not before the review. A commit that touches any other file
   — or another field of a manifest, or a dependency in `package-lock.json` — is work like any other and has
   to be reviewed.
2. Run the plugin evaluation, `npm run eval:plugin` (billed, see [Evaluating the plugin](#evaluating-the-plugin-before-a-release)),
   on that version commit; a case below the threshold stops the release until you have read it in the report.
3. `git tag v<version> && git push origin main v<version>` — the tag starts `.github/workflows/publish.yml`,
   which publishes to npm through Trusted Publishing (OIDC, no token stored anywhere): it checks the tag
   matches `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` and that `CHANGELOG.md` has a `## [x.y.z]` section for it (no section, no publication), then `npm publish --provenance`, where `prepublishOnly` runs the type-check and the
   tests and `prepare` builds `dist/`; a red suite stops the publication; then it creates the GitHub release with that CHANGELOG section as its text. The trusted publisher is declared
   once on npmjs.com (package settings → Trusted Publisher → GitHub Actions, `Sylad/cadence`, `publish.yml`).
4. Watch the run: `gh run watch` (or `gh run list --workflow publish.yml`).
5. Check the effect: `npm view @sylad/cadence version` answers the new version.
   A run is safe to re-run, and two runs for one tag queue instead of racing (`concurrency` per ref, never cancelling the one that publishes):
   a version already on npm skips `npm publish`, and a GitHub release that is missing is created (`--verify-tag`)
   while an existing one is left alone. If the package is on npm but the release is still missing, re-run the job;
   the by-hand fallback is `gh release create v<version> --title v<version> --notes-file <the section of CHANGELOG.md> --verify-tag`.

`.github/workflows/tests.yml` runs the type-check and the test suite on the same runner image, Node 24 and `npm ci` as the publish job, and never publishes: start it with `gh workflow run tests.yml --ref <branch>` or by pushing a `diag/**` branch, to see on the runner what a red publish run saw.

The Claude Code plugin is read from the repository, so pushing `main` is what updates it; npm is what
`npx @sylad/cadence` and a global install read, and only the tag publishes there. A missing tag, or a red
publish run, leaves npm behind without any other error — 0.3.0 and 0.4.0 were never published — hence
step 5.

## Evaluating the plugin (before a release)

`evals/` holds an evaluation suite for the plugin itself, run by `claude plugin eval` (Claude Code 2.1.263 and later). Each case is
a folder with a `prompt.md` and `graders/*.md`, and replays a trap found by hand: `raf-done-sans-revue` (`raf done` refused on a lot whose
commits have no code review, with no `--force` to get round it), `deliver-sha` (`git push origin <sha>:main` then
`cadence deliver --sha <sha>` for a pushed commit that is not `HEAD`), `orchestrate-id-avec-slash` (`maritime-atlas:Q4/accueil-4-ux12@haiku`
keeps its `/`) and `livrer-sh-sans-bloc` (a `./livrer.sh` without a `deliver:` block in `cadence.yaml` is not
run by `cadence deliver`). Every case also runs a **baseline without the plugin**, so the report gives the score of each arm and the
difference: a trap the baseline already avoids proves nothing about the plugin. The cases are read-only questions (tools `Read`, `Glob`, `Grep`,
`Skill`, no scaffold script), each graded by a regular expression and by a model-judged criterion.

```sh
npm run eval:plugin              # claude plugin eval . --max-cost-usd 5 --no-publish; 4 cases × 3 runs × 2 arms = 24 runs
claude plugin eval . --case deliver-sha --runs 1 --trust-plugin --no-publish --max-cost-usd 1    # one case, one run (the first run asks to trust the plugin)
```

**Every run is billed** (a full `claude` session on your own credential, plus the judge): the suite is run at the release, once the
version commit is ready, never in `npm test`, in `prepublishOnly` or in CI, and `--max-cost-usd 5` aborts a runaway. A case below
the threshold (1.0 by default, `--threshold`) makes the command exit 1: read the case in the report before deciding it is the plugin
and not the wording of the case. `npm test` only checks that the
files are well formed (`test/plugin-evals.test.ts`); `evals/` is not part of the npm package.
