# Tests instables sous charge, vagues du 01 au 04-11 (L577)

Mesure « avant » : les lignes `N test(s) instable(s) sous charge` des `journal.log` des vagues du 01 au 04-11 (`grep -h "instable(s) sous charge" .cadence/runs/2026-11-0[1-4]*/journal.log`) : 20 lignes sur ces vagues, la même ligne par rouge de la suite rejoué vert seul. Les journaux ne gardent pas le message d'échec (seulement le nom du test) : la cause de chaque test est lue dans son code, aucune n'a pu être rejouée rouge, même avec 64 boucles actives sur 32 cœurs.

| Test | Lignes | Cause (lue dans le code) | État |
|---|---|---|---|
| `orchestrate-creneaux-libres-l527-probe` — `--priority explicite` | 6 | ordre d'appel de `claude` et lignes du journal pris pour l'ordre du tirage | corrigé avant (L533, L539 : le test lit `wave.json`) |
| `porte-deportee` — R19 délai | 1 | `SIGTERM` envoyé avant l'adoption du script par le suivi ; `pgrep` non ancré | corrigé avant (L555) |
| `porte-deportee` — R17 deux remplissages | 2 | non établie : `install: sleep 1` est un délai de travail, pas d'attente ; deux `mv` d'un même cache sont atomiques côté hôte | **non corrigé** |
| `deliver` — (b) SIGTERM | 1 | script dormant 3 s, fenêtre au mur | corrigé avant (L555) |
| `deliver` — (f) sans signal | 2 | `sleep 0.6` pour que le suivi relève le descendant (relevé périodique, pas immédiat), bornes 1 s et 4,5 s au mur | corrigé ici (L577) : la commande attend que le suivi ait adopté le descendant ; le test borne par l'état du descendant (encore vivant) et par la durée écoulée depuis l'adoption |
| `verify` — SIGINT relayé | 2 | non établie ; le test attend déjà des événements (fichier pid, mort du pid) avec des bornes de 15 et 10 s | non corrigé (SIGHUP : L505) |
| `orchestrate-worktree-plan-writes` — R16 | 2 | démarrage de l'application et file au mur | corrigé avant (L567) |
| `orchestrate-app` — délai restant | 1 | réveil de la sonde du verrou en retard sur le saut d'horloge | corrigé avant (L528, L540) |
| `orchestrate-app` — verrou vide volé au bout de 5 s | 1 | non établie | **non corrigé** |
| `probe-L539-bords` — 6 fois de suite | 1 | délais à la mesure du travail | corrigé avant (L567) |
| `orchestrate-worktree-integration` — L443 | 1 | refus attendu sous un délai de 2 s | corrigé avant (L550) |

« Après » : à relever dans les prochaines vagues avec la commande ci-dessus ; les trois tests non corrigés sont ceux à surveiller. Rien n'a été relevé sur le gate de cette session (non rejoué par elle).
