export type Mesure = Record<string, number>;
export interface OutilAnalyse { name: string; command: string; format: string; dir: string; report?: string; baseline: string; configs: string[] }
export const SCRIPT: string;
export const DOSSIER_BASES: string;
export const LECTEURS: Record<string, (texte: string, racine: string, dir: string, code: number | null) => Mesure>;
export function lireAnalyse(valeur: unknown, fichier: string): OutilAnalyse[];
export function lireDirectives(racine: string, dir: string, format: string): Mesure;
export function mesurerOutil(racine: string, outil: OutilAnalyse): Mesure;
export function jugerOutil(racine: string, outil: OutilAnalyse, mode: 'verifier' | 'init' | 'ecrire' | 'migrer', mesure: Mesure, ref?: (import('./qualite.mjs').Ref & { analyse?: OutilAnalyse[] }) | null): { code: number; texte: string };
/** Les outils de cadence.yaml au départ du lot (vide sans fichier, sans clé ou pour une clé mal formée). */
export function outilsAuDepart(ref: import('./qualite.mjs').Ref, parse: (texte: string) => unknown): OutilAnalyse[];
/** Vrai si la ligne de base de l'outil n'était pas celle du même outil (même nom, même chemin, fichier présent) au départ : neuve, tenue à sa mesure. */
export function baseNeuve(ref: import('./qualite.mjs').Ref, departs: OutilAnalyse[], outil: OutilAnalyse): boolean;
export function commandePorte(cible: string): string;
export function main(argv: string[], io: { cwd: string; out: (l: string) => void; err: (l: string) => void }): Promise<number>;
export function etapeAnalyse(valeur: unknown, cible: string): { commandes: string[]; refus?: string };
/** Ce que les commits du lot déclarent (`contre..HEAD`), nom d'outil → sha court : `Analyse-adoption: <outil>` et `Analyse-config: <outil>` (sans plan natif). */
export interface Declarations { adoptions?: Map<string, string>; configs?: Map<string, string> }
export function declarationsDuLot(racine: string, contre: string): Required<Declarations>;
/**
 * La garde de l'analyse contre le départ du lot : un outil retiré ou modifié sous `analyse:` ou une `configs` changée hors d'un lot `config: true`, une base
 * née sans lot `config: true` ni adoption déclarée. À afficher : `neuves`, les bases nées dans le lot et ce qui les autorise ; `configs`, les outils dont la
 * config a changé par un changement déclaré (projet sans plan natif).
 */
export function gardeIdentite(racine: string, ref: import('./qualite.mjs').Ref, outils: OutilAnalyse[], parse: (texte: string) => unknown, declare?: Declarations): { refus: { code: number; texte: string } | null; neuves: string[]; configs: string[] };
/** Les lignes d'une porte verte à relire (« analyse : ligne de base neuve : … », « analyse : config changée : … »), que cadence run reprend à son journal. */
export function lignesARelire(sortie: string): string[];
/** `--contre <ref>` dont le départ est HEAD lui-même (issue #72) : `refus` si HEAD relève une base de son parent, `avis` si une base y naît ; null sinon. */
export function departEgalHead(racine: string, ref: string, outils: OutilAnalyse[]): { refus: { code: number; texte: string } | null; avis: string | null } | null;
