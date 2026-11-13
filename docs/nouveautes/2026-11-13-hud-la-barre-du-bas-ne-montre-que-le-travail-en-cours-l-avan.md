---
title: "HUD : la barre du bas ne montre que le travail en cours, l'avancement des projets passe dans le panneau des lots"
date: 2026-11-13
created: 2026-11-13T17:06+01:00
lots: [L719]
captures:
  - { file: captures/l719-95col-panneau-ouvert.png, alt: "Terminal de 95 colonnes, panneau des lots ouvert : le panneau manque de hauteur, la barre d'avancement est sur la ligne de chaque projet de l'arbre (« ▾ cadence ▮▮▮▮▮▮▮▮▮▯ 682/697 · 15 lots non clos ») ; la barre du bas ne garde que le contexte, le quota et le coût, sans aucune ligne de projet" }
  - { file: captures/l719-200col-panneau-ouvert-ordre.png, alt: "Terminal de 200 colonnes et 100 lignes, panneau des lots ouvert : la région « ordre des projets » donne pour chacun des 14 projets sa barre colorée, fait/total et ses lots non clos ; la barre du bas montre les trois cadence run en cours, le run intégré et la ligne « runs cadence run : 3 · créneaux libres : 0 sur 3 », sans avancement de projet" }
---
La barre du bas du HUD ne montre plus que le travail en cours : le contexte, les quotas et le coût, les agents et les commandes, les vagues, les `cadence run`, les sessions du lead, les créneaux et le banc en cours. Elle ne dessine plus l'avancement des projets, que le panneau des lots soit ouvert ou fermé. Les cases d'avancement serrées à plusieurs par ligne, qui se décalaient et se coupaient dans la barre étroite de l'app de bureau, sont retirées.

L'avancement de chaque projet est dans le panneau des lots (`/hud lots`) : la région « ordre des projets » donne sa barre colorée, lots faits sur total et ses lots non clos (`▮▮▮▮▮▮▮▮▮▯ 682/697  15 lots non clos`). Quand le panneau n'a pas la hauteur pour cette région (beaucoup de projets dans un petit terminal), la barre passe sur la ligne du projet dans l'arbre des lots, jamais aux deux endroits.

`/hud projets` ne replie plus rien : il dit que l'avancement est dans le panneau des lots.

Panneau fermé et aucune vague en cours, le HUD ne lance plus `cadence lead tour` chaque minute : cette lecture des plans (7 à 9 s sur dix projets) ne servait plus à rien. Elle reprend dès qu'on ouvre le panneau, ou qu'une vague apparaît dans la barre.
