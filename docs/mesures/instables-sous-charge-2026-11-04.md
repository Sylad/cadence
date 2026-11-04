# Tests instables sous charge, vagues du 01 au 04-11 (L577)

Mesure « avant » : les lignes `N test(s) instable(s) sous charge` des `journal.log` des vagues du 01 au 04-11 (`grep -h "instable(s) sous charge" .cadence/runs/2026-11-0[1-4]*/journal.log`) : 22 lignes sur ces vagues (21 hors la vague de cette session, dont la ligne du 04-11T13:20:38Z de `probe-L539-bords`), la même ligne par rouge de la suite rejoué vert seul. Les journaux ne gardent pas le message d'échec (seulement le nom du test) : la cause de chaque test est lue dans son code, aucune n'a pu être rejouée rouge, même avec 64 boucles actives sur 32 cœurs.

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
| `orchestrate-app` — verrou vide volé au bout de 5 s | 1 | horloge, lue dans le code : le test écrit un verrou vide puis attend au mur (`startApp`, 600 ms) ; `takeUrlLock` (`src/orchestrate/app.ts`) vole un verrou vide dès que `age >= 5_000`, âge mesuré à l'horloge réelle (mtime contre maintenant) ; plus de 5 s sous charge entre l'écriture et la première sonde, et le verrou est volé. Rejoué seul : vert | **non corrigé** : proposé au lead comme lot propre (horloge simulée comme dans le test « délai restant ») |
| `probe-L539-bords` — 6 fois de suite | 2 | délais à la mesure du travail | **récidive mesurée** : le correctif de L567 (442228a) ne fait que porter le délai du test à 180 s, et la ligne du 04-11T13:20:38Z (`cadence:L558`, worktree qui contient 442228a) l'a vu instable après lui. Cause non levée, à reprendre par un lot propre |
| `mise-en-service` — copie séparée (L195), `npm run build` | 1 | trois `tsc` complets à la suite sous un délai fixe, au mur (ligne du 03-11T17:35:28Z, `cadence:L553`) | corrigé avant (L567) par un délai porté à 180 s, pas par une attente d'événement |
| `orchestrate-worktree-integration` — L443 | 1 | refus attendu sous un délai de 2 s | corrigé avant (L550) |

Les « corrigé avant » de L540 (5 s de marge au réveil de la sonde), L567 (R16 « attendus plus largement », 180 s de `probe-L539-bords` et de `mise-en-service`) élargissent un délai au lieu d'attendre un événement : ils réduisent la fréquence, pas la cause. Seul `deliver` (f) attend un événement (L577).

Les tests non corrigés (R17, `verify` SIGINT, verrou vide, `probe-L539-bords`) ont été rejoués seuls dans cette session : tous verts. Un rouge de charge qui passe seul n'est pas un défaut du lot : ils sont proposés au lead, chacun pour son lot (R22 de la session), sans changer le code ici.

« Après » : à relever dans les prochaines vagues avec la commande ci-dessus ; à surveiller : les trois non corrigés (R17, `verify` SIGINT, verrou vide) et `probe-L539-bords`, déjà instable une fois après son correctif (13:20:38Z, vague de cette session). Le gate de cette session n'a pas été rejoué par elle.
