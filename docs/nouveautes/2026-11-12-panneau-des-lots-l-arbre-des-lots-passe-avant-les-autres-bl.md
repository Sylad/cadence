---
title: "Panneau des lots : l'arbre des lots passe avant les autres blocs"
date: 2026-11-12
created: 2026-11-12T21:40+01:00
lots: [L712]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Le panneau des lots (`/hud lots`) ne dit plus « Aucun lot non clos » quand des projets ont des lots ouverts. L'arbre des lots passe en premier dans le partage de la hauteur : tant qu'il n'a pas de quoi montrer chaque projet qui a un lot en cours, les blocs du dessus se replient en une ligne, le banc d'abord (son dernier passage), puis les livraisons, les dépenses et les décisions ; ils cèdent ensuite cette ligne dans le même ordre. La ligne ⚠ d'un lot en dépassement reste toujours.

Un panneau trop petit pour montrer un seul lot le dit : « Pas la place de montrer un lot : agrandir le panneau. » « Aucun lot non clos » n'apparaît que si aucun projet n'a de lot ouvert.

## Hypothèses

- Un projet à lot en cours est gardé visible même s'il vient après d'autres projets dans `priority:` : les blocs du dessus cèdent pour lui, les projets qui le précèdent gardent leurs lots.
- La ligne ⚠ d'un lot en dépassement (L414) ne cède jamais, même quand l'arbre manque d'une ligne.
