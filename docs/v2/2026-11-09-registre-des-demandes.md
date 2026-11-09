# Registre des demandes (besoin n°1 : ne rien oublier) — conception

Statut : proposition du 2026-11-09, à valider par Sylvain avant tout code, puis à mesurer au banc avant adoption (règle de cadence 2).

## Le besoin

Les demandes de Sylvain arrivent au fil de l'eau, souvent en une phrase, au milieu d'autre chose. Exemple vécu le 08-11 : « quand tu affiches L/H ou A/D, la légende doit adapter les symboles ». Rien ne doit se perdre entre le moment où il le dit et le moment où c'est livré et vérifié.

## Ce que disent les mesures connues

- **Anthropic, longues tâches (2025).** Un registre de fonctionnalités en JSON, toutes « à faire » au départ. L'agent ne change que leur état, une fonctionnalité par session. Le JSON est choisi parce que le modèle le corrompt moins que le markdown.
- **Anthropic, mémoire d'agent (06-11-2026).** Des agents qui écrivent dans un même fichier perdent 72 % des faits. Avec une page par sujet et les termes cités mot pour mot, tous sont gardés. Une note fausse persiste tant qu'on ne la corrige pas contre le transcript.
- **MAST.** Le non-respect de la demande cause 11,8 % des échecs, et la vérification de l'objectif d'ensemble est le meilleur gain mesuré.

## Le mécanisme proposé (le plus petit qui sert le besoin)

1. **Une entrée par demande**, dans `.cadence/demandes/<id>.json`, un fichier par demande et jamais un fichier commun. Elle contient :
   - le texte de Sylvain **mot pour mot** ;
   - la date et l'origine (session, issue) ;
   - l'état : `ouverte`, `livrée`, `vérifiée` ou `abandonnée` ;
   - et, une fois livrée, **la preuve** : commit, capture ou commande avec sa sortie.
2. **Personne ne réécrit le texte d'origine.** On peut ajouter des précisions datées, jamais remplacer.
3. **Une demande n'est « vérifiée » qu'avec une preuve sur la vraie sortie.** Un commit ne suffit pas.
4. **Un contrôle mécanique**, par un hook de fin de session ou à la porte, liste les demandes ouvertes sans lot ou sans preuve. Il le dit en clair, et ne laisse pas passer une fin de lot qui déclare faite une demande sans preuve.
5. **« Abandonnée » est un geste de Sylvain**, avec la raison. Une demande ne disparaît jamais en silence.

## Ce qu'on ne fait pas

- Pas de nouvel agent ni de « gardien des demandes ».
- Pas de fiche ni de spec : le registre ne contient que le texte, l'état et la preuve.
- Pas de doublon avec le plan : un lot cite les demandes qu'il sert, le registre ne remplace pas le plan.

## Comment le mesurer

Séquence de banc où des demandes arrivent **en cours de route** : une seconde demande glissée pendant la première, comme dans la vraie vie.
- **Critère principal** : nombre de demandes oubliées ou à moitié faites à la fin, avec et sans registre.
- **Critère secondaire** : le temps ajouté.

Plusieurs répétitions, selon ce que le bruit mesuré le 09-11 impose.

## Décisions de Sylvain (2026-11-09, « ça me va »)

1. **Un registre par dépôt** (`.cadence/demandes/`) :
   - la session ne lit que les demandes de son projet ;
   - les demandes sont versionnées avec le code ;
   - perso et pro restent séparés sans filtre.
   
   La vue d'ensemble se calcule à la demande en lisant les registres de tous les dépôts, comme le tour de `cadence lead`. Les règles valables pour tous les projets ne sont pas des demandes : elles vont dans le `CLAUDE.md` global.
2. **La session crée l'entrée elle-même** dès qu'elle reconnaît une demande, et l'annonce en une ligne (« Noté D-12 : « … » »). Sylvain corrige en deux mots si ce n'en était pas une ou si elle est mal comprise ; le texte d'origine reste intact.
