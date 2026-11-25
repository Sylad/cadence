export interface PorteRapide { command: string; dir: string; full: string[] }
export const SCRIPT: string;
export function aucunTest(sortie: string): boolean;
export function motif(p: string): (f: string) => boolean;
export function ensemble(motifs: string[]): (f: string) => boolean;
export function commandeDerivee(test: unknown): string | null;
export function lirePorteRapide(run: unknown, orchestrate: unknown, fichier: string): PorteRapide | null;
export function selectionner(racine: string, depart: string, cfg: PorteRapide, yaml?: unknown): { fichiers: string[]; commande: string; motif?: undefined } | { motif: string; fichiers?: undefined; commande?: undefined };
export function choisir(racine: string, touches: string[], retires: string[], cfg: PorteRapide, yaml?: unknown): ReturnType<typeof selectionner>;
export function etapeTests(racine: string, depart: string, cfg: PorteRapide | null, yaml: unknown, complete: string[]): { commandes: string[]; ciblee: boolean; ligne?: string };
export function jouer(liee: string, complete: string, io?: { out: (t: string) => void; err: (t: string) => void }): number;
