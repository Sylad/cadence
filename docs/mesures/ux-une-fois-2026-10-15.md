# Mesure avant/après de la revue UX jouée une seule fois (L221)

Avant L221, la revue UX d'un lot visible non petit passait avant la revue de code et revenait après chaque passe de correction. Depuis L221 elle passe une fois, après la dernière revue de code conforme. Ce document compte, par lot visible non petit des journaux de vague (`<vague>/<projet>--<lot>.json`, dans `.cadence/runs` du dossier des projets), les étapes `ux` terminées (`kind: ux`, `status: ok`). Aucune commande ni option n'est ajoutée à `cadence corrections` : la lecture est faite à la main sur les journaux existants.

La borne de l'avant est la mise en service de L221 (`npm run service -- <sha>`), à relever par le lead (`stat -c %y ~/.local/share/cadence/service`, en UTC) ; au 2026-10-15 le lot n'est pas en service, tous les journaux existants sont donc « avant ».

## Le cas qui motive le lot : finance L75, le 2026-10-15

Journal `2026-10-15-1606/finance-tracker--L75.json` (lot visible, non petit). Étapes dans l'ordre : precheck, spec, fiche, spec, fiche, implement, **ux** (7), review, fix, **ux** (10), review, fix, **ux** (13), review. Les trois étapes `ux` sont terminées ; un seul verdict utile.

| | Sessions `ux` de finance L75 |
|---|---|
| Avant | 3 (étapes 7, 10 et 13, vérifiées dans le journal) |
| Après : à relever | à relever |

## Tous les lots visibles non petits des journaux (avant)

Relevé du 2026-10-15 sur les journaux de `.cadence/runs` : 35 journaux de lot visible non petit (un journal par lot et par vague : un lot repris dans plusieurs vagues compte autant de fois).

| Étapes `ux` terminées par journal | Journaux |
|---|---|
| 0 | 19 |
| 1 | 2 |
| 2 | 5 |
| 3 | 7 |
| 4 | 2 |

Soit 41 sessions `ux` terminées pour 16 journaux qui en ont au moins une : 2,6 par lot passé par l'UX.

## Après

Après : à relever par le lead, à la première vague d'un lot visible non petit qui a convergé avec L221 en service (date de relevé prévue : la fin de la première vague suivant la mise en service). La même lecture donne le nombre de sessions `ux` terminées par journal ; le cas courant attendu est une seule (une correction, puis revue de code conforme, puis UX). Ce document n'affirme aucun gain tant que cette colonne n'est pas remplie, et la colonne est complétée dans un lot de mesure différé, sans code.

| | Journaux | Sessions `ux` terminées | Par journal passé par l'UX |
|---|---|---|---|
| Avant (relevé du 2026-10-15) | 16 avec au moins une session `ux` (sur 35) | 41 | 2,6 |
| Après | à relever | à relever | à relever |
