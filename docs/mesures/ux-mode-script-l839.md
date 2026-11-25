# Mode script du ux-reviewer : banc (L839, D-34) — retiré le 25-11

**Verdict : ne pas garder.** Le mode script a été jugé au banc court du 25-11 puis retiré du dépôt le même jour. Cette page
garde le vécu, le critère et le résultat. Chiffres, limites et un JSON par essai :
[docs/etudes/2026-11-25-code-mode-banc-court.md](../etudes/2026-11-25-code-mode-banc-court.md).

## Le vécu et l'idée

Vécu du 24-11 : le `ux-reviewer` avait coûté 63,63 $ sur 24 h (16 % du jour, tarif API). La revue UXW-36 de maritime avait
pris seule ~158 k jetons et 69 appels d'outils : clics et instantanés Playwright un par un, chaque page remontant dans le
contexte.

Le mode script tenait en deux pièces. Une commande, `cadence mesures <url>`, mesurait la mise en page d'un coup aux quatre
largeurs et ne rendait que des chiffres. Une section « Script mode » de `agents/ux-reviewer.md` la faisait jouer quand le
brief portait la ligne `Mode: script`.

## Le critère, fixé avant le banc

On gardait le mode script s'il retrouvait **autant de défauts connus** pour **moins de jetons**. Un défaut connu manqué le
faisait retirer, quel que soit le gain. Sinon le mode et sa ligne étaient retirés de l'agent.

## Le cas réduit sans modèle, démenti

Un script (`scripts/banc-ux-script.mjs`) estimait sans modèle ce que chaque mode faisait entrer dans le contexte pour une
page. Il annonçait pour le mode script 28 à 54 % des jetons du mode actuel. Le banc réel a mesuré l'inverse sur la même page
de test : +71 % de jetons. L'estimation ne comptait pas les requêtes de plus, qui relisent chacune tout le contexte en cache.
Elle est retirée avec son test.

## Le banc complet, non joué

Le banc prévu rejouait la revue UXW-36 dans les deux modes (deux revues Opus sur un écran lourd). Il n'a pas été joué.

## Le résultat du banc court (25-11)

La revue d'une page de test à 7 défauts semés par `claude -p`, 2 essais par bras : mode actuel, `Mode: script`, et Code Mode
de Claude Code. Les trois bras ont retrouvé les 7 défauts. Le mode script a coûté autant (+3 %), pris plus de jetons (+71 %)
et duré 2,3 fois plus longtemps : il ne remplissait pas le critère.

## Ce qui a été retiré, ce qui reste

- Retirés : la section « Script mode » de l'agent, la commande `cadence mesures` (scripts, doc, pages de test, tests) et le
  cas réduit. Aucun usage de `cadence mesures` seul n'était mesuré. Tout se relit par `git show 36d77f79 --stat`.
- Restent : l'étude et ses JSON par essai, et le compte `outils N` de `scripts/jetons-agents.mjs` (appels d'outils de chaque
  appel d'agent), qui sert à mesurer toute revue.
