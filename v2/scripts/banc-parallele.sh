#!/usr/bin/env bash
# Banc rapide (plan n°5, 09-11) : N répétitions d'une séquence jouées EN PARALLÈLE, sans toucher au code du banc.
# Chaque répétition tourne dans sa propre racine de banc (BENCH_ROOT, donc son propre verrou), avec :
#   - un port d'application à elle (bras et juge), écrit dans les briefs des bras et dans la section Écran du juge ;
#   - un navigateur Playwright isolé (PLAYWRIGHT_MCP_ISOLATED) : deux sessions ne se disputent pas le même profil ;
#   - les mêmes séquences et pièces (lien vers ~/bench-cadence/sequences).
# Les deux bras reçoivent exactement la même ligne sur le port : la comparaison reste à armes égales.
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
  mkdir -p "$R/secrets/sequences" "$R/briefs"
  ln -s "$BANC/sequences" "$R/sequences"
  cp -r "$BANC/secrets/sequences/$SEQ" "$R/secrets/sequences/$SEQ"
  # Juge : le port écrit dans la section Écran devient celui de la répétition.
  sed -i -E "s/--port [0-9]+/--port $P/g; s/localhost:[0-9]+/localhost:$P/g" "$R/secrets/sequences/$SEQ/mesure.md"
  printf '\n\nCette évaluation tourne en même temps que d'"'"'autres : pour lancer une application, utilise le port %s (ng serve --port %s) et aucun autre.\n' "$P" "$P" >> "$R/secrets/sequences/$SEQ/mesure.md"
  # Bras : copie des briefs avec la même ligne de port, et bras.yaml qui pointe dessus.
  python3 - "$BANC/bras.yaml" "$R" "$P" "$CAND" "$REF" <<'EOF'
import sys, yaml, os
src, R, P, cand, ref = sys.argv[1:]
y = yaml.safe_load(open(src))
out = {}
for nom in (cand, ref):
    d = dict(y[nom]); b = open(d['brief']).read()
    b += f"\n- Plusieurs sessions tournent en même temps sur cette machine : si tu lances l'application, utilise le port {P} (ng serve --port {P}) et aucun autre.\n"
    dest = os.path.join(R, 'briefs', f'bras-{nom}.md'); open(dest, 'w').write(b); d['brief'] = dest
    out[nom] = d
yaml.safe_dump(out, open(os.path.join(R, 'bras.yaml'), 'w'), allow_unicode=True, sort_keys=False)
EOF
  ( BENCH_ROOT=$R PLAYWRIGHT_MCP_ISOLATED=true \
      cadence2 bench sequence "$SEQ" --candidat "$CAND" --reference "$REF" --repetitions 1 > "$R/journal.log" 2>&1
    echo "code=$?" >> "$R/journal.log" ) &
  pids+=($!)
  echo "répétition $i : racine $R, port $P, pid $!"
  sleep 20 # décale les installations et les premiers appels
done
echo "LOT=$LOT"
for p in "${pids[@]}"; do wait "$p" || true; done
echo "terminé : $LOT"
