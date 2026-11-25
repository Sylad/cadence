export function fichierDeCode(f: string): boolean;
export function lireEtats(dossier: string, depuis?: string): Record<string, unknown>[];
export interface Compte { runs: number; passes: number; mesurees: number; sansCode: number; sansCommit: number; nonMesurees: number; sensibles: number; runsSensibles: number }
export function mesurer(etats: unknown[]): { total: Compte; parProjet: Record<string, Compte> };
export function rendre(r: { total: Compte; parProjet: Record<string, Compte> }, dossier: string, depuis?: string): string;
/** Ce qu'une correction après porte rouge a commité (L842). */
export interface Commits { commits?: number; fichiers?: string[] }
export function avecMesure<T>(corrections: Commits[] | undefined, cwd: string, actif: boolean, f: () => T): T;
