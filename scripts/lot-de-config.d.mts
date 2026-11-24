import type { Ref } from './qualite.mjs';
/** Ce qu'un cliquet juge de ses configs : `changees()` rend les libellés « fichier[#clé] (état) » qui diffèrent du départ ; `estConfig` ce qu'un lot `config: true` peut toucher. */
export type JeuConfig = { actif: boolean; changees: () => string[]; estConfig: (fichier: string) => boolean; raison: string };
export function configChangee(racine: string, ref: Ref | null, jeu: JeuConfig): { code: number; texte: string } | null;
export function fichiersDifferents(racine: string, ref: Ref, fichiers: string[]): string[];
export function lotsDeConfig(config: (chemin: string) => string | null): Set<string>;
export function lireSiPresent(racine: string, fichier: string): string | null;
export function differences(couples: [string, string | null, string | null][]): string[];
export function planNatif(config: (chemin: string) => string | null): boolean;
/** Le lot de config qui peut faire monter la base `baseline` (L824) : celui de la branche, ou les lots `config: true` que citent tous les commits ; null sinon. */
export function lotDeConfigQuiMonte(ref: Ref | null, baseline: string): string | null;
/** Les clés où la base diffère de la mesure (L824) : vide quand la base est la mesure, clé par clé. */
export function ecartsALaMesure(base: Record<string, number>, mesure: Record<string, number>): { cle: string; avant: number | 'absente'; apres: number | 'absente' }[];
