# Attente de créneau des vagues : garder 2 sessions ou passer à 3 (L206)

Relevé du 2026-10-12 à 19 h 45, sur `~/projects/developpeur/.cadence/runs` (199 dossiers de vague dont 4 essais non datés écartés). Reproduction : `cadence orchestrate --waits` depuis `~/projects/developpeur` (relecture seule). Aucun changement de `--max-sessions` dans ce lot : le défaut reste 2, la décision est celle de Sylvain.

## Ce qui a attendu

| Jour | Attente cumulée | Attentes | Vagues | Arrêts par le quota |
|---|---|---|---|---|
| 2026-10-06 | 40 min 10 s | 4 | 12 | 0 |
| 2026-10-10 | 6 min 04 s | 2 | 48 | 0 |
| 2026-10-12 | **1 h 07 min 17 s** | 21 | 22 | 0 |
| 2026-10-04 | 0 | 0 | 11 | **1** (`1609`, lot L27, reprise ensuite par `--resume`) |
| autres jours (05, 07, 08, 09, 11) | 0 | 0 | — | 0 |
| **Total** | 1 h 53 min | | 199 | **1** |

- Le plan citait 58 min pour le 12-10 : c'était l'état de la matinée ; avec les vagues de l'après-midi, le jour monte à 1 h 07 (21 attentes, 3 min 12 s en moyenne).
- Le 12-10, 3 vagues concentrent 57 min sur 67 : `0820` (35 min en 10 attentes, la plus longue 7 min), `0905` (11 min) et `0800` (10 min). Le 06-10 est dû à une seule vague (`1801`, une attente de 19 min). Les 6 autres jours (04, 05, 07, 08, 09, 11) n'ont rien attendu.
- L'attente tient à des vagues lancées en même temps (les créneaux sont comptés toutes vagues confondues), pas à une vague seule : une vague ne joue de toute façon qu'un lot à la fois par dépôt (`pool`), si bien qu'un 3e créneau ne sert que quand 3 dépôts ont chacun un pas à jouer.
- Deux journaux (`2026-10-09-1826`, `1846`) montrent une attente sans créneau obtenu : vague arrêtée pendant l'attente.

## Ce que coûterait un 3e créneau sur Big-Blue

Mesures prises sur la machine pendant deux sessions `claude -p` actives (19 h 44) : 62 Go de RAM dont 54 Go libres, 32 cœurs, charge moyenne 1,2 sur la dernière minute (pointe vue sur 15 min : 6,9, sessions + suites de tests).

| Ressource | Une session `claude -p` | Effet d'un 3e créneau |
|---|---|---|
| RAM | 0,35 à 0,5 Go résident (355 Mo et 388 Mo relevés) | +0,5 Go ; les tests/build lancés par la session (vitest, tsc, Playwright pour une revue UX) s'y ajoutent, de l'ordre du Go : large dans 62 Go |
| CPU | 2 à 11 % d'un cœur au repos de la session ; pointes courtes pendant tests et build | négligeable sur 32 cœurs |
| GPU | aucun (Ollama n'est pas dans les vagues) | aucun |
| Quota Anthropic | 13,7 M de jetons le 12-10 (23,2 M le 11-10, jour sans attente) ; **1 arrêt par le quota sur 199 vagues** (le 04-10, à 2 créneaux et un débit de 5 M de jetons, bien en dessous des 23 M du 11-10) | le débit peut monter de 50 % en pointe (3 sessions au lieu de 2) ; le total de jetons ne change pas, il est consommé plus vite : le risque nouveau est d'atteindre la limite de fenêtre plus tôt dans la journée |

Limites de la mesure : la RAM et le CPU sont un instantané de deux sessions, non un historique (les journaux n'en gardent pas) ; les jetons viennent de `wave.json` (`consumed`), les arrêts par le quota des lignes « → suspended — quota atteint » du journal (le statut final de `wave.json` ne les garde pas : `--resume` le remet à `done`) ; ni l'un ni l'autre ne vaut la jauge du compte.

## Recommandation (décision de Sylvain)

**Passer à 3**, en essai : la machine ne le sent pas (RAM et CPU marginaux) et l'attente du 12-10 (1 h 07 cumulées sur une journée, concentrée sur 3 vagues) est du temps de réalisation perdu quand plusieurs vagues se chevauchent. Le seul coût réel est le quota : une seule vague l'a atteint sur 199 (le 04-10, jour à faible débit), alors que le 11-10 a consommé 23 M de jetons sans arrêt ; la marge existe, mais l'arrêt du 04-10 montre que la limite n'est pas hypothétique, et elle se vérifie. Garder 2 reste raisonnable si Sylvain préfère ne pas risquer la limite de fenêtre : le gain est limité aux jours où plusieurs vagues se chevauchent (3 jours sur 9 ont attendu).

Pour trancher sur pièces : lancer les vagues d'un jour avec `--max-sessions 3` (ou `CADENCE_MAX_SESSIONS=3`, identique pour toutes les vagues), puis comparer `cadence orchestrate --waits --since <jour>` : attente cumulée (attendue proche de 0) et colonne « quota atteint » (doit rester à 0 ; elle compte les arrêts inscrits au journal, y compris ceux d'une vague reprise ensuite par `--resume`). Un seul arrêt par le quota suffit à revenir à 2.
