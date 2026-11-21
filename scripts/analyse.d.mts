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
/** La garde d'identité de l'analyse contre le départ du lot : un outil apparu, retiré ou modifié sous `analyse:`, une base absente au départ ou une `configs` changée, hors d'un lot `config: true`. */
export function identiteChangee(racine: string, ref: import('./qualite.mjs').Ref, outils: OutilAnalyse[], parse: (texte: string) => unknown): { code: number; texte: string } | null;
