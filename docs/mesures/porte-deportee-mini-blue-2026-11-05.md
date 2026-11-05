[← cadence](../../README.md)

# Remote gate on mini-blue, first measure (L617)

`cadence verify --gate --sha HEAD` of the L617 worktree, played on the WSL of mini-blue (`mini-blue-wsl`: i9-13900HK, 20 threads, 15 GB given to WSL). Load is the 1-minute `uptime` of Big-Blue, sampled every 20 s during the gate.

| Run | Sha | Workers on the host | Duration | Big-Blue load (min / mean / max) | Host load (max) | Verdict |
|---|---|---|---:|---|---:|---|
| 1, dependency cache filled | 5bb468e | 6 | 8 min 30 s | 3.4 / 7.8 / 15.9 | 8.6 | red |
| 2, cache used | 4c35a36 | 6 | 7 min 01 s | 2.3 / 5.1 / 10.2 | 8.4 | green |
| 3, cache used, `CADENCE_TEST_WORKERS=14` | 4c35a36 | 14 | 5 min 28 s | 5.7 / 10.9 / 15.8 | 16.6 | green |

Reference on Big-Blue, measured on 2026-11-05: about 4 min alone, 8 to 13 min under load 43.

**Reading.** At 6 workers the host is slower than an idle Big-Blue (7 min against 4) and about level with the good end of a loaded one. At 14 workers it takes 5 min 28 s, still above 4 min alone, and well under 8 to 13 min. The gate takes the build and tests off Big-Blue, whose load stayed that of its other sessions. No run happened under a wave at load 43, so the gain under load is expected, not measured.

**Workers.** The 6 come from `cores ÷ session cap` (20 ÷ `CADENCE_MAX_SESSIONS=3`), the share of a machine several sessions divide. Only the gate uses this host.

**Red of run 1.** Two causes. The ratchet was a real red of the lot, not of the host: `src/verify-gate-remote.ts` at complexity 16, fixed in 4c35a36. `test/verify.test.ts`, « SIGINT reçu par cadence », went red once in the full suite; it passed 6 times out of 6 alone on the host, with and without a tty, and in runs 2 and 3. Its cause is not established.

**Not measured yet.** The measure on three real lots, which the goal of L617 asks for, has not been done. The table above is three plays of one lot's sha (L617's own), outside a wave, not a before and after: it shows the host runs the gate, not what it saves on real lots. The gain under load is expected, not measured. To do: play three real lots of a wave with `orchestrate.gate.host` set, then the same lots without, and compare duration and Big-Blue load.
