#!/usr/bin/env bash
# Banc rapide (plan n°5, 09-11) : N répétitions d'une séquence jouées EN PARALLÈLE, sans toucher au code du banc.
# Chaque répétition tourne dans sa propre racine de banc (BENCH_ROOT, donc son propre verrou), avec :
#   - un port d'application à elle : CADENCE_PORT pour les bras (ligne commune des briefs v2b/v2c), section Écran réécrite pour le juge ;
#   - un navigateur Playwright isolé (PLAYWRIGHT_MCP_ISOLATED) : deux sessions ne se disputent pas le même profil ;
#   - son propre espace de processus (unshare --pid) : un bras qui fait pkill ou killall ne voit et ne tue que les siens
#     (vécu le 09-11 : « pkill -f ng serve » d'un bras tuait les sessions des autres répétitions, code 143) ;
#   - les mêmes séquences et pièces (lien vers ~/bench-cadence/sequences).
# Les deux bras lisent la même consigne de port : la comparaison reste à armes égales.
# Usage : banc-parallele.sh <séquence> <candidat> <référence> <N> [port de départ, 4400]
# Puis : banc-parallele-bilan.py <dossier affiché à la fin>
set -euo pipefail
SEQ=$1 CAND=$2 REF=$3 N=$4 PORT0=${5:-4400}
BANC=$HOME/bench-cadence
LOT=$BANC/paralleles/$(date +%Y-%m-%d-%H%M)-$SEQ-$CAND-$REF
[ -d "$BANC/secrets/sequences/$SEQ" ] || { echo "séquence inconnue : $SEQ" >&2; exit 2; }
mkdir -p "$LOT"
pids=()
for i in $(seq 1 "$N"); do
  R=$LOT/w$i P=$((PORT0 + 10 * i))
  mkdir -p "$R/secrets/sequences"
  ln -s "$BANC/sequences" "$R/sequences"
  cp -r "$BANC/secrets/sequences/$SEQ" "$R/secrets/sequences/$SEQ"
  # Juge : le port écrit dans la section Écran devient celui de la répétition.
  sed -i -E "s/--port [0-9]+/--port $P/g; s/localhost:[0-9]+/localhost:$P/g" "$R/secrets/sequences/$SEQ/mesure.md"
  printf '\n\nCette évaluation tourne en même temps que d'"'"'autres : pour lancer une application, utilise le port %s (ng serve --port %s) et aucun autre ; arrête-la par son numéro de processus, jamais par son nom.\n' "$P" "$P" >> "$R/secrets/sequences/$SEQ/mesure.md"
  # Bras : briefs d'origine (le banc n'admet que les briefs versionnés) ; le port passe par CADENCE_PORT, lu par la même ligne des deux briefs.
  cp "$BANC/bras.yaml" "$R/bras.yaml"
  ( set +e; BENCH_ROOT=$R CADENCE_PORT=$P PLAYWRIGHT_MCP_ISOLATED=true \
      unshare --user --map-current-user --pid --fork --mount-proc cadence2 bench sequence "$SEQ" --candidat "$CAND" --reference "$REF" --repetitions 1 > "$R/journal.log" 2>&1
    echo "code=$?" >> "$R/journal.log" ) &
  pids+=($!)
  echo "répétition $i : racine $R, port $P, pid $!"
  sleep 20 # décale les installations et les premiers appels
done
echo "LOT=$LOT"
for p in "${pids[@]}"; do wait "$p" || true; done
echo "terminé : $LOT"
