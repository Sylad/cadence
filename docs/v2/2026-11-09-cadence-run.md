# cadence run — une demande, une session

Depuis le 2026-11-09, `cadence run` remplace `cadence orchestrate` pour faire une demande. Il joue exactement ce que le banc a mesuré gagnant (docs/v2/banc.md), et rien d'autre.

```bash
cadence run "<demande>" [--piece docs/norme.md]… [--lot L12] [--taille retouche|fonction] [--complet] [--sans-porte] [--fond]
cadence run --reponse <id> "<texte>"
cadence run --liste
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

Le mode et sa raison s'affichent au lancement. Dans un vrai dépôt, la ligne « Taille » du brief complet, qui ne sert qu'au banc, est retirée : elle casserait un commitlint. Les mots se comparent sans accents ni casse, en mot entier. Un document ou une `--piece` peut être relatif au dépôt, absolu ou sous `~` : une base de connaissance hors du dépôt (par exemple `~/kb/dossiers/<dépôt>-<lot>.md`) se lit comme une pièce.

## Déroulé

1. Ouvre un worktree à côté du dépôt (`../.cadence-run/<projet>-<id>`), sur une branche `cadence/run-<id>`. Les `node_modules` et `.venv` y sont liés en dur.
2. Lance une seule session Opus, dans le mode choisi par l'aiguillage. En mode complet : brief `v2/briefs/bras-sequence-v2d.md` et hook « lecture obligatoire ». Les pièces passées par `--piece` doivent être lues en entier avant toute écriture. La session tient le registre des demandes du dépôt (`.cadence/demandes/`).
3. Si la session pose une question, le run s'arrête à l'état `attente`. `--reponse` reprend alors la même session.
4. Rebase sur la branche de départ, puis porte complète (`orchestrate.test` et `orchestrate.build` de `cadence.yaml`), jouée une seule fois. Si elle est rouge, la même session corrige une fois, puis la porte est rejouée.
5. Intégration en avance rapide sur la branche de départ, puis le worktree est retiré. Rien n'est poussé. Le plan (`raf`) et `cadence deliver` restent ceux de la v1.

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
| `--fond` | Le run se détache et survit à la session qui l'a lancée (vécu au compte pro le 10-11 : un lot mort avec la session précédente) ; journal dans `../.cadence-run/`. |
| `KUBECONFIG` | Comme les vagues : sans `orchestrate.prodAccess: true`, la session n'a ni `kubectl`, ni `helm`, ni `KUBECONFIG` ; avec, elle joue le banc du projet. |
| `--sans-porte` | Un dépôt sans porte déclarée n'est pas intégré en silence : il faut le choisir explicitement. |

## Mesures qui le fondent

- Bras v2b (une session, sans relecture), préféré à v2 (avec relecture) : environ ×1,4 plus rapide.
- Registre des demandes (v2d) : la demande différée est tenue 3 fois sur 3 avec registre, 0 sur 3 sans, pour +7 % de temps (micro-banc, 09-11).
- Hook « lecture obligatoire » : les références sont lues en entier.
