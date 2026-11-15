export function option(args: string[], nom: string): string | undefined;
export function sans(args: string[], noms: string[]): string[];
export function casSousLeSeuil(agregat: { suite?: { threshold?: number }; cases: { name: string; aggregates: { score: number } }[] }): { name: string; score: number }[];
export function argsDuRejeu(args: string[], cas: string, dossier: string, plafond?: number): string[];
export interface Rejoue { name: string; premier: number; rejeu: number | null; raison?: string; passe: boolean }
export function rapportRejeu(seuil: number, rejoues: Rejoue[]): string;
export function evalAvecRejeu(
  argv: string[],
  opts?: { run?: (cmd: string, args: string[]) => number; maintenant?: Date; log?: (s: string) => void },
): number;
export function avecSeparateur(cmd: string, args: string[]): string[];
export function plafondDe(cmd: string, args: string[], racine?: string): number | undefined;
