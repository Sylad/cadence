# Remote gate: build and tests played on another machine (L403)

A project whose build and tests are heavy can play its gate on a second machine through ssh, at the sha
it pushes there, with a cache of dependencies. It is one optional key of `cadence.yaml`; absent, nothing changes
(no ssh call, the same output lines as before).

```yaml
# cadence.yaml
orchestrate:
  build: npm run build
  test: npx vitest run
  gate:
    host: build-box            # an ssh destination: `machine`, `user@machine`
    install: npm ci            # optional: installs the dependencies on the host to fill a cache
```

`host` is a non-empty string without space, not starting with `-` (ssh would read it as an option);
anything else refuses `cadence.yaml` with `orchestrate.gate.host : destination ssh attendue …`. `install` is a non-empty command.
`install` without `host` does nothing (the gate stays local). Any other key of `gate` is refused as unknown (`readsPlan`, `host`, `install` are the three). Declaring `host` alone is **not** `readsPlan`:
the plan-only commits are still crossed (L444) and the `readsPlan` message does not appear.
Nothing in cadence names a machine: the host comes from this key, and the work folder on it is derived.

## What runs where

Played on the host, at the sha, in a throwaway worktree: `orchestrate.build` then `orchestrate.test` of `cadence verify --gate`
(`docs/deliver.md`), and, in a wave (`docs/orchestrate.md`), the program's gate of a lot after a work step, the baseline of the starting sha
and the replay alone of the red tests (`orchestrate.testReplay`, or the `replay` of each part of a gate declared as a list, L512: each part and its replay run in their `dir` of the host's worktree). The commands are those of `cadence.yaml`, unchanged; the verdict is read as a local one
(0 green, 1 red with the tests named, baseline, recording of the checks), and the verdict of a sha is noted in the local shared state as before.
The other commands of a wave (claude sessions, acceptance, start, verdict) stay local.

The first line of the gate says where it ran:
`verify --gate 6b0d9aa : porte jouée sur l'hôte build-box (sha 6b0d9aa, cache utilisé (empreinte 1a2b3c4d))`. In a wave the same line goes to the journal
(`porte du lot L12 : porte jouée sur l'hôte …`) and the place is kept in the lot's checks (`lieu`).

`verify.inPlace: true` wins over the host: the gate runs in the main tree and the output says `l'hôte … est ignoré`.
`inPlace: false` or absent lets the host come before the main tree and the throwaway copy.

A wave plays the gate on the host only when the lot's worktree is **clean and at the commit pushed**: the host would not see uncommitted
changes. Otherwise the gate is local and the journal says `worktree non validé, jouée en local`.

## The work folder on the host

Relative to the ssh login directory: `.cadence-gate/<folder name of the local project>/` with `repo.git` (bare repository where the sha is pushed,
`git push --no-verify`, created at first use), `deps/<fingerprint>` (the dependency caches) and `wt/<unique id>` (the throwaway worktrees).
The host needs `ssh` access without password (`BatchMode`), `git`, `tar` and the tools of the project. Installing the machine is the lead's job.

## The dependency cache

The key is the sha256 of the lockfiles of the sha, at any level of the repository: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
`yarn.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`. No lockfile at the sha: no cache, the gate plays without prepared dependencies.
A known fingerprint is reused without installing; the worktree receives a **copy** of the cache, never a link. An absent cache is filled once:

- with `gate.install`: played **on the host**, in a worktree at the sha; the cache folder carries the platform of the host in its key (`<fingerprint>-linux-x64`);
- without `gate.install`: by copying the local dependencies (`node_modules`, `.venv`, or `orchestrate.worktreeDeps`), but only if the lockfiles of the local tree
  have the fingerprint of the sha **and** the local system and architecture equal the host's (read by the probe). Otherwise the gate falls back to local, with the cause.

A cache is written in a unique temporary folder, then published by a rename to `deps/<fingerprint>`; if it already exists (a wave in parallel, a `verify --gate`), the temporary is
thrown and the existing cache is used. A failed install publishes nothing. cadence **never purges** the caches or the bare repository: freeing the host's disk is up to the lead
(deleting `.cadence-gate/<project>` only forces a push and a reinstall). Temporary folders and worktrees left more than 6 hours ago are removed at the next call.

## When the host does not answer

The gate first probes the host (`ssh -o BatchMode=yes`, short connection delay: never a password prompt). It falls back to the **local gate**, never to a red, and says so:

- `verify --gate : porte déportée indisponible sur <host> (<cause>) — repli sur la porte locale`: the probe, the work folder or the push failed;
- `verify --gate : cache de dépendances impossible sur <host> (<cause>) — repli sur la porte locale`: the cache could not be filled or read;
- in a wave: `porte du lot <lot> : porte déportée indisponible sur <host> (<cause>) — jouée en local` and `… cache de dépendances impossible sur <host> (<cause>) — jouée en local`.

**A connection lost during a command (ssh exit code 255).** The command did not give a verdict, so it is never counted red:
`verify --gate : connexion perdue avec <host> pendant la porte — rejouée en local` (the whole gate is replayed locally), and in a wave
`porte du lot <lot> : connexion perdue avec <host> pendant la porte — rejouée en local` (the command is replayed locally — the lot's gate, its baseline `(ligne de base <sha>)`
or the replay alone — and the next commands of that gate stay local), written to the output **and** to the journal of the wave, with no correction pass and no finding. Any other remote exit code
is the verdict of the command: 1 is a red, as locally.

## Timeout, Ctrl-C, signals

Remote commands run with a terminal (`ssh -tt`) and their process group id is kept on the host, one file per command (a command that times out and is followed by another one keeps its own). At the timeout (30 minutes per command), on Ctrl-C or on a signal, cadence kills the local
ssh and then sends the host a separate command that kills the group and removes the worktree. If that command fails the output says
`nettoyage de l'hôte <host> en échec (<cause>) — le worktree orphelin y sera retiré au prochain appel`.

## Quoting and the sha

The sha, the host and the paths put in an ssh command are single-quoted with escaped quotes. A sha that is not hexadecimal (4 to 64 characters) is refused before any ssh command:
`verify --gate : sha invalide pour la porte déportée (hexadécimal attendu)`, exit 2.

## `CADENCE_TEST_WORKERS`

The commands receive `CADENCE_TEST_WORKERS` computed with the **host's** cores (`nproc`) divided by the session cap (`CADENCE_MAX_SESSIONS`, 2 by default), unless the caller's environment already
holds a positive integer (same rule as the local gate, L350).
