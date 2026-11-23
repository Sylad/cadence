// L730 (D-22) : le banc complet du samedi, court avec juges puis chaque séquence, cadence-run contre A ; ses alertes lèvent la garde proportionnée.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../cli.js';
import { sequence } from '../sequence/cli.js';
import { racineBanc } from './banc.js';
import { bench, bruitDuSamedi, numerosARemesurer, REPO } from './cli.js';
import { construireV2, distPerime, effacerRefus, ENV_CONSTRUIT, nonCommite, noterRefus, relancerV2 } from './refus-complet.js';
import { PUBLIE } from './verdict.js';

export const USAGE_COMPLET = 'usage : cadence2 bench complet [--sequences id1,id2] [--juge modèle]';

/** Les séquences de la racine (`<racine>/sequences/<id>/`), dans l'ordre des noms. */
export const sequencesDe = (racine: string): string[] => {
  const d = join(racine, 'sequences');
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
};

/** L804 : construire v2 quand son dist est périmé, puis se relancer sur le dist neuf. `repo` : le dépôt du code mesuré. Substituable dans les tests. */
export type Construction = {
  repo: string; perime: (repo: string) => string | null; nonCommite: (repo: string) => string | null; construire: (repo: string) => string | null;
  relancer: (repo: string, args: string[], env: NodeJS.ProcessEnv, noter: (cause: string) => void) => Promise<number>;
};
export const CONSTRUCTION: Construction = { repo: REPO, perime: distPerime, nonCommite, construire: construireV2, relancer: relancerV2 };

type Deps = { bench: typeof bench; sequence: typeof sequence; bruit: typeof bruitDuSamedi; construction?: Construction };

/**
 * `cadence2 bench complet` : d'abord, s'il y en a, les bancs du court à remesurer (L738 : `bench bruit`, A contre A sans juge, sur chaque banc bruité ou
 * dont le bruit expire dans les 7 jours, le seul passage A contre A compté pour le seuil ; joué avant le court pour que son verdict lise un bruit frais, et hors du code de retour), puis le banc court (1, 3 et 7, avec juges, en série), puis chaque séquence (`--sequences`, défaut toutes celles de la racine),
 * deux répétitions, cadence-run contre A ; puis `statut`, dont les lignes ⚠ portent une alerte au journal. 0 si tout est vert, 2 si le court est refusé
 * (les séquences le seraient aussi), 1 sinon. Un court rouge n'arrête pas les séquences : le samedi mesure tout.
 * L804 : un v2/dist périmé est construit (`npm run build`), puis le banc se relance sur le dist neuf ; tout refus (code 2) ou toute erreur laisse sa cause
 * dans `complet-refus.txt`, que `bench statut` montre en ⚠ (hook de démarrage, tour du lead) jusqu'au prochain banc complet qui mesure.
 */
export async function complet(args: string[], io: Io, d: Deps = { bench, sequence, bruit: bruitDuSamedi, construction: CONSTRUCTION }): Promise<number> {
  const racine = racineBanc(io.env), erreurs: string[] = [];
  const suivi: Io = { ...io, err: (l) => { erreurs.push(l); io.err(l); } };
  const refuser = (cause: string) => { noterRefus(racine, io.now(), cause); return 2; };
  try {
    const c = d.construction;
    const vieux = c?.perime(c.repo);
    if (c && vieux) {
      const sale = c.nonCommite(c.repo); // avant toute construction : jamais de travail en cours compilé dans le dist lié (revue L804 M1)
      if (sale) { suivi.err(`bench complet refusé, v2 non construit : ${sale}`); return refuser(erreurs.join(' ')); }
      if (io.env.CADENCE_BANC_CONSTRUIT) { // ENV_CONSTRUIT, posée par la relance : pas de seconde construction
        suivi.err(`bench complet refusé : ${vieux} (encore après la construction)`); return refuser(erreurs.join(' '));
      }
      io.out(`banc complet : ${vieux.replace(/ : lancer .*$/, '')} ; construction de v2 (npm run build) avant de mesurer`);
      const echec = c.construire(c.repo);
      if (echec) { suivi.err(`bench complet refusé : la construction de v2 (npm run build) a échoué : ${echec}`); return refuser(erreurs.join(' ')); }
      io.out('banc complet : v2 construit, relance sur le dist neuf');
      return await c.relancer(c.repo, ['bench', 'complet', ...args], { ...io.env, [ENV_CONSTRUIT]: '1' }, (cause) => { noterRefus(racine, io.now(), cause); });
    }
    const code = await mesurer(args, suivi, d, racine);
    return code === 2 ? refuser(erreurs.join(' ') || 'banc refusé (code 2), cause absente du journal') : code;
  } catch (e) {
    noterRefus(racine, io.now(), `erreur : ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

async function mesurer(args: string[], io: Io, d: Deps, racine: string): Promise<number> {
  const choix = args.indexOf('--sequences') >= 0 ? args[args.indexOf('--sequences') + 1] : undefined;
  const juge = args.indexOf('--juge') >= 0 ? args[args.indexOf('--juge') + 1] : undefined;
  if ((args.includes('--sequences') && !choix) || (args.includes('--juge') && !juge)) { io.err(USAGE_COMPLET); return 2; }
  const ids = choix ? choix.split(',').filter(Boolean) : sequencesDe(racine);
  if (ids.length === 0) { io.err(`bench complet refusé : aucune séquence sous ${join(racine, 'sequences')}`); return 2; }
  const bras = ['--candidat', PUBLIE.candidat, '--reference', PUBLIE.reference, ...(juge ? ['--juge', juge] : [])];
  io.out(`banc complet : court, puis séquence(s) ${ids.join(', ')} (${PUBLIE.candidat} contre ${PUBLIE.reference})`);
  const bruit = numerosARemesurer(racine, io.now());
  if (bruit.length) await d.bruit(bruit, io); // correctif L738 : seul ce passage compte pour le bruit, pas `bench bruit` à la main
  const codes = [await d.bench(['court', ...bras], io)];
  if (codes[0] === 2) return 2;
  effacerRefus(racine); // le banc mesure : l'ancien refus n'est plus d'actualité
  for (const id of ids) codes.push(await d.sequence([id, '--repetitions', '2', ...bras], io));
  await d.bench(['statut'], io);
  return codes.every((c) => c === 0) ? 0 : 1;
}
