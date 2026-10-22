[← cadence](../README.md)

# Stability

From 1.0.0 cadence follows [semantic versioning](https://semver.org): what is listed under
*Guaranteed* only changes incompatibly in a major version; a minor or a patch never breaks it.

**Guaranteed**

- **Commands and options** of `raf` and `cadence` (`cadence raf …` is `raf …`): `init`, `add`, `start`, `done`, `drop`,
  `note`, `did`, `public`, `screen`, `spec`, `ux`, `review`, `commits`, `show`, `list`, `now`, `ignore`, `check`, `gantt`, `hook`;
  `cadence news`, `session` (`start`, `close`, `next`, `context`), `lead tour`, `corrections`, `deliver`, `verify`, `orchestrate`,
  `skills`, `spec` (`cadence spec <lot> on|off` is `raf spec`; `check`, `qa`: exit **0** when the sheet is valid and the section is printed, **1** with violations, **2** on a missing or unreadable file or a wrong usage);
  their options and exit codes as the pages [raf](raf.md), [orchestrate](orchestrate.md), [deliver](deliver.md), [spec](spec.md), [news](news.md), [session](session.md), [lead](lead.md), [corrections](corrections.md) and [skills](skills.md) document them. A new command or option is a minor change.
- **The keys of `cadence.yaml`**: `plan`, `news`, `hook`, `session`, `deliver`, `orchestrate`, `docs`, `qa`, `priority`, `depth`, `lead` (`lead.ux`)
  and the keys each of them takes. A key is not renamed nor removed, nor does its meaning change; a new key is a minor change.
- **The plan file** (`.cadence/raf.yaml`, or the legacy `docs/plan/raf.yaml`): `project`, `prefix`, `since`, `ignore`, `lots` (with their
  fields, `tasks`, `notes`, `repos`) and `acknowledged`, and the plan formats `plan:` in `cadence.yaml` can read.
  The `version` key is kept in the file but ignored (`src/plan.ts` does not read it): it is not a schema version.
- **The names of the skills** (`session-start`, `session-close`, `deliver`, `lead`) **and of the agents**
  (`ux-reviewer`, `code-reviewer`, `qa-reviewer`).

**Not guaranteed** (may change in any release)

- The **text of the outputs**: wording, layout, order of the lines and columns of every report, table and message
  (the `--json` outputs and the exit codes are part of the commands above). In a `--json` output a new field is a
  minor change, so consumers must tolerate unknown fields; removing or renaming a field is a major change.
- The **`precheck-reader`**, **`spec-writer`** and **`acceptance-writer`** agents, and the mockup and conformity modes of **`ux-reviewer`**: internal to `cadence orchestrate`, not meant to be called by hand.
- The **`cadence-hud` band**: its segments, colours and layout; it is versioned on its own.
- The **wave journals** under `.cadence/runs` and the files `cadence orchestrate` keeps there.
- The wording of the briefs and of the instructions inside the skills and the agents.
- The **format of the sheets** (`fiche.yaml`: the screen sheet `templates/fiche.yaml`, the back-end sheet `templates/fiche-back.yaml`, the mixed sheet) and so the invariants `cadence spec check` enforces: experimental while the next bricks of the spec step (S3–S6) still reshape it, a sheet that passes today may be refused by a later release. The `spec` commands and their exit codes are guaranteed, the keys they read are not yet.

There is no schema version and no migration: a file written by an earlier release keeps working, and a key a
release adds is optional.
