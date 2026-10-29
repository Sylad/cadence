---
title: Le cycle complet de chaque lot en cours, en frise
date: 2026-10-29
created: 2026-10-29T20:23+01:00
lots: [L413]
captures: []
# une capture peut dire ce qu'elle montre : captures: [{ file: captures/x.png, alt: "texte alternatif" }]
nocapture: le panneau ne se dessine que dans Claude Code (app desktop ou terminal), aucune page à capturer
---
Dans le panneau des lots (`/hud lots`), chaque lot que porte une vague affiche sous son titre **une frise de son cycle** :

`✔ implement 10 min → ▶ revue 4 min → ○ correction 1/3 → ○ porte → ○ UX → ○ intégration → ○ prêt → ○ revue posée → ○ clos → ○ livré`

- Les étapes de la vague (fiche, maquette et accept seulement pour un lot qui les joue, puis implement, revue, correction, porte, UX, intégration, prêt) montrent ce qui est fait (`✔`), l'étape courante (`▶`, en gras), ce qui reste (`○`) ou ce qui a échoué (`✖`).
- Chaque étape donne sa durée ; la correction dit ses passes (`correction 1/3`), la revue dit combien de fois elle a été jouée (`revue ×2`), la porte dit si elle lance le build ou les tests.
- La frise se poursuit côté plan : **revue posée → clos → livré**. Un lot en cours au plan, sans vague, ne l'affiche qu'une fois sa revue posée.
- Si la frise est trop longue pour le panneau, les étapes faites se replient en `✔ 3`, puis les flèches se resserrent, avant que la fin ne soit coupée.

Elle se lit dans l'état de la vague et dans le plan, et se met à jour avec le panneau.
