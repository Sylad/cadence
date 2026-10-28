---
title: Replier les projets dans le panneau des lots
date: 2026-10-28
created: 2026-10-28T20:52+01:00
lots: [L409]
captures: []
nocapture: le panneau s'affiche dans le terminal de Claude Code, il n'y a pas de page à capturer
---
Dans le panneau des lots (`/hud lots`), chaque projet peut maintenant être replié sur une seule ligne, pour que le projet qui compte des dizaines de lots n'écrase plus les autres.

- Le nom de chaque projet est un bouton : un clic (ou Entrée une fois le bouton sélectionné) le replie ou le déplie. Le triangle devant le nom dit l'état : `▾` déplié, `▸` replié.
- Un projet replié tient en une ligne : son nom, son nombre de lots non clos et le nombre de lots en cours (`▸ maritime  159 lots non clos · 3 en cours`).
- Au premier affichage, un projet de plus de 20 lots non clos est replié ; les autres sont dépliés. Votre choix l'emporte ensuite sur ce défaut, dans les deux sens.
- Au clavier, `/hud lots <projet>` replie ou déplie le projet nommé ; un nom inconnu répond en listant les projets du dossier.
- Le choix est gardé : le panneau fermé puis rouvert, et d'une session à l'autre, retrouve les mêmes projets repliés.
- Un projet replié affiché ne compte pas dans la ligne « … +N lots de plus » et laisse sa place aux suivants ; si la place manque même pour sa ligne, il est retiré et ses lots non clos passent dans ce « +N ». Un projet illisible n'a pas de bouton.

## Hypothèses

- R1 — le seuil est de plus de 20 lots non clos (sous-tâches non comptées) ; seule la valeur change si c'est faux.
- R5 — la « touche » est celle du bouton (Entrée sous le focus) et la commande `/hud lots <projet>` ; une touche par projet n'est pas posée : Entrée sous le focus suffit, et `/hud lots <projet>` couvre le clavier sans donner le focus au panneau. Pour donner le focus au panneau : un clic dedans, ou ctrl+x puis tab.
