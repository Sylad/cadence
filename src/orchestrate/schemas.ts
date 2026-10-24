import type { SessionKind } from './launch.js';

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const strings = { type: 'array', items: str } as const;
const result = { type: 'object', properties: { commande: str, resultat: str, vert: { type: 'boolean' } }, required: ['commande', 'resultat', 'vert'] } as const;

/** Sortie d'une implémentation ou d'une correction. */
export const WORK_SCHEMA = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'object', properties: { sha: str, sujet: str }, required: ['sha', 'sujet'] } },
    tests: result,
    build: result,
    nonVerifie: strings,
    questions: strings,
    choix: strings,
    echecsDeBase: strings,
    nouveauxEchecs: strings,
    resume: str,
  },
  required: ['commits', 'tests', 'build', 'nonVerifie', 'questions', 'resume'],
} as const;

/**
 * Sortie de l'étape spec : `sousSeuil` vaut une raison (une ligne) quand le lot ne change aucun écran, « » sinon ;
 * `fiche` le chemin de la fiche écrite (relatif au dépôt), « » sous le seuil.
 */
export const SPEC_SCHEMA = {
  type: 'object',
  properties: { commits: WORK_SCHEMA.properties.commits, nonVerifie: strings, questions: strings, choix: strings, sousSeuil: str, fiche: { type: 'string', description: 'path of the sheet relative to the repository, or empty' }, resume: str },
  required: ['commits', 'nonVerifie', 'questions', 'sousSeuil', 'fiche', 'resume'],
} as const;

/** Sortie de l'étape accept : les tests d'acceptation rouges, commités avec leur acceptation.json. */
export const ACCEPT_SCHEMA = {
  type: 'object',
  properties: { commits: WORK_SCHEMA.properties.commits, nonVerifie: strings, questions: strings, choix: strings, resume: str },
  required: ['commits', 'nonVerifie', 'questions', 'resume'],
} as const;

/** Sortie d'une revue (code, UX ou passe unique) : `verdict` est la ligne pour `raf review` / `raf ux`. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    bloquants: num,
    majeurs: num,
    mineurs: num,
    constats: { type: 'array', items: { type: 'object', properties: { gravite: { type: 'string', enum: ['bloquant', 'majeur', 'mineur'] }, fichier: str, ligne: num, texte: str, inchange: { type: 'boolean', description: 'optional, review 2 or later of a mockup: true when the finding is on a point the spec writer did not change and the previous review had not raised' } }, required: ['gravite', 'texte'] } },
    sousTaches: strings,
    nonVerifie: strings,
    verdict: str,
  },
  required: ['bloquants', 'majeurs', 'mineurs', 'constats', 'sousTaches', 'nonVerifie', 'verdict'],
} as const;

/** Sortie du contrôle préalable : `dejaPresent` vaut « oui » (rien à faire), « partiel » ou « non ». */
export const PRECHECK_SCHEMA = {
  type: 'object',
  properties: { dejaPresent: { type: 'string', enum: ['oui', 'partiel', 'non'] }, preuves: strings, resume: str },
  required: ['dejaPresent', 'preuves', 'resume'],
} as const;

/** Une revue de maquette rend le même rapport qu'une revue d'ergonomie (REVIEW_SCHEMA). */
export const schemaFor = (kind: SessionKind): object => (kind === 'precheck' ? PRECHECK_SCHEMA : kind === 'spec' ? SPEC_SCHEMA : kind === 'accept' ? ACCEPT_SCHEMA : kind === 'implement' || kind === 'fix' ? WORK_SCHEMA : REVIEW_SCHEMA);

export interface PrecheckReport {
  dejaPresent: 'oui' | 'partiel' | 'non';
  preuves: string[];
  resume: string;
}

export interface WorkReport {
  commits: { sha: string; sujet: string }[];
  tests: { commande: string; resultat: string; vert: boolean };
  build: { commande: string; resultat: string; vert: boolean };
  nonVerifie: string[];
  questions: string[];
  /** Choix d'interprétation faits par l'auteur ; absent d'un ancien rapport. */
  choix?: string[];
  /** Tests rouges déjà au sha de départ de la session, vérifiés par elle (L213) ; absent ou vide : aucun. */
  echecsDeBase?: string[];
  /** Tests rouges qui ne l'étaient pas au sha de départ (L215) ; liste présente et vide : aucun nouvel échec. Absent : inconnu, le vert:false vaut correction. */
  nouveauxEchecs?: string[];
  resume: string;
}

export interface SpecReport {
  commits: { sha: string; sujet: string }[];
  nonVerifie: string[];
  questions: string[];
  choix?: string[];
  sousSeuil: string;
  fiche: string;
  resume: string;
}

export interface AcceptReport {
  commits: { sha: string; sujet: string }[];
  nonVerifie: string[];
  questions: string[];
  choix?: string[];
  resume: string;
}

export interface ReviewReport {
  bloquants: number;
  majeurs: number;
  mineurs: number;
  constats: { gravite: string; fichier?: string; ligne?: number; texte: string; inchange?: boolean }[];
  sousTaches: string[];
  nonVerifie: string[];
  verdict: string;
}

/** Contrôle la forme d'une sortie structurée : un champ absent ou mal typé est une erreur nommée. */
export function checkShape<T>(value: unknown, schema: { required: readonly string[]; properties: Record<string, { type: string }> }): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sortie structurée : objet attendu');
  const o = value as Record<string, unknown>;
  for (const k of schema.required) {
    if (!(k in o)) throw new Error(`sortie structurée : champ « ${k} » absent`);
    const want = schema.properties[k].type;
    const ok = want === 'array' ? Array.isArray(o[k]) : typeof o[k] === want;
    if (!ok) throw new Error(`sortie structurée : champ « ${k} » mal typé (attendu ${want})`);
  }
  return value as T;
}
