import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// R29 : deux budgets distincts. Le noyau (le produit) reste petit ; la mesure (banc, séquence) a le sien.
// Les fichiers à la racine de src/ (cli.ts) comptent dans le noyau. R32 : v2/hooks (*.mjs, hors src) est le module `hooks` du noyau.
type Groupe = { total: number; modules: Record<string, number> };
const racine = join(import.meta.dirname, '..');
const budget = JSON.parse(readFileSync(join(racine, 'budget.json'), 'utf8')) as Record<'noyau' | 'mesure', Groupe>;
const src = join(racine, 'src');

function lignes(chemin: string): number {
  if (statSync(chemin).isDirectory()) return readdirSync(chemin).reduce((n, e) => n + lignes(join(chemin, e)), 0);
  return /\.(ts|mjs)$/.test(chemin) && !chemin.endsWith('.d.ts') ? readFileSync(chemin, 'utf8').split('\n').length : 0;
}
const entrees = readdirSync(src);
const dossiers = entrees.filter((e) => statSync(join(src, e)).isDirectory());
const chemin = (d: string) => (d === 'hooks' ? join(racine, 'hooks') : join(src, d)); // hooks : seul module hors de src
const modules = [...dossiers, 'hooks'];
const fichiersRacine = entrees.filter((e) => !dossiers.includes(e));

describe('budget de lignes de v2/src (cause C4 de l\'échec du 07-11, R29)', () => {
  // L689 (décision de Sylvain du 13-11) : on ne tasse pas le code pour tenir le budget ; bench relevé de 800 à 984, ses lignes lisibles (bancs sans juge, en parallèle) ;
  // issue #57 : bench 998, run 455 : bras.ts rendu lisible (lire : le tour du travail décide, le dernier result donne le coût, l'erreur est nommée),
  // run.ts garde les messages de la session à toute fin (échec, délai, signal, quota), pas seulement au succès.
  // L722 : run 466 (+11 lignes), le départ du run nomme les fichiers non commités de l'arbre principal (même règle : pas de ligne tassée pour tenir le budget).
  // L723 : run 520, run.ts se rebase seul quand la cible avance pendant la porte (rebase, conflit rendu à la session, porte rejouée, arbre principal sale nommé).
  // L723 (revue, M1) : run 539, le conflit résolu va à l'état et au journal, le rapport du travail n'est plus remplacé par le « fini » de la résolution.
  // L722 (revue r1) : run 532 (-7), la lecture des fichiers non commités vient de scripts/arbre-non-commite.mjs, partagée avec src (la copie de run.ts est retirée).
  // L724 : run 557, la correction après porte rouge va à l'état et au journal, le rapport du travail n'est plus remplacé par le « fini » de la correction.
  // L724 (revue) : run 561 (+4), la reprise après quota pendant un conflit garde le rapport ; le dernier mot d'une session à sujet n'a plus qu'un mécanisme.
  // L728 (issue #58) : run 562 (+1, import de origineRapport dans cli.ts), --liste dit de quel tour vient le rapport.
  // L728 (revue) : run 569 (+7), la ligne --liste et la ligne de fin détassées (cinq et deux lignes), le type Etat étend EtatRapport (rapport.ts).
  // L726 : run 670 (+101), aiguillage de modèle (escalade.ts : Fable d'office à la 3e passe de correction du lot ou après deux revues non conformes ; chaque passe, son modèle et pourquoi).
  // L726 (revue) : run 695 (+25, 691 mesurées) : la correction après revue exige une revue non conforme neuve (revueApresIntegre), lignes à deux instructions détassées.
  // L730 (D-22) : bench 1080 (+82), mesure 1780 : garde proportionnée (banc mécanique avant publication, alerte du banc complet) et bench complet.ts, sans ligne tassée.
  // L730 (revue) : bench 1090 (+10), mesure 1790 : l'alerte du banc complet ne tombe que sur un banc complet vert qui rejoue chaque rouge en attente (même séquence).
  // L730 (revue 2) : bench 1100 (+10), mesure 1800 : la garde en quatre règles (une fonction, le banc rouge rejoué sur l'empreinte à publier, refus nommant les bancs à rejouer).
  // L730 (revue 3) : règle 2 bornée (un rejeu vert après le rouge, sur la version corrigée ou une suivante, lève l'alerte pour de bon), budget inchangé (1100 atteint).
  // L730 (décision de Sylvain du 15-11) : bench 1104 (+4), mesure 1804 : règle 1 bornée par GARDE_DEPUIS, les rouges d'avant la mise en service sont déjà arbitrés.
  // L733 : bench 1134 (+30), mesure 1834 : un bras qui ne livre que du plan ou de la doc rend le banc mécanique non mesurable (sansLivrable, verdict, garde), sans ligne tassée.
  // L734 : bench 1164 (+30), mesure 1864 : une suite rouge sous la charge des autres bancs est rejouée seule après eux (rejouerSuites), sans ligne tassée.
  // L733 (revue 2) : bench 1167 (+3), mesure 1867 : les cinq règles du banc non livré écrites en tête de verdictSansJuge, seule fonction qui les porte.
  // L736 : bench 1171 (+4), mesure 1871 : le banc court donne ses pièces au bras (piecesBanc) et le bras aiguillé garde le modèle de bras.yaml.
  // L737 : bench 1240 (+69), mesure 1940 : le temps tient compte du bruit de chaque banc (bruitParBanc, criteresTemps, lirePassages, empreinte du bras) et l'ordre des bras alterne d'un passage à l'autre.
  // L738 : bench 1320 (+80), mesure 2020 : le bruit d'un banc expire 14 jours après sa dernière paire A contre A (datePassage, pairesIdentiques, bancsARemesurer) et le samedi le remesure (bench bruit, A contre son jumeau), sans ligne tassée.
  // L738 (revue 1) : bench 1340 (+20), mesure 2040 : seules les paires A contre A du banc complet comptent pour le bruit (bruitDuSamedi, ecartPaire), seuil à la médiane des 3 dernières, sans ligne tassée.
  // L739 : bench 1343 (+3), mesure 2043 : les bancs du court (1, 3 et 7, le banc 7 remplace le banc 6) dans une seule constante, BANCS_COURT, que lisent la garde, les sous-commandes et les messages.
  // L742 (D-23 B) : bench 1493 (+150), sequence 702 (+2), mesure 2195 : chaque rapport note la version de Claude Code, le modèle exact de chaque bras, le contexte max et les
  // réglages suivis, et les compare au rapport précédent (environnement.ts, bench comparer), sans ligne tassée.
  // L745 (issue #62) : run 777 (+82), clore.ts (--liste « integre a la main », --clore) ; L745 (revue) : run 800 (+23), conflit résolu à la main reconnu par le contenu,
  // --clore --force, --reponse refuse un run clos, fichierRun et retirerRun partagés (une copie de moins dans cli.ts et clore.ts), sans ligne tassée.
  // L745 (revue r2) : run 802 (+2), noms lus avec -z et comparés en JS (un nom accentué, « : » initial ou « \ » ne passe plus pour intégré), git diff en échec = non intégré.
  // L745 (4e passe) : run 846 (+44), clore.ts réécrit en contrat, une fonction par ligne du tableau de la doc (têtes du run, worktree, commits hors cible, patch-id
  // sans git cherry), la reconnaissance par contenu retirée, sans ligne tassée.
  // L745 (5e passe, changement de conception) : run 845 (-1), --clore archive avant de retirer (refs/cadence/archive/), --liste ne fait qu'afficher, cadence run
  // --archives ; patch-id, tableau de reconnaissance et --force retirés, sans ligne tassée.
  // L748 : run 881 (+36), escalade.ts lit aussi les revues du lot mises en attente (.cadence/plan-en-attente.yaml, parse des argv de raf review) et
  // reconnaît une revue à son commit seul quand il est connu, sans ligne tassée.
  // L752 : bench 1500 (+7), mesure 2202 : horlogeAPas exportée (tests en ligne et enfants) et Enfants.pas_horloge_ms passée aux bras des enfants, sans ligne tassée.
  // L756 (issue #61) : bench 1517 (+17), mesure 2219, run 885 (+4) : l'id exact du modèle (sortie des sessions, jamais l'alias) dans la ligne d'historique de chaque
  // passage, pour les juges (modelUsage) et pour chaque passe de cadence run, sans ligne tassée.
  // L756 (revue) : bench 1526 (+9), sequence 715 (+13), mesure 2241 : juges lus en stream-json (le juge à part des modèles auxiliaires facturés), une répétition
  // de séquence interrompue emporte ses étapes jouées et écrit modeles_exacts, sans ligne tassée.
  // L760 : run 888 (+3) : la clé references: lue par scripts/references.mjs comme cadence ref (forme { dir, run }, ancienne liste avec migration dite au lancement,
  // forme mal formée refusée avant le worktree), sans ligne tassée.
  // L762 : bench 1588 (+62), mesure 2303 : le banc mécanique refuse de partir sous la charge du lead (runs vivants, lead hold ; --malgre-charge noté au
  // rapport) et chaque rapport note la charge (load average) au départ et à la fin (charge.ts), sans ligne tassée.
  // L763 (issue #63) : run 895 (+7), hooks 215 (+15) : le hook premier-plan.mjs refuse run_in_background dans les sessions du run (une session claude -p
  // n'est jamais réveillée par sa fin), --liste signale une session vivante sans commande ni écriture depuis N minutes (--inactif), sans ligne tassée.
  // L764 : run 917 (+22) : la porte du run est lue dans le cadence.yaml du run (commandesDuRun, la différence avec l'arbre principal dite) et ne joue pas sur un
  // environnement périmé (perime, état environnement-perime ; la lecture est dans scripts/environnement-porte.mjs, partagée avec src), sans ligne tassée.
  // L764 (revue r1) : run 923 (+6) : la porte changée par le run reprise au détail et sous la ligne de fin de l'état integre (porte_changee, comme un
  // conflit résolu, L723), dite une fois par changement et non à chaque essai, sans ligne tassée.
  // L767 : run 1027 (+104) : cadence run --purger [--dry-run] (purger.ts : les fichiers des runs intégrés ou clos depuis run.purgeAfterDays jours, jamais un
  // run qui se reprend ni un worktree gardé) et --liste / --clore d'un run qui se reprend dont la tête est déjà sur la cible, sans ligne tassée.
  // L773 (issue #64) : run 1032 (+5) : un journal par run --fond, nommé d'après l'id du run (nouvelIdRun, ID_RUN, id passé par le lanceur), sans ligne tassée.
  // L781 : run 1137 (+105) : regenerer.ts, les commandes du projet qui appellent cadence (npm run news, plan.onWrite) jouées par le run avant la porte et
  // commitées en un commit du lot, retirées puis rejouées avant un rebase, sans ligne tassée.
  // L781 (revue r1) : run 1152 (+15) : run.regenerate déclaré dans cadence.yaml (lu par scripts/regeneration.mjs) au lieu de scripts.news, tous les
  // commits de régénération retirés avant un rebase ou une reprise de session, échec de régénération à correction propre, sans ligne tassée.
  // L784 : run 1156 (+4) : la porte du run note son verdict pour le hook pre-push (scripts/verdicts-porte.mjs, le fichier de verify --gate, L786), sans ligne tassée.
  // L784 (revue r1) : run 1174 (+18) : la porte du run joue les étapes de verify --gate (scripts/etapes-porte.mjs : build puis test, parties comprises) et ne note un verdict
  // que pour un arbre égal au commit avant et après la porte, au même HEAD (M1, M2), sans ligne tassée.
  // L792 : run 1178 (+4) : le brief nomme les commandes de vérification du projet quand il a des fiches (scripts/commandes-du-brief.mjs), cadence spec check permise.
  // L792 (revue r1) : run 1184 (+6), hooks 231 (+16) : le hook seul-spec-check.mjs refuse tout cadence ou raf hors spec check|qa (cadence spec <lot> on|off
  // écrivait le plan) ; type Etat et état initial détassés (m3 : une seule ligne de run.ts au-delà de 250 colonnes, deux avant le lot).
  // L794 : run 1202 (+18) : la consigne Nouveautés d'un lot visible et la ligne « Nouveautés manquante » de fin de run et de --liste (le reste dans
  // scripts/nouveautes-du-run.mjs), sans ligne tassée.
  // L801 : run 1205 (+3) : l'étape analyse (clé analyse:, scripts/analyse.mjs) jouée entre le build et les tests de la porte, contre la cible du run,
  // sans ligne tassée (le cliquet et les lecteurs vivent dans scripts/analyse.mjs).
  // L775 : bench 1609 (+21), sequence 717 (+2), mesure 2326 : le détecteur de fuites ignore les appels refusés par le hook du bras (refusParHook, partagé
  // avec lectureReferences), sans ligne tassée.
  // L777 : bench 1672 (+63), mesure 2389 : « tests d'origine verts » compte les tests d'origine réussis par bras (testsReussis, cachesReussis, lus dans les
  // bilans jest, vitest et pytest) avec une marge de bruit (MARGE_CACHES, retirée en revue r1 : elle ne venait pas de bras identiques), sans ligne tassée.
  // L777 (revue r1) : bench 1693 (+21), mesure 2410 : marge retirée, candidat ≥ A test par test ; un lanceur ne compte que s'il a un bilan dans les deux
  // journaux et aucun rouge dans la suite seule (cachesReussis), sinon le banc est non mesurable, sans ligne tassée.
  // L798 : bench 1765 (+72), mesure 2482 : un test d'origine dont le résultat suit le chemin d'écriture du bras sort du compte des deux bras, nommé
  // (TESTS_HORS_COMPTE, testReussiJest, exclureTests), et une fuite de la référence sans effet possible sur le candidat est signalée sans rougir
  // (fuiteSansEffet, trierFuitesReference, critère non bloquant), sans ligne tassée.
  // L798 (revue r1) : bench 1769 (+4), mesure 2486 : la fuite de la référence n'est signalée que jouée après le candidat (refApres), un fichier absent du
  // journal jest est « inconnu », pas réussi (etatTestJest), sans ligne tassée.
  it('les totaux sont ceux de R29 : noyau 3000, mesure 2486 (L689, issue #57, L730, L733, L734, L736, L737, L738, L739, L742, L752, L756, L762, L775, L777, L798)', () => {
    expect(Object.keys(budget).sort()).toEqual(['mesure', 'noyau']);
    expect([budget.noyau.total, budget.mesure.total]).toEqual([3000, 2486]);
  });
  for (const [nom, g] of Object.entries(budget)) {
    it(`groupe ${nom} : la somme des budgets ne dépasse pas ${g.total}`, () =>
      expect(Object.values(g.modules).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(g.total));
    it(`groupe ${nom} : ses lignes tiennent dans ${g.total}`, () => {
      const n = modules.filter((d) => d in g.modules).reduce((a, d) => a + lignes(chemin(d)), 0)
        + (nom === 'noyau' ? fichiersRacine.reduce((a, f) => a + lignes(join(src, f)), 0) : 0);
      expect(n).toBeLessThanOrEqual(g.total);
    });
  }
  for (const e of modules) {
    it(`le module ${e} appartient à un seul groupe et tient son budget`, () => {
      const groupes = Object.values(budget).filter((g) => e in g.modules);
      expect(groupes.length, `module ${e} sans budget (ou dans deux groupes) : un module neuf demande un rapport de banc où il gagne`).toBe(1);
      expect(lignes(chemin(e))).toBeLessThanOrEqual(groupes[0].modules[e]);
    });
  }
});
