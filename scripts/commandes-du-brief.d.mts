export const OUTILS_CADENCE: string[];
export function demandeToucheFiches(demande: string): boolean;
export function commandesNommees(repo: string, orchestrate: unknown, demande: string, lot?: string): { texte: string; nommeSpec: boolean };
export function leverPourSpec(brief: string): string;
export function interditsPourSpec(interdits: string[]): string[];
export function lotAFiches(repo: string, lot: string | undefined): boolean;
export function avecRefusCadence<T extends { hooks?: Record<string, unknown[]> }>(reglages: T, hooks: string): T & { hooks: Record<string, unknown[]> };
export function cadenceHorsSpecCheck(commande: string): string | null;
