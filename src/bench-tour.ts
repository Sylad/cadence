// L730 (D-22) : l'alerte de la garde de publication dans le tour du lead. La garde est proportionnée (banc mécanique avant une publication,
// banc complet le samedi) ; un banc complet rouge, ou un samedi manqué, se lit au tour, sans attendre la prochaine release.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Lance `bench statut` du dépôt : code et sortie, ou l'erreur. Substituable dans les tests. */
export type StatutBanc = (cli: string, env: NodeJS.ProcessEnv) => { code: number | null; sortie: string; erreur?: string };
const statutBanc: StatutBanc = (cli, env) => {
  const r = spawnSync(process.execPath, [cli, 'bench', 'statut'], { env, encoding: 'utf8', timeout: 10_000 });
  return { code: r.status, sortie: `${r.stdout ?? ''}`, erreur: r.error?.message ?? (r.signal ? `signal ${r.signal}` : r.status !== 0 ? (r.stderr ?? '').trim() : undefined) };
};

/** Les lignes ⚠ du banc complet que `cadence2 bench statut` donne pour chaque dépôt qui porte un v2 construit ; une ligne quand le statut est illisible. */
export function tourBancLines(roots: string[], env: NodeJS.ProcessEnv, lire: StatutBanc = statutBanc): string[] {
  return roots.flatMap((root) => {
    const cli = join(root, 'v2', 'bin', 'cadence2.js');
    if (!existsSync(cli) || !existsSync(join(root, 'v2', 'dist', 'cli.js'))) return [];
    const r = lire(cli, env);
    if (r.erreur || r.code !== 0) return [`${basename(root)} · garde du banc : statut illisible (${r.erreur || `code ${r.code}`})`];
    return r.sortie.split('\n').filter((l) => l.startsWith('⚠') && l.includes('banc complet')).map((l) => `⚠ ${basename(root)} · ${l.slice(1).trim()}`);
  });
}
