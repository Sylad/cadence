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

Le bloc n'apparaît que lorsqu'il y a quelque chose à décider, ne prend jamais plus de la moitié du panneau (le reste affiche « … +N décisions de plus ») et disparaît de lui-même quand la décision est prise.
