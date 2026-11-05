---
title: "Panneau des lots : les lots prêts, livrés et clos tiennent en trois lignes"
date: 2026-11-05
created: 2026-11-05T08:22+01:00
lots: [L592]
captures: []
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Dans le panneau des lots (`/hud lots`), les lots dont la vague a fini le travail ne prennent plus une ligne chacun. Sous les lots qui jouent et les lots libres, chaque projet affiche au plus trois lignes repliées : `prêts : K` (lots encore ouverts au plan, que la vague dit prêts), `livrés : N` (lots que le plan dit livrés) et `clos non livrés : M` (lots clos au plan sans livraison), dans cet ordre. Un clic, ou Entrée sur la ligne, la déplie : un lot par ligne, avec son id, son titre et `✔ prêt`, `✔ livré` ou `✔ clos` ; un second geste la replie. Quand la hauteur manque, ces trois lignes gardent leur place avant « … +N lots de plus ».

Les livrés et les clos ne comptent plus dans « N lots non clos » du projet ; les prêts y comptent, le plan les tient ouverts. Un lot prêt qui a des sous-lots reste une ligne de lot.

La colonne des identifiants est dimensionnée pour l'id le plus long affiché, lignes dépliées comprises, retrait compris : le titre est coupé par « … », jamais l'id.

## Hypothèses

- R5 — un lot clos au plan sans `delivered` est dit « ✔ clos » et replié dans « clos non livrés : M », pas dans « livrés » : si le plan doit tout dire livré, les deux lignes n'en feront qu'une.
- R9 — quand la hauteur manque, les lignes repliées sont gardées avant les lots coupés ; les lots d'une ligne dépliée sont coupés avec les autres et comptés dans « … +N lots de plus » : si la personne veut les garder visibles, elle agrandit le panneau.
- R10 — entre deux relectures du tableau (une minute au plus), un lot que le plan vient de clore reste dans « prêts » jusqu'à la relecture, puis passe dans « livrés » ou « clos non livrés ».
- R11 — un lot ouvert dont la vague dit « prêt » et qui n'a pas de sous-lot se replie dans « prêts : K » au lieu d'avoir sa ligne : si la personne veut le voir en ligne, il suffit de déplier « prêts ».
