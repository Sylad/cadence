# Banc « séquence » — mesurer ce pour quoi cadence existe

Date : 2026-11-08. Statut : **à relire par Sylvain**. Suite de `2026-11-07-cadence-2-design.md`.

## 0. Pourquoi

Les deux mesures de la nuit du 08-11 sont rouges : équipe légère ×2,3 en temps ; flux v2 moins bon sur les tests cachés. Elles ne rejouent qu'une demande isolée, sur un clone neuf, jugée tout de suite. C'est le terrain où Claude seul est bon. Elles ne mesurent pas les besoins pour lesquels cadence existe (Sylvain, 08-11) :

1. ne rien oublier des demandes qui arrivent au fil de l'eau ;
2. lire vraiment les documents et les images de référence (normes OMM/OACI) ;
3. ne pas casser ce qui a été livré par les lots précédents ;
4. garder la cohérence entre les fonctionnalités et un code maintenable ;
5. le sérieux d'une équipe, pas le code d'un « gugus seul dans son garage ».

Le banc « séquence » mesure les besoins 2, 3 et 4. Le besoin 1 est servi par le plan, qu'on garde : aucun A/B ne le départage. Le besoin 5 est la somme des autres.

## 1. Le principe

On rejoue une **suite de vraies demandes successives** d'un même projet, depuis un même commit de départ. Chaque bras **garde son propre code d'une demande à l'autre**, comme dans la vraie vie. Après chaque demande, on mesure ce que le bras a cassé et ce qu'il a fait au code.

## 2. Première séquence : aether, centres de pression et barre de temps (17 → 19-10)

- Base : `def0e7b2` (maritime-atlas).
- **Demandes rejouées**, uniquement celles qui ajoutent ou changent une fonction : B68, B68.2, B68.3, Q-LBL1, Q-LBL4, Q-LBL5. Ce sont 6 étapes.
- **Lots de réparation exclus de la séquence** : B68.4 et B68.5. Ils n'existent que parce que B68.3 a cassé B68. Leurs tests deviennent des **tests cachés de régression** : un bras qui ne casse rien les passe sans avoir eu à les écrire.
- B68.1 est exclu, car son test exige Docker et GeoServer.
- **Références** : `docs/normes/centres-de-pression.md` (WMO-No. 49, 8, 306, 485, Annexe 3) et la figure `docs/etudes/centres-pression-meteored-2026-10-17.webp`, jointe à la demande B68.
- **Texte des demandes** : la phrase brute de Sylvain, extraite des transcripts de ces journées, à la manière de l'essai du 07-11. Si une demande est introuvable, le titre du lot est utilisé avec la mention « reconstruit », et la liste des demandes reconstruites est montrée à Sylvain avant le premier passage.
- **Suites jouées sans cluster** : frontend vitest (environ 5 s) et build de production (environ 11 s). La base de données, GeoServer, Docker et les sondes QA sont exclus.

D'autres séquences suivront, avec le même outil :
- SIGWX R18 → R22, la plus riche en figures de norme ;
- champs de différences E-GL5.x.

## 3. Ce qu'on mesure, après chaque étape k

| Mesure | Comment | Besoin |
|---|---|---|
| **Régressions** | tests cachés de toutes les étapes ≤ k (tests ajoutés par le lot d'origine, plus les tests de réparation B68.4/B68.5 dès l'étape B68.3) : nombre de tests qui passaient et qui échouent | 3 |
| **Couverture de la demande** | tests cachés de l'étape k | 2, 5 |
| **Lecture des références** | dans les transcripts du bras : chaque pièce ou document cité a-t-il été ouvert (outil Read, images comprises) **avant la première écriture de code** ? | 2 |
| **Dérive de maintenabilité** | sur le frontend, à chaque étape : duplication (jscpd, %), taille des 5 plus gros fichiers touchés, nombre de fichiers de plus de 400 lignes, avertissements eslint ; on suit la pente, pas la valeur | 4 |
| **Temps et coût** | par étape et au total | — |

À la fin de la séquence, les deux juges à l'aveugle d'aujourd'hui interviennent :
- le juge **mécanique** joue tous les tests cachés et les mutations sur le code changé ;
- le juge **relecteur** lit l'**état final** des deux dépôts contre la liste des demandes et la norme, au lieu d'un seul diff.

## 4. Barre du banc séquence

Le candidat passe si, sur la séquence :
- **régressions ≤ A** (le but est d'en avoir strictement moins) ;
- tests cachés cumulés ≥ A ;
- lecture des références : 100 % des pièces citées ouvertes avant le code ;
- pente de maintenabilité ≤ A ;
- temps total ≤ 1,5 × A.

Comme aujourd'hui, un critère raté rend le verdict rouge, et la publication de la 2.0.0 exige un vert sur **les deux** bancs, court et séquence.

## 5. Les bras

- **A** : Claude seul, une session neuve par demande, avec le brief d'aujourd'hui.
- **Candidat** : chaque mécanisme vise un besoin, et chacun doit gagner sa place.
  - **Lecture obligatoire** (besoin 2) : un hook refuse toute écriture de code tant que les pièces et documents cités par la demande n'ont pas été ouverts. C'est mécanique, sans promesse.
  - **Non-régression** (besoin 3) : avant le commit, la suite complète du projet tourne. Les tests de chaque demande livrée restent dans la suite, comme des tests ordinaires, sans scellés.
  - **Carte du projet** (besoin 4) : le gardien tient `.cadence/carte.md` à jour, avec les écrans, les workflows et les décisions. La session suivante la lit en premier.
  - **Relecture** : comme flux v2, une seule fois et seulement pour une fonction. La taille de la demande est fixée par le gardien, pas par le bras : la mesure du 08-11 a montré que l'auto-classement n'est pas fiable.

Pour savoir lequel de ces mécanismes porte le gain, on fera ensuite une ablation : un bras sans chaque mécanisme, l'un après l'autre.

## 6. Coût

Environ 6 étapes × 2 bras × 5 à 15 min, plus les tests à chaque étape et les juges en fin de séquence. Compter 2 à 3 h par passage, puis deux passages par bras pour le bruit, soit environ 5 h. Ce banc tourne le weekend avec le banc court.

## 7. Ce que l'outil doit savoir faire (pour le plan)

- **Définition d'une séquence** : `sequence.yaml`, avec la base, les étapes (demande, pièces, tests cachés de l'étape, tests de régression ajoutés à partir de l'étape) et les commandes de test et de mesure.
- **Passage** : un clone par bras, gardé d'une étape à l'autre, et une session neuve par étape. Les questions, les fuites et les échecs sont gérés comme aujourd'hui.
- **Mesures par étape**, écrites dans `etape-<k>.json`, puis les juges de fin et le verdict de séquence.
- **Hook « lecture obligatoire »** pour le bras candidat, avec ses tests.
- **Rapport** : la courbe des régressions et la pente de maintenabilité, étape par étape, côte à côte.
