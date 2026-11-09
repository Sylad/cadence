# cadence run — une demande, une session

Depuis le 2026-11-09, `cadence run` remplace `cadence orchestrate` pour faire une demande. Il joue exactement ce que le banc a mesuré gagnant (docs/v2/banc.md), et rien d'autre.

```bash
cadence run "<demande>" [--piece docs/norme.md]… [--taille retouche|fonction] [--sans-porte]
cadence run --reponse <id> "<texte>"
cadence run --liste
```

## Déroulé

1. Ouvre un worktree à côté du dépôt (`../.cadence-run/<projet>-<id>`), sur une branche `cadence/run-<id>`. Les `node_modules` et `.venv` y sont liés en dur.
2. Lance une seule session Opus avec le brief `v2/briefs/bras-sequence-v2d.md` et le hook « lecture obligatoire ». Les pièces passées par `--piece` doivent être lues en entier avant toute écriture. La session tient le registre des demandes du dépôt (`.cadence/demandes/`).
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
| `--sans-porte` | Un dépôt sans porte déclarée n'est pas intégré en silence : il faut le choisir explicitement. |

## Mesures qui le fondent

- Bras v2b (une session, sans relecture), préféré à v2 (avec relecture) : environ ×1,4 plus rapide.
- Registre des demandes (v2d) : la demande différée est tenue 3 fois sur 3 avec registre, 0 sur 3 sans, pour +7 % de temps (micro-banc, 09-11).
- Hook « lecture obligatoire » : les références sont lues en entier.
