// Déclaration de scripts/sondes-interaction.mjs (L778) pour les tests TypeScript.
export interface Options {
  seuil: number; max: number; parListe: number; attente: number; charge: number; repos: number; largeur: number; hauteur: number;
  url?: string; attendus?: string; route?: string; json?: string; captures?: string; sansBalayage?: boolean;
}
export interface Region { distance: number; cote: 'au-dessus' | 'en dessous' | 'à côté'; region: string; texte: string }
export interface Mesure {
  nonMesure?: string; connecte?: boolean; sautMax?: number | null; sautFinal?: number | null;
  defilement?: Array<{ cible: string; dx: number; dy: number }>;
  regions?: { proche: Region | null; dessus: Region | null; horsVue: boolean; nombre: number } | null;
  etatChange?: boolean; navigation?: boolean;
  dialogue?: { nom: string; focusDedans: boolean } | null;
  echap?: { ferme: boolean; focusRendu: boolean } | null;
}
export interface Constat { type: 'saut' | 'defilement' | 'hors-vue' | 'focus' | 'echap' | 'focus-rendu'; valeur: number; texte: string }
export interface Controle { id: string; nom: string; role: 'bascule' | 'bouton'; liste: boolean; mesure: Mesure; retour?: Mesure; constats: Constat[]; capture?: string }
export interface Pas { etape: string; nom?: string; mesure?: Mesure; nonMesure?: string; constats: Constat[]; capture?: string }
export interface Rapport {
  url: string; largeur: number; hauteur: number; seuil: number; date: string;
  repos: Array<{ cible: string; dx: number; dy: number }>; controles: Controle[]; parcours: Array<{ nom: string; pas: Pas[] }>; ecrituresBloquees: number;
}
export type Etape = { type: 'cliquer'; sel: string; n: number } | { type: 'attendre'; ms: number } | { type: 'touche'; touche: string };
export interface Parcours { nom: string; etapes: Etape[] }
export interface Io { cwd: string; env: NodeJS.ProcessEnv; out: (l: string) => void; err: (l: string) => void }
export interface Navigateur { navigateur: unknown; chemin: string; fermer: () => Promise<void> }

export const DEFAUTS: Readonly<Options>;
export function lireParcours(texte: string, route: string): Parcours[];
export function cheminsPlaywright(env: Record<string, string | undefined>, cwd: string, processus: string[], caches: string[]): string[];
export function lancerNavigateur(env: Record<string, string | undefined>, cwd: string): Promise<Navigateur | null>;
export function constatsClic(m: Mesure | null | undefined, seuil: number): Constat[];
export function sonder(navigateur: unknown, url: string, o: Options, parcours: Parcours[]): Promise<Rapport>;
export function tousLesConstats(r: Rapport): Array<Constat & { ou: string }>;
export function nonMesures(r: Rapport): string[];
export function formater(r: Rapport): string;
export function lireOptions(argv: string[]): Options & { url: string };
export function main(argv: string[], io: Io): Promise<number>;
