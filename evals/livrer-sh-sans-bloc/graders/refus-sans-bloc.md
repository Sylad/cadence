---
type: llm
---
La réponse dit que sans bloc `deliver:` cadence ne devine pas `./livrer.sh` : la commande échoue (la clé `deliver` est absente) au lieu de lancer le script. Elle propose le bloc `deliver:` avec `script: ./livrer.sh "$CADENCE_SHORT"` (les arguments après `--` partent au script, `allowDirty` optionnel), et précise que cadence garde les préconditions, le verrou, le journal et la liste des lots livrés pendant que le script garde l'attente de la CI et le déploiement. Elle ne prétend pas que `cadence deliver` exécuterait `./livrer.sh` tout seul.
