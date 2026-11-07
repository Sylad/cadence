#!/usr/bin/env bash
# Migre les 8 bancs de l'essai du 07-11 vers ~/bench-cadence (BENCH_ROOT). Idempotent ; ne touche pas aux sources.
set -euo pipefail
E=$HOME/projects/developpeur/tmp/essai; C=$HOME/.essai-cache-0711; P=$HOME/projects/developpeur
R=${BENCH_ROOT:-$HOME/bench-cadence}
OLT='(cd backend && npm test) && (cd frontend && npm test)'
# Installs rejouables, d'après _install-A.log et tmp/essai/_outils (finance-fix.sh, fix-678.sh, fix-67-lock.sh) :
# - 1, 2, 3, 5 : npm ci simple (locks présents à la base).
# - 4 : npm ci refusé côté frontend (fsevents absent du lock) -> npm install, lock suivi restauré.
# - 6, 7 : pas de lock frontend à la base -> lock de eb3bada (18-10, package.json identique), npm ci, lock retiré.
# - 8 : pas de lock frontend à la base -> lock de e3451a01 (27-10, package.json identique), npm ci, lock retiré.
OLI='(cd backend && npm ci --no-audit --no-fund) && (cd frontend && npm ci --no-audit --no-fund)'
OLI67="(cd backend && npm ci --no-audit --no-fund) && (cd frontend && git -C $P/ol-companion show eb3bada:frontend/package-lock.json > package-lock.json && npm ci --no-audit --no-fund; rc=\$?; rm -f package-lock.json; exit \$rc)"
FII='npm ci --no-audit --no-fund && (cd backend && npm ci --no-audit --no-fund) && (cd frontend && npm install --no-audit --no-fund && git checkout -- package-lock.json)'
FIT='(cd backend && npm test) && (cd frontend && npx vitest run)'
MAI="cd frontend && git -C $P/maritime-atlas show e3451a01:frontend/package-lock.json > package-lock.json && npm ci --no-audit --no-fund; rc=\$?; rm -f package-lock.json; exit \$rc"
MAT='cd frontend && npx vitest run'
#        id                     projet           base      install tests visible taille
ligne() { local id=$1 projet=$2 base=$3 inst=$4 tst=$5 vis=$6 taille=$7
  local b=$R/bancs/$id s=$R/secrets/$id
  mkdir -p "$b" "$s"
  # texte brut de Sylvain : la partie au-dessus de « --- », sans le titre ni les citations « > »
  python3 -I -c 'import sys,re;t=open(sys.argv[1]).read().split("\n---\n")[0];t=re.sub(r"^# Demande\s*\n","",t).strip();t=re.sub(r"^> ?","",t,flags=re.M);print(re.sub(r"\n{3,}","\n\n",t).strip())' "$E/$id/demande.md" > "$b/demande.md"
  if [ -d "$E/$id/pieces" ]; then rm -rf "$b/pieces"; cp -a "$E/$id/pieces" "$b/pieces"; fi
  sed -i "s#$E/$id/pieces#$b/pieces#g" "$b/demande.md"
  if [ -f "$C/$id/reponses-de-sylvain.md" ]; then cp "$C/$id/reponses-de-sylvain.md" "$b/reponses.md"; fi
  for f in mesure.md attendu.md; do
    sed -e "s#$C/$id/#$s/#g" -e "s#$E/$id/<A|B>#<clone X ou Y>#g" -e "s#<A|B>#<X|Y>#g" "$C/$id/$f" \
      | sed -E -e 's#(~|/home/[a-z_]+)/projects/developpeur/tmp/essai/[0-9]+-[A-Za-z0-9-]+/(A|B|X|Y|<X\|Y>)([/ ,.)]|$)#<copie X ou Y>\3#g' \
             -e 's#(~|/home/[a-z_]+)/projects/developpeur/tmp/essai/[0-9]+-[A-Za-z0-9-]+#<dossier d'"'"'évaluation>#g' \
             -e 's#(~|/home/[a-z_]+)/\.essai-cache-0711/[0-9]+-[A-Za-z0-9-]+#<dossier d'"'"'évaluation>#g' \
             -e "s#^\./rendu-sld\.sh A captures-A/rendu #$s/rendu-sld.sh <copie X ou Y> captures-<X|Y>/rendu #" -e '/^\.\/rendu-sld\.sh B /d' -e 's#captures-A/rendu-europe#captures-<X|Y>/rendu-europe#g' \
             -e 's#\bA et B\b#X et Y#g' -e 's#\bA ou B\b#X ou Y#g' > "$s/$f"
  done
  if [ -f "$E/$id/rendu-sld.sh" ]; then   # banc 8 : rendu GetMap (lecture seule) et rendus de référence
    sed -E -e "s#$C/$id/rendus/#$s/rendus/#g" -e '/^cd "\$\(dirname/d' \
      -e 's#^C=\$\{1:\?A ou B\}; O=\$\{2:-rendu-\$C\}#C=${1:?copie X ou Y (chemin)}; O=${2:-rendu-$(basename "$C")}#' \
      -e 's#<clone A\|B>#<copie X ou Y>#' "$E/$id/rendu-sld.sh" > "$s/rendu-sld.sh"
    chmod 755 "$s/rendu-sld.sh"; rm -rf "$s/rendus"; cp -a "$C/$id/rendus" "$s/rendus"
  fi
  rm -rf "$s/tests-origine" && cp -a "$C/$id/tests-origine" "$s/tests-origine"
  cat > "$b/banc.yaml" <<EOF
projet: $projet
source: $P/$projet
base: $base
install: |-
  $inst
tests: |-
  $tst
visible: $vis
taille: $taille
EOF
}
ligne 1-ol-companion-L239     ol-companion   e91b65c  "$OLI"   "$OLT" true  retouche
ligne 2-ol-companion-L248     ol-companion   e902609  "$OLI"   "$OLT" true  retouche
ligne 3-ol-companion-L241     ol-companion   94bc157  "$OLI"   "$OLT" false fonction
ligne 4-finance-tracker-L73   finance-tracker 7ec567b "$FII"   "$FIT" true  fonction
ligne 5-ol-companion-L242     ol-companion   29abec4  "$OLI"   "$OLT" false fonction
ligne 6-ol-companion-L167     ol-companion   dc133f6  "$OLI67" "$OLT" true  grosse
ligne 7-ol-companion-L160     ol-companion   f8e6b82  "$OLI67" "$OLT" true  grosse
ligne 8-maritime-atlas-B68    maritime-atlas ba9e6743 "$MAI"   "$MAT" true  fonction
mkdir -p "$R/secrets"; chmod 700 "$R/secrets"
echo "8 bancs migrés dans $R"
