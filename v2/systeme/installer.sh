#!/usr/bin/env bash
# Installe le banc mécanique du samedi (sudo). À lancer une fois par Sylvain.
set -euo pipefail
D=$(dirname "$(readlink -f "$0")")
LIEN=$(readlink -f "$(command -v cadence2 || true)" 2>/dev/null || true)
case "$LIEN" in "$HOME"/projects/developpeur/cadence/v2/*) ;; *)
  echo "⚠ cadence2 pointe sur « ${LIEN:-rien} » : le service refusera de tourner. Corriger : cd ~/projects/developpeur/cadence/v2 && npm run build && npm link" >&2;; esac
sudo cp "$D/cadence-banc.service" "$D/cadence-banc.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cadence-banc.timer
systemctl list-timers cadence-banc.timer --no-pager
