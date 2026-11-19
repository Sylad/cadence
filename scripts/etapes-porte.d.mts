export interface PartiePorte { dir: string; run: string; replay?: string }
export type PortePorte = string | PartiePorte[];
export interface EtapePorte { nom: 'build' | 'tests'; porte: PortePorte; commandes: string[] }
export function lirePorteTest(brut: unknown): { porte: PortePorte; refus?: undefined } | { refus: string; porte?: undefined };
export function commandeDePartie(partie: PartiePorte, commande?: string): string;
export function lireEtapes(orchestrate: unknown): { etapes: EtapePorte[]; refus?: undefined } | { refus: string; etapes?: undefined };
