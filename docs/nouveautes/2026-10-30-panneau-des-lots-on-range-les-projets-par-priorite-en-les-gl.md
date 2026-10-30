---
title: "Panneau des lots : on range les projets par priorité en les glissant"
date: 2026-10-30
created: 2026-10-30T15:28+01:00
lots: [L449]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Dans le panneau des lots (`/hud lots`), les projets du dossier se rangent comme les lots : au-dessus de l'arbre, une ligne par projet (`cadence  7 lots non clos`) sous le titre `ordre des projets (priority:)`. On glisse un projet sur un autre à la souris (app desktop), ou on clique dessus puis **Alt**+↑ / **Alt**+↓ pour le monter ou le descendre d'un cran.

Le dépôt réécrit la liste `priority:` du `cadence.yaml` du dossier parent : c'est l'ordre du tableau du lead, de `cadence orchestrate --continue` et du panneau lui-même. Les commentaires du fichier sont conservés. Le panneau écrit sous le titre `✔ ol placé avant cadence — priority: du cadence.yaml est modifiée, à commiter` : il ne commite rien, le fichier reste à vous.

Si le `cadence.yaml` est illisible (ou si `priority:` n'est pas une liste de noms), le déplacement est refusé, la raison s'affiche sous le titre et le fichier n'est pas touché. La même chose existe en ligne de commande : `cadence lead priority <projet> --before|--after <projet>`.
