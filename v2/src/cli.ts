import { bench } from './bench/cli.js';
import { sequence } from './sequence/cli.js';
import { AIDE_RUN, cmdRun } from './run/cli.js';
export type Io = { cwd: string; env: NodeJS.ProcessEnv; out: (l: string) => void; err: (l: string) => void; now: () => Date };
type Commande = (args: string[], io: Io) => Promise<number>;

export const COMMANDES: Record<string, Commande> = {};
COMMANDES.run = cmdRun;
COMMANDES.bench = (a, io) => (a[0] === 'sequence' ? sequence(a.slice(1), io) : bench(a, io)); // le banc séquence vit dans son module

const AIDE = `cadence2 — noyau de cadence 2 (en construction)
  cadence2 bench court|hebdo|eclair|micro|mecanique|lancer|statut|verifier-publication|ajouter [--paralleles N]   banc de mesure (docs/v2/banc.md)
  cadence2 bench sequence <id> [--candidat c] [--reference r] [--repetitions N] [--juge modèle]   banc séquence (docs/v2/banc.md)
${AIDE_RUN}`;

export async function run(args: string[], io: Io): Promise<number> {
  const [nom, ...reste] = args;
  if (!nom || nom === 'help' || nom === '--help') { io.out(AIDE); return 0; }
  const c = COMMANDES[nom];
  if (!c) { io.err(`cadence2 : commande inconnue : ${nom}`); return 2; }
  return c(reste, io);
}
