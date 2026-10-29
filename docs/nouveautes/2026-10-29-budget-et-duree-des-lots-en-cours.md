---
title: Budget et durée des lots en cours
date: 2026-10-29
created: 2026-10-29T20:20+01:00
lots: [L414]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Dans le panneau des lots (`/hud lots`), un bloc « Lots en cours : budget et durée » donne, pour chaque lot en cours d'une vague qui tourne, une ligne : les tokens consommés sur le budget du lot (`100k/750k tokens`), le temps écoulé depuis le début de sa première session et le temps habituel d'un lot de la même taille (`10 min (habituel 30 min)`).

Un lot qui dépasse se repère d'un coup d'œil : il passe en tête du bloc, en couleur d'avertissement, avec un `⚠` — par exemple `⚠ cadence:L64  786k/750k tokens dépassé · 53 min (habituel 30 min, dépassé)`. Le budget est dépassé quand les tokens consommés passent le budget des passes ordinaires (la part réservée à l'escalade de modèle ne compte qu'une fois l'escalade engagée) ; le temps est dépassé au-delà d'une fois et demie le temps habituel.

Le temps habituel est la médiane de la durée des lots rendus de la même taille, telle que `cadence perf --json` la donne désormais (`lotMinutes`). Sans mesure pour la taille du lot, la ligne montre la durée seule et ne signale pas le temps. Le bloc n'apparaît que pendant qu'une vague tourne, et ne prend jamais plus du quart du panneau (au plus la moitié avec « ce qui attend une décision »).
