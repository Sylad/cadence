---
name: orchestrate
description: The exact command line of `cadence orchestrate` — launch a wave ("lancer une vague orchestrate", "start an orchestrate wave", run lot X with model Haiku) and resume it with `--resume [--wave <wave>]`. Use it before writing any `cadence orchestrate` command, without going through /lead. Syntax `<project>:<lot>[@<model>]`, a lot id with « / » kept as is.
---

# orchestrate — the command line of a wave

`cadence orchestrate` runs one fresh short session per step of each lot (write, review, correction, delivery of
the sheet). This page is only the syntax; the lead's workflow is the `cadence:lead` skill and every option is in
`docs/orchestrate.md` of the cadence package.

## Launch

```sh
cadence orchestrate <project>:<lot>[@<model>] [<project>:<lot>[@<model>] …] [--wave <id>] [--budget 2M]
cadence orchestrate maritime-atlas:Q4/accueil-4-ux12@haiku
cadence orchestrate finance-tracker:L41 cadence:L18@haiku --budget 1.5M
```

- One positional argument per lot: `<project>:<lot>`, then `@<model>` to give that lot a model (`@haiku`, `@sonnet`,
  `@opus`). The project is what comes before the **first `:`**, the model what comes after the **last `@`**.
- **A lot id may contain « / »** (sub-tasks of a plan kept read-only by another tool, `Q4/accueil-4-ux12`): write it as is, never escape
  it, never replace it, never split it. Quote the whole argument only if the shell needs it.
- There is no `--lot` and no `--model`: the lot and its model are always in the same argument, `<project>:<lot>@<model>`.
  From inside a project, `cadence orchestrate L18` is enough.
- `--dry-run` first when a precondition is in doubt (nothing is started); `--budget` takes `1.5M`, `800k` or `1500000`;
  `--goal "<what done looks like>"` for a single lot whose title is stale.

## Resume

A wave that stopped (a question, the quota, an interruption) is resumed with the same program, never with a new wave:

```sh
cadence orchestrate --resume                     # the only unfinished wave of the folder
cadence orchestrate --resume --wave <wave>       # a named wave (required when several are unfinished)
cadence orchestrate --resume --wave <wave> --answer <project>:<lot> "reply"
```

`--resume` takes no lot: it replays the lots of the wave. `cadence orchestrate --status` shows the live waves of the machine and the table of the folder's latest wave; `--resume` with no wave lists the unfinished ones when there are several.
