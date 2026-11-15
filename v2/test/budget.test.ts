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
  it('les totaux sont ceux de R29 : noyau 3000, mesure 1864 (L689, issue #57, L730, L733, L734)', () => {
    expect(Object.keys(budget).sort()).toEqual(['mesure', 'noyau']);
    expect([budget.noyau.total, budget.mesure.total]).toEqual([3000, 1864]);
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
