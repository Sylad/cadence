---
type: llm
---
La réponse garde le « / » dans l'id passé en argument (`maritime-atlas:Q4/accueil-4-ux12@haiku`, le premier `:` séparant projet et lot, le `@` final le modèle) et dit que dans `.cadence/runs/<vague>/` le « / » devient `__` (fichier `maritime-atlas--Q4__accueil-4-ux12.json`). Elle indique la reprise avec `cadence orchestrate --resume` (éventuellement avec l'id de la vague). Elle n'échappe pas le « / » et ne remplace pas l'id par un autre.
