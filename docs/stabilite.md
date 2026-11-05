[← cadence](../README.md)

# Stability

From 1.0.0 cadence follows [semantic versioning](https://semver.org): what is listed under
*Guaranteed* only changes incompatibly in a major version; a minor or a patch never breaks it.

**Guaranteed**

- **Commands and options** of `raf` and `cadence` (`cadence raf …` is `raf …`): `init`, `add`, `start`, `done`, `drop`,
  `archive`, `status`, `todo`, `note`, `did`, `title`, `import`, `migrate`, `move`, `estimate`, `public`, `screen`, `spec`, `visible`, `ux`, `review`, `commits`, `show`, `list`, `export`, `events`, `now`, `ignore`, `check`, `gantt`, `hook`;
  `cadence news`, `session` (`start`, `close`, `next`, `context`), `lead tour`, `corrections`, `deliver`, `verify`, `orchestrate`,
  `skills`, `spec` (`cadence spec <lot> on|off` is `raf spec`; `check`, `qa`: exit **0** when the sheet is valid and the section is printed, **1** with violations, **2** on a missing or unreadable file or a wrong usage);
  their options and exit codes as the pages [raf](raf.md), [orchestrate](orchestrate.md), [deliver](deliver.md), [spec](spec.md), [news](news.md), [session](session.md), [lead](lead.md), [corrections](corrections.md) and [skills](skills.md) document them. A new command or option is a minor change.
- **The keys of `cadence.yaml`**: `plan`, `news`, `hook`, `session`, `deliver`, `orchestrate`, `docs`, `qa`, `priority`, `depth`, `lead` (`lead.ux`),
  `verify` (`inPlace`, [deliver](deliver.md)), `migrate` and `resources` ([raf](raf.md))
  and the keys each of them takes (`docs`: `sync`, `since`, `articles`; `docs.articles` names both the article refreshed after a delivery and the outside documents the `doc-keeper` agent proposes lots for). A key is not renamed nor removed, nor does its meaning change; a new key is a minor change.
- **The plan file** (`.cadence/raf.yaml`, or the legacy `docs/plan/raf.yaml`): `project`, `prefix`, `since`, `ignore`, `lots` (with their
  fields, `tasks`, `notes`, `repos`) and `acknowledged`, and the plan formats `plan:` in `cadence.yaml` can read.
  The `version` key is kept in the file but ignored (`src/plan.ts` does not read it): it is not a schema version.
- **The names of the skills** (`session-start`, `session-close`, `deliver`, `lead`, `orchestrate`) **and of the agents**
  (`ux-reviewer`, `code-reviewer`, `qa-reviewer`, `doc-keeper`).

**Experimental** (documented, read by the code, but the contract is not frozen: a release may change or replace it, announced under *Changed* in the [CHANGELOG](../CHANGELOG.md))

- **Subcommands of `raf`**: `quickwins` (the threshold of a « small lot » is read under three names, `express`, `light` and `small`, that are to become one), `uses` (follows the `resources` table it checks against), `plan` (the plan file location and format it reports follow the plan reader, which is to be split from the native plan) and `docs-ok` (the same notion is spelled three ways, `docs-ok`, `docs_ok` and `docsOk`).
- **Tools of `cadence`**: `ref` (reference documents: its options still grow with the documents studied, and it needs outside programs), `perf` (a dashboard whose measures and thresholds are tuned), `local`, `release` and `config` (the lead's own tools, shaped by how the lead works, not by a project's scripts), and `claude-hook` (the Bash hook of the plugin, called by `hooks/hooks.json`, not by hand: its output follows the refusals it recognises).
- **Keys of `cadence.yaml`**: `references` (the setting of `cadence ref`) and `perf` (the setting of `cadence perf`): each follows its tool.

Promoting one of these to *Guaranteed* is a minor change, and calling a surface experimental commits cadence to nothing.

**Not guaranteed** (may change in any release)

- The **text of the outputs**: wording, layout, order of the lines and columns of every report, table and message
  (the `--json` outputs and the exit codes are part of the commands above; `raf export` and `raf events` carry a `schema` number, 1 today, that only a removed or renamed field changes). In a `--json` output a new field is a
  minor change, so consumers must tolerate unknown fields; removing or renaming a field is a major change.
- The **`precheck-reader`**, **`spec-writer`** and **`acceptance-writer`** agents, and the mockup and conformity modes of **`ux-reviewer`**: internal to `cadence orchestrate`, not meant to be called by hand.
- The **`cadence-hud` band**: its segments, colours and layout; it is versioned on its own.
- The **wave journals** under `.cadence/runs` and the files `cadence orchestrate` keeps there.
- The wording of the briefs and of the instructions inside the skills and the agents.
- The **format of the sheets** (`fiche.yaml`: the screen sheet `templates/fiche.yaml`, the back-end sheet `templates/fiche-back.yaml`, the mixed sheet) and so the invariants `cadence spec check` enforces: experimental while the next bricks of the spec step (S3–S6) still reshape it, a sheet that passes today may be refused by a later release. The `spec` commands and their exit codes are guaranteed, the keys they read are not yet.

**Node**: `engines.node` is `>=22.18` (the first Node that runs `.ts` files without a tool, which the test suite relies on). The minimum Node version follows the maintained LTS lines: when a Node line leaves maintenance, cadence raises its minimum in a **minor** release, announced under *Changed* in the [CHANGELOG](../CHANGELOG.md) with an explicit warning. Node 20, out of maintenance since April 2026, is no longer supported.

There is no schema version and no migration: a file written by an earlier release keeps working, and a key a
release adds is optional.

## Languages

The documentation (`README`, `docs/*.md`), the **names** — commands, options, keys, files and folders — and the text the tool gives to the models (the agents, the skills, the brief templates under `templates/orchestrate/`; the few prompts held in the code, for `cadence corrections --classify` and `cadence ref`, are still in French) and to its readers (the CHANGELOG) are in English; the **messages** the tool prints (outputs, refusals) and the code comments are in French. The tool is not a French CLI: it speaks French and is named in English.

A few names are French. The keys `maquette`, `maquetteReviews` and `fiche` under `orchestrate` in `cadence.yaml`, and the options `--porteur` (of `spec reseal`) and `--cache-sous-causes` (of `corrections`), are on guaranteed surfaces: they keep their names until a major version, and no alias is added: two names for one key would be one more overlap. The options `--quoi`, `--largeur`, `--seuil` and `--sans-rendu` exist only under `cadence ref`, which is experimental: they follow its status, not a guarantee. The files `acceptation-<lot>.json` (and the older `acceptation.json`, still read as is), `qualite-baseline.json` and the folder `docs/nouveautes/` are French too, as are the sub-commands of the hook entry point, `cadence claude-hook retour|attente|pipe`. The sheet files `fiche.yaml` and `inventaire.json` and the keys of the sheets (`sujet`, `cas`, `regles`, `contrats`, `donnees` in `templates/fiche-back.yaml`, `ecran`, `etats`, `champs`, `actions` in `templates/fiche.yaml`) are French as well: the sheet format is experimental (see above), so these names carry no guarantee.

A new name is in English: it is the language of almost every command and key, and naming new ones in French would deepen the mix.
