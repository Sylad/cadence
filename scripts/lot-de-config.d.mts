import type { Ref } from './qualite.mjs';
/** Ce qu'un cliquet juge de ses configs : `changees()` rend les libellés « fichier[#clé] (état) » qui diffèrent du départ ; `estConfig` ce qu'un lot `config: true` peut toucher. */
export type JeuConfig = { actif: boolean; changees: () => string[]; estConfig: (fichier: string) => boolean; raison: string };
export function configChangee(racine: string, ref: Ref | null, jeu: JeuConfig): { code: number; texte: string } | null;
export function fichiersDifferents(racine: string, ref: Ref, fichiers: string[]): string[];
export function lotsDeConfig(config: (chemin: string) => string | null): Set<string>;
export function lireSiPresent(racine: string, fichier: string): string | null;
export function differences(couples: [string, string | null, string | null][]): string[];
