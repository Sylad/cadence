---
title: Les lots en cours en tête de chaque projet dans le panneau
date: 2026-10-28
created: 2026-10-28T22:08+01:00
lots: [L410]
captures: []
nocapture: le panneau s'affiche dans le terminal de Claude Code, il n'y a pas de page à capturer
---
Dans le panneau des lots (`/hud lots`), chaque projet liste maintenant ses lots en cours en premier : un projet de plusieurs dizaines de lots ne cache plus ce qui avance sous les lots qui attendent.

- En tête, les lots en cours : ceux du plan en cours, et ceux qui sont dans une vague en implémentation, en revue, en correction, en question, prêts ou rendus.
- Ensuite les lots prêts (à faire, sans `after:` ouvert), puis le reste (les lots bloqués par un `after:` ouvert). Un lot d'une vague en attente, en échec ou suspendu suit le plan : libre, il est avec les prêts.
- Dans chaque groupe, l'ordre du plan est conservé.
- Un sous-lot reste sous son lot ; un lot dont un sous-lot est en cours remonte avec lui, et ce sous-lot passe avant ses frères.

