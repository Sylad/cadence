#!/usr/bin/env bash
# Fumée de cadence release (L696) : `cadence run` en mode léger, depuis le paquet installé, avec un faux claude.
# 2.0.0 et 2.0.1 publiées sans v2/briefs/bras-A.md : ce run-là plantait chez un utilisateur npm (erreur 2 du relevé du 10-11).
# Lancé dans un dossier vide ; `cadence` est celui du paquet installé (PATH posé par la release).
set -euo pipefail
ici=$PWD
mkdir -p faux-bin projet
cat > faux-bin/claude <<'FAUX'
#!/usr/bin/env bash
# Faux claude : la session crée fait.txt et le commite dans son worktree, puis rend la sortie JSON de `claude -p`.
echo ok > fait.txt
git add fait.txt
git -c user.email=fumee@cadence -c user.name=fumee commit -qm "feat: fait.txt"
echo '{"session_id":"fumee","total_cost_usd":0,"result":"fini","subtype":"success"}'
FAUX
chmod +x faux-bin/claude
cd projet
git init -q -b main
printf 'orchestrate:\n  test: test -f fait.txt\n' > cadence.yaml
git add cadence.yaml
git -c user.email=fumee@cadence -c user.name=fumee commit -qm "chore: initial"
PATH="$ici/faux-bin:$PATH" cadence run "Crée fait.txt" > ../run.log 2>&1 || { cat ../run.log; exit 1; }
cat ../run.log
grep -q "en mode leger" ../run.log || { echo "le run n'est pas parti en mode léger"; exit 1; }
test "$(git show HEAD:fait.txt)" = ok || { echo "fait.txt n'est pas intégré sur main"; exit 1; }
