import type { PartiePorte } from './etapes-porte.mjs';
export const REJEUX_MAX: number;
export const REJEU_MS: number;
export interface CibleRejeu { fichier: string | null; commande: string; filtre?: boolean; titreNode?: boolean }
export type Rejeu = { forme: string; cible: (nom: string, sortie: string) => CibleRejeu | null; raison?: undefined } | { raison: string; forme?: undefined; cible?: undefined };
export function rejeuDeLaCommande(run: string, declare: string | undefined, dossier: string, partie?: PartiePorte): Rejeu;
export function rejeuxDesTests(orchestrate: unknown, racine: string): Map<string, Rejeu>;
export function testsReussis(sortie: string): number;
export function rougesDotnet(sortie: string): string[];
export function envRejeu(env: NodeJS.ProcessEnv, coeurs?: number): NodeJS.ProcessEnv;
export interface Joue { code: number; sortie: string; ms: number }
export function jouerRejeu(commande: string, cwd: string): Joue;
export interface Rejoue { sensibles: { test: string; ms: number }[]; rouges: string[]; raison?: string }
export function rejouerRouges(sortie: string, rejeu: Rejeu | undefined, jouer: (commande: string) => Joue): Rejoue;
