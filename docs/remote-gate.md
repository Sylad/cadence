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
    refs: [main, origin/main]  # optional: git references pushed with the sha (L617)
```

`host` is a non-empty string without space, not starting with `-` (ssh would read it as an option);
anything else refuses `cadence.yaml` with `orchestrate.gate.host : destination ssh attendue …`. `install` is a non-empty command.
`refs` is a non-empty list of git reference names (no space, not starting with `-`); anything else refuses `cadence.yaml` with `orchestrate.gate.refs : liste de références git attendue …`.
`install` or `refs` without `host` does nothing (the gate stays local). Any other key of `gate` is refused as unknown (`readsPlan`, `host`, `install`, `refs` are the four). Declaring `host` alone is **not** `readsPlan`:
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

## References the gate reads (L617)

Only the sha is pushed to the host. A build or a test that reads another reference of the repository (`git merge-base HEAD main`, `qualite --contre origin/main`) then finds
nothing there and goes red with « référence introuvable » — a red of the setup, not of the sha. `gate.refs` lists the references pushed with the sha: each is resolved locally
(`git rev-parse`) and pushed under its full name (`refs/heads/main`, `refs/remotes/origin/main`, forced: `main` moves), so the host's worktree resolves the same short names.
A reference missing locally is a fallback to the local gate, said (`porte déportée indisponible sur <host> (référence « x » introuvable en local) — repli sur la porte locale`), never a red.

## The work folder on the host

Relative to the ssh login directory: `.cadence-gate/<folder name of the local project>/` with `repo.git` (bare repository where the sha is pushed,
`git push --no-verify`, created at first use), `deps/<fingerprint>` (the dependency caches) and `wt/<unique id>` (the throwaway worktrees).
The host needs `ssh` access without password (`BatchMode`), `git`, `tar` and the tools of the project. Installing the machine is the lead's job.

## A host behind WSL (L617)

ssh to a Windows machine lands in the Windows shell, not in WSL, so the commands of the gate (`sh`, `git`, `tar`) would not run. The host declared is the ssh server of the WSL itself:
`openssh-server` in the distribution, `Port 2222` and `PasswordAuthentication no` in `/etc/ssh/sshd_config.d/`, the key of the machine that runs cadence in `~/.ssh/authorized_keys`,
`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig` (the WSL answers on the LAN address of Windows) and an inbound firewall rule for the port. On the machine that runs cadence, one alias in `~/.ssh/config`
(`Host build-box-wsl`, `HostName`, `User`, `Port 2222`, `StrictHostKeyChecking accept-new`) is the `host` of `cadence.yaml`: cadence never names a machine.

**WSL stops when no process runs in it**: between two ssh sessions the VM is stopped and port 2222 times out. cadence then falls back to the local gate and says so, so a host left to idle costs
a warning, not a wave. To keep it up, hold one process in it with a scheduled task of the Windows host, started at boot and running whether a user is logged on or not (`S4U` logon, no stored password). In an elevated PowerShell of the host:

```powershell
$a = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d <distribution> -e sleep infinity'
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId '<windows-user>' -LogonType S4U
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName Keep-WSL-alive -Action $a -Trigger $t -Principal $p -Settings $s
Start-ScheduledTask -TaskName Keep-WSL-alive
```

`-ExecutionTimeLimit 0` matters: the default limit of a task (three days) would stop the process, and WSL with it. A persistent change of the host, so the lead's call; the sshd of the distribution must start with it (`systemctl enable ssh`).

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

Remote commands run with a terminal (`ssh -tt`) and their process group id is kept on the host, one file per command (a command that times out and is followed by another one keeps its own). At the timeout (30 minutes per command), on Ctrl-C or on a signal (including during the host probe and `gate.install`, L507), cadence kills the local
ssh — even if the host cleanup then fails — and then sends the host a separate command that kills the group and removes the worktree. If that command fails the output says
`nettoyage de l'hôte <host> en échec (<cause>) — le worktree orphelin y sera retiré au prochain appel`.

## Quoting and the sha

The sha, the host and the paths put in an ssh command are single-quoted with escaped quotes. A sha that is not hexadecimal (4 to 64 characters) is refused before any ssh command:
`verify --gate : sha invalide pour la porte déportée (hexadécimal attendu)`, exit 2.

## `CADENCE_TEST_WORKERS`

The commands receive `CADENCE_TEST_WORKERS` computed with the **host's** cores (`nproc`) divided by the session cap (`CADENCE_MAX_SESSIONS`, 2 by default), unless the caller's environment already
holds a positive integer (same rule as the local gate, L350).
