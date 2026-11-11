# cadence run — une demande, une session

Depuis le 2026-11-09, `cadence run` remplace `cadence orchestrate` pour faire une demande. Il joue exactement ce que le banc a mesuré gagnant (docs/v2/banc.md), et rien d'autre.

```bash
cadence run "<demande>" [--piece docs/norme.md]… [--lot L12] [--taille retouche|fonction] [--complet] [--modele opus|fable] [--sans-porte] [--fond]
cadence run --reponse <id> "<texte>"
cadence run --liste
cadence run --help        # ou -h
```

## Aiguillage (10-11)

Le brief complet (v2d, hook de lecture) ne gagne au banc que quand la demande a des références à lire : normes, captures. Sans elles, au banc court du 10-11, Claude seul faisait aussi bien, et plus vite. `cadence run` choisit donc son mode par une règle mécanique :

- **complet** (brief v2d + hook) : une `--piece` est donnée, ou la demande contient un mot de la section `references` de `cadence.yaml`, ou `--complet` est passé. Les documents de la référence trouvée deviennent des pièces à lire en entier ;
- **léger** (brief de Claude seul, `v2/briefs/bras-A.md`) : sinon. Le worktree, la porte et l'intégration ne changent pas.

```yaml
references:
  - mots: [sigwx, jet, cb]
    docs: [docs/normes/sigwx.md]
```

Le modèle, le mode et sa raison s'affichent au lancement (« session Fable en mode leger (…) »). Dans un vrai dépôt, la ligne « Taille » du brief complet, qui ne sert qu'au banc, est retirée : elle casserait un commitlint. Les mots se comparent sans accents ni casse, en mot entier. Un document ou une `--piece` peut être relatif au dépôt, absolu ou sous `~` : une base de connaissance hors du dépôt (par exemple `~/kb/dossiers/<dépôt>-<lot>.md`) se lit comme une pièce.

## Déroulé

1. Ouvre un worktree à côté du dépôt (`../.cadence-run/<projet>-<id>`), sur une branche `cadence/run-<id>`. Les `node_modules` et `.venv` y sont liés en dur.
2. Lance une seule session, dans le mode choisi par l'aiguillage et sur le modèle choisi (`--modele`, sinon `CADENCE_RUN_MODELE`, sinon Opus). En mode complet : brief `v2/briefs/bras-sequence-v2d.md` et hook « lecture obligatoire ». Les pièces passées par `--piece` doivent être lues en entier avant toute écriture. La session tient le registre des demandes du dépôt (`.cadence/demandes/`).
3. Si la session pose une question, le run s'arrête à l'état `attente`. `--reponse` reprend alors la même session, sur le modèle de son lancement (gardé dans l'état du run).
4. Rebase sur la branche de départ, puis porte complète (`orchestrate.test` et `orchestrate.build` de `cadence.yaml`), jouée une seule fois. Si elle est rouge, la même session corrige une fois, puis la porte est rejouée.
5. Intégration en avance rapide sur la branche de départ, puis le worktree est retiré. Rien n'est poussé. Le plan (`raf`) et `cadence deliver` restent ceux de la v1.

**Quota (L700, D-15).** En `claude -p`, la fin de quota ne se reconnaît qu'au texte du résultat (doc officielle lue le 11-11). Un résultat qui commence par « You've hit your weekly limit · resets <jour heure> » met le run à l'état `quota`, pas `echec`, avec l'heure de reprise lue dans ce texte (jour, heure, fuseau entre parenthèses). Le run rend la branche, puis attend : une minute après l'heure dite, il reprend la même session (`--resume`, même worktree, même modèle) et continue (porte, intégration). `cadence run --reponse <id> "reprends"` le reprend avant ; le run qui attendait relit son état toutes les 10 min et s'arrête. Une heure illisible : pas de reprise seule, `--reponse` seulement. « You've hit your Opus limit » bascule sur `fable` dans la même session, sans attendre ; jamais la limite hebdo, qui bloque tous les modèles (Fable compris, vécu le 10-11). `cadence run --liste` et `cadence lead tour` montrent les runs en quota et leur heure de reprise ; le tour montre aussi la jauge hebdo publiée par la bande cadence-hud.

En cas d'échec, le worktree est gardé avec l'état du run (`../.cadence-run/<projet>-<id>.json`). Le run s'arrête alors dans l'un de ces états : `sans-commit`, `conflit`, `porte-rouge`, `sans-porte` ou `refus-integration`.

## Pourquoi ces options

| Option | Justification |
|---|---|
| `--piece` | Le hook « lecture obligatoire » est le seul gain clairement prouvé au banc séquence (lecture des références). La pièce est la liste qu'il fait respecter. |
| `--taille` | Le brief mesuré reçoit la taille du gardien. Sans gardien, la valeur par défaut est `fonction`, comme au banc court. |
| `--reponse` | Une question à Sylvain reprend la même session (cause C2 : ne pas découper le contexte). |
| `--liste` | Retrouver un run rendu, en attente ou rouge, sans fouiller le disque. |
| `--complet` | Forcer le mode complet quand l'aiguillage rate une demande qui a des références. |
| `--lot` | Les commits d'un dépôt suivi par un plan citent le lot (`feat(L51): …`) : la session le reçoit avec la demande. |
| `--modele`, `CADENCE_RUN_MODELE` | Choisir le modèle de la session : `opus` (défaut, celui des deux bras mesurés au banc) ou `fable` ; Sonnet et Haiku n'écrivent pas de code (cause C2). La valeur s'écrit en minuscules. L'option l'emporte sur la variable ; une valeur inconnue est refusée en code 2 avant toute création ; la ligne de lancement dit le modèle utilisé (L699). En Fable, le run sort de ce que le banc a mesuré. |
| `--fond` | Le run se détache et survit à la session qui l'a lancée (vécu au compte pro le 10-11 : un lot mort avec la session précédente) ; journal dans `../.cadence-run/`. |
| `KUBECONFIG` | Comme les vagues : sans `orchestrate.prodAccess: true`, la session n'a ni `kubectl`, ni `helm`, ni `KUBECONFIG` ; avec, elle joue le banc du projet. |
| `--sans-porte` | Un dépôt sans porte déclarée n'est pas intégré en silence : il faut le choisir explicitement. |
| `--help`, `-h` | L'usage, sans rien créer (issue #54 : « --help » partait en demande, laissait worktree, branche et état). Un autre argument qui commence par `-` est refusé en code 2 avant toute création. |

## Mesures qui le fondent

- Bras v2b (une session, sans relecture), préféré à v2 (avec relecture) : environ ×1,4 plus rapide.
- Registre des demandes (v2d) : la demande différée est tenue 3 fois sur 3 avec registre, 0 sur 3 sans, pour +7 % de temps (micro-banc, 09-11).
- Hook « lecture obligatoire » : les références sont lues en entier.
