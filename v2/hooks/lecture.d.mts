export type Entree = Record<string, unknown>;
export interface Appel { id?: string; name: string; input: Entree; cwd?: string }
export interface Lecture { lue: boolean; entiere: boolean; pages_inconnues: boolean }
export declare const ECRITURES: string[];
export declare const cheminOutil: (input: Entree | undefined) => string | undefined;
export declare function reel(p: string): string;
export declare const dansClone: (p: string, clone: string) => boolean;
export declare const reglageClaude: (p: string, home: string | undefined) => boolean;
export declare function ecritureBash(cmd: string, clone: string, cwd?: string): boolean;
export declare const contournement: (name: string, input: unknown, home: string | undefined) => boolean;
export declare function evenements(ligne: string): { appels: Appel[]; resultats: { id: string; erreur: boolean }[] };
export declare const pagesDe: (f: string) => number | null;
export declare function couverture(f: string, inputs: Entree[]): { entiere: boolean; pages_inconnues: boolean };
export declare function lectures(appels: Appel[], ok: Set<string | undefined>, pieces: string[]): Map<string, Lecture>;
