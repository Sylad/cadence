export type Mesure = Record<string, number>;
export interface OutilAnalyse { name: string; command: string; format: string; dir: string; report?: string; baseline: string; configs: string[] }
export const SCRIPT: string;
export const DOSSIER_BASES: string;
export const LECTEURS: Record<string, (texte: string, racine: string, dir: string, code: number | null) => Mesure>;
export function lireAnalyse(valeur: unknown, fichier: string): OutilAnalyse[];
export function lireDirectives(racine: string, dir: string, format: string): Mesure;
export function mesurerOutil(racine: string, outil: OutilAnalyse): Mesure;
export function jugerOutil(racine: string, outil: OutilAnalyse, mode: 'verifier' | 'init' | 'ecrire' | 'migrer', mesure: Mesure, ref?: import('./qualite.mjs').Ref | null): { code: number; texte: string };
export function commandePorte(cible: string): string;
export function main(argv: string[], io: { cwd: string; out: (l: string) => void; err: (l: string) => void }): Promise<number>;
export function etapeAnalyse(valeur: unknown, cible: string): { commandes: string[]; refus?: string };
/** Les adoptions déclarées par les commits du lot (`Analyse-adoption: <outil>` dans un message, `contre..HEAD`) : nom d'outil → sha court. */
export function adoptionsDeclarees(racine: string, contre: string): Map<string, string>;
/**
 * La garde de l'analyse contre le départ du lot : un outil retiré ou modifié sous `analyse:` ou une `configs` changée hors d'un lot `config: true`, une base
 * née sans lot `config: true` ni adoption déclarée. `neuves` : les bases nées dans le lot et ce qui les autorise (à afficher).
 */
export function gardeIdentite(racine: string, ref: import('./qualite.mjs').Ref, outils: OutilAnalyse[], parse: (texte: string) => unknown, declarees?: Map<string, string>): { refus: { code: number; texte: string } | null; neuves: string[] };
