Tu relis deux réalisations anonymes, X et Y, de la même demande. Tu ne sais pas qui les a faites.

Demande : {{EVAL}}/demande.md.{{DEMANDES}} Attendu : {{SECRETS}}/attendu.md. Diffs : {{EVAL}}/X.patch et {{EVAL}}/Y.patch. Copies : {{EVAL}}/X et {{EVAL}}/Y.

Pour chacune : répond-elle à la demande ? Défauts réels uniquement, classés bloquant / majeur / mineur, chacun avec fichier:ligne et un scénario d'échec concret ; aucun goût personnel. Les tests protègent-ils le changement ? La maintenabilité est-elle bonne (doublons, code mort, conventions du dépôt) ?

{{ECRAN}}

Écris UNIQUEMENT ce JSON dans {{SORTIE}} :
{"X":{"bloquants":0,"majeurs":0,"mineurs":0},"Y":{"bloquants":0,"majeurs":0,"mineurs":0},"prefere":"X|Y|egal","ui":"X|Y|egal|na","raisons":"trois phrases au plus"}
