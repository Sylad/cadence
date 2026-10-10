---
name: deliver-sha
description: Piège relevé à la main — livrer un commit poussé qui n'est pas HEAD avec cadence deliver --sha, après l'avoir poussé seul.
tags: [cadence, deliver, piege]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
runs: 3
---

Mon dépôt utilise cadence avec `ci: github`. HEAD contient un lot qui n'est pas prêt, mais le commit 6b0d9aa, plus ancien, est celui que je veux mettre en production. Donne-moi les commandes exactes, dans l'ordre, pour le livrer sans toucher à HEAD, et dis pourquoi cet ordre. Réponds en quelques lignes, sans rien exécuter.
