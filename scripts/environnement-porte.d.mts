export interface Perime { probleme: string; remede: string }
export const JOUER_QUAND_MEME: string;
export function ecartsLockfile(dossier: string): string[];
export function satisfait(version: string, plage: string): boolean | null;
export function nodeDuPath(env?: Record<string, string | undefined>): string | null;
export function environnementPerime(racine: string, env?: Record<string, string | undefined>, node?: string | null): Perime[];
export function lignesPerime(qui: string, problemes: Perime[]): string[];
export function ignorerPerime(env?: Record<string, string | undefined>): boolean;
