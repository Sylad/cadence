import { bench } from './bench/cli.js';
export type Io = { cwd: string; env: NodeJS.ProcessEnv; out: (l: string) => void; err: (l: string) => void; now: () => Date };
type Commande = (args: string[], io: Io) => Promise<number>;

export const COMMANDES: Record<string, Commande> = {};
COMMANDES.bench = bench;

const AIDE = `cadence2 — noyau de cadence 2 (en construction)
  cadence2 bench court|hebdo|lancer|statut|verifier-publication|ajouter   banc de mesure (docs/v2/)`;

export async function run(args: string[], io: Io): Promise<number> {
  const [nom, ...reste] = args;
  if (!nom || nom === 'help' || nom === '--help') { io.out(AIDE); return 0; }
  const c = COMMANDES[nom];
  if (!c) { io.err(`cadence2 : commande inconnue : ${nom}`); return 2; }
  return c(reste, io);
}
