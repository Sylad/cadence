import { bench } from './bench/cli.js';
import { sequence } from './sequence/cli.js';
export type Io = { cwd: string; env: NodeJS.ProcessEnv; out: (l: string) => void; err: (l: string) => void; now: () => Date };
type Commande = (args: string[], io: Io) => Promise<number>;

export const COMMANDES: Record<string, Commande> = {};
COMMANDES.bench = (a, io) => (a[0] === 'sequence' ? sequence(a.slice(1), io) : bench(a, io)); // le banc séquence vit dans son module

const AIDE = `cadence2 — noyau de cadence 2 (en construction)
  cadence2 bench court|hebdo|eclair|lancer|statut|verifier-publication|ajouter   banc de mesure (docs/v2/)
  cadence2 bench sequence <id> [--candidat c] [--reference r] [--repetitions N] [--juge modèle]   banc séquence (docs/v2/banc.md)`;

export async function run(args: string[], io: Io): Promise<number> {
  const [nom, ...reste] = args;
  if (!nom || nom === 'help' || nom === '--help') { io.out(AIDE); return 0; }
  const c = COMMANDES[nom];
  if (!c) { io.err(`cadence2 : commande inconnue : ${nom}`); return 2; }
  return c(reste, io);
}
