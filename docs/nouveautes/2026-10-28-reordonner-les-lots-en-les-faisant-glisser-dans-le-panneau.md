---
title: Réordonner les lots en les faisant glisser dans le panneau
date: 2026-10-28
created: 2026-10-28T22:20+01:00
lots: [L402]
captures: []
nocapture: le panneau s'affiche dans le terminal et l'app de Claude Code, dans une région que la page de test ne dessine pas ; il n'y a pas de page à capturer
---
Dans le panneau des lots (`/hud lots`), on peut maintenant changer l'ordre des lots sans quitter la conversation.

- À la souris (terminal avec la souris active, app de bureau) : appuyez sur un lot, faites-le glisser sur un autre lot du même projet et du même groupe (en cours, libres, bloqués), relâchez. Pendant le glisser, un repère montre où il va tomber : `⇡` (avant la ligne survolée) ou `⇣` (après). Une sous-tâche se déplace de la même façon parmi celles de son lot.
- Au clavier : sélectionnez une ligne (un clic, puis ↑ / ↓), puis Alt+↑ ou Alt+↓ pour la placer avant le lot précédent ou après le suivant.
- Le dépôt lance `raf move` dans le projet, puis le panneau relit les plans. Il écrit ensuite que le plan est modifié et reste à commiter : le panneau ne commite rien.
- Un lot ne se réordonne qu'à l'intérieur de son groupe, celui où le panneau l'affiche : en cours, libres, bloqués. Lâcher un lot libre sur un lot en cours est refusé : le panneau n'y touche pas, le `⊘` rouge le signale pendant le glisser et il écrit « L411 est en cours : un lot libre se range parmi les libres ». Alt+↑ ou Alt+↓ vers un voisin d'un autre groupe donne le même refus. Un lot ne disparaît donc plus sous « + N lots » après un déplacement.
- Quand le déplacement est impossible, le panneau le dit sous son titre avec la raison, et rien ne bouge : une vague tient le dépôt, le plan est tenu par un autre outil (le panneau ne nomme pas cet outil : à chercher dans le projet), le lot est archivé, ou les deux lignes n'ont pas le même parent. Un `⊘` rouge prévient pendant le glisser quand l'arrivée sera refusée.
- Sur mobile et dans l'éditeur, le panneau reste en lecture seule.

## Hypothèses

- Alt+↑ / Alt+↓ est reçu comme la touche `meta` de Claude Code ; sur un terminal qui n'envoie pas Alt de cette façon, le glisser à la souris reste possible.
- Le panneau ne commite pas le plan : `raf move` ne le fait jamais et le fichier de plan peut porter d'autres changements non commités.
