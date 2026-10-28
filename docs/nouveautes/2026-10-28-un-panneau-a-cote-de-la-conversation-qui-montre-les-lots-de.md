---
title: Un panneau à côté de la conversation qui montre les lots de chaque projet
date: 2026-10-28
created: 2026-10-28T16:46+01:00
lots: [L401]
captures: []
nocapture: le panneau s'affiche dans le terminal de Claude Code, il n'y a pas de page à capturer
---
Un panneau des lots, en lecture seule, s'ouvre à côté de la conversation avec la commande `/hud lots` ; la même commande le referme.

- Pour chaque projet du dossier, dans l'ordre de `priority:`, il montre son nom, son nombre de lots non clos, puis l'arbre de ses lots : un sous-lot est rangé sous son lot, avec `├` ou `└`. Dans un plan cadence, les sous-tâches d'un lot (`L401/2`) sont ses sous-lots.
- Chaque lot dit son état en mots, avec un glyphe et une couleur : `▶ en cours`, `○ libre`, `⊘ bloqué`, ou, quand le lot est dans une vague, l'état de la vague (`⟳ relit`, `? QUESTION`, `✔ prêt`…), les mêmes mots que la bande. Les liens `after:` suivent le titre ; un lien vers un lot déjà clos est barré et ne bloque rien.
- Le panneau se met à jour quand une vague change d'étape, dès qu'un fichier de plan est modifié, et au plus toutes les minutes. Si une relecture échoue, le dernier tableau reste affiché.
- Un projet que `cadence` n'a pas pu lire montre son erreur (`illisible : …`) sans cacher les autres. Avec un `cadence` trop ancien, le panneau le dit au lieu d'afficher une liste vide.
- Le panneau ne s'ouvre jamais tout seul, et la commande l'ouvre quelle que soit la largeur de la fenêtre, Claude le plaçant ; s'il ne peut pas, elle répond `panneau des lots non placé : <raison>`. Un argument inconnu de `/hud` cite maintenant `lots` parmi ceux qui existent.

## Hypothèses

- R1 — l'état vide dit « Aucun lot non clos dans les projets de ce dossier. » ; si le texte est faux, seul le texte change.
- R2 — avant la première lecture, le panneau dit « Lecture des plans… » ; seul le texte change si c'est faux.
- R3 — sans réponse de `cadence`, le panneau affiche l'erreur et relit à la minute, sans bouton ; si c'est faux, seul le texte change, et sans relecture automatique il faudrait un bouton « Réessayer ».
- R7 — un projet illisible affiche « illisible : » suivi de l'erreur du tour, la ligne `cadence.yaml` du tour de même ; seul ce libellé change si c'est faux.
- R11 — un sous-lot dont le parent est clos, un cycle ou un doublon reste au premier niveau ; si ces cas devaient disparaître, être signalés ou se rattacher autrement, seule la construction de l'arbre change.
- R12 — les dates des plans sont lues toutes les 5 s par le mod tant que le panneau est ouvert ; si ce coût ou cet accès aux fichiers n'est pas acceptable, un changement de plan n'apparaît qu'à la relecture suivante, au plus une minute plus tard.
- R14 — avec un `cadence` trop ancien, le panneau le dit plutôt que d'afficher l'état vide ; seul le texte change, et le comportement s'inverse si le vide était préféré.
- R15 — sous 60 colonnes de corps, la liste `after:` passe sur sa propre ligne et le titre est tronqué ; seule la valeur 60 change si le seuil devait être autre.
- R16 — la commande s'appelle `/hud lots` et le panneau ne s'ouvre jamais seul ; si elle devait s'appeler autrement ou s'ouvrir seule, seuls le nom et le déclencheur changent.
- R17 — au-dessus du prompt, le panneau tient en un tiers de la hauteur et finit par « … +N lots de plus » ; s'il devait défiler ou plier des projets, seule la présentation change.
- R19 — la commande ouvre le panneau à toute largeur, Claude le plaçant ; s'il ne le place pas, elle répond « panneau des lots non placé : <raison> » et n'ouvre rien.
- R20 — une sous-tâche affiche « ▶ en cours » ou « ○ à faire », jamais « libre » ni l'état de vague de son lot ; seuls le mot et la couleur changent si c'est faux.
- R21 — le nombre de lots d'un projet ne compte pas les sous-tâches de plan natif ; si elles devaient compter, seul le calcul du compte change.
