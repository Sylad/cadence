export const BASELINE: string;
export type Mesure = Record<string, number>;
export function lireEslint(json: { filePath: string; messages: { ruleId: string | null; message: string }[] }[], racine: string): Mesure;
export function lireKnip(json: { files?: string[]; issues?: Record<string, unknown>[] }, racine: string): Mesure;
export function lireJscpd(rapport: { duplicates?: { firstFile: { name: string }; secondFile: { name: string } }[] }): Mesure;
export function comparer(base: Mesure, courant: Mesure): { pires: { cle: string; avant: number; apres: number }[]; mieux: { cle: string; avant: number; apres: number }[] };
export function lireBase(racine: string): Mesure;
export function mesurer(racine: string): Mesure;
export function appliquer(racine: string, mode: 'verifier' | 'init' | 'ecrire', mesure?: Mesure): { code: number; texte: string };
