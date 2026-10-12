# Mesure de l'étape spec contre les lots visibles (L176, S8)

Relevé du 2026-10-12 (soir), journaux `.cadence/runs` de `~/projects/developpeur`, vagues jusqu'à 2026-10-12-1955. Critère : [`2026-10-10-etape-spec-design.md`](../superpowers/specs/2026-10-10-etape-spec-design.md), section « Mesure : critère de réussite », contre la référence des **lots visibles** de [`corrections-2026-10-10.md`](corrections-2026-10-10.md). La cible de la 3e ligne (≤ 8 %) a été fixée par le lead avant la mesure.

**Conclusion : le critère n'est atteint sur aucune des quatre lignes, et l'étape coûte plus de tokens qu'elle ne fait économiser de passes (aucune passe évitée). Ces chiffres ne justifient pas de généraliser l'étape ; l'abandonner ou la resserrer est la décision du lead.**

## Échantillon

8 lots visibles avec fiche, tous livrés (`ready`) : ol-companion L113, L25, L50, L85, L43 ; warhammer40k L35, L47, L49 (aucun lot de cadence : le lot de cadence cité dans la note du lot n'a pas de fiche dans les journaux). Un lot est suivi dans toutes les vagues depuis celle de sa première fiche, y compris les vagues de reprise qui n'ont plus la clé `spec` (revues UX et de code, corrections) : 17 passages, 30 passes de correction.

| Lot | Écran | Vagues | Passes de correction | Revue UX avec un bloquant |
|---|---|---|---|---|
| ol L113 | page | 1 | 1 | non |
| ol L25 | page | 2 | 3 | oui (contraste préexistant d'une entrée voisine) |
| ol L50 | parcours | 2 | 2 | oui (focus invisible, régression du lot) |
| ol L85 | parcours (petit lot) | 3 | 5 | pas de revue UX (revue allégée) |
| ol L43 | composant | 1 | 3 | non |
| wh L35 | page | 2 | 5 | non |
| wh L47 | parcours | 3 | 7 | oui (1re revue de la reprise) |
| wh L49 | parcours | 3 | 4 | oui (3 revues de suite) |

## Résultats par ligne du tableau

Méthode de la référence : un lot compte à chaque enregistrement de journal où une session d'écriture a abouti (un lot rejoué compte plusieurs fois). Les deux lectures sont données : **par passage** (même méthode que la référence, 17 passages) et **par lot** (les passes de toutes les vagues du lot, 8 lots), plus juste ici puisque les 8 lots ont été repris plusieurs fois.

| Indicateur | Référence (lots visibles) | Cible | Mesuré | Verdict |
|---|---|---|---|---|
| lots avec au moins 1 correction | 45 % (25 sur 55) | ≤ 30 % | 100 % (8 sur 8) par lot ; 82 % (14 sur 17) par passage | **non atteint** |
| lots avec au moins 2 corrections | 25 % (14 sur 55) | ≤ 12 % | 88 % (7 sur 8) par lot ; 65 % (11 sur 17) par passage | **non atteint** |
| passes dues à « spec floue », « règle inventée » ou « test manquant » (part des passes) | 16 % (7 sur 45) | ≤ 8 % | 20 % (6 sur 30) | **non atteint** |
| lot qui revient d'une revue UX avec un bloquant | non mesuré | aucun | 4 lots sur 8 (L25, L50, L47, L49), 4 sur les 7 qui ont une revue UX | **non atteint** |

### Passes par cause (30 passes)

Une cause par passe, celle du constat le plus grave de la revue qui la précède (le premier si égalité) ; « bug de code » par défaut, « spec floue » seulement si le constat dit que la fiche ne couvre pas le cas, « règle inventée » si le constat dit que le code applique une règle absente de la fiche. Classement fait à la main sur les 25 revues lues, sans modèle local (voir Limites).

| Cause | Passes | Part |
|---|---|---|
| spec floue ou critère absent | 1 | 3 % |
| règle de gestion inventée | 4 | 13 % |
| dérive d'architecture | 1 | 3 % |
| bug de code | 18 | 60 % |
| test manquant | 1 | 3 % |
| sans revue (tests rouges) | 5 | 17 % |

Détail des six passes de la ligne 3 : **règle inventée** — L113 « groupe Autres » hors de R8 ; L25 R7 écrite dans la fiche par la session de code, ses tests hors de l'acceptation scellée ; L85 messages d'erreur de deux composants codés hors fiche ; L49 exception « images perso » de R9 que la fiche ne prévoit pas. **Spec floue** — L25 bloc « Prochaine sortie » qui disparaît quand la sortie est nulle (« ce cas n'est pas couvert par la fiche »). **Test manquant** — L50 test d'acceptation vert sur une ligne morte, mesure réelle sans test.

Lecture : **hors « règle inventée »**, la ligne vaut 7 % (2 sur 30), sous la cible, mais cette cause vaut 0 % dans la référence faute de constat classé ainsi (limite connue de la spec) ; la fiche la rend mesurable, c'est précisément ce que ses 4 cas montrent (du code écrit hors fiche, trouvé par la revue règle → test → vert). La cible était posée sur les trois causes : la ligne n'est pas atteinte.

Les 5 passes « sans revue » (L43 ×2, L35 ×2, L47 ×1) sont des tests rouges juste après l'écriture : 17 % des passes, contre 13 % (6 sur 45) pour les lots visibles de la référence.

## Coût

Tokens comptés des journaux (entrée, écriture de cache, sortie ; hors lecture de cache), sur toutes les vagues des 8 lots :

| Poste | Sessions | Tokens | Par lot |
|---|---|---|---|
| spec + revue de maquette + précontrôle | 68 | 3 956 379 | 494 547 |
| accept | 10 | 777 694 | 97 212 |
| **Étape spec (spec + maquette + accept)** | 78 | **4 734 073** | **591 759** |
| passes de correction | 30 | 1 741 318 | 217 665 (58 044 par passe) |

Passes évitées : **aucune**. Les 8 lots font 3,75 passes en moyenne contre 0,82 (45 sur 55) pour les lots visibles de la référence. Même si l'étape supprimait toutes les passes attendues à ce taux (6,5 passes ≈ 380 000 tokens), elle coûterait plus de 12 fois ce qu'elle ferait économiser. Les 68 sessions de spec et de maquette (8,5 par lot) viennent des vagues rendues au lead après chaque boucle de maquette ; l'étape ne se paie pas qu'une fois.

## Verdict

- Sur 8 lots, deux projets, **le critère de réussite n'est atteint sur aucune ligne** ; avec 8 lots le résultat est un verdict (seuil de la spec), non une note.
- Aucune baisse des corrections ne compense le coût : ni les lots ni les passes n'ont diminué, et l'étape ajoute environ 590 000 tokens par lot.
- Ce que la fiche apporte reste vrai (états prévus, règles reprises, « règle inventée » rendue visible par la revue), mais cela n'a pas réduit les passes.
- Conformément à la spec, **le seuil (`screen:`) est à resserrer avant d'abandonner l'étape** : décision du lead. Pistes lues dans les chiffres, non démontrées : les parcours coûtent le plus de passes (4,5 par lot, 18 sur 4 lots) contre 3,0 pour les pages (9 sur 3) ; les 5 passes « sans revue » viennent de tests d'acceptation rouges après l'écriture.
- Le critère de l'étape back (B1–B5, lots non visibles) est inchangé par cette mesure.

## Limites

- **8 lots, deux projets, une période de deux jours** : pas de significativité statistique ; la fiche était en rodage (les défauts L180 à L184 ont été corrigés pendant la période).
- **Pas un essai contrôlé** : les lots avec fiche sont des écrans neufs ou des parcours, plus lourds que la moyenne des lots visibles de la référence (qui compte des retouches) ; aucune assignation au hasard.
- **Vagues de reprise guidées par le lead** : une partie des passes vient de décisions prises en cours de route (par exemple L49 : retour au comportement collant de l'aside, décision du 12-10), qui changent la demande plus qu'elles ne corrigent la fiche.
- **Un classement par une seule lecture** (la session qui a écrit cette note, sur le premier constat de chaque passe), sans le modèle local ni relecture croisée : la frontière bug de code / test manquant / spec floue est la plus fragile. Si les trois passes à la frontière (L85 fix 5, L43 fix 10, L35 fix 10) étaient classées « test manquant » ou « spec floue », la part monterait à 30 % ; à l'inverse elle ne descend sous 8 % que si les 4 « règle inventée » deviennent des bugs de code.
- La référence et la mesure ne classent pas avec le même lecteur (modèle local + relecture, contre une lecture).
- Le relevé n'est pas reproductible par `cadence corrections` : la commande ne sait pas isoler « les lots qui ont une fiche ». Le recensement des 17 passages et des 30 passes est fait par lecture directe des journaux (clé `spec.fiche` du premier passage de chaque lot).
