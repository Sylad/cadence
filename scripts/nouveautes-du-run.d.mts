export const DOSSIER_NOUVEAUTES: string;
export function lotDuPlan(repo: string, lot: string | undefined): (Record<string, unknown> & { id: string; visible?: unknown; screen?: unknown; spec?: unknown }) | undefined;
export function lotVisible(repo: string, lot: string | undefined): boolean;
export function consigneNouveautes(lot: string, o?: { maintenant?: Date; regenere?: boolean; dossier?: string }): string;
export function entreesQuiCitent(repo: string, lot: string, o?: { ref?: string; dossier?: string }): string[] | null;
export function ligneNouveautes(lot: string, entrees: string[] | null, dossier?: string): string;
