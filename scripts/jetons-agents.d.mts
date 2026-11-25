export interface AppelAgent {
  session: string;
  date: string | null;
  modeles: Record<string, number>;
  opus: number;
  total: number;
  /** L839 : appels d'outils du sous-agent. */
  outils: number;
  reponse: string;
  ratee: boolean;
}
export function nomCourt(type: unknown): string;
export function jetonsParModele(texte: string): Record<string, number>;
export function appelsAgent(texte: string): { type: string; prompt: string; date: string | null }[];
export function promptDe(texte: string): string | null;
export function reponseDe(texte: string): string;
export function outilsDe(texte: string): number;
export function estRatee(reponse: string): boolean;
export function collecter(projects: string, agent?: string): AppelAgent[];
export function rendre(appels: AppelAgent[], agent?: string): string;
export function main(argv: string[]): string;
