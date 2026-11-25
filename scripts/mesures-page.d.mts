// Déclaration de scripts/mesures-page.mjs (L839) pour les tests TypeScript.
import type { Io, Parcours } from './sondes-interaction.mjs';

export interface Options {
  largeurs: number[]; hauteur: number; charge: number; max: number; plafondMots: number;
  url?: string; json?: string; captures?: string; etats?: Parcours[]; rendu?: 'gpu' | 'logiciel';
}
export interface Passe {
  etat: string; largeur: number; erreur?: string; capture?: string;
  vue?: number; document?: number; defilementHorizontal?: number; motsLus?: number; plafondAtteint?: boolean;
  reperes?: Array<{ sel: string; gauche: number; largeur: number; droite: number }>;
  debordements?: Array<{ sel: string; px: number; largeur: number; texte: string }>;
  tronques?: Array<{ sel: string; visible: number; contenu: number; texte: string }>;
  coupures?: Array<{ sel: string; mot: string; coupe: string; trait: boolean }>;
  separees?: Array<{ sel: string; valeur: string; unite: string }>;
  sautsDeLigne?: Array<{ sel: string; lignes: number; largeur: number; texte: string }>;
  cibles?: Array<{ sel: string; largeur: number; hauteur: number; texte: string }>;
  polices?: { min: number | null; sous12: number };
}
export interface Rapport { url: string; hauteur: number; date: string; rendu?: 'gpu' | 'logiciel'; passes: Passe[]; ecrituresCoupees: number }
export interface Groupe { famille: string; nom: string; detail: string; vus: Passe[] }

export const DEFAUTS: Readonly<Options>;
export function lireEtat(texte: string): Parcours;
export function lireOptions(argv: string[]): Options & { url: string; etats: Parcours[] };
export function mesurer(navigateur: unknown, o: Options & { url: string; etats: Parcours[] }): Promise<Rapport>;
export function constatsDe(p: Passe): number;
export function codeSortie(r: Rapport): 0 | 1 | 2;
export function ligneChiffres(p: Passe): string;
export function constatsGroupes(r: Rapport): Groupe[];
export function formater(r: Rapport, max?: number): string;
export function main(argv: string[], io: Io): Promise<number>;
