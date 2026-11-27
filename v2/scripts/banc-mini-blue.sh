#!/usr/bin/env bash
# Banc de cadence DÉTACHÉ sur mini-blue (L901, D-39 et D-40) : le banc tourne là-bas sur une copie figée de cadence, Big-Blue garde ses
# créneaux et le dépôt de cadence n'est plus tenu pendant un banc (vécu du 26-11 : banc court de 2 h sous la charge de Big-Blue, contre
# 28 min au calme). Modèle : ~/projects/developpeur/scripts/mini-blue-run.sh et mini-blue-recup.sh. Doc : docs/v2/banc.md, « Banc sur mini-blue ».
#
#   banc-mini-blue.sh lance [--depot d] [--commande "<cmd>"] [--sans-construction] [--] <arguments de cadence2 bench…>
#       ex. lance court · lance complet · lance mecanique · lance sequence aether-b68 --repetitions 2 --candidat cadence-run --reference A
#       rend la main tout de suite ; --commande : fumée sans modèle (<cmd> au lieu du banc, BENCH_ROOT posé) ;
#       --sans-construction : ni npm ci ni build de v2 là-bas (tests)
#   banc-mini-blue.sh etat               une ligne par banc lancé : en cours, fini rc=…, interrompu, injoignable ; sa dernière ligne
#   banc-mini-blue.sh recup              ramène chaque banc fini dans la racine locale (rapports/, runs/, historique.jsonl à sa date)
#   banc-mini-blue.sh attendre [<job>]   attend la fin des bancs en cours (sondage chaque minute), puis recup ; à lancer en arrière-plan
# Codes : 3 un banc tourne déjà ; 5 mini-blue injoignable, état d'un banc inconnu (lance refuse, recup le dit) ; 6 attendre : mini-blue
# injoignable à BANC_MB_ESSAIS sondages de suite (défaut 15). Injoignable n'est jamais pris pour fini.
#
# Copie figée : le commit HEAD du dépôt (git bundle), jamais l'arbre de travail ; l'empreinte de v2/ est celle de ce commit, et le dépôt
# peut changer dès que `lance` a rendu la main. Ce qui voyage : ce commit, le référentiel du banc (bancs/, sequences/, secrets/ — les tests
# cachés —, bras.yaml, historique.jsonl, rapports/*.json) et un bundle git de chaque `source:` des bancs et séquences, toutes ses refs sauf
# refs/stash (un `git stash -u` y garde les fichiers non suivis, .env compris : revue L901). Aucun identifiant :
# ni ~/.claude, ni ~/.ssh, ni .env ; mini-blue a sa propre session Claude Code. Repli : le banc local, inchangé (cadence2 bench …).
set -euo pipefail

HOTE=${MINI_BLUE_HOTE:-sylva@192.168.1.26}
DISTRO=${MINI_BLUE_DISTRO:-Ubuntu-24.04}
TRANSPORT=${BANC_MB_TRANSPORT:-ssh}   # ssh (mini-blue) ou local (tests : même machine, sans ssh)
ICI=$(cd "$(dirname "$0")" && pwd)
RACINE=${BENCH_ROOT:-$HOME/bench-cadence}
JOBS=${BANC_MB_JOBS:-${XDG_CACHE_HOME:-$HOME/.cache}/cadence/banc-mini-blue}
PAS=${BANC_MB_PAS:-60}
ESSAIS=${BANC_MB_ESSAIS:-15}
if [ "$TRANSPORT" = local ]; then
  ECH_SCP=${BANC_MB_ECHANGE:?BANC_MB_ECHANGE : dossier d échange du transport local}; ECH_WSL=$ECH_SCP
else
  ECH_SCP=mini-blue-banc   # relatif au profil Windows de l'utilisateur ssh, côté scp
  # le même dossier vu du WSL : C:\Users\<utilisateur de MINI_BLUE_HOTE>, ou MINI_BLUE_ECHANGE_WSL si le profil Windows porte un autre nom
  if [[ $HOTE == *@* ]]; then UTIL_WIN=${HOTE%%@*}; else UTIL_WIN=$USER; fi
  ECH_WSL=${MINI_BLUE_ECHANGE_WSL:-/mnt/c/Users/$UTIL_WIN/mini-blue-banc}
fi

usage() { sed -n '5,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# --- transport : ssh + scp vers le WSL de mini-blue, ou la même machine (tests) ---
distant() { # distant <script> <args…> : bash <script> <args…> là-bas (aucun espace dans les arguments : ils traversent cmd.exe)
  if [ "$TRANSPORT" = local ]; then bash "$@"; else ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HOTE" "wsl -d $DISTRO -- bash $*" | tr -d '\r'; fi
}
envoyer() { # envoyer <dossier local> <job>
  if [ "$TRANSPORT" = local ]; then mkdir -p "$ECH_WSL/$2"; cp -r "$1/." "$ECH_WSL/$2/"
  else
    ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HOTE" "wsl -d $DISTRO -- mkdir -p $ECH_WSL/$2"
    scp -q -r -o BatchMode=yes "$1/." "$HOTE:$ECH_SCP/$2/"
  fi
}
recevoir() { # recevoir <job> <fichier> <cible locale>
  if [ "$TRANSPORT" = local ]; then cp "$ECH_WSL/$1/$2" "$3"; else scp -q -o BatchMode=yes "$HOTE:$ECH_SCP/$1/$2" "$3"; fi
}
detacher() { # le banc vit sans la session qui l'a lancé
  local s="$ECH_WSL/$1/banc-mini-blue-distant.sh" j="$ECH_WSL/$1"
  if [ "$TRANSPORT" = local ]; then setsid nohup bash "$s" lance "$j" </dev/null >/dev/null 2>&1 &
  else # Win32_Process.Create sort wsl.exe de l'objet job de la session ssh (mini-blue-lance.ps1)
    scp -q -o BatchMode=yes "$ICI/banc-mini-blue-lance.ps1" "$HOTE:$ECH_SCP/$1/"
    ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$HOTE" "powershell -NoProfile -ExecutionPolicy Bypass -File $ECH_SCP\\$1\\banc-mini-blue-lance.ps1 $DISTRO $s $j" | tr -d '\r'
  fi
}

# empreinte de v2 au commit donné : même calcul que empreinte() de v2/src/bench/cli.ts (arbres v2/src, v2/briefs, puis ls-tree v2/hooks)
empreinte() {
  local d=$1 c=$2 a b h
  a=$(git -C "$d" rev-parse "$c:v2/src") b=$(git -C "$d" rev-parse "$c:v2/briefs") h=$(git -C "$d" ls-tree "$c" v2/hooks)
  if [ -n "$h" ]; then printf '%s\n%s\n%s' "$a" "$b" "$h"; else printf '%s\n%s' "$a" "$b"; fi | sha1sum | cut -c1-12
}

referentiel() { # chemins relatifs à la racine du banc
  local f
  for f in bancs sequences secrets bras.yaml historique.jsonl; do if [ -e "$RACINE/$f" ]; then echo "$f"; fi; done
  if [ -d "$RACINE/rapports" ]; then (cd "$RACINE" && find rapports -maxdepth 1 -name '*.json'); fi
}

etat_job() { distant "$ECH_WSL/$1/banc-mini-blue-distant.sh" etat "$ECH_WSL/$1"; } # etat=… puis derniere=… ; échec = mini-blue injoignable
# en_cours <job> : 0 en cours, 1 pas en cours (fini, interrompu, jamais lancé), 2 injoignable (état inconnu : jamais « fini », revue L901)
en_cours() { local e; e=$(etat_job "$1" 2>/dev/null) || return 2; [ -n "$e" ] || return 2; [[ $e == "etat=en cours"* ]]; } # jamais « | grep -q » : sous pipefail, son SIGPIPE rend faux

lance() {
  local DEPOT COMMANDE= SANS=0
  DEPOT=$(cd "$ICI/../.." && pwd)
  while [ $# -gt 0 ]; do
    case $1 in
      --depot) DEPOT=$(cd "$2" && pwd); shift 2 ;;
      --commande) COMMANDE=$2; shift 2 ;;
      --sans-construction) SANS=1; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  [ $# -gt 0 ] || [ -n "$COMMANDE" ] || usage
  [ -f "$RACINE/bras.yaml" ] || { echo "banc-mini-blue : $RACINE/bras.yaml absent (racine du banc : BENCH_ROOT)" >&2; exit 2; }
  local j c
  for j in $(ls "$JOBS" 2>/dev/null); do
    [ ! -f "$JOBS/$j/recupere" ] || continue
    c=0; en_cours "$j" || c=$?
    if [ "$c" = 0 ]; then echo "banc-mini-blue : un banc tourne déjà sur mini-blue ($j) : banc-mini-blue.sh etat" >&2; exit 3; fi
    # injoignable : un second banc réinitialiserait la copie sous celui qui tourne peut-être encore
    if [ "$c" = 2 ]; then echo "banc-mini-blue : mini-blue injoignable, état de $j inconnu : rien lancé (banc-mini-blue.sh etat)" >&2; exit 5; fi
  done
  local SHA EMP JOB L
  SHA=$(git -C "$DEPOT" rev-parse HEAD); EMP=$(empreinte "$DEPOT" "$SHA")
  JOB=$(date +%Y%m%d-%H%M%S)-$EMP-$(printf '%s' "${1:-commande}" | tr -c 'a-zA-Z0-9-' '_')
  L=$JOBS/$JOB; mkdir -p "$L/envoi/sources"
  git -C "$DEPOT" bundle create -q "$L/envoi/aller.bundle" HEAD
  # référentiel du banc : ce qu'un passage lit dans sa racine (bancs, séquences, tests cachés, bras, historique et rapports JSON pour le bruit et l'environnement)
  referentiel | tar -czf "$L/envoi/referentiel.tar.gz" -C "$RACINE" --exclude=node_modules --exclude=.git -T -
  # sources des bancs et séquences : un bundle git de chacune (tout l'historique commité, rien d'ignoré par git)
  local n=0 s
  while read -r s; do
    [ -n "$s" ] || continue
    if ! git -C "$s" rev-parse --git-dir >/dev/null 2>&1; then echo "banc-mini-blue : source $s absente ou hors git, ses bancs échoueront là-bas" >&2; continue; fi
    n=$((n + 1)); git -C "$s" bundle create -q "$L/envoi/sources/$n.bundle" --exclude=refs/stash --all; printf '%s' "$s" > "$L/envoi/sources/$n.chemin"
  done < <(cat "$RACINE"/bancs/*/banc.yaml "$RACINE"/sequences/*/sequence.yaml 2>/dev/null | sed -n 's/^source:[[:space:]]*//p' | sed "s/^[\"']//; s/[\"'][[:space:]]*\$//; s/[[:space:]]*\$//" | sort -u)
  q() { printf '%s=%q\n' "$1" "$2"; }
  {
    q NOM_JOB "$JOB"; q SHA "$SHA"; q EMPREINTE "$EMP"; q DEPOT_BB "$DEPOT"; q RACINE_BB "$RACINE"; q COMMANDE "$COMMANDE"; q SANS_CONSTRUCTION "$SANS"
    q HISTORIQUE_LIGNES "$( [ -f "$RACINE/historique.jsonl" ] && wc -l < "$RACINE/historique.jsonl" || echo 0)"
    [ -z "${BANC_MB_BASE:-}" ] || q BASE "$BANC_MB_BASE"
    printf 'BENCH_ARGS=('; for a in "$@"; do printf '%q ' "$a"; done; printf ')\n'
  } > "$L/envoi/args.sh"
  cp "$ICI/banc-mini-blue-distant.sh" "$L/envoi/"
  cp "$L/envoi/args.sh" "$L/args.sh"
  envoyer "$L/envoi" "$JOB"
  rm -rf "$L/envoi"   # bundles envoyés : rien à garder ici
  detacher "$JOB" >/dev/null
  local k e
  for k in $(seq 1 30); do # le banc a démarré là-bas (pid écrit) avant de rendre la main : attendre ne le prend jamais pour fini
    e=$(etat_job "$JOB" 2>/dev/null | sed -n 1p) || true
    [ -z "$e" ] || [ "$e" = "etat=jamais lancé" ] || break
    sleep 1
  done
  [ -n "$e" ] && [ "$e" != "etat=jamais lancé" ] || { echo "banc-mini-blue : $JOB envoyé mais pas démarré sur mini-blue après 30 s : banc-mini-blue.sh etat" >&2; exit 1; }
  echo "banc-mini-blue : $JOB lancé sur mini-blue (cadence ${SHA:0:8}, empreinte $EMP, $n source(s)) : ${COMMANDE:-cadence2 bench $*}"
  echo "banc-mini-blue : le dépôt est libre ; suivi : banc-mini-blue.sh etat · fin et rapports : banc-mini-blue.sh attendre (en arrière-plan)"
}

etat() {
  local j e
  [ -n "$(ls "$JOBS" 2>/dev/null)" ] || { echo "aucun banc lancé sur mini-blue"; return 0; }
  for j in $(ls "$JOBS"); do
    if [ -f "$JOBS/$j/recupere" ]; then # déjà ramené : l'état local suffit, sans aller-retour
      echo "JOB $j etat=fini $(sed -n 1p "$JOBS/$j/recupere") recupere=oui"
      echo "    $(sed -n 's/^rapport=//p' "$JOBS/$j/recupere" | head -1)"; continue
    fi
    e=$(etat_job "$j" 2>/dev/null || echo "etat=injoignable")
    echo "JOB $j $(sed -n 1p <<<"$e") recupere=non"
    echo "    $(sed -n 2p <<<"$e")"
  done
}

# inserer_historique <historique local> <lignes venues de mini-blue> : chaque ligne absente est insérée à sa date, pas en fin de fichier.
# La garde de publication (verdict.ts, gardeEnQuatreRegles) lit l'ordre du fichier : un mécanique vert de 10 h 30 rapatrié à 15 h après un
# éclair rouge local de 12 h passerait pour le plus récent (revue L901). Ordre stable : à date égale ou sans date, la ligne reste après.
# Écrit le fichier d'un bloc (fichier temporaire puis mv) et affiche le nombre de lignes ajoutées.
inserer_historique() {
  node -e '
    const fs = require("fs"); const [, h, nv] = process.argv;
    const lignes = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "") : []);
    const date = (l) => { try { const t = Date.parse(JSON.parse(l).date); return Number.isNaN(t) ? null : t; } catch { return null; } };
    const tout = lignes(h); const vus = new Set(tout); let n = 0;
    for (const l of lignes(nv)) {
      if (vus.has(l)) continue; vus.add(l); n++;
      const d = date(l); let i = tout.length;
      if (d !== null) while (i > 0) { const p = date(tout[i - 1]); if (p === null || p <= d) break; i--; }
      tout.splice(i, 0, l);
    }
    if (n > 0) { fs.writeFileSync(h + ".tmp", tout.map((l) => l + "\n").join("")); fs.renameSync(h + ".tmp", h); }
    process.stdout.write(String(n));
  ' "$1" "$2"
}

# ramène un banc fini : rapports et runs sans rien écraser, lignes d'historique absentes ajoutées, trace du banc complet
recup_job() { # recup_job <job> <ligne etat=fini …> <ligne derniere=…>
  local j=$1 T rc f n=0 complet=0
  ( . "$JOBS/$j/args.sh"; [ -z "$COMMANDE" ] && [ "${BENCH_ARGS[0]:-}" = complet ] ) && complet=1
  T=$(mktemp -d)
  if ! recevoir "$j" retour.tar.gz "$T/retour.tar.gz" 2>/dev/null; then # arrêté avant le banc (prérequis, copie, référentiel) : rien à ramener
    rc=$(sed -n 's/^etat=fini rc=\([0-9]*\).*/\1/p' <<<"$2")
    printf 'rc=%s\nhistorique=0\n' "$rc" > "$JOBS/$j/recupere"
    # un banc complet qui n'a pas mesuré laisse sa trace (L804), au format de noterRefus : date ISO, puis la cause
    [ "$complet" = 0 ] || printf '%s\nbanc complet sur mini-blue (%s) arrêté avant de mesurer, rc=%s : %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$j" "$rc" "${3#derniere=}" > "$RACINE/complet-refus.txt"
    echo "== $j : fini rc=$rc avant le banc, rien à ramener : ${3#derniere=}"; rm -rf "$T"; return 0
  fi
  mkdir -p "$T/x" "$RACINE/rapports" "$RACINE/runs"; tar -xzf "$T/retour.tar.gz" -C "$T/x"
  [ -d "$T/x/rapports" ] && cp -r --update=none "$T/x/rapports/." "$RACINE/rapports/"
  [ -d "$T/x/runs" ] && cp -r --update=none "$T/x/runs/." "$RACINE/runs/"
  [ -s "$T/x/historique-nouveau.jsonl" ] && n=$(inserer_historique "$RACINE/historique.jsonl" "$T/x/historique-nouveau.jsonl")
  # un banc complet là-bas dit l'état de la trace de refus (L804) : posée s'il n'a pas mesuré, retirée s'il a mesuré
  [ "$complet" = 0 ] || {
    if [ -f "$T/x/complet-refus.txt" ]; then cp "$T/x/complet-refus.txt" "$RACINE/"; else rm -f "$RACINE/complet-refus.txt"; fi; }
  rc=$(sed -n 's/^rc=//p' "$T/x/fin.txt" 2>/dev/null)
  { echo "rc=$rc"; echo "historique=$n"; for f in $(cd "$T/x" && find rapports -type f -name '*.md' 2>/dev/null | sort); do echo "rapport=$RACINE/$f"; done; } > "$JOBS/$j/recupere"
  echo "== $j : fini rc=$rc ; $n ligne(s) d'historique ajoutée(s) ; rapports :"
  sed -n 's/^rapport=/   /p' "$JOBS/$j/recupere"
  grep -v '^[[:space:]]*$' "$T/x/run.log" 2>/dev/null | tail -3 | sed 's/^/   | /' || true
  rm -rf "$T"
}

recup() {
  local j e vus=0 inj=0
  for j in $(ls "$JOBS" 2>/dev/null); do
    [ -f "$JOBS/$j/recupere" ] && continue
    if ! e=$(etat_job "$j" 2>/dev/null) || [ -z "$e" ]; then
      echo "banc-mini-blue : mini-blue injoignable, état de $j inconnu : rien ramené" >&2; inj=$((inj + 1)); continue
    fi
    case $e in "etat=fini "*) recup_job "$j" "$(sed -n 1p <<<"$e")" "$(sed -n 2p <<<"$e")"; vus=$((vus + 1)) ;; esac
  done
  [ "$vus" -gt 0 ] || [ "$inj" -gt 0 ] || echo "banc-mini-blue : aucun banc fini à ramener"
  [ "$inj" = 0 ] || exit 5
}

attendre() {
  local filtre=${1:-} j encore c rates=0 inj
  while :; do
    encore=0; inj=
    for j in $(ls "$JOBS" 2>/dev/null); do
      [ -z "$filtre" ] || [ "$j" = "$filtre" ] || continue
      [ ! -f "$JOBS/$j/recupere" ] || continue
      c=0; en_cours "$j" || c=$?
      case $c in 0) encore=1 ;; 2) encore=1; inj="$inj $j" ;; esac
    done
    # injoignable : état inconnu, on réessaie ; jamais pris pour fini (revue L901 : coupure Wi-Fi, mise en veille de mini-blue)
    if [ -n "$inj" ]; then
      rates=$((rates + 1))
      echo "banc-mini-blue : mini-blue injoignable ($rates/$ESSAIS) pour$inj" >&2
      if [ "$rates" -ge "$ESSAIS" ]; then echo "banc-mini-blue : mini-blue injoignable $ESSAIS fois de suite, rien ramené : relancer banc-mini-blue.sh attendre" >&2; exit 6; fi
    else rates=0; fi
    [ "$encore" = 1 ] || break
    sleep "$PAS"
  done
  recup
}

case ${1:-} in
  lance) shift; lance "$@" ;;
  etat) etat ;;
  recup) recup ;;
  attendre) shift; attendre "${1:-}" ;;
  *) usage ;;
esac
