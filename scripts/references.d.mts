export interface ReferenceRun { mots: string[]; docs: string[] }
export interface References { dir?: string; run: ReferenceRun[]; migration?: string }
export const MIGRATION_REFERENCES: string;
export function lireReferences(valeur: unknown, fichier: string): References;
