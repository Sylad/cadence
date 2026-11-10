import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Io } from '../cli.js';
import { executerRun, repondreRun, type Etat } from './run.js';

export const AIDE_RUN = `  cadence run "<demande>" [--piece chemin]… [--taille retouche|fonction] [--complet] [--sans-porte]   une demande, une session Opus (mode complet si références), porte, intégration
  cadence run --reponse <id> "<texte>"   reprend un run en attente ou rendu, dans la même session
  cadence run --liste                    les runs du dépôt et leur état`;

export async function cmdRun(a: string[], io: Io): Promise<number> {
  const out = io.out;
  try {
    if (a[0] === '--liste') {
      const racine = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' }).trim(), d = join(dirname(racine), '.cadence-run');
      const etats = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Etat).filter((e) => e.repo === racine) : [];
      for (const e of etats) out(`${e.id}  ${e.etat}  ${e.demande.split('\n')[0].slice(0, 80)}`);
      if (!etats.length) out('aucun run');
      return 0;
    }
    if (a[0] === '--reponse') {
      if (!a[1] || !a[2]) { io.err('usage : cadence run --reponse <id> "<texte>"'); return 2; }
      return repondreRun(a[1], io.cwd, a.slice(2).join(' '), { out }).etat === 'integre' ? 0 : 1;
    }
    const pieces: string[] = [], mots: string[] = []; let taille: string | undefined, sansPorte = false, complet = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--piece') pieces.push(a[++i]);
      else if (a[i] === '--taille') taille = a[++i];
      else if (a[i] === '--sans-porte') sansPorte = true;
      else if (a[i] === '--complet') complet = true;
      else mots.push(a[i]);
    }
    if (!mots.length || pieces.some((p) => !p) || (taille && !['retouche', 'fonction'].includes(taille))) { io.err(`usage :\n${AIDE_RUN}`); return 2; }
    return executerRun({ repo: io.cwd, demande: mots.join(' '), pieces, taille, complet, out, sansPorte }).etat === 'integre' ? 0 : 1;
  } catch (e) { io.err(String((e as Error).message ?? e)); return 1; }
}
