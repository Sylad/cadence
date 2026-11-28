#!/usr/bin/env bash
# Partie WSL de banc-mini-blue.sh (L901) ; copiée dans le dossier de chaque banc lancé, c'est cette copie qui tourne.
#   banc-mini-blue-distant.sh lance <dossier-job>   copie figée de cadence, référentiel et sources, puis le banc ; écrit retour.tar.gz et fin.txt
#   banc-mini-blue-distant.sh etat <dossier-job>    deux lignes : etat=en cours|fini rc=…|interrompu|jamais lancé, puis derniere=…
# Tout vit sous $BASE (défaut ~/banc-mini-blue) : cadence/ (la copie), racine/ (BENCH_ROOT du banc), sources/ (miroirs des sources).
set -uo pipefail
export PATH=$HOME/.local/bin:$PATH
for d in "$HOME"/.local/share/node/*/bin; do [ -d "$d" ] && PATH=$d:$PATH; done

vivant() { local p; p=$(cat "$1/pid" 2>/dev/null) || return 1; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

# remplace chaque occurrence littérale de $2 par $3 dans le fichier $1 (aucun caractère spécial interprété)
remplacer() {
  awk -v o="$2" -v n="$3" '{ s = $0; r = ""; while ((i = index(s, o)) > 0) { r = r substr(s, 1, i - 1) n; s = substr(s, i + length(o)) } print r s }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}
# chaque occurrence du chemin $2 devient $3 dans le fichier $1 : la ligne « source: » comme les commandes qui le citent
# (install: git -C <source> show …, L941 ; git -C sur le miroir nu accepte show). Un chemin dont $2 n'est qu'un préfixe
# (…/ol-companion-x pour …/ol-companion) ou un suffixe (/x…/ol-companion) reste tel quel ; « $2/sous-dossier » est réécrit.
resourcer() {
  awk -v o="$2" -v n="$3" '{
    s = $0; r = ""
    while ((i = index(s, o)) > 0) {
      p = i > 1 ? substr(s, i - 1, 1) : substr(r, length(r), 1)
      q = substr(s, i + length(o), 1)
      if (p !~ /[A-Za-z0-9._\/~-]/ && q !~ /[A-Za-z0-9._~-]/) r = r substr(s, 1, i - 1) n
      else r = r substr(s, 1, i - 1 + length(o))
      s = substr(s, i + length(o))
    }
    print r s
  }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

lance() {
  local JOB=$1 rc
  exec >"$JOB/distant.log" 2>&1 </dev/null
  echo $$ > "$JOB/pid"
  rm -f "$JOB/fin.txt" "$JOB/retour.tar.gz" "$JOB/run.log"
  # shellcheck disable=SC1091
  . "$JOB/args.sh"
  BASE=${BASE:-$HOME/banc-mini-blue}
  local C=$BASE/cadence R=$BASE/racine
  fin() { printf 'rc=%s\nfin=%s\n%s\n' "$1" "$(date '+%F %T')" "$2" > "$JOB/fin.txt"; rm -f "$JOB/pid"; exit 0; }
  local manque=() o
  for o in git node npm tar awk; do command -v "$o" >/dev/null || manque+=("$o"); done
  [ -n "$COMMANDE" ] || command -v claude >/dev/null || manque+=(claude)
  [ ${#manque[@]} -eq 0 ] || fin 93 "prérequis absents sur mini-blue : ${manque[*]}"
  mkdir -p "$BASE/sources" "$R"

  # 1. copie figée de cadence : le commit envoyé, rien d'autre (arbre propre, v2/dist reconstruit)
  [ -d "$C/.git" ] || git init -q "$C" || fin 90 "git init $C"
  git -C "$C" fetch -q "$JOB/aller.bundle" HEAD || fin 91 "fetch du bundle de cadence impossible"
  git -C "$C" checkout -q --force --detach "$SHA" && git -C "$C" clean -ffdxq -e node_modules || fin 91 "checkout de $SHA impossible"
  [ "$(git -C "$C" rev-parse HEAD)" = "$SHA" ] || fin 91 "copie de cadence à $(git -C "$C" rev-parse HEAD), attendu $SHA"
  if [ "$SANS_CONSTRUCTION" != 1 ]; then
    # v2 importe des scripts/*.mjs de la racine (fumée du 27-11 : « Cannot find package 'yaml' ») : dépendances de production de la racine, toutes celles de v2
    local emp; emp=$(cat "$C/package-lock.json" "$C/v2/package-lock.json" 2>/dev/null | sha256sum | cut -c1-16)
    if [ "$(cat "$C/.git/banc-deps" 2>/dev/null)" != "$emp" ]; then
      echo "banc-mini-blue : npm ci (racine, production) et npm ci dans v2"
      npm ci --prefix "$C" --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error || fin 94 "npm ci racine"
      npm ci --prefix "$C/v2" --no-audit --no-fund --loglevel=error || fin 94 "npm ci v2"
      echo "$emp" > "$C/.git/banc-deps"
    fi
    npm run --prefix "$C/v2" build --silent || fin 94 "build de v2"
  fi

  # 2. référentiel du banc, rafraîchi depuis Big-Blue (la source de vérité) ; les chemins de Big-Blue deviennent ceux d'ici
  rm -rf "$R/bancs" "$R/sequences" "$R/secrets" "$R/bras.yaml" "$R/historique.jsonl"
  tar -xzf "$JOB/referentiel.tar.gz" -C "$R" || fin 92 "référentiel illisible"
  local y f nom
  for f in "$JOB"/sources/*.chemin; do
    [ -f "$f" ] || continue
    o=$(cat "$f"); nom=$(printf '%s' "$o" | sha1sum | cut -c1-12)
    if [ -d "$BASE/sources/$nom" ]; then git -C "$BASE/sources/$nom" fetch -q --prune "${f%.chemin}.bundle" '+refs/*:refs/*' || fin 92 "source $o"
    else git clone -q --mirror "${f%.chemin}.bundle" "$BASE/sources/$nom" || fin 92 "source $o"; fi
    for y in "$R"/bancs/*/banc.yaml "$R"/sequences/*/sequence.yaml; do [ -f "$y" ] && resourcer "$y" "$o" "$BASE/sources/$nom"; done
  done
  for y in "$R"/bancs/*/banc.yaml "$R"/sequences/*/sequence.yaml "$R/bras.yaml"; do
    [ -f "$y" ] || continue; remplacer "$y" "$DEPOT_BB" "$C"; remplacer "$y" "$RACINE_BB" "$R"
  done
  # briefs et réglages des bras : ceux de la copie, quel que soit le dépôt de cadence que nommait bras.yaml (absolu ou relatif à la racine)
  [ -f "$R/bras.yaml" ] && sed -E -i "s#[^[:space:]\"']*/v2/(briefs|hooks)/#$(printf '%s' "$C" | sed 's/[#&\\]/\\&/g')/v2/\1/#g" "$R/bras.yaml"

  # 3. le banc ; tout ce qu'il écrit après ce repère revient à Big-Blue
  touch "$JOB/debut"; sleep 1
  echo "banc-mini-blue : cadence ${SHA:0:8} (empreinte $EMPREINTE) / node $(node --version) / $(claude --version 2>/dev/null || echo 'claude absent')"
  if [ -n "$COMMANDE" ]; then (cd "$C" && BENCH_ROOT=$R bash -c "$COMMANDE") 2>&1 | tee "$JOB/run.log"; rc=${PIPESTATUS[0]}
  else (cd "$C" && BENCH_ROOT=$R node v2/bin/cadence2.js bench "${BENCH_ARGS[@]}") 2>&1 | tee "$JOB/run.log"; rc=${PIPESTATUS[0]}; fi

  # 4. retour : rapports et passages nés pendant le banc, lignes d'historique ajoutées, trace du banc complet
  local T; T=$(mktemp -d)
  mkdir -p "$T/rapports" "$T/runs"
  (cd "$R" && [ -d rapports ] && find rapports -maxdepth 1 -type f -newer "$JOB/debut" -exec cp {} "$T/rapports/" \;)
  (cd "$R" && [ -d runs ] && find runs -mindepth 1 -maxdepth 1 -type d -newer "$JOB/debut" -print0 \
    | tar -cf - --null --exclude=node_modules --exclude=.git -T - | tar -xf - -C "$T")
  [ -f "$R/historique.jsonl" ] && tail -n +"$((HISTORIQUE_LIGNES + 1))" "$R/historique.jsonl" > "$T/historique-nouveau.jsonl"
  [ -f "$R/complet-refus.txt" ] && cp "$R/complet-refus.txt" "$T/"
  cp "$JOB/run.log" "$T/"
  printf 'rc=%s\n' "$rc" > "$T/fin.txt"
  tar -czf "$JOB/retour.tar.gz" -C "$T" . && rm -rf "$T"
  fin "$rc" "derniere=$(grep -v '^[[:space:]]*$' "$JOB/run.log" | tail -1)"
}

etat() {
  local JOB=$1 derniere
  if vivant "$JOB"; then echo "etat=en cours (pid $(cat "$JOB/pid"))"
  elif [ -f "$JOB/fin.txt" ]; then echo "etat=fini $(sed -n 1p "$JOB/fin.txt") $(sed -n 2p "$JOB/fin.txt")"
  elif [ -f "$JOB/pid" ]; then echo "etat=interrompu (processus mort sans fin.txt)"
  else echo "etat=jamais lancé"; fi
  derniere=$(grep -v '^[[:space:]]*$' "$JOB/run.log" 2>/dev/null | tail -1)
  [ -n "$derniere" ] || derniere=$(sed -n 3p "$JOB/fin.txt" 2>/dev/null)   # arrêté avant le banc : la cause écrite par fin()
  [ -n "$derniere" ] || derniere=$(tail -1 "$JOB/distant.log" 2>/dev/null)
  echo "derniere=$derniere"
}

case ${1:-} in
  lance) lance "$2" ;;
  etat) etat "$2" ;;
  *) sed -n '2,4p' "$0"; exit 2 ;;
esac
