Tu évalues deux réalisations anonymes, X et Y, de la même demande. Tu ne sais pas qui les a faites et tu ne dois pas chercher à le savoir.

Demande : voir {{EVAL}}/demande.md. Critères et tests cachés : {{MESURE}} et {{SECRETS}}/tests-origine/. Copies jetables : {{EVAL}}/X et {{EVAL}}/Y (tu peux les modifier) ; diffs : {{EVAL}}/X.patch et {{EVAL}}/Y.patch.

Pour CHAQUE copie, avec exactement la même méthode pour les deux :
1. Suite du projet : `{{TESTS}}` ; suite_ok = code 0 (un test instable rejoué seul une fois, noté).
2. Tests cachés : copie les tests d'origine à côté des tests du bras, sous un autre nom (sans écraser). N'adapte que les sélecteurs ou les imports renommés, de la même façon pour X et Y, jamais une attente. Compte uniquement les cas que le lot d'origine a ajoutés ou modifiés.
3. Mutations : 8 à 15 mutations du code CHANGÉ par la copie (inverser une condition, changer une constante, supprimer un appel, décaler un indice). Joue les tests du bras pour chacune ; tuée = au moins un test rouge. Restaure après chaque mutation. Une à la fois, jamais en parallèle.
4. Attendu : oui / en partie / non, au sens de {{MESURE}}.

Écris UNIQUEMENT ce JSON dans {{SORTIE}}, rien d'autre :
{"X":{"suite_ok":true,"caches_passes":0,"caches_total":0,"mutations_tuees":0,"mutations_total":0,"attendu":"oui","mutations":[{"ou":"fichier:ligne","quoi":"avant → après","tuee":true}]},"Y":{…même forme…}}
