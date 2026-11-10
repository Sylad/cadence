# Carte

## Banc séquence (v2/src/sequence/passage.ts) — L690, D-8

- Workflow : un clone par bras, gardé d'étape en étape ; session neuve par étape, sauf bras qui déclare `suite` dans `bras.yaml`
  (`gardee`, `compactee`, `seuil` à 150 k) : l'étape k reprend la dernière session de l'étape k-1 (`x.sessions`).
- Décision : pour un journal qui existait avant l'étape (session reprise), fuites et lecture des références ne lisent que les
  lignes horodatées depuis le début de l'étape (`lignesEtape(…, debut)`). Fichiers neufs : toutes leurs lignes.
- Décision : pas d'option `cadence run --suite` ; la clé `suite` n'existe qu'au banc (doc : docs/v2/banc.md, section Banc séquence).
