# Mode script du ux-reviewer : banc (L839, D-34)

Vécu du 24-11 : le `ux-reviewer` a coûté 63,63 $ sur 24 h (16 % du jour, tarif API). La revue UXW-36 de maritime a pris seule
~158 k jetons et 69 appels d'outils : clics et instantanés Playwright un par un, chaque page remontant dans le contexte.
Le mode script ([commande](../mesures-page.md), section « Script mode » de `agents/ux-reviewer.md`) mesure d'un coup et ne rend
que les chiffres. Il ne joue que sur la ligne `Mode: script` du brief, tant que ce banc n'a pas tranché.

Critère (fixé avant le banc) : on garde le mode script s'il retrouve **autant de défauts connus** pour **moins de jetons**. Un
défaut connu manqué le fait retirer, quel que soit le gain. Sinon le mode et sa ligne sont retirés de l'agent.

## Cas réduit, mesuré le 25-11 (sans modèle)

`node scripts/banc-ux-script.mjs <url>` estime ce que chaque mode fait entrer dans le contexte pour UNE page, aux quatre largeurs.
Mode actuel au plancher : un instantané d'accessibilité et une capture par largeur, sans aucun clic. Mode script : le compte rendu
de `cadence mesures` et deux captures regardées (375 et 1440 px). Texte à 4 caractères par jeton, images par la règle de l'API.

| Page | Mode actuel (plancher) | Mode script | Rapport | Défauts connus retrouvés |
|---|---|---|---|---|
| `test/fixtures/mesures/defauts.html` (7 défauts semés, page courte) | ~4 693 | ~2 526 | 54 % | 7 / 7 |
| `docs/specs/panneau-lots/maquette.html` | ~7 157 | ~2 474 | 35 % | sans liste connue |
| `docs/specs/bande-lots-clos/maquette.html` | ~8 557 | ~2 402 | 28 % | sans liste connue |

Commandes rejouées :

```bash
node scripts/banc-ux-script.mjs file://$PWD/test/fixtures/mesures/defauts.html --charge 100
node scripts/banc-ux-script.mjs file://$PWD/docs/specs/panneau-lots/maquette.html --charge 300
node scripts/banc-ux-script.mjs file://$PWD/docs/specs/bande-lots-clos/maquette.html --charge 300
npx vitest run test/mesures-page-l839.test.ts
```

Lecture : le gain grandit avec la page (54 % sur une page de 40 mots, 28 % sur une maquette de 800 mots). C'est un plancher. La revue UXW-36 a fait 69 appels, pas 8 : le gain réel se mesure sur la revue rejouée, ci-dessous.
Ce cas ne dit rien des défauts que seul un œil voit (hiérarchie, texte, charte) : les deux modes gardent les captures pour eux.

## Banc complet : la même revue rejouée dans les deux modes

Coût attendu : deux revues Opus (~150 k jetons chacune au mode actuel). À jouer par le lead, pas dans une session de lot.

1. **Choisir la revue** : maritime UXW-36, dont le rapport d'origine nomme le défaut M1. Recopier dans `connus.txt` (hors dépôt)
   une ligne par défaut connu de ce rapport, M1 en tête, avec sa mesure.
2. **Remettre la page dans l'état revu** : le sha d'origine de la revue, servi en local ou sur la prod si rien n'a changé depuis.
3. **Lancer les deux bras**, un après l'autre, avec l'outil Agent (`subagent_type: "cadence:ux-reviewer"`, même modèle Opus).
   Le brief est mot pour mot celui de la revue d'origine, plus ces lignes ; le bras B ajoute seulement `Mode: script` :

   ```text
   Bras A (mode actuel) :
   <brief d'origine de UXW-36>
   Report file: <scratchpad>/banc-l839/A.md

   Bras B (mode script) :
   <brief d'origine de UXW-36>
   Mode: script
   Report file: <scratchpad>/banc-l839/B.md
   ```

4. **Mesurer jetons et appels d'outils** des deux appels, dans les transcripts du lead :

   ```bash
   node scripts/jetons-agents.mjs --agent ux-reviewer --dernieres 2
   ```

   Une ligne par bras : `opus <jetons>  total <jetons>  outils <appels>`. Coût au tarif API : jetons × prix d'Opus du jour.
5. **Compter les défauts connus retrouvés** : pour chaque ligne de `connus.txt`, chercher le défaut dans `A.md` et `B.md` (même
   élément, même largeur, même mesure à 1 px près). Un défaut nouveau trouvé par un seul bras se vérifie sur sa capture avant
   d'être compté.
6. **Trancher** : B garde si `connus(B) ≥ connus(A)` et `total(B) < total(A)`. Écrire le résultat ci-dessous, avec les deux
   lignes de `jetons-agents.mjs`. Si B gagne, la ligne `Mode: script` devient le défaut (lot suivant) ; sinon la section est
   retirée de l'agent.

## Résultat du banc complet

Non joué sur UXW-36 (il coûte deux revues Opus sur un écran lourd).

Un **banc court** l'a remplacé le 25-11 : la revue de `test/fixtures/mesures/defauts.html` par `claude -p`, 2 essais par bras,
sans `Mode: script`, avec `Mode: script`, et avec le Code Mode de Claude Code. Les trois bras retrouvent les 7 défauts connus.
Le mode script coûte autant (+3 %), prend plus de jetons (+71 %) et dure 2,3 fois plus longtemps : sur ce banc il ne remplit
pas le critère. Chiffres, limites et verdict : [docs/etudes/2026-11-25-code-mode-banc-court.md](../etudes/2026-11-25-code-mode-banc-court.md).
