# Le banc de cadence 2

## Pourquoi

Cadence 1 a perdu son essai A/B (×3,8 en temps, référence préférée 8 fois sur 8) faute de mesure continue. Le banc rejoue des demandes réelles avec la référence (bras `A`, Claude seul) et le candidat (`cadence-run` par défaut, le mode par défaut de cadence depuis 2.0.0) et rend un verdict chiffré. Les cinq causes de l'échec sont décrites dans [la spec, §0](2026-11-07-cadence-2-design.md).

## Trois niveaux de banc (L689)

Vécu du 13-11 : le banc hebdo, garde de publication, a duré plus de 5 h (demande D-3). Chaque niveau a son usage :

| Niveau | Commande | Bancs | Juges | Durée visée | Quand |
|---|---|---|---|---|---|
| micro | `cadence2 bench micro` | 1 | aucun juge IA | ≈ 8 min | pendant un changement de v2, pour voir vite si le flux est redevenu lent ou bavard |
| mécanique | `cadence2 bench mecanique` | 1, 3 et 6, en parallèle | aucun juge IA | ≈ 30 min | à chaque changement de v2, et chaque samedi (minuteur) |
| complet | `cadence2 bench court` puis `cadence2 bench sequence <id> --repetitions 2 --candidat cadence-run --reference A` | 1, 3 et 6, l'un après l'autre, puis la séquence | mécanique + aveugle | plus long | seulement avant une release : c'est la garde de publication |

**Sans juge IA** (micro et mécanique, `sans-juge.ts`) : après les deux bras, le banc joue la suite du projet (`tests` du `banc.yaml`) dans le clone de chaque bras, puis la même suite avec les tests d'origine du banc (`secrets/<banc>/tests-origine/`) posés à côté de ceux du bras sous un autre nom (`x.test.ts` → `x.cache-banc.test.ts`, retirés ensuite). Ni mutations, ni relecture aveugle, ni adaptation des imports : la mesure est plus grossière que celle du juge mécanique. Critères : ceux qui ne demandent pas de juge (mesures complètes, fuites, échecs, temps, retouches, questions), plus « suite du projet verte » et « tests d'origine verts » sur au moins autant de bancs que la référence. Ces passages portent `niveau` dans l'historique et n'autorisent jamais la publication : ils ne comptent ni pour ni contre elle.

**Bancs en parallèle, seulement sans juge** : les bancs d'un passage micro ou mécanique (et leurs répétitions) tournent chacun dans son processus `cadence2 bench _banc`, trois à la fois par défaut (`--paralleles N` ; `--paralleles 1` rejoue l'ancien passage, un banc après l'autre dans le même processus). Les deux bras d'un même banc restent l'un après l'autre, dans l'ordre alterné. Un processus de banc qui ne démarre pas, meurt sans résultat ou laisse un résultat illisible met les deux bras de son banc en échec ; les autres bancs vont au bout. `en-cours.json` porte en plus `en_parallele`, la phase de chaque banc en cours.

**Les passages que compte la garde tournent en série** (`court`, `hebdo`, `eclair`, `lancer`, et la séquence ; décision du lead du 13-11) : `--paralleles N` au-delà de 1 y est refusé (code 2). Raison : en parallèle, le temps d'un bras est mesuré sous la charge des autres bancs, et elle ne pèse pas pareil sur les deux bras. Les premiers bras des trois bancs du court démarrent ensemble ; les seconds tournent quand les bancs plus courts ont fini, sous moins de charge ; A est premier bras sur les bancs 1 et 6, `cadence-run` sur le banc 3. Le critère bloquant « temps total ≤ 1,5 × A » pencherait vers le candidat. Ce biais n'a pas encore été chiffré : il faut d'abord un vrai passage qui compare série et parallèle, par exemple `bench mecanique --paralleles 1` puis `--paralleles 3` sur la même empreinte. Le banc séquence garde lui aussi ses répétitions l'une après l'autre.

## Ce que mesure le banc

Un passage est **vert** si tous les critères bloquants passent (`verdict.ts`).

| Critère | Seuil |
|---|---|
| au moins un banc | ≥ 1 |
| mesures complètes | les deux bras mesurés sur chaque banc |
| tous les bancs jugés | tous |
| aucune fuite | 0 |
| aucun bras en échec | 0 (un bras en échec saute les juges du banc) |
| relecture aveugle | le candidat n'est pas moins bien préféré (> la moitié) ; « indécis » (R39) compte comme une absence de préférence pour la référence |
| tests cachés, mutations tuées | ≥ référence |
| défauts bloquants et majeurs | ≤ référence |
| cohérence UI | ≥ référence |
| temps total | ≤ 1,5 × la référence |
| temps des retouches | ≤ 1,2 × la référence ; bloquant seulement si le passage compte au moins un banc de retouche |
| questions inutiles | 0 sur un banc sans vraie décision |

Les chiffres absolus du 07-11 (304 tests cachés, 79 % de mutations) sont affichés, non bloquants : la barre est relative à la référence du même passage.

## Fonctionnement

- Un seul passage à la fois par racine : verrou `<racine>/passage.lock`, repris si son pid est mort ou s'il date d'un autre démarrage de la machine (identifiant de démarrage écrit dans le verrou ; un pid réutilisé après un redémarrage de WSL ne bloque donc pas). Échappatoire manuelle : `rm ~/bench-cadence/passage.lock`.
- Les deux bras d'un banc l'un après l'autre, dans des clones jetables `c1`/`c2` (ordre alterné d'un banc à l'autre) ; les bancs, eux, tournent en parallèle dans un passage micro ou mécanique, en série dans un passage avec juges (section ci-dessus). La correspondance bras/clone n'est écrite qu'après les juges (relecture aveugle).
- Un banc est un dossier de `bancs/` (les fichiers y sont ignorés). Un `banc.yaml` invalide n'arrête pas le passage : ses deux bras sont en échec (« banc invalide : … ») et les bancs suivants sont joués.
- Préparation d'un clone : `install` puis la suite `tests` à la base, chacune au plus 30 minutes, dans son propre groupe de processus (tué au retour). Une installation en échec ou un délai dépassé met les deux bras du banc en échec (phase « préparation », journal `<clone>.install.log` ou `<clone>.tests-base.log`) ; le code de la suite à la base est noté dans `resultat.json` (`suite_base`).
- Un bras livre par commit : s'il finit sans commit (« aucun commit ») ou laisse des fichiers modifiés ou non suivis apparus pendant son tour (« travail non commité », hors `.cadence`, `docs/plan` et `cadence.yaml`), il est en échec et les juges du banc sont sautés : ils ne voient que `base..HEAD`.
- Les juges travaillent dans `<racine>/eval/<passage>/<banc>`, chaque passe dans son propre sous-dossier, qui est aussi son répertoire de travail : `meca/` (juge mécanique), `ordre-1/` et `ordre-2/` (juge aveugle), chacun avec sa demande, ses copies `X` et `Y`, ses patchs, sa sortie JSON et ses captures ; aucune passe ne voit les fichiers d'une autre. Les copies sont effacées à la sortie du juge, quel que soit le chemin (jugement rendu, JSON invalide, erreur).
- Juge aveugle à ordre permuté (R39, contre le biais de position) : il est joué deux fois, la seconde avec X et Y échangés (dossier `ordre-2/`, nouvelles copies, `aveugle.json` et `captures-X|Y` à lui). Une préférence (`prefere`, `ui`) ne compte que si elle désigne le même bras dans les deux ordres, sinon elle vaut « indécis » (le rapport montre `indécis (A dans un ordre, cand dans l'autre)`) ; les défauts de chaque bras sont le maximum, champ par champ, des deux passages ; les deux passages sont gardés dans `aveugle_ordres` et leurs raisons dans `raisons`. Un passage au JSON invalide après relance rend le banc non jugé ; un juge mécanique sans JSON valide arrête le banc avant toute session aveugle. Le juge mécanique n'est joué qu'une fois.
- Nettoyage : après `resultat.json`, chaque clone (environ 1 Go) est remplacé par `<clone>.patch` (`git diff base..HEAD`) et `<clone>.commits.txt` (`git log --oneline base..HEAD`) ; captures et journaux restent. `--garder-clones` les garde pour le débogage.
- Un passage s'appelle `<date>-<HHMM>-<empreinte>`, date et heure de Paris (comme `statut`) ; l'empreinte hache `v2/src` et `v2/briefs` à HEAD.
- Refus (code 2) si `v2/src` ou `v2/briefs` a des changements non commités, ou si `v2/dist/cli.js` est absent ou plus ancien que les sources.
- **Publication** : permise seulement si le **dernier** passage avec juges de l'empreinte courante qui couvre les bancs 1, 3 et 6 est vert, oppose `cadence-run` à `A` (L689, décision de Sylvain du 13-11 : la garde mesure le mode par défaut contre Claude seul ; la séquence aussi), oppose un candidat à une référence distincte (`--candidat` égal à `--reference` est refusé, code 2), avec le modèle que le `bras.yaml` courant donne au candidat (le modèle est hors de l'empreinte : chaque ligne d'historique porte `reference` et `modele_candidat`), et si aucun passage rouge de cette empreinte, éclair compris, ne le suit.

## Limites connues des garde-fous

Les outils interdits aux bras et aux juges (`--disallowedTools`, `OUTILS_INTERDITS` de `bras.ts`) sont des motifs sur le **début** de la commande : `Bash(git push:*)` n'arrête pas `git -C x push`, ni `Bash(ssh:*)` un `ssh` lancé par `env`, `bash -c` ou un script. Ce qui protège vraiment : les clones n'ont aucun remote (supprimé à la préparation), `SSH_AUTH_SOCK`, `GH_TOKEN` et `GITHUB_TOKEN` sont vides et `KUBECONFIG` pointe sur `/nonexistent`. Restent possibles un `git push` vers une URL explicite ou un `ssh` qui lit une clé de `~/.ssh` sans phrase de passe ; le contrôle des fuites ne les voit pas. Le banc suppose des bras de bonne foi ; le durcir demanderait un utilisateur ou un conteneur séparé.

## La version à publier (L689)

La garde de `cadence release` lit l'empreinte du dépôt publié (`node <dépôt>/v2/bin/cadence2.js bench verifier-publication`). Le 13-11, le banc avait été lancé par `cadence2` du PATH, lié au clone `cadence-v2-banc` arrêté sur une autre branche : il a mesuré l'empreinte `06a30f5c451a` au lieu de `5fe7bdf4cff7`. Désormais :

- un refus de `verifier-publication` (et `statut`) donne la commande exacte à lancer depuis le dépôt à publier : `node <dépôt>/v2/bin/cadence2.js bench court`, puis `node <dépôt>/v2/bin/cadence2.js bench sequence <id> --repetitions 2 --candidat cadence-run --reference A`. La séquence garde ses propres défauts (`sequence-v2` contre `A`) : sans `--candidat cadence-run`, elle mesurerait un autre bras, et la garde la refuserait ;
- chaque passage écrit d'abord, et dans son rapport, le dépôt qu'il mesure (chemin, branche, commit) et son empreinte ;
- le rapport et la ligne d'historique portent la durée du passage entier (`duree_s`).

## Commandes

La racine est `~/bench-cadence` (ou `$BENCH_ROOT`).

| Commande | Effet |
|---|---|
| `cadence2 bench micro` | banc 1, sans juge IA (≈ 8 min) |
| `cadence2 bench mecanique` | bancs 1, 3 et 6 en parallèle, sans juge IA (≈ 30 min), à chaque changement |
| `cadence2 bench court` | bancs 1, 3 et 6 l'un après l'autre (`--paralleles` > 1 refusé), avec juges : le passage minimal avant publication |
| `cadence2 bench hebdo` | tous les bancs, avec juges, l'un après l'autre (plus de 5 h le 13-11) ; le samedi ne le lance plus |
| `cadence2 bench lancer --bancs 1,4` | les bancs choisis |
| `cadence2 bench statut` | dernier passage, publication permise ou non (avec la commande à lancer si elle est refusée), alerte « aucun banc frais » ; toujours code 0 : plus de banc du weekend exigé (décision de Sylvain du 13-11), seule la garde court + séquence compte, avant une release |
| `cadence2 bench verifier-publication` | code 0 si la publication est permise |
| `cadence2 bench ajouter <projet> <lot> <demande.md> --install c --tests c [--taille retouche\|fonction\|grosse] [--visible]` | fabrique un banc frais à partir d'un lot livré |
| `cadence2 bench sequence <id> [--candidat c] [--reference r] [--repetitions N]` | le banc séquence (section ci-dessous) ; défauts : candidat `sequence-v2`, référence `A`, 1 répétition ; pour la garde : `--candidat cadence-run --reference A` |

Options communes : `--candidat <bras>` (défaut `cadence-run`), `--reference <bras>` (défaut `A`), `--juge <modèle>`, `--garder-clones` (ne pas effacer les clones après le passage, pour le débogage), `--paralleles N` (bancs joués en même temps : défaut 3 sur `micro` et `mecanique`, 1 ailleurs, où plus de 1 est refusé) et `--repetitions N` (entier ≥ 1, défaut 1) sur `micro`, `mecanique`, `court`, `hebdo`, `lancer` et `eclair` : chaque bras est joué N fois par banc, dans des clones frais `r1`, `r2`… jugés séparément (ids `<banc>#k` au rapport). Temps, jetons et critères mécaniques sont sommés sur les répétitions ; une préférence (relecture aveugle, UI) ne compte pour un banc que si toutes ses répétitions sont jugées et s'accordent, sinon le banc compte égal. Préférer un N pair, pour que l'ordre des bras soit équilibré.

## Banc séquence

`cadence2 bench sequence aether-b68` rejoue une **suite de vraies demandes successives** d'un même projet, depuis un même commit. Chaque bras garde son propre code d'une demande à l'autre ; il ouvre une session neuve par demande, sauf un bras qui déclare la clé `suite` (ci-dessous). Il mesure ce que le banc court ne voit pas : lire vraiment les documents de référence, ne pas casser ce qui existe, garder un code maintenable (spec : [2026-11-08-banc-sequence-design.md](2026-11-08-banc-sequence-design.md)).

**Une demande ne cite que ses pièces (L706)**. Au chargement, `etapes/<k>/demande.md` est refusée si elle cite un fichier hors des pièces déclarées (`pieces` de `sequence.yaml`) de son étape ou des étapes d'avant, et hors des dossiers de ces étapes : le bras ouvrirait le fichier cité et le détecteur de fuites compterait une fuite. Sont des citations les chemins `~/…`, `$HOME/…`, les chemins absolus sous le home (`HOME`) ou sous le banc ou qui existent (une route `/api/x` n'en est pas une), et les chemins relatifs avec `/` qui existent depuis l'étape ou la séquence. Le message nomme le chemin cité et les pièces permises. Vécu du 10 au 12-11 : `aether-b68-court/etapes/1/demande.md` citait la figure de `aether-b68` ; 4 passages rouges à tort.

**Bras qui gardent leur session (clé `suite` de `bras.yaml`, L690)**. Sans la clé, chaque étape part d'une session neuve. Avec elle, l'étape k reprend (`claude -p --resume`) la dernière session de l'étape k-1 du même bras, même identifiant, même journal :

- `suite: gardee` : la session est reprise telle quelle ;
- `suite: compactee` : un `/compact` dirigé (garder décisions, fichiers touchés, conventions, demandes ouvertes ; jeter sorties de commandes et fichiers lus) est lancé avant chaque étape, et son coût compté à l'étape ;
- `suite: seuil` : le même `/compact`, seulement quand le contexte de la session dépasse 150 000 jetons (`SEUIL_CONTEXTE`, lu à la dernière requête du journal `~/.claude/projects/<…>/<session>.jsonl` : entrée + cache lu + cache écrit). 150 k est un point de départ, réglé d'après la mesure.

La première étape, et une étape dont la précédente n'a rendu aucune session, partent d'une session neuve. **Coût et tokens d'une étape reprise (L703)** : `claude -p --resume` rend le total cumulé de la session depuis son début ; l'étape ne compte que l'écart entre son dernier relevé et le dernier relevé de la même session avant elle (`mesure.releve` de l'étape d'avant, `/compact` et réponses aux questions compris), comme un bras en session neuve compte sa seule session. La clé n'existe qu'au banc : `cadence run` n'a pas d'option de suite. Pour un bras qui reprend sa session, les fuites et la lecture des références d'une étape ne lisent que les lignes du journal horodatées depuis le début de l'étape : une fuite n'est comptée qu'à son étape, et une écriture d'une étape d'avant ne classe pas « après écriture » une pièce lue avant d'écrire.

**Les 6 étapes d'aether** (maritime-atlas, base `def0e7b2`, centres de pression et barre de temps) : B68, B68.2, B68.3, Q-LBL1, Q-LBL4, Q-LBL5. Les lots de réparation B68.4 et B68.5 n'y sont pas ; leurs tests servent de tests de régression cachés. Les pièces à lire sont `docs/normes/centres-de-pression.md` et la figure `centres-pression-meteored`.

Options : `<id>` (dossier `~/bench-cadence/sequences/<id>/`, ses secrets sont dans `~/bench-cadence/secrets/sequences/<id>/`), `--candidat` (défaut `sequence-v2`), `--reference` (défaut `A`), `--repetitions N` (entier ≥ 1, défaut 1), `--juge`, `--garder-clones`. Même garde qu'un passage ordinaire (checkout propre et construit, bras différents et présents), même verrou `passage.lock`, et `HOME` non vide (les réglages utilisateur se contrôlent depuis `$HOME/.claude`) ; un refus rend le code 2. **Une seule invocation joue toutes les répétitions, sous un même identifiant de passage** (`<date>-<heure>-<empreinte>`) : chaque répétition écrit son rapport `rapports/<passage>-<id>-r<N>.md` (et `.json`) — `r1` est la première répétition, `r2` la deuxième, et l'en-tête du rapport dit « Répétition k/N » — et sa ligne d'historique avec le même `run`, `repetition` k et `repetitions` N, dans `runs/<passage>/<id>/r1`, `r2`… (une seule répétition : `-r1` au rapport, pas de dossier `rK`). Une répétition qui lève une exception écrit une ligne rouge « répétition non terminée : <message> » et les suivantes sont jouées. La publication exige que le dernier run de l'id compte **exactement N lignes** (répétitions 1..N) **toutes vertes** : une répétition tuée (SIGINT, WSL coupé) n'écrit rien, le run est incomplet et la publication reste refusée. Code de sortie : 0 seulement si chaque répétition est verte, 1 sinon, 2 pour un refus ou un usage faux. Préférer N pair (l'ordre des bras alterne).

**Ce qui est mesuré après chaque étape k**, par bras :

- les régressions : un test vert à l'étape d'avant et rouge ou disparu maintenant ; un test déjà rouge n'en est pas une ; tests supprimés, ignorés (`skip`) ou aux assertions retirées sont comptés à part et montrés ;
- la lecture des références : chaque pièce ou document cité a-t-il été ouvert avant la première écriture de code ? Un `Read` après la première écriture ne compte pas ; une pièce lue en partie (offset, limit, pages) est marquée « partiel » et ne compte pas pour « en entier » ;
- le build, la duplication (jscpd) et le nombre de fichiers de plus de 400 lignes : on suit la pente depuis l'étape 0 (la base), pas la valeur ;
- le temps, les questions (inutiles quand l'étape n'a pas de `reponses.md`) et les fuites ; une étape en échec est notée et la séquence continue avec le code du bras tel quel (verdict rouge).

À la fin, les juges aveugles lisent l'état final des deux dépôts contre toutes les demandes, jouent les tests cachés cumulés et la régression finale ; un test d'une demande ancienne dont une demande ultérieure a changé le comportement est « remplacé par l'étape k », listé, non compté. Quand les secrets déclarent des `sorties` (R35), le juge mécanique les vérifie **en premier, sur les copies intactes** (avant tests cachés et mutations), en lançant l'app comme le dit `secrets/sequences/<id>/mesure.md`, section « Écran » — fichier exigé au chargement dès qu'une sortie est déclarée, pour ne jamais viser la prod —, captures dans `eval/…/meca/captures-sorties-X|Y` (le juge aveugle a ses propres dossiers) ; il rend `{i, verdict, preuve}` par sortie (i = 1..n dans l'ordre) et le banc rattache l'étape et le texte. Le jugement porte `anonymat` (X et Y → bras) pour vérifier les preuves. Les réglages utilisateur sont recontrôlés avant et après les juges.

**Le hook de lecture obligatoire** (bras `sequence-v2`, `v2/hooks`) refuse toute écriture de code tant que les pièces et documents de l'étape n'ont pas été lus en entier (liste passée par `CADENCE_PIECES`, réglages et hooks en lecture seule, empreinte avant/après : un contournement est une fuite). Le banc mesure en plus la lecture dans les transcripts, pour le bras A comme pour le candidat.

**Lire le rapport** `rapports/<passage>-<id>-r<N>.md` (un fichier par répétition) : un tableau par étape, côte à côte (référence · candidat) : régressions rouges/disparus, tests affaiblis, nouveaux tests, lecture `ouvertes/pièces`, build, duplication, fichiers de plus de 400 lignes, temps ; la ligne 0 est la base. Une ligne « Juge aveugle (deux ordres, R39) » donne la préférence, l'écran et les défauts bloquants/majeurs/mineurs de chaque bras. Dessous, les critères (bloquants : étapes mesurées, aucune fuite, réglages utilisateur inchangés pendant le passage (R36 : `~/.claude/CLAUDE.md`, ses `@imports`, `settings*.json`), aucun bras en échec, juge final fait, régressions ≤ A, sorties attendues vérifiées ≥ A quand la séquence en déclare (R35 : clé `sorties` des secrets, par étape, vérifiées par le juge sur l'application de l'état final ; un « incertain » chez l'un ou l'autre bras rend le critère « non mesuré », rouge, R38), suite du candidat au juge final, attendu ≥ A, questions inutiles 0, pièces lues 100 % en entier, pentes de duplication et de gros fichiers ≤ A, temps total ≤ 1,5 × A, build final ok ; tests cachés cumulés ≥ A, bloquant pour une séquence sans `sorties` et seulement affiché, « en dessous (indicatif) », quand elle en déclare, R35 et R37), puis les lectures à vérifier, les questions, les tests affaiblis, les sorties attendues « non » ou « incertain » et les tests remplacés. Pendant le passage, le HUD affiche `séquence ⟳ <id> · étape k/n` (étape 0 = préparation) et la répétition.

## Installation du timer

```bash
bash v2/systeme/installer.sh
```

Chaque samedi à 10 h, le service lance `cadence2 bench mecanique` (bancs 1, 3 et 6, sans juge IA, ≈ 30 min ; décision de Sylvain du 13-11, à la place du banc hebdo de plus de 5 h). Ce passage ne compte ni pour ni contre la publication. Le service lance la commande avec un `PATH` explicite (node de nvm, `~/.local/bin` pour `claude`) : pas de shell de connexion. Précondition, vérifiée au démarrage du service (échec net dans le journal sinon) : `cadence2` doit être lié au checkout principal, `~/projects/developpeur/cadence/v2` ; pour le corriger : `cd ~/projects/developpeur/cadence/v2 && npm run build && npm link` (l'installeur avertit si le lien pointe ailleurs). Le service vérifie aussi que `node` est sur son `PATH` : après une montée de version nvm, mettre à jour la ligne `Environment=PATH` du service puis relancer l'installeur. Ce checkout doit être propre (rien de non commité sous `v2/src` et `v2/briefs`) et construit (`npm run build` dans `v2`), sinon le passage est refusé. Journal : `~/bench-cadence/mecanique.log`. `TimeoutStartSec=infinity` : pas de délai global ; chaque session de bras reste bornée à 4 h, install et tests à 30 min. Après une mise à jour de ce dépôt, relancer l'installeur pour copier le nouveau service dans `/etc/systemd/system/`.

## Banc éclair

`cadence2 bench eclair` joue le seul banc 1 (une retouche), A contre le candidat, avec les juges : environ 15 minutes, à lancer après tout changement de v2 pour vérifier que le flux n'est pas redevenu lent ni bavard. Même garde (checkout propre et construit) et même verrou qu'un passage ordinaire. Il affiche d'abord « temps candidat ≤ 1,2 × A » et « questions du candidat : 0 », les recopie dans la section « Contrôles éclair » du rapport et note `eclair_ok` dans la ligne d'historique (le HUD affiche ✗ quand il vaut `false`) ; il ne sort en 0 que si le verdict est vert et les deux contrôles tiennent. Il n'autorise jamais la publication : `statut` exige les bancs 1, 3 et 6, donc seul `bench court` compte.

## Rattrapage

`Persistent=true` : un samedi manqué (WSL éteint) est rejoué au premier démarrage de WSL suivant.

## Où lire les rapports

- `~/bench-cadence/rapports/<passage>.md` (et `.json`) : par banc, temps, jetons, préféré, tests cachés, mutations, suite du projet (`ok` ou `ROUGE`) et réponse à la demande (`oui`, `en partie`, `non`) de chaque bras ;
- `~/bench-cadence/historique.jsonl`, une ligne par passage ;
- `~/bench-cadence/runs/<passage>/<banc>/resultat.json` pour le détail.
- `~/bench-cadence/en-cours.json` : écrit à chaque changement de phase pendant un passage (banc, répétition, phase, termines), effacé avec le verrou ; le HUD le montre.

## Règle

Un mécanisme neuf n'entre dans cadence 2 qu'avec un rapport de banc où il gagne.
