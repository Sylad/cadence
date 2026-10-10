---
type: llm
---
La réponse donne `git push origin 6b0d9aa:main` (ce sha seul) AVANT `cadence deliver --sha 6b0d9aa`, et explique que l'attente de la CI (`ci: github`) cherche le run de ce sha exact, donc qu'il doit être poussé d'abord. Elle peut proposer `cadence deliver --dry-run --sha 6b0d9aa` d'abord. Elle n'invente pas d'option (ni `--commit`, ni `--rev`) et ne propose pas de `git reset` ou de retour arrière de HEAD.
