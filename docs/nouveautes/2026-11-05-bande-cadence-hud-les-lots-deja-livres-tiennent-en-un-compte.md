---
title: "Bande cadence-hud : les lots déjà livrés tiennent en un compteur"
date: 2026-11-05
created: 2026-11-05T11:13+01:00
lots: [L609]
captures: []
nocapture: la bande ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Dans la bande cadence-hud, une vague vivante ne liste plus les lots que le plan a déjà clos. Reprendre une vague dont 21 lots sont livrés ne met plus 21 lignes « prêt » au-dessus de tout : sous les lots encore ouverts, une seule ligne grise, en retrait, les compte : `livrés : 14 · clos non livrés : 3`. La partie « clos non livrés » n'apparaît que s'il y en a, et la ligne n'existe pas quand aucun lot de la vague n'est clos.

Les mots et le critère sont ceux du panneau des lots (`/hud lots`) : un lot est clos quand le plan le dit, quel que soit l'état que la vague lui prête (prêt, rendu, en attente). Un lot encore ouvert au plan garde sa ligne, y compris « prêt ». La ligne est en lecture seule : le détail, lot par lot, se déplie dans `/hud lots`. Les vagues terminées ne changent pas.

Tant que le tour n'est pas lu, ou si cadence est trop ancien pour dire quels lots sont clos, tous les lots restent listés comme avant, sans compteur et sans message de plus dans la bande.

## Hypothèses

- R2 — avant la première lecture du tour, la bande liste tous les lots sans compteur : si elle devait les masquer jusqu'à la lecture, un état de chargement s'ajouterait à ses lignes.
- R3 — si le tour est illisible et qu'aucun tableau n'a été lu, la bande liste tous les lots sans message propre (l'erreur reste celle du panneau des lots) : si la bande doit dire elle-même que le plan est illisible, un message s'ajoute, à écrire.
- R5 — « livrés : N » ne compte que les lots que le plan dit livrés, les autres clos vont dans « clos non livrés : M » : si tout lot clos doit compter « livrés », « clos non livrés » disparaît, mais la bande dirait le contraire du bloc de livraison ; si la ligne doit se déplier, il faudra une donnée de plus.
- R6 — une vague finie garde sa ligne actuelle, sans compteur : si elle devait porter « livrés : N », seule cette ligne change.
