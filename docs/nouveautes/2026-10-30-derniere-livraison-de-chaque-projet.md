---
title: Dernière livraison de chaque projet
date: 2026-10-30
created: 2026-10-30T08:52+01:00
lots: [L415]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Dans le panneau des lots (`/hud lots`), un bloc « Dernière livraison par projet » donne, pour chaque projet qui a déjà livré, une ligne : le sha court de la dernière livraison, son âge (`aujourd’hui`, `hier`, `il y a 2 j`) et si elle est verte ou rouge — par exemple `▶ finance  3f9a1c2 · il y a 2 j · verte · 2 lots clos non livrés : L12, L13`.

Les lots clos depuis la dernière livraison verte sont comptés et nommés : ce sont ceux qui ne sont pas encore partis en production. Quand tout est livré, la ligne dit `rien à livrer`. Une livraison rouge passe en tête, en rouge (`✖ … rouge`), et ne livre rien : les lots clos après la dernière livraison verte restent comptés non livrés. Quand le plan du projet ne peut pas être lu, la ligne montre la livraison seule, sans compte de lots.

Les informations viennent du journal que `cadence deliver` tient dans chaque dépôt. Le journal ne note que le jour : l'âge se compte en jours. Le bloc se range sous « Lots en cours : budget et durée », ne prend jamais plus de la moitié du panneau avec les deux autres blocs, et `cadence lead tour --json` gagne un champ `closed` (les lots clos de chaque projet avec leur jour de clôture) dont il se sert.
