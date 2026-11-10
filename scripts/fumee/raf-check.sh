#!/usr/bin/env bash
# Fumée de cadence release (L696) : raf init, raf add, commit du plan puis raf check sur un plan jouet, depuis le paquet installé.
set -euo pipefail
git init -q -b main
git config user.email fumee@cadence
git config user.name fumee
raf init --project fumee --no-hook
raf add "Un lot jouet"
git add -A
git commit -qm "plan: L1 ajouté"
raf check
