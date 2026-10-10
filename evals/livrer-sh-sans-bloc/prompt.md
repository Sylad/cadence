---
name: livrer-sh-sans-bloc
description: Piège relevé à la main — un projet a un ./livrer.sh mais cadence.yaml sans bloc deliver ; cadence deliver ne doit pas être donné comme fonctionnel avant d'avoir déclaré le script.
tags: [cadence, deliver, piege]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
runs: 3
---

Mon projet a un script `./livrer.sh` qui attend la CI, déploie et vérifie, mais son `cadence.yaml` n'a aucune clé `deliver:`. Si je lance `cadence deliver`, qu'est-ce qui se passe, et que dois-je écrire dans `cadence.yaml` pour que cadence utilise mon script en gardant ses garde-fous (arbre propre, verrou, lots livrés) ? Réponds en quelques lignes, sans rien exécuter.
