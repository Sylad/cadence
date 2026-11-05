[← cadence](../../README.md)

# Session slot given back by a remote gate, measure (L624)

**Metric:** minutes of the wave with an empty slot, that is no claude session playing while lots are still to play.

| | Before L624 | After L624 |
|---|---|---|
| Wave 1810-cad, 05-11 (cap 3, gates of 16 min on mini-blue) | 30 min with 0 session, L622 waiting (reported in the lot's statement) | not measured yet |
| Pool test `test/porte-deportee-creneau-l624.test.ts`, R1 (one slot, one lot in a remote gate, one lot to start) | the second lot starts only when the gate of the first ends | the second lot starts during the gate |
| Same file, R1 on the real pool and cycle with a fake ssh (one slot, `maxParallel: 1`, gates of 1.5 s, three lots) | the third lot starts only once the second lot's gate is on the host (the wait for the host's bound held the slot) | the third lot starts while the second waits for the host, its state saying `waiting` |

**Reading.** The test shows the mechanism: with a remote gate the next lot starts while the gate runs, with a local gate it does not (R2). The test is not a measure in minutes.
The 30 minutes come from the lot's statement, not from a log re-read in this session.

**To do by the lead, at the next wave with `orchestrate.gate.host` set.** Count the minutes with 0 session between the first and the last gate (the lines `en attente d'un créneau de session` and `porte jouée sur l'hôte` of the wave journal, and `cadence orchestrate --status --detail`),
and compare with the 30 minutes above. Check also the host load: with `maxParallel` at 2 the host plays two gates at once at most; raise it only after reading its load.
