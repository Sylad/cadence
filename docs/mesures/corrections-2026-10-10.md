# Mesure de référence des corrections de vague (L165)

Relevé du 2026-10-10, arrêté à 18 h 31 UTC (vagues créées avant, étapes terminées avant : 125 vagues, journaux `.cadence/runs` de tous les projets) : 253 passes de correction sur 263 lots, 61 % des lots à au moins une correction, 29 % à au moins deux (le plan citait 61 % et 28 % sur 227 passages, relevés plus tôt dans la journée). Point de départ du lot suivant (L166) : son critère de réussite se mesure contre ces chiffres.

Reproduction : `cadence corrections <dossier-des-projets> --cache docs/mesures/corrections-classement.json --until 2026-10-10T18:31Z` (relecture seule, aucun appel au modèle ; `--classify` reclasse les passes absentes du cache ; `--until` borne le relevé aux vagues créées jusque-là et aux étapes terminées jusque-là (`ended`), sans quoi les vagues suivantes, et la vague encore en cours à cette heure-là, changent les chiffres). Le test `test/corrections-mesure.test.ts` rejoue cette commande sur les journaux et vérifie que la section « Résultats » ci-dessous en est la sortie exacte.

## Méthode

- **Lot** : un enregistrement de journal dont une session d'écriture (`implement`) a abouti ; un lot rejoué dans plusieurs vagues compte plusieurs fois. **Passe de correction** : un pas `fix` abouti.
- **Cause** : une seule par passe, celle du constat le plus grave de la revue qui la précède. Classement par `mistral-small3.2:24b` (Ollama local, température 0, hors quota Anthropic), puis relecture à la main.
- **Premier essai écarté** : avec un premier prompt, le modèle mettait 169 passes sur 254 en « spec floue » et n'était d'accord avec la relecture que sur 5 passes sur 24 ; le prompt a été resserré (bug de code par défaut, « spec floue » seulement si le constat dit que l'énoncé est flou). Le classement ci-dessous est le second.
- **Fiabilité** : l'échantillon de `--sample 24` (24 passes réparties sur les clés triées, qui ont toutes des constats) a été relu en entier sur le code final : le modèle est d'accord avec la relecture sur 17 passes sur 24 (71 %). Au total 77 passes ont été relues (cet échantillon et ceux des relevés précédents, dont les clés ont changé quand le nombre de passes a changé) : accord sur 59 (77 %). Les relectures priment dans les tableaux. Les désaccords viennent de la frontière entre bug de code, test manquant (un test qui ne peut pas échouer ou une sonde non mise à jour y sont rangés) et dérive d'architecture (doc non suivie) : lire les parts par cause comme un ordre de grandeur, pas comme une mesure exacte. La relecture est celle d'une seule personne, et elle lit le premier constat de chaque passe.
- **Passes sans revue** : 13 passes (cadence L84 et L154, claude-code-codex L16, evatosorus L24 ×2 et L33, finance-tracker L3, warhammer40k L54, L60 ×2, L74, L80, L91) n'ont aucun constat à lire : déclenchées par des tests rouges juste après l'écriture, ou deuxième passe `fix` d'une revue déjà traitée par la première. Elles sont comptées à part et ne passent pas par le modèle. Une première version les envoyait au modèle, qui en classait en « faux constat de revue » : cette ligne mesurait donc des passes sans revue, non des erreurs de revue (elle vaut 0).
- Limite : une passe peut avoir plusieurs constats de causes différentes ; seule la plus grave est comptée. « Faux constat de revue » et « données / SQL » valent 0 : aucun constat relu n'était une erreur de la revue elle-même, et les projets mesurés n'ont guère de SQL.

## Résultats

**263 lots** passés par une session d'écriture, **253 passes de correction** : 61 % des lots ont eu au moins une correction, 29 % au moins deux.

### Par cause

| Cause | Passes | Part |
|---|---|---|
| spec floue ou critère absent | 25 | 10 % |
| règle de gestion inventée | 1 | 0 % |
| dérive d'architecture | 32 | 13 % |
| données / SQL | 0 | 0 % |
| bug de code | 130 | 51 % |
| test manquant | 52 | 21 % |
| faux constat de revue | 0 | 0 % |
| sans revue (tests rouges) | 13 | 5 % |

### Par cause et par projet (passes)

| Projet | spec floue ou critère absent | règle de gestion inventée | dérive d'architecture | données / SQL | bug de code | test manquant | faux constat de revue | sans revue (tests rouges) | Total |
|---|---|---|---|---|---|---|---|---|---|
| avatar-pandora | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cadence | 13 | 0 | 15 | 0 | 60 | 30 | 0 | 2 | 120 |
| claude-code-codex | 0 | 0 | 2 | 0 | 4 | 2 | 0 | 1 | 9 |
| evatosorus | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 3 | 4 |
| finance-tracker | 1 | 1 | 4 | 0 | 12 | 2 | 0 | 1 | 21 |
| maritime-atlas | 7 | 0 | 3 | 0 | 21 | 7 | 0 | 0 | 38 |
| ol-companion | 1 | 0 | 5 | 0 | 27 | 7 | 0 | 0 | 40 |
| warhammer40k | 3 | 0 | 3 | 0 | 5 | 4 | 0 | 6 | 21 |

### Lots avec correction

| Projet | Lots | ≥ 1 correction | ≥ 2 corrections | Passes |
|---|---|---|---|---|
| avatar-pandora | 1 | 0 (0 %) | 0 (0 %) | 0 |
| cadence | 123 | 77 (63 %) | 37 (30 %) | 120 |
| claude-code-codex | 7 | 6 (86 %) | 2 (29 %) | 9 |
| evatosorus | 2 | 2 (100 %) | 1 (50 %) | 4 |
| finance-tracker | 12 | 10 (83 %) | 8 (67 %) | 21 |
| maritime-atlas | 39 | 30 (77 %) | 8 (21 %) | 38 |
| ol-companion | 49 | 24 (49 %) | 14 (29 %) | 40 |
| warhammer40k | 30 | 11 (37 %) | 5 (17 %) | 21 |
| **Total** | 263 | 160 (61 %) | 75 (29 %) | 253 |

### Lots visibles et non visibles

| Lots | Lots | ≥ 1 correction | ≥ 2 corrections | Passes |
|---|---|---|---|---|
| visibles | 55 | 25 (45 %) | 14 (25 %) | 45 |
| non visibles | 208 | 135 (65 %) | 61 (29 %) | 208 |

Échantillon relu à la main : 77 passes, le modèle local est d'accord avec la relecture sur 59 (77 %) ; la cause relue prime dans les tableaux.
