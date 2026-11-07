#!/usr/bin/env bash
# Installe le banc du weekend (sudo). À lancer une fois par Sylvain.
set -euo pipefail
D=$(dirname "$(readlink -f "$0")")
sudo cp "$D/cadence-banc.service" "$D/cadence-banc.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cadence-banc.timer
systemctl list-timers cadence-banc.timer --no-pager
