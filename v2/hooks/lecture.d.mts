export type Entree = Record<string, unknown>;
export declare const ECRITURES: string[];
export declare const cheminOutil: (input: Entree | undefined) => string | undefined;
export declare const lectureEntiere: (input: Entree | undefined) => boolean;
export declare const dansClone: (p: string, clone: string) => boolean;
export declare function appelsOutils(ligne: string): { name: string; input: Entree }[];
