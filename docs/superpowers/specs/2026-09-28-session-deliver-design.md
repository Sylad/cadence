# session et deliver — design (lot 3 de cadence : rituels de session et livraison)

Date : 2026-09-28. Statut : validé (approche « CLI de faits + skills minces + deliver configurable + plugin »).

## But

Rendre réutilisables, dans n'importe quel dépôt qui a un plan raf, trois rituels :

- **reprendre** une session : les faits (en cours, fait depuis, écarts, livraison en cours, notes
  de la veille), puis trois propositions tirées du plan, puis **attendre la priorité** de l'humain ;
- **clôturer** une session : hygiène du plan, état du dépôt, trois lignes pour la prochaine fois ;
- **livrer** : attendre la CI du sha poussé, déployer, puis **vérifier l'effet** — une livraison
  n'est finie que quand ses vérifications passent.

Le CLI collecte les faits et exécute ; les skills Claude Code décrivent la méthode et restent minces.
Rien de propre à une infrastructure : le déploiement est une commande fournie par l'utilisateur.

## Décisions

| Sujet | Choix |
|---|---|
| Faits de session | `cadence session start` / `close`, texte français comme le reste du CLI, testés |
| État local | dans le dossier git, jamais commité : notes de clôture par worktree (`--git-path cadence`), verrou et journal des livraisons communs aux worktrees (`--git-common-dir`/cadence) |
| Notes pour la suite | `cadence session next "…" …` écrit `next.md` dans l'état local ; `session start` les affiche |
| Configuration de livraison | `cadence.yaml` à la racine du dépôt (`--config`), clé `deliver:` |
| CI | `ci: github` (sondage de `gh run list --commit`), `ci: none`, ou `ci: { command: "…" }` |
| Vérifications | `url` (+ `status`, `contains`) ou `command`, réessayées jusqu'au délai |
| Garde-fous | arbre propre, sha présent sur une branche distante, verrou contre deux livraisons simultanées |
| Skills | `skills/session-start`, `skills/session-close`, `skills/deliver`, en anglais (dépôt public) |
| Distribution | plugin Claude Code (`.claude-plugin/plugin.json` + `marketplace.json`) et `cadence skills install` |
| Dépendances | aucune nouvelle (`fetch` et `child_process` de Node 20) |

## `cadence session start [--since "24 hours ago"] [--idle 2]`

Sections, dans cet ordre, chacune omise si vide sauf « En cours » :

1. **Notes de la dernière clôture** (`next.md`, avec sa date).
2. **Livraison en cours** : verrou présent → sha, pid, depuis quand ; verrou périmé (pid mort) signalé.
3. **En cours** : lots `doing`, avec la date de dernière activité (dernier commit, dernière note ou
   démarrage) ; `silencieux` quand elle date de plus de `--idle` jours (défaut 2).
4. **Fait depuis** `--since` : commits groupés par lot (`L3 — 2 commit(s) : sujet ; sujet`), puis le
   nombre de commits sans lot.
5. **Écarts** : les messages de `raf check` (Nouveautés comprises).
6. **Dépôt** : branche, fichiers modifiés, commits non poussés (ou « pas de branche amont »).
7. **Propositions** : au plus trois ids, dans l'ordre : lots `doing`, puis lots `todo` prêts (dépendances
   terminées), gains rapides d'abord. Même règle que `raf now`, factorisée.

Code de sortie 0 (c'est un rapport).

## `cadence session close [--since <aujourd'hui 00:00>]`

1. **Commits de la période** groupés par lot ; commits sans lot listés avec sha court et sujet.
2. **Lots en cours sans commit dans la période** : à fermer (`raf done`) ou à expliquer (`raf note`).
3. **Écarts** : `raf check`.
4. **Dépôt** : fichiers modifiés, commits non poussés, livraison en cours.

Code de sortie 1 si l'un des points 3 ou 4 n'est pas vide (« pas fermé »), 0 sinon.

## `cadence session next "ligne" …`

Remplace `next.md` par la date du jour et les lignes. Sans argument : efface.

## `cadence deliver [--dry-run] [--config cadence.yaml]`

```yaml
deliver:
  ci: github              # github | none | { command: "…" } ; absent = none
  ciTimeout: 1800         # secondes, attente totale de la CI
  deploy:                 # commandes sh, dans l'ordre, à la racine du dépôt
    - ./scripts/bump-tag.sh "$CADENCE_SHORT"
  verify:
    - url: https://app.example.com/api/health
      status: 200         # défaut 200
    - url: https://app.example.com/
      contains: "${SHORT}"
    - command: kubectl rollout status deploy/app --timeout=60s
  verifyTimeout: 300      # secondes pendant lesquelles les vérifications sont réessayées
```

Variables fournies aux commandes : `CADENCE_SHA`, `CADENCE_SHORT` (7 caractères), `CADENCE_BRANCH`.
Dans `url` et `contains`, `${SHA}` et `${SHORT}` sont remplacés.

Déroulé :

1. **Préconditions**, toutes vérifiées avant d'agir, refus avec code 2 :
   configuration présente et valide ; arbre propre ; `HEAD` contenu dans une branche distante
   (`git branch -r --contains`) — sinon « sha non poussé : la CI n'a rien construit » ;
   pas de verrou vivant ; avec `ci: github`, `gh auth status` réussi. Un verrou dont le pid est mort
   est retiré avec un avertissement (renommé puis relu : on ne retire que celui qu'on a lu) ; un verrou
   illisible de moins de 5 s est considéré comme tenu. Le verrou est posé par lien atomique.
2. **Verrou** `deliver.lock` (pid, sha, début) dans l'état local, retiré à la fin quoi qu'il arrive.
3. **CI** :
   - `github` : toutes les 15 s, `gh run list --commit <sha> --json databaseId,name,status,conclusion`.
     Aucun run après 5 min → échec « aucun run CI pour ce sha ». Runs tous terminés → succès si
     chaque conclusion vaut `success`, `skipped` ou `neutral`, échec sinon (noms des runs en échec).
     `ciTimeout` dépassé → échec.
   - `{ command }` : la commande doit sortir 0.
4. **Déploiement** : chaque commande, sortie affichée ; la première qui échoue arrête tout.
5. **Vérifications** : chaque vérification est réessayée toutes les 10 s jusqu'à `verifyTimeout` ;
   échec avec la dernière raison (statut reçu, texte absent, code de sortie).
6. **Succès** : ligne ajoutée à `deliveries.log` (date, sha) ; lots cités par les commits depuis la
   livraison précédente affichés : « livré : L3, L5 — raf done si l'effet est celui attendu ».

`--dry-run` : préconditions (sans verrou), puis affichage des étapes avec les variables résolues ;
rien n'est exécuté. Codes : 0 livré, 1 échec d'une étape, 2 refus avant d'agir.

Toute commande est tuée au-delà de son budget (`ciTimeout`, `deployTimeout` par commande — défaut
1800 s —, reste de `verifyTimeout`) : « délai dépassé ». Les erreurs de `gh` sont réessayées et
remontées avec leur cause (stderr) après 5 min. En HEAD détachée, `CADENCE_BRANCH` est vide. Si la
livraison précédente n'est pas un ancêtre de HEAD (historique réécrit), les lots livrés ne sont pas
calculés et le message le dit.

Pour les tests, le sondage GitHub, l'attente et `fetch` sont injectés.

## Skills

Minces : ils disent quoi lancer, comment lire la sortie, et ce qu'il ne faut PAS faire.

- **session-start** : lancer `cadence session start` ; rendre un compte rendu court (en cours et
  silencieux — oubli de `raf` ou vrai arrêt —, fait depuis par lot, écarts, livraison en cours) ;
  proposer trois choses **du plan** avec leur id et une phrase ; une idée hors plan n'est proposée
  qu'avec son `raf add` ; **s'arrêter et attendre** la priorité. Rien démarré ni commité avant la
  réponse, sauf `raf note` sur un lot silencieux dont la cause est connue.
- **session-close** : lancer `cadence session close` ; hygiène (`raf done` si tests verts, `raf note`
  sinon, commits sans lot rattachés par une note) ; entrées Nouveautés des lots visibles ; mémoire
  filtrée si l'agent en a une (seulement ce que le dépôt ne dit pas) ; skills ou agents **proposés**,
  jamais créés, quand une même chaîne a été refaite à la main deux fois ; ne pas dire « fermé » si le
  code de sortie est 1 ; finir par `cadence session next` avec trois lignes.
- **deliver** : tests et build verts, commits poussés ; `cadence deliver --dry-run` puis
  `cadence deliver` ; jamais deux à la fois ; en cas d'échec, lire l'étape et la raison, ne pas relancer
  à l'aveugle ; un statut vert d'outil n'est pas une preuve, seules les vérifications le sont ; après
  succès, `raf done` des lots dont l'effet est vérifié, `cadence news build` si un lot est visible.
  Sans `deliver:`, aider à écrire la configuration en demandant la commande de déploiement.

`cadence skills install [--dir .claude/skills] [--force]` copie les trois skills sous les noms
`cadence-session-start`, `cadence-session-close`, `cadence-deliver` (le champ `name` est réécrit) ;
refuse d'écraser un dossier différent sans `--force`. En plugin, ils s'appellent
`/cadence:session-start`, etc.

## Premier client : finance-tracker

Lot raf dédié ; `cadence.yaml` avec CI GitHub, un script de déploiement qui bumpe le tag du chart
dans `developpeur-gitops` et pousse, vérifications `https://finance.sladoire.dev` ; skills installés ;
section CLAUDE.md. Seul `--dry-run` est exécuté dans ce lot (le dépôt n'est pas encore poussé).

## Hors périmètre

Connaissance d'ArgoCD, Helm ou d'un hébergeur ; retour arrière automatique ; notifications ;
mémoire propre à un agent (le skill la mentionne seulement).
