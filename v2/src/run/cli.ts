import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { Io } from '../cli.js';
import { executerRun, repondreRun, type Etat } from './run.js';

export const AIDE_RUN = `  cadence run "<demande>" [--piece chemin]… [--lot L12] [--taille retouche|fonction] [--complet] [--sans-porte] [--fond]   une demande, une session Opus (mode complet si références), porte, intégration
  cadence run --reponse <id> "<texte>"   reprend un run en attente ou rendu, dans la même session
  cadence run --liste                    les runs du dépôt et leur état
  --fond : le run se détache (il survit à la session qui l'a lancé), son journal est dans ../.cadence-run/`;

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
    const pieces: string[] = [], mots: string[] = []; let taille: string | undefined, lot: string | undefined, sansPorte = false, complet = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--piece') pieces.push(a[++i]);
      else if (a[i] === '--taille') taille = a[++i];
      else if (a[i] === '--sans-porte') sansPorte = true;
      else if (a[i] === '--complet') complet = true;
      else if (a[i] === '--lot') lot = a[++i];
      else if (a[i] !== '--fond') mots.push(a[i]);
    }
    if (a.includes('--fond')) { // relancé détaché, sans --fond : vécu au pro le 10-11, une session de lot morte avec celle qui l'avait lancée
      const racine = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' }).trim(), d = join(dirname(racine), '.cadence-run');
      mkdirSync(d, { recursive: true });
      const journal = join(d, `fond-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.log`), fd = openSync(journal, 'a');
      spawn(process.execPath, [process.argv[1], 'run', ...a.filter((x) => x !== '--fond')], { cwd: io.cwd, detached: true, stdio: ['ignore', fd, fd] }).unref();
      out(`cadence run lancé en arrière-plan ; journal : ${journal} ; état : cadence run --liste`);
      return 0;
    }
    if (!mots.length || pieces.some((p) => !p) || (lot !== undefined && !lot) || (taille && !['retouche', 'fonction'].includes(taille))) { io.err(`usage :\n${AIDE_RUN}`); return 2; }
    return executerRun({ repo: io.cwd, demande: mots.join(' '), pieces, taille, complet, lot, out, sansPorte }).etat === 'integre' ? 0 : 1;
  } catch (e) { io.err(String((e as Error).message ?? e)); return 1; }
}
