// Aiguillage de cadence run (10-11) : le brief complet ne gagne au banc que quand la demande a des références à lire
// (normes, captures : AetherWX) ; sans elles, Claude seul fait aussi bien plus vite (banc court du 10-11).
// La règle est mécanique : une pièce donnée, ou un mot de la section `references` de cadence.yaml dans la demande.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { DefBras } from '../bench/bras.js';

const BRIEFS = join(import.meta.dirname, '..', '..', 'briefs');
export const BRAS_COMPLET: DefBras = { nom: 'sequence-v2d', modele: 'opus', brief: join(BRIEFS, 'bras-sequence-v2d.md'), settings: join(BRIEFS, 'settings-sequence-v2.json') };
export const BRAS_LEGER: DefBras = { nom: 'A', modele: 'opus', brief: join(BRIEFS, 'bras-A.md') };
export interface Aiguillage { mode: 'complet' | 'leger'; bras: DefBras; pieces: string[]; raison: string }

const plat = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const contient = (texte: string, mot: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${plat(mot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(texte);

/** `pieces` : relatives au dépôt. Rend les pièces à lire (données d'abord, puis documents des références trouvées, existants). */
export function aiguiller(demande: string, repo: string, pieces: string[], forcer = false): Aiguillage {
  const f = join(repo, 'cadence.yaml');
  const refs = existsSync(f) ? (parse(readFileSync(f, 'utf8')) as { references?: unknown } | null)?.references : undefined;
  if (refs !== undefined && !(Array.isArray(refs) && refs.every((r) => Array.isArray(r?.mots) && Array.isArray(r?.docs))))
    throw new Error('cadence.yaml : references attend une liste de { mots: [...], docs: [...] }');
  const texte = plat(demande), trouves: string[] = [], docs = [...pieces];
  for (const r of (refs ?? []) as { mots: string[]; docs: string[] }[]) {
    const mot = r.mots.find((m) => contient(texte, String(m)));
    if (!mot) continue;
    const ici = r.docs.filter((x) => existsSync(join(repo, x)));
    trouves.push(`${mot} → ${ici.join(', ') || 'aucun document présent'}`);
    for (const x of ici) if (!docs.includes(x)) docs.push(x);
  }
  const complet = forcer || pieces.length > 0 || trouves.length > 0;
  const raison = [forcer ? '--complet' : '', pieces.length ? `pièces données : ${pieces.join(', ')}` : '', ...trouves].filter(Boolean).join(' ; ');
  return { mode: complet ? 'complet' : 'leger', bras: complet ? BRAS_COMPLET : BRAS_LEGER, pieces: docs, raison: raison || 'aucune référence dans la demande' };
}
