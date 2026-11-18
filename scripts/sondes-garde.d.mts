// Déclaration de scripts/sondes-garde.mjs (L778, revue r2) pour les tests TypeScript.
import type { Ecriture } from './sondes-interaction.mjs';
export interface Garde {
  ouvrirPasse(ecritures: Ecriture[]): void;
  fermerPasse(): { echecs: string[]; workers: Array<{ type: string; url: string }> };
  fermer(): void;
}
export const ARG_DEBOGAGE: string;
export const PRELUDE_WORKER: string;
export function gardeDe(navigateur: unknown): Garde | undefined;
export function armerGarde(navigateur: unknown, dossier: string): Promise<Garde>;
export function couperLesEcritures(contexte: unknown, ecritures: Ecriture[], coupees?: Array<{ nom: string; fois: number }>, restes?: string[], erreurs?: string[]): Promise<void>;
export function lectureSeule(r: import('./sondes-interaction.mjs').Rapport): string[];
