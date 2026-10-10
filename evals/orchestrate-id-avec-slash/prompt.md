---
name: orchestrate-id-avec-slash
description: Piège relevé à la main — cadence orchestrate avec un id de lot contenant « / » (plan en lecture seule) et un modèle @haiku.
tags: [cadence, orchestrate, piege]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
runs: 3
---

Je veux lancer une vague cadence orchestrate sur le lot `Q4/accueil-4-ux12` du projet maritime-atlas (plan en lecture seule : l'id contient un « / »), avec le modèle Haiku parce que c'est mécanique. Écris la ligne de commande exacte, puis dis comment la reprendre si elle s'arrête. Réponds en quelques lignes, sans rien exécuter.
