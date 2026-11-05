import type { SessionKind } from './launch.js';
import type { ReviewSummary } from './state.js';

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
    constats: { type: 'array', items: { type: 'object', properties: { gravite: { type: 'string', enum: ['bloquant', 'majeur', 'mineur'] }, fichier: str, ligne: num, texte: str, inchange: { type: 'boolean', description: 'optional, review 2 or later of a mockup or of the code: true when the finding is on a point the author did not change (outside the goal of the lot and the lines it changes) and the previous review had not raised; a major marked true does not block, it goes to the lead as a follow-up item' } }, required: ['gravite', 'texte'] } },
    sousTaches: strings,
    nonVerifie: strings,
    verdict: str,
  },
  required: ['bloquants', 'majeurs', 'mineurs', 'constats', 'sousTaches', 'nonVerifie', 'verdict'],
} as const;

/** Sortie du contrôle préalable : `dejaPresent` vaut « oui » (rien à faire), « partiel » ou « non ». `lu` (L523, facultatif) est ce que le lecteur a lu : fichiers, code voisin, tests. */
export const PRECHECK_SCHEMA = {
  type: 'object',
  properties: { dejaPresent: { type: 'string', enum: ['oui', 'partiel', 'non'] }, preuves: strings, resume: str, lu: str },
  required: ['dejaPresent', 'preuves', 'resume'],
} as const;

/** Sortie de la sonde de cas limites (L497) : les tests commités, `echecs` les tests commités qu'elle annonce rouges (« test — borne — attendu », un par entrée), et `horsRegle` (facultatif, L580) les attentes qui ne sont pas des règles du lot, non commitées. */
export const PROBE_SCHEMA = {
  type: 'object',
  properties: { commits: WORK_SCHEMA.properties.commits, echecs: strings, horsRegle: strings, nonVerifie: strings, questions: strings, choix: strings, resume: str },
  required: ['commits', 'echecs', 'nonVerifie', 'questions', 'resume'],
} as const;

/** Une revue de maquette rend le même rapport qu'une revue d'ergonomie (REVIEW_SCHEMA). */
export const schemaFor = (kind: SessionKind): object => (kind === 'precheck' ? PRECHECK_SCHEMA : kind === 'spec' ? SPEC_SCHEMA : kind === 'accept' ? ACCEPT_SCHEMA : kind === 'probe' ? PROBE_SCHEMA : kind === 'implement' || kind === 'fix' ? WORK_SCHEMA : REVIEW_SCHEMA);

/** L'agent du paquet de chaque étape qui en a un, ou `undefined` pour une écriture sans agent ; les revues et la fiche n'y sont pas : `code-reviewer`. */
const STEP_AGENT: Partial<Record<SessionKind, string | undefined>> = { implement: undefined, fix: undefined, probe: undefined, spec: 'spec-writer', accept: 'acceptance-writer', ux: 'ux-reviewer', maquette: 'ux-reviewer', precheck: 'precheck-reader' };

const agentOf = (kind: SessionKind): string | undefined => (kind in STEP_AGENT ? STEP_AGENT[kind] : 'code-reviewer');

/** L'agent d'une étape, la passe du bibliothécaire (`fix` de documentation) comprise : un seul choix pour la session réelle et pour le `--dry-run`. */
export const stepAgent = (kind: SessionKind, docsFix?: boolean): string | undefined => (kind === 'fix' && docsFix ? 'doc-keeper' : agentOf(kind));

/** La clé de `effort` d'une étape : la revue d'un petit lot visible (`review-small`) prend l'effort de `review`. */
export const effortKey = <K extends SessionKind>(kind: K): Exclude<K, 'review-small'> | 'review' => (kind === 'review-small' ? 'review' : (kind as Exclude<K, 'review-small'>));

export interface PrecheckReport {
  dejaPresent: 'oui' | 'partiel' | 'non';
  preuves: string[];
  resume: string;
  /** Facultatif, et pas contrôlé par `checkShape` (hors `required`) : le type n'est pas garanti, `precheck()` le vérifie. */
  lu?: unknown;
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

export interface ProbeReport {
  commits: { sha: string; sujet: string }[];
  echecs: string[];
  /** Facultatif, pas contrôlé par `checkShape` (hors `required`) : le type n'est pas garanti, `horsRegleWarnings` le vérifie. */
  horsRegle?: unknown;
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

/** Le résumé d'un rapport de revue : les totaux annoncés ne sont pas crus sur parole (un constat de gravité majeure compte même si le total dit 0). */
export function summarize(rep: ReviewReport, head: string, repoHeads?: Record<string, string>): ReviewSummary {
  // Rien d'un rapport n'est cru sur parole : un constat de gravité majeure compte même si les totaux annoncés disent 0.
  const count = (g: string) => rep.constats.filter((k) => k.gravite === g).length;
  const bloquants = Math.max(rep.bloquants, count('bloquant'));
  const majeurs = Math.max(rep.majeurs, count('majeur'));
  return { conforme: bloquants === 0 && majeurs === 0, bloquants, majeurs, mineurs: Math.max(rep.mineurs, count('mineur')), verdict: rep.verdict.trim(), sousTaches: rep.sousTaches, nonVerifie: rep.nonVerifie, head, ...(repoHeads ? { repoHeads } : {}) };
}
