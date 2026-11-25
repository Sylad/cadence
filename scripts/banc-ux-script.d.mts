// Déclaration de scripts/banc-ux-script.mjs (L839) : banc réduit du mode script du ux-reviewer.
import type { Options } from './mesures-page.mjs';
import type { Parcours } from './sondes-interaction.mjs';

export function jetonsImage(largeur: number, hauteur: number): number;
export function jetonsTexte(texte: string): number;
export function banc(navigateur: unknown, o: Options & { url: string; etats: Parcours[] }, capturesLues?: number): Promise<{ actuel: number; script: number; texte: string }>;
