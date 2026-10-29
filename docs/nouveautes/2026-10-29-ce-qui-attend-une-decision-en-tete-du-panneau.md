---
title: Ce qui attend une décision, en tête du panneau
date: 2026-10-29
created: 2026-10-29T16:58+01:00
lots: [L412]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
En tête du panneau des lots (`/hud lots`), un bloc « Ce qui attend une décision » réunit ce qu'il vous reste à trancher, sans parcourir les vagues une à une :

- les **questions** des sessions, avec la commande `cd <dossier> && cadence orchestrate --resume --wave … --answer projet:lot "…"` à copier pour répondre (tant que la vague tourne, « réponse possible à la fin de la vague ») ;
- les **lots rendus** au lead, avec leur cause en une ligne ;
- les **verdicts UX** à poser, avec la commande `cd <dépôt> && raf ux …` ;
- les **livraisons en échec** de chaque projet, avec le sha et la raison.

Chaque commande à copier commence par `cd` : elle s'exécute telle quelle, d'où que vous soyez. Le bloc n'apparaît que lorsqu'il y a quelque chose à décider et ne prend jamais plus de la moitié du panneau (le reste affiche « … +N décisions de plus ») ; la commande à copier est repliée sur plusieurs lignes à la largeur du panneau, jamais coupée, chaque ligne sauf la dernière finie par ` \` : collées telles quelles dans un shell, elles ne lancent qu'une commande. Il lit les états de vague — toutes les vagues finies du dossier des 7 derniers jours (30 au plus), de la plus récente à la plus ancienne : une question ou un lot rendu reste affiché, sans limite de temps, même pendant qu'une autre vague tourne ou finit dans le dossier — et le plan tranche : un lot clos (`raf done`) emporte sa décision avec lui à la relecture suivante. La bande, elle, ne change pas : la vague finie n'y reste que sans vague vivante.
