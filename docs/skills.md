[← cadence](../README.md)

# Claude Code skills

As a plugin:

```
/plugin marketplace add Sylad/cadence
/plugin install cadence@cadence
```

gives `/cadence:session-start`, `/cadence:session-close`, `/cadence:deliver`,
`/cadence:lead` and the `ux-reviewer`, `code-reviewer` and `qa-reviewer` agents. Or copy them into the
repository with `cadence skills install` (to `.claude/skills/cadence-*` and
`.claude/agents/cadence-*.md`; `--dir` for another `.claude` folder,
`--force` to overwrite local edits).

- **session-start**: reports the facts briefly, proposes three lots from the
  plan, then waits for your priority — nothing starts before your answer.
- **session-close**: plan hygiene, clean repository, a cleanup proposal for stale
  working files (`session.clean` patterns, older than `session.cleanDays`; never
  anything git tracks, a git repository or a folder holding one, anything under
  `.git`, a bare repository or separate git directory or anything inside one,
  anything behind a symbolic link a `*` matched (only the link itself), a hidden `.xxx` name a `*` would not match, nor anything it could not
  read entirely — it asks before deleting), memory limited to what the
  repository does not say, new skills or agents proposed but never created, three
  lines for next time.
- A project with its own tooling keeps it: its plan is read where it is (`plan:`),
  its delivery script is called by `cadence deliver` (`deliver.script`), its
  morning and evening scripts feed the session report (`session:`), and its own
  skills can become one-line aliases of `session-start` / `session-close`.
- **deliver**: dry run, delivery, and on failure the cause fixed rather than a
  blind retry; after a green delivery that changes what a page shows or what it
  is served, the `qa-reviewer` agent walks the delivered app.
- **lead**: from a folder holding several projects, `cadence lead tour` (a program,
  no model: see [lead tour](lead.md#lead-tour)) prints one line of facts per project, you choose the priorities, the lots are delegated with
  `cadence orchestrate` (fresh short sessions with a standard brief — test first,
  README and usage documentation updated with the change, commits citing the lot, no push — reviewed by the `code-reviewer` agent, see
  [orchestrate](orchestrate.md#orchestrate); a lot with `screen: page` first goes through the [spec, mockup review and accept steps](orchestrate.md#the-spec-step-of-a-lot-with-screen)), re-verified by the lead, then delivered
  one project at a time; a delivery that changes what a page shows or what it is
  served is then checked in the running app by the `qa-reviewer` agent, whose
  blocking findings come back to you. As many
  subagents as the session cap at most (2 by default, `CADENCE_MAX_SESSIONS`), the ones it starts by hand declared with `cadence lead hold`, never two in the same repository. The whole flow is drawn in
  [docs/lead.md](lead.md); how a lot, a wave, the lead and the service of cadence itself fit together, in four figures, is in
  [docs/fonctionnement.md](fonctionnement.md).
- **ux-reviewer** (agent): captures at 1440 and 390 px, findings grounded in a
  named rule (Nielsen, WCAG 2.2 AA) or a measurement, ranked, turned into
  `raf add --parent` sub-tasks, and a one-line verdict for `raf ux`. It never
  edits code. Read-only for real: its `tools:` list is `Read, Grep, Glob, Bash` and the
  Playwright tools (`mcp__playwright`, and `mcp__plugin_playwright_playwright` when the
  browser comes from the Playwright plugin) — no `Edit`, no `Write`. In a wave it gives its captures the absolute path of the capture directory its brief names (a bare name would land in the repository); outside a wave, a path under `.playwright-mcp/` (e.g. `.playwright-mcp/page-home.png`; the Playwright MCP resolves a bare file name against the repository, where it would land at the root); `qa-reviewer` follows it too.
- **code-reviewer** (agent): any stack; given a repository and a lot id, it reads
  the diff itself from the commits that cite the lot — not the author's summary —
  and the project's CLAUDE.md, when there is one, for its conventions; findings grounded in a
  measurement (a failing command, changed code without a test, a duplicated
  block, dead code) or a named rule, each with `file:line` and a concrete
  scenario; real defects only, ranked, what it could not verify, and a one-line
  verdict for `raf review`. It takes the lot's commits from `raf commits`, never
  runs a build whose output is used live, and never edits code. A README or usage
  documentation that does not follow the lot's change is a *major* finding.
- **doc-keeper** (agent, L306): any stack; given a repository and a lot id, it reads the diff of the lot and the
  project's map of documents (`docs.sync` of `cadence.yaml`, README, `docs/`, CHANGELOG, news entries), says which
  documents must change and where, then updates them in a writing session (explicit paths, `docs(<lot>): …`) or
  only lists them in a read-only one. `cadence orchestrate` calls it before the review when `docs.sync` reports a
  document behind the lot; the lead calls it by hand. A document outside the repository only when the project's
  `cadence.yaml` names it (`docs.articles`): the agent then proposes a lot for that repository's plan and never writes it
  ([news](news.md#the-librarian-doc-keeper)).
- **reference-analyst** (agent, L265): given the folder of a document registered by `cadence ref add` and the file to
  write, it looks at every rendered page whole, then every zone at full resolution, measures with `cadence ref measure`
  (never by eye), copies every text verbatim, links each figure to the passages that cite it and writes one reading in
  the format of `templates/inventaire.json`, validated by `cadence ref check`; what it cannot read for sure is
  `incertain` with its cause, what the document does not show is a `silence`. Its tools are `Read`, `Write`, `Bash`,
  `Grep`, `Glob`: it writes only its reading, never the tokens (the program counts them), never an expected inventory.
  `cadence ref analyse` launches it ([ref](ref.md#cadence-ref-analyse-documentpdf---sections-3-59---slug-name---model-sonnetopushaiku)).
- **qa-reviewer** (agent): any web app (read-only like `ux-reviewer`: same tool list, no `Edit`, no `Write`); given a repository and a base URL (and
  optionally a lot id, to walk only the pages it touched — those that call the
  changed endpoints, those of the screens it changed, the pages that consume the services the lot changed,
  and the home page; a backend-only lot stays in scope, and when the lot changes no route
  and no screen, or the endpoints cannot be mapped to pages, every page is walked; the others are named « Not walked »), it opens each page of
  the project's expectations file in a real browser at 1440 and 390 px and
  measures: expected content present and non-empty, no error or missing-data
  message, every API call answered 2xx with a non-empty body, no console error,
  no broken content image. It reads the page as text first and takes a capture only for a gap. Findings are defects (a line of the expectations
  broken, or a universal check failing with a visible effect, with or without an
  expectations file), suspects (it looks like missing or wrong data and no
  expectation settles it) or noise (a console error or a failed request with no
  visible effect, ranked minor) or already planned (an open lot covers it: returned in one line, the lot id and its title), ranked, each with
  the route, what was expected, what was measured and the evidence; pages checked
  N/N, follow-ups as `raf add` lines, what it could not verify, a one-line
  verdict. Read-only: GET only, no login, nothing submitted; it stops at a PIN.
