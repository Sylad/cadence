# Revue UX — design (lot 4 de cadence)

Date : 2026-09-28. Statut : validé (agent générique + garde-fou raf + campagne sur les projets).

## But

Aucun changement visible par l'utilisateur ne se termine sans revue d'ergonomie, et chaque interface
existante reçoit une revue planifiée. Même principe que les Nouveautés : la règle est dans le plan,
`raf check` la fait respecter.

## Garde-fou dans raf

| Élément | Choix |
|---|---|
| Activation | clé `uxSince: AAAA-MM-JJ` du plan, posée par `raf ux enable` ; absente = règle inactive (compatibilité) |
| Revue enregistrée | `raf ux <lot> "verdict"` → `ux: { date, verdict }` sur le lot |
| `raf done` | refuse un lot `visible` sans revue quand la règle est active (`--force` pour passer outre) |
| `raf check` | écart pour un lot `visible` terminé à partir de `uxSince` sans revue |

Un changement visible sans écran (calcul corrigé) s'enregistre avec un verdict explicite :
`raf ux L8 "sans écran : correction de calcul"`.

## Agent `ux-reviewer`

`agents/ux-reviewer.md` à la racine du paquet : découvert par le plugin Claude Code, copié par
`cadence skills install` sous `.claude/agents/cadence-ux-reviewer.md`. Écrit pour ce paquet, générique.

Méthode : captures (bureau 1440 px et téléphone 390 px) avec l'outil de navigation disponible ;
chaque écart cite une règle nommée (heuristiques de Nielsen, WCAG 2.2 AA : contraste 4.5:1, clavier,
focus visible, cibles ≥ 24 px, textes alternatifs) ou une mesure ; gravité (bloquant, majeur, mineur) ;
respect de l'identité visuelle existante ; maquette décrite avant toute refonte. Livrable : rapport
court + sous-tâches `raf add --parent <lot>` proposées, verdict pour `raf ux`. Ne modifie pas le code.

## Campagne

Dans chaque projet perso doté d'une interface : `raf init`, `raf ux enable`, un lot
« Revue UX — <écran> » par page ou écran (inventaire des routes), skills et agent installés, section
CLAUDE.md. Les revues elles-mêmes sont faites plus tard, lot par lot.
