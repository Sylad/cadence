export const BASELINE: string;
export type Mesure = Record<string, number>;
export function lireEslint(json: { filePath: string; messages: { ruleId: string | null; message: string }[] }[], racine: string): Mesure;
export function lireKnip(json: { files?: string[]; issues?: Record<string, unknown>[] }, racine: string): Mesure;
/** `perimetres[nom]` : les fichiers (relatifs à `racine`) que l'outil de la directive `nom` analyse. */
export function lireDirectives(racine: string, perimetres: Record<string, Iterable<string>>): Mesure;
export function lireJscpd(rapport: { duplicates?: { firstFile: { name: string }; secondFile: { name: string }; lines?: number }[] }): Mesure;
export function comparer(base: Mesure, courant: Mesure): { pires: { cle: string; avant: number; apres: number }[]; mieux: { cle: string; avant: number; apres: number }[] };
export function serialiser(mesure: Mesure): string;
export function lireBase(racine: string): Mesure;
export function mesurer(racine: string): Mesure;
export type Ref = { nom: string; base: Mesure | null; existe?: (chemin: string) => boolean; contenu?: (chemin: string) => string | null; config?: (chemin: string) => string | null; fichiers?: () => string[]; touches?: () => string[]; commits?: () => { sujet: string; fichiers: string[] }[]; lotsConfig?: Set<string>; lotConfig?: boolean };
export type Pire = { cle: string; avant: number; apres: number; note?: string };
/** `lien(neuf)` : la source liée ou null ; `lien.proche(neuf)` : la source la plus proche même sous le seuil, avec la part des lignes du fichier neuf qui en viennent. */
export type Lien = ((neuf: string) => string | null) & { proche?: (neuf: string) => { source: string; part: number } | null };
/** `lecture` : le contenu d'un fichier au point de départ (null s'il n'y était pas ; lève si git échoue), de la source aujourd'hui (null si disparue) et du fichier neuf. */
export function creerLien(base: Mesure, lecture: { depart: (chemin: string) => string | null; courant: (chemin: string) => string | null; neuf: (chemin: string) => string | null }): Lien;
export function comparerMigration(avant: Mesure, apres: Mesure, existe: (chemin: string) => boolean, lien?: Lien, depart?: Mesure): Pire[];
export function lireRef(racine: string, ref: string): Ref;
export function appliquer(racine: string, mode: 'verifier' | 'init' | 'ecrire' | 'migrer', mesure?: Mesure, ref?: Ref | null): { code: number; texte: string };
export function retardSurBranche(racine: string, ref: string): { code: number; texte: string } | null;
export function refDepartLot(racine: string, branche?: string): string;
