// L730 (D-22) : le banc complet du samedi, court avec juges puis chaque séquence, cadence-run contre A ; ses alertes lèvent la garde proportionnée.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../cli.js';
import { sequence } from '../sequence/cli.js';
import { racineBanc } from './banc.js';
import { bench, bruitDuSamedi, numerosARemesurer } from './cli.js';
import { PUBLIE } from './verdict.js';

export const USAGE_COMPLET = 'usage : cadence2 bench complet [--sequences id1,id2] [--juge modèle]';

/** Les séquences de la racine (`<racine>/sequences/<id>/`), dans l'ordre des noms. */
export const sequencesDe = (racine: string): string[] => {
  const d = join(racine, 'sequences');
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
};

/**
 * `cadence2 bench complet` : d'abord, s'il y en a, les bancs du court à remesurer (L738 : `bench bruit`, A contre A sans juge, sur chaque banc bruité ou
 * dont le bruit expire dans les 7 jours, le seul passage A contre A compté pour le seuil ; joué avant le court pour que son verdict lise un bruit frais, et hors du code de retour), puis le banc court (1, 3 et 6, avec juges, en série), puis chaque séquence (`--sequences`, défaut toutes celles de la racine),
 * deux répétitions, cadence-run contre A ; puis `statut`, dont les lignes ⚠ portent une alerte au journal. 0 si tout est vert, 2 si le court est refusé
 * (les séquences le seraient aussi), 1 sinon. Un court rouge n'arrête pas les séquences : le samedi mesure tout.
 */
export async function complet(args: string[], io: Io, d = { bench, sequence, bruit: bruitDuSamedi }): Promise<number> {
  const choix = args.indexOf('--sequences') >= 0 ? args[args.indexOf('--sequences') + 1] : undefined;
  const juge = args.indexOf('--juge') >= 0 ? args[args.indexOf('--juge') + 1] : undefined;
  if ((args.includes('--sequences') && !choix) || (args.includes('--juge') && !juge)) { io.err(USAGE_COMPLET); return 2; }
  const ids = choix ? choix.split(',').filter(Boolean) : sequencesDe(racineBanc(io.env));
  if (ids.length === 0) { io.err(`bench complet refusé : aucune séquence sous ${join(racineBanc(io.env), 'sequences')}`); return 2; }
  const bras = ['--candidat', PUBLIE.candidat, '--reference', PUBLIE.reference, ...(juge ? ['--juge', juge] : [])];
  io.out(`banc complet : court, puis séquence(s) ${ids.join(', ')} (${PUBLIE.candidat} contre ${PUBLIE.reference})`);
  const bruit = numerosARemesurer(racineBanc(io.env), io.now());
  if (bruit.length) await d.bruit(bruit, io); // correctif L738 : seul ce passage compte pour le bruit, pas `bench bruit` à la main
  const codes = [await d.bench(['court', ...bras], io)];
  if (codes[0] === 2) return 2;
  for (const id of ids) codes.push(await d.sequence([id, '--repetitions', '2', ...bras], io));
  await d.bench(['statut'], io);
  return codes.every((c) => c === 0) ? 0 : 1;
}
