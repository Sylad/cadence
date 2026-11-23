export interface Reglages { phrase: number; consigne: number; passif: boolean; pointVirgule: boolean; depuis?: string }
export type Signal =
  | { type: 'longue' | 'consigne-longue'; mots: number; seuil: number }
  | { type: 'passif'; forme: string }
  | { type: 'point-virgule' };
export interface Phrase { ligne: number; mots: number; consigne: boolean; texte: string; signaux: Signal[] }
export interface Bilan { phrases: number; mots: number; moyenne: number; longues: number; consignesLongues: number; passives: number; pointsVirgules: number }
export const SCRIPT: string;
export const DEFAUTS: Readonly<Reglages>;
export const AIDE: string;
export function lireEcriture(valeur: unknown, fichier: string): Reglages;
export function blocs(texte: string): { ligne: number; texte: string }[];
export function mots(phrase: string): string[];
export function phrasesDuBloc(texte: string): string[];
export function estConsigne(phrase: string): boolean;
export function passif(phrase: string): string | null;
export function signaux(phrase: string, reglages?: Reglages): Signal[];
export function analyser(texte: string, reglages?: Reglages): { phrases: Phrase[] };
export function analyserFichier(chemin: string, nom: string, reglages?: Reglages): (Phrase & { ou: string })[];
export function jourDuFrontMatter(texte: string): string | null;
export function bilan(phrases: Phrase[]): Bilan;
export function ligneBilan(titre: string, fichiers: number, b: Bilan): string;
export function ligneSignal(p: Phrase & { ou: string }, s: Signal): string;
export function fichiersDe(racine: string, chemin: string): string[];
export function nomDe(racine: string, abs: string): string;
export function mesurer(cwd: string, fichiers: { abs: string; groupe: 'nouveautes' | 'fichiers' }[], reglages: Reglages): unknown;
export function main(argv: string[], io: { cwd: string; out: (l: string) => void; err: (l: string) => void }): Promise<number>;
