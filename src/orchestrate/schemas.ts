import type { StepKind } from './launch.js';

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
    resume: str,
  },
  required: ['commits', 'tests', 'build', 'nonVerifie', 'questions', 'resume'],
} as const;

/** Sortie d'une revue (code, UX ou passe unique) : `verdict` est la ligne pour `raf review` / `raf ux`. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    bloquants: num,
    majeurs: num,
    mineurs: num,
    constats: { type: 'array', items: { type: 'object', properties: { gravite: { type: 'string', enum: ['bloquant', 'majeur', 'mineur'] }, fichier: str, ligne: num, texte: str }, required: ['gravite', 'texte'] } },
    sousTaches: strings,
    nonVerifie: strings,
    verdict: str,
  },
  required: ['bloquants', 'majeurs', 'mineurs', 'constats', 'sousTaches', 'nonVerifie', 'verdict'],
} as const;

export const schemaFor = (kind: StepKind): object => (kind === 'implement' || kind === 'fix' ? WORK_SCHEMA : REVIEW_SCHEMA);

export interface WorkReport {
  commits: { sha: string; sujet: string }[];
  tests: { commande: string; resultat: string; vert: boolean };
  build: { commande: string; resultat: string; vert: boolean };
  nonVerifie: string[];
  questions: string[];
  resume: string;
}

export interface ReviewReport {
  bloquants: number;
  majeurs: number;
  mineurs: number;
  constats: { gravite: string; fichier?: string; ligne?: number; texte: string }[];
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
