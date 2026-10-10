# Mesure de référence des corrections de vague (L165)

Relevé du 2026-10-10 (en fin de journée : 255 passes, 29 % à ≥2 corrections, un lot ayant reçu une seconde correction depuis les 61 % / 28 % du plan) sur les journaux `.cadence/runs` de tous les projets (125 vagues). Point de départ du lot suivant (L166) : son critère de réussite se mesure contre ces chiffres.

Reproduction : `cadence corrections <dossier-des-projets> --cache docs/mesures/corrections-classement.json` (relecture seule, aucun appel au modèle ; `--classify` reclasse les passes absentes du cache).

## Méthode

- **Lot** : un enregistrement de journal dont une session d'écriture (`implement`) a abouti ; un lot rejoué dans plusieurs vagues compte plusieurs fois. **Passe de correction** : un pas `fix` abouti.
- **Cause** : une seule par passe, celle du constat le plus grave de la revue qui la précède. Classement par `mistral-small3.2:24b` (Ollama local, température 0, hors quota Anthropic), puis relecture à la main de 24 passes réparties sur les clés triées (`--sample 24`).
- **Premier essai écarté** : avec un premier prompt, le modèle mettait 169 passes sur 254 en « spec floue » et n'était d'accord avec la relecture que sur 5 passes sur 24 ; le prompt a été resserré (bug de code par défaut, « spec floue » seulement si le constat dit que l'énoncé est flou). Le classement ci-dessous est le second.
- **Fiabilité** : sur les 24 passes relues, le second classement est d'accord sur 16 (67 %). Les relectures priment dans les tableaux. Les écarts viennent surtout de la frontière entre bug de code, test manquant et dérive d'architecture (doc non suivie) : lire les parts par cause comme un ordre de grandeur, pas comme une mesure exacte. La relecture est celle d'une seule personne.
- **Passes sans revue** : 4 passes (cadence L154, evatosorus L33, warhammer40k L80 et L91) ont été déclenchées par des tests rouges juste après l'écriture, sans revue : elles n'ont aucun constat à lire, sont comptées à part et ne passent pas par le modèle. Une première version les envoyait au modèle, qui en classait 3 en « faux constat de revue » : cette ligne mesurait donc des passes sans revue, non des erreurs de revue (elle vaut 0).
- Limite : une passe peut avoir plusieurs constats de causes différentes ; seule la plus grave est comptée.

## Résultats

**264 lots** passés par une session d'écriture, **255 passes de correction** : 61 % des lots ont eu au moins une correction, 29 % au moins deux.

### Par cause

| Cause | Passes | Part |
|---|---|---|
| spec floue ou critère absent | 30 | 12 % |
| règle de gestion inventée | 1 | 0 % |
| dérive d'architecture | 36 | 14 % |
| données / SQL | 0 | 0 % |
| bug de code | 135 | 53 % |
| test manquant | 49 | 19 % |
| faux constat de revue | 0 | 0 % |
| sans revue (tests rouges) | 4 | 2 % |

### Par cause et par projet (passes)

| Projet | spec floue ou critère absent | règle de gestion inventée | dérive d'architecture | données / SQL | bug de code | test manquant | faux constat de revue | sans revue (tests rouges) | Total |
|---|---|---|---|---|---|---|---|---|---|
| avatar-pandora | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| cadence | 15 | 0 | 15 | 0 | 59 | 30 | 0 | 1 | 120 |
| claude-code-codex | 0 | 0 | 2 | 0 | 4 | 3 | 0 | 0 | 9 |
| evatosorus | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 1 | 4 |
| finance-tracker | 1 | 1 | 5 | 0 | 12 | 2 | 0 | 0 | 21 |
| maritime-atlas | 8 | 0 | 3 | 0 | 22 | 5 | 0 | 0 | 38 |
| ol-companion | 1 | 0 | 6 | 0 | 27 | 6 | 0 | 0 | 40 |
| warhammer40k | 5 | 0 | 5 | 0 | 6 | 3 | 0 | 2 | 21 |

### Lots avec correction

| Projet | Lots | ≥ 1 correction | ≥ 2 corrections | Passes |
|---|---|---|---|---|
| avatar-pandora | 1 | 1 (100 %) | 1 (100 %) | 2 |
| cadence | 124 | 77 (62 %) | 37 (30 %) | 120 |
| claude-code-codex | 7 | 6 (86 %) | 2 (29 %) | 9 |
| evatosorus | 2 | 2 (100 %) | 1 (50 %) | 4 |
| finance-tracker | 12 | 10 (83 %) | 8 (67 %) | 21 |
| maritime-atlas | 39 | 30 (77 %) | 8 (21 %) | 38 |
| ol-companion | 49 | 24 (49 %) | 14 (29 %) | 40 |
| warhammer40k | 30 | 11 (37 %) | 5 (17 %) | 21 |
| **Total** | 264 | 161 (61 %) | 76 (29 %) | 255 |

### Lots visibles et non visibles

| Lots | Lots | ≥ 1 correction | ≥ 2 corrections | Passes |
|---|---|---|---|---|
| visibles | 55 | 26 (47 %) | 15 (27 %) | 47 |
| non visibles | 209 | 135 (65 %) | 61 (29 %) | 208 |

Échantillon relu à la main : 24 passes, le modèle local est d'accord avec la relecture sur 16 (67 %) ; la cause relue prime dans les tableaux.

