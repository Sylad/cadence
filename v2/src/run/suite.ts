// Suite de session d'un lot à l'autre (L690, D-4) : ce que cadence garde quand il compacte une session avant le lot suivant,
// et quand il compacte : toujours (« compactee », rejeté au micro-banc du 10-11 : ×3 en coût) ou au seuil (« seuil », idée de Sylvain).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Suite = 'gardee' | 'compactee' | 'seuil';
export const SEUIL_CONTEXTE = 150_000; // le seuil que /usage montre le plus souvent (Sylvain, 10-11)
export const COMPACTAGE = '/compact Garde : les décisions prises et pourquoi, les fichiers touchés et leur rôle, les conventions du dépôt, '
  + 'les demandes encore ouvertes (y compris « pour plus tard ») mot pour mot. Jette : les sorties de tests et de commandes, le contenu des fichiers lus en entier.';

/** Taille du contexte de la session à sa dernière requête (entrée + cache lu + cache écrit), lue dans son journal ; 0 si introuvable. */
export function tailleContexte(session: string, home = homedir()): number {
  const d = join(home, '.claude', 'projects');
  for (const p of existsSync(d) ? readdirSync(d) : []) {
    const f = join(d, p, `${session}.jsonl`);
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').trim().split('\n').reverse()) {
      try {
        const u = (JSON.parse(l) as { message?: { usage?: Record<string, number> } }).message?.usage;
        if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      } catch { /* ligne illisible : la précédente */ }
    }
  }
  return 0;
}
export const doitCompacter = (suite: Suite | undefined, reprise: string | undefined, home = homedir()): boolean =>
  !!reprise && (suite === 'compactee' || (suite === 'seuil' && tailleContexte(reprise, home) > SEUIL_CONTEXTE));
