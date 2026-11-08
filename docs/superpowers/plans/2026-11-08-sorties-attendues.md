# Plan n°4 — sorties attendues (candidat sequence-v2c) et banc qui juge les sorties

Décidé avec Sylvain le 2026-11-08 au soir, après les mesures S7 (sequence-v2, puis sequence-v2b sans relecture).
Ledger : `.superpowers/sdd/2026-11-08-banc-sequence/progress.md` (suite des rulings R23-R32).

## Pourquoi

Le besoin n°4 de Sylvain, la cohérence entre fonctionnalités, n'est pas mesuré par le banc. Cas vécu : le sélecteur L/H ↔ D/A change la carte, mais la légende reste en L/H (lot Q-LBL9 d'AetherWX). Aucune revue ne l'a vu, parce que toutes lisent le diff et que la légende n'y était pas.

Idée de Sylvain : décrire dès la spec les sorties produites par le lot (UI, retours de service…), puis les contrôler. Contrainte : ne jamais refaire le « monstre » de cadence v1. Donc un seul mécanisme, petit, mesuré, et jeté s'il ne gagne rien.

## Décisions (Sylvain, 08-11 : « ok avec tes propositions »)

- **R33 — périmètre** : les sorties visibles (écrans, légendes, panneaux, cartouches, URL, réponses des services). Les incohérences internes du code restent au juge des défauts.
- **R34 — prix** : v2c coûte au plus +15 % de temps par rapport à v2b ; au-delà, on simplifie ou on jette.
- **R35 — tests cachés informatifs** : les tests cachés d'origine ne sont plus un critère bloquant du verdict. Ils sont couplés au code d'origine (trois mesures le montrent). Ils restent affichés. Le critère bloquant devient les **sorties attendues cachées**, écrites depuis le vrai lot et vérifiées par le juge sur les captures et réponses réelles.
- **R36 — gel des réglages utilisateur** : `~/.claude/CLAUDE.md` a été modifié pendant r2 du run f4e768e16df3 et a contaminé le juge. Les instructions et réglages de l'utilisateur sont scellés pendant un passage ; toute modification rend le passage rouge.

## Tâches

### T1 — gel des réglages utilisateur (R36)
Au début d'un passage de séquence, prendre l'empreinte de `~/.claude/CLAUDE.md`, de chaque fichier qu'il importe par `@…` (récursif, chemins relatifs à `~/.claude/`), de `~/.claude/settings.json` et de `~/.claude/settings.local.json` s'ils existent. Recontrôler après chaque étape et avant les juges. Si une empreinte a changé, l'étape porte la liste des fichiers changés et un critère bloquant du verdict, « réglages utilisateur inchangés pendant le passage », passe rouge. Tests : empreinte stable = ok ; fichier importé modifié pendant une étape = rouge et nommé.

### T2 — juge : sorties attendues cachées (R35)
- Secrets de séquence : clé facultative `sorties` par étape, une liste de phrases observables (où, quoi, pour quelle option). Chargée avec le reste des secrets, jamais montrée aux bras.
- Juge mécanique (`v2/src/bench/juges.ts`, gabarit de brief du juge) : pour chaque bras, `sorties: [{ k, sortie, verdict: "oui" | "non" | "incertain", preuve }]`, la preuve étant une capture ou une commande sur l'application réelle de l'état final. Validation stricte (une entrée par sortie déclarée, verdict dans l'ensemble, preuve non vide).
- Verdict de séquence : nouveau critère bloquant « sorties attendues vérifiées » (nombre de « oui » du candidat ≥ référence) quand la séquence en déclare. « tests cachés cumulés » reste affiché comme critère informatif, non bloquant. Une séquence sans `sorties` garde l'ancien comportement.
- Rapport : liste des sorties « non » et « incertain » par bras.

### T3 — brief sequence-v2c (le seul mécanisme mesuré)
`v2/briefs/bras-sequence-v2c.md` = `bras-sequence-v2b.md` + la section « sorties attendues » : avant le code, une liste dans `{{CLONE}}/.cadence/sorties.md` (où, quoi, pour chaque option), dont la ligne « ailleurs, qu'est-ce qui affiche la même chose ? » trouvée par recherche dans le code ; les règles du projet et les règles globales appliquées ; après le code, chaque ligne vérifiée sur la vraie sortie avec sa preuve, et en test quand c'est possible. Entrée `sequence-v2c` dans `~/bench-cadence/bras.yaml` (réglages de v2, hook compris). Règles anti-rechute étendues à v2c.

### T4 — séquence « piège de cohérence » (données)
À partir de vrais incidents d'AetherWX où une légende ou un autre affichage n'a pas suivi un changement (sélecteur L/H ↔ D/A, légende des CB en cercles, givrage L/T, symboles noirs invisibles…) : pour chacun, le lot d'origine, le commit de base, le texte brut de la demande, le commit qui a corrigé l'incohérence plus tard, et les sorties attendues cachées. Les demandes reconstruites (symptôme seul, R25) sont montrées à Sylvain avant tout passage.

### T5 — mesure
`cadence2 bench sequence <piege> --candidat sequence-v2c --reference sequence-v2b --repetitions 2`, réglages scellés. Après validation des demandes de T4 par Sylvain seulement.

## Ordre
T4 (recherche, lecture seule) en parallèle de T1 puis T2 (un seul implémenteur dans le dépôt à la fois), puis T3, puis validation par Sylvain, puis T5.
