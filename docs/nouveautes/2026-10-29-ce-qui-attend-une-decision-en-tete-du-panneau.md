---
title: Ce qui attend une décision, en tête du panneau
date: 2026-10-29
created: 2026-10-29T16:58+01:00
lots: [L412]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
En tête du panneau des lots (`/hud lots`), un bloc « Ce qui attend une décision » réunit ce qu'il vous reste à trancher, sans parcourir les vagues une à une :

- les **questions** des sessions, avec la commande `cadence orchestrate --resume --wave … --answer projet:lot "…"` à copier pour répondre ;
- les **lots rendus** au lead, avec leur cause en une ligne ;
- les **verdicts UX** à poser, avec la commande `raf ux`;
- les **livraisons en échec** de chaque projet, avec le sha et la raison.

Le bloc n'apparaît que lorsqu'il y a quelque chose à décider et ne prend jamais plus de la moitié du panneau (le reste affiche « … +N décisions de plus ») ; la commande à copier est repliée sur plusieurs lignes à la largeur du panneau, jamais coupée, chaque ligne sauf la dernière finie par ` \` : collées telles quelles dans un shell, elles ne lancent qu'une commande. Il lit les états de vague — une question ou un lot rendu d'une vague finie reste affiché, sans limite de temps, même pendant qu'une autre vague tourne, jusqu'à ce qu'une vague plus récente du dossier finisse à son tour (lancer une autre vague ne l'efface pas) — et le plan tranche : un lot clos (`raf done`) emporte sa décision avec lui à la relecture suivante. La bande, elle, ne change pas : la vague finie n'y reste que sans vague vivante.
