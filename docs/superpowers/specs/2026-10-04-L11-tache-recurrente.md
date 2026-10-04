# L11 — tâche récurrente dans le plan

Cadrage (lead, 04-10) : indépendant de L4 — le nettoyage de L4 se fait à chaque clôture, pas comme tâche récurrente.

## Modèle
- `every: N` — périodicité en jours (entier > 0) : le lot est récurrent.
- `last: AAAA-MM-JJ` — dernier passage ; absent = jamais fait (référence : `created`, sinon `started`, sinon aujourd'hui).
- Un lot récurrent reste `todo` : il ne se termine pas. `raf done` / `raf drop` y mettent fin comme pour tout lot.

## Échéance
`échéance = référence + every` ; `retard = aujourd'hui − échéance`.
- retard > 0 : « dû depuis N j » ; retard = 0 : « dû aujourd'hui » ; retard < 0 : « prochain dans N j ».

## Commandes
- `raf add "titre" --every N` crée un lot récurrent.
- `raf did <id> ["texte"]` pose `last` à aujourd'hui (+ une note si texte) ; refuse un lot non récurrent ou une sous-tâche.
- `raf now` : section « Récurrent » ; ces lots sortent de « À suivre », du planning (gantt) et des propositions de session-start (dus d'abord listés dans « Récurrent »).
- `raf check` ne signale rien : un lot dû n'est pas un écart plan/historique.

## Plans en lecture seule
`every` et `last` sont des champs de la correspondance (cadence.yaml : plan.fields), lus s'ils sont valides.
