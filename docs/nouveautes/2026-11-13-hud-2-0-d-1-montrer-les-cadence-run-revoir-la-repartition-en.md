---
title: "HUD : les cadence run en cours dans la barre du bas et le panneau des lots, sans doublon"
date: 2026-11-13
created: 2026-11-13T08:40+01:00
lots: [L687]
captures:
  - { file: captures/l687-panneau-ouvert.png, alt: "Panneau des lots ouvert : la barre du bas montre deux lignes « ▶ run cadence:L687 en cours opus 9 min » et « ▶ run cadence:L707 en cours », puis « runs cadence run : 2 · créneaux libres : 1 sur 3 » ; dans le panneau, L687 et L707 lisent « run » au lieu de « libre »" }
  - { file: captures/l687-panneau-ferme.png, alt: "Panneau des lots fermé : la barre du bas garde les deux lignes de run, puis retrouve l'avancement de chaque projet et la ligne du banc" }
---
Chaque `cadence run` a maintenant sa ligne dans la barre du bas : le dépôt et le lot (`▶ run cadence:L687`), son état (en cours, en attente du quota avec l'heure de reprise, intégré, en attente d'un geste…), le modèle et la durée, le coût, puis la demande. Les runs vivants viennent d'abord, puis ceux intégrés depuis moins de 30 minutes et ceux qui attendent un geste depuis moins de 12 heures. La ligne des créneaux les compte sans les nommer (`runs cadence run : 2 · créneaux libres : 1 sur 3`).

Dans le panneau des lots (`/hud lots`), un lot qu'un run vivant est en train de jouer lit « ⟳ run » (« ⏸ run en quota » quand il attend le quota), au lieu de « ◌ en sommeil ».

Panneau ouvert, la barre du bas ne répète plus ce que le panneau montre : l'avancement des projets et les lignes du banc la quittent, et reviennent quand on ferme le panneau. Elle garde le contexte, les quotas, les vagues, les runs et les créneaux.

Après avoir fait glisser un lot dans le panneau, « à commiter » n'est plus dit quand le fichier déplacé n'est pas dans un dépôt git : le dossier parent des projets lit « dossier hors dépôt git : rien à commiter ».
