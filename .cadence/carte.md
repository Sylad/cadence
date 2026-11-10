# Carte

## Banc séquence (v2/src/sequence/passage.ts) — L690, D-8

- Workflow : un clone par bras, gardé d'étape en étape ; session neuve par étape, sauf bras qui déclare `suite` dans `bras.yaml`
  (`gardee`, `compactee`, `seuil` à 150 k) : l'étape k reprend la dernière session de l'étape k-1 (`x.sessions`).
- Décision : pour un journal qui existait avant l'étape (session reprise), fuites et lecture des références ne lisent que les
  lignes horodatées depuis le début de l'étape (`lignesEtape(…, debut)`). Fichiers neufs : toutes leurs lignes.
- Décision : pas d'option `cadence run --suite` ; la clé `suite` n'existe qu'au banc (doc : docs/v2/banc.md, section Banc séquence).

## Dépôt tenu, plan en attente (src/repo-held.ts, src/cli/attente-commands.ts) — L695, D-9

- Workflow : un programme tient la branche par `<git-common-dir>/cadence/tenu/<kind>-<pid>.json` (cadence run : du début à la fin, écrit par
  v2/src/run/run.ts ; `verify --gate` joué dans l'arbre principal). Pre-commit de `raf hook install` : commit sur cette branche refusé (code 3) avec le geste.
- `raf add|note|done` sur la branche tenue : la ligne de commande va dans `.cadence/plan-en-attente.yaml` (info/exclude). cadence run, en rendant le dépôt
  (intégré ou non), lance `raf attente appliquer` ; sinon le premier add|note|done sur la branche libre l'applique d'abord. Le plan reste à commiter par le lead.
- Décision : porteur mort (pid absent ou repris) = fichier ignoré et retiré. Les vagues v1 (orchestrate) ne tiennent pas la branche par ce mécanisme :
  leur orchestrateur commite lui-même le plan sur la branche ; elles gardent L425, L475, L521.
