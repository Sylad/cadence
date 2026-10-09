---
title: La bande d'état retombe à zéro et grise les vagues terminées
date: 2026-10-09
created: 2026-10-09T11:01+02:00
lots: [L142]
captures: []
nocapture: la bande cadence-hud s'affiche dans le terminal de Claude Code, il n'y a pas de page à capturer
---
La bande au-dessus du prompt dit désormais clairement ce qu'elle compte et ce qui est fini.

- `/hud cmd` liste les commandes d'arrière-plan comptées dans « N cmd » : identifiant, outil, origine (la session ou tel sous-agent), âge et nom.
- Le compteur retombe à zéro quand les commandes sont finies : un sous-agent terminé emporte ses commandes, et un arrêt par `TaskStop` est toujours pris en compte. Une commande dont on n'a vu aucune fin depuis plus d'une heure (ou dont on ignore le lancement) n'est plus comptée en orange ; la bande l'écrit à part, en gris, « 1 sans fin vue ».
- Une vague orchestrate terminée reste sur une ligne grise (« terminée il y a 12 min · 3 prêts ») sans afficher de budget, et disparaît 30 minutes après sa fin.
