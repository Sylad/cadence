import { PLACE_KEY } from './archive.js';
import { FIELDS, RafError, type Lot } from './plan.js';

/** Un champ d'extension déclaré (`plan.extras`, L464) : valeurs permises, et valeur d'un lot qui n'en porte pas. Sans règle, tout texte non vide est permis. */
export interface ExtraDecl {
  enum?: string[];
  default?: string;
}

export type ExtraDecls = Record<string, ExtraDecl>;

const EXTRA_KEYS = ['enum', 'default'];
const EXTRA_NAME = /^[a-z][a-z0-9_]*$/;
/** Les clés que raf lit ou écrit sur un lot (`place` : le rang d'un lot archivé sous `plan.idPattern`, L536) : un champ d'extension ne peut pas en prendre le nom. */
const LOT_KEYS = ['tasks', 'uses', 'planned', 'local', 'ux', 'review', 'docs_ok', 'extras', 'problems', 'state', 'state_before', PLACE_KEY];

const nonEmptyText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Une déclaration `plan.extras.<nom>` lue, ou l'erreur (message sans préfixe) qui la refuse. */
function readDecl(name: string, decl: unknown): ExtraDecl | string {
  if (decl == null) return {};
  if (typeof decl !== 'object' || Array.isArray(decl)) return `extras.${name} doit être un objet { enum, default }`;
  const d = decl as Record<string, unknown>;
  const unknown = Object.keys(d).find((k) => !EXTRA_KEYS.includes(k));
  if (unknown) return `extras.${name}.${unknown} inconnu (attendu : ${EXTRA_KEYS.join(', ')})`;
  const out: ExtraDecl = {};
  if (d.enum != null) {
    if (!Array.isArray(d.enum) || d.enum.length === 0 || !d.enum.every(nonEmptyText)) return `extras.${name}.enum doit être une liste non vide de textes`;
    if (new Set(d.enum).size !== d.enum.length) return `extras.${name}.enum : une valeur est donnée deux fois`;
    out.enum = d.enum as string[];
  }
  if (d.default != null) {
    if (!nonEmptyText(d.default)) return `extras.${name}.default doit être un texte non vide`;
    if (out.enum && !out.enum.includes(d.default)) return `extras.${name}.default « ${d.default} » hors de enum (${out.enum.join(', ')})`;
    out.default = d.default;
  }
  return out;
}

/**
 * Clé `plan.extras` de cadence.yaml (L464) lue en `{ extras }` (`{}` quand la clé manque). Refuse, en nommant la clé : une forme fausse, un nom invalide ou pris
 * par un champ de raf, un plan tenu par un autre outil (`foreign` : lecture seule, raf n'y écrit aucun champ).
 */
export function readExtras(v: unknown, foreign: boolean, bad: (what: string) => Error): { extras?: ExtraDecls } {
  if (v == null) return {};
  if (foreign) throw bad("extras ne s'applique pas à un plan tenu par un autre outil (lecture seule)");
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('extras doit être un objet { champ: { enum, default } }');
  const extras: ExtraDecls = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!EXTRA_NAME.test(name)) throw bad(`extras.${name} : nom invalide (minuscules, chiffres et _, commençant par une lettre)`);
    if ((FIELDS as readonly string[]).includes(name) || LOT_KEYS.includes(name)) throw bad(`extras.${name} : c'est un champ de raf, pas un champ d'extension`);
    const decl = readDecl(name, raw);
    if (typeof decl === 'string') throw bad(decl);
    extras[name] = decl;
  }
  return { extras };
}

/** Ce qui cloche dans la valeur d'un champ d'extension, ou null : champ non déclaré, pas un texte non vide, hors de `enum`. */
function valueProblem(decls: ExtraDecls, name: string, value: unknown): string | null {
  const decl = decls[name];
  if (!decl) {
    const names = Object.keys(decls);
    return names.length === 0 ? `${name} : aucun champ d'extension déclaré (cadence.yaml : plan.extras)` : `${name} : champ d'extension non déclaré (${names.join(', ')})`;
  }
  if (!nonEmptyText(value)) return `${name} : texte non vide attendu`;
  if (decl.enum && !decl.enum.includes(value.trim())) return `${name} « ${value.trim()} » hors de enum (${decl.enum.join(', ')})`;
  return null;
}

/** Les champs à poser à la création d'un lot (`raf add --set`), validés et nettoyés ; une erreur refuse tout. Sans valeur donnée : rien. */
export function checkedExtras(decls: ExtraDecls | undefined, given: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(given ?? {})) {
    const problem = valueProblem(decls ?? {}, name, value);
    if (problem) throw new RafError(problem);
    out[name] = value.trim();
  }
  return out;
}

/**
 * Le lot lu avec ses champs d'extension : la valeur écrite, sinon le `default`. Une valeur fausse est remontée par check (`bad-field`) et n'est pas gardée.
 * Les clés non déclarées ne sont pas lues : elles restent sur le disque, intactes.
 */
export function withExtras(lot: Lot, raw: Record<string, unknown>, decls: ExtraDecls | undefined): Lot {
  const extras: Record<string, string> = {};
  for (const [name, decl] of Object.entries(decls ?? {})) {
    const written = raw[name];
    if (written == null) {
      if (decl.default !== undefined) extras[name] = decl.default;
      continue;
    }
    const problem = valueProblem(decls ?? {}, name, written);
    if (problem) lot.problems.push(problem);
    else extras[name] = (written as string).trim();
  }
  return Object.keys(extras).length > 0 ? { ...lot, extras } : lot;
}

/** Les `--set champ=valeur` de `raf add` : champ → valeur, coupée au premier « = ». Une forme sans champ ou sans valeur, un champ donné deux fois : refusés. Rend undefined sans `--set`. */
export function parseSet(sets: string[] | undefined): Record<string, string> | undefined {
  if (sets === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const item of sets) {
    const [name, ...rest] = item.split('=');
    const value = rest.join('=').trim();
    if (name.trim() === '' || value === '') throw new RafError(`--set attend champ=valeur (reçu « ${item} »)`);
    if (Object.hasOwn(out, name.trim())) throw new RafError(`--set ${name.trim()} est donné deux fois`);
    out[name.trim()] = value;
  }
  return out;
}

/** `plan.requirePlanned` de cadence.yaml (L466) : un booléen, jamais avec un plan tenu par un autre outil (`foreign` : lecture seule). */
export function readRequirePlanned(raw: unknown, foreign: boolean, bad: (what: string) => Error): { requirePlanned?: boolean } {
  if (raw == null) return {};
  if (typeof raw !== 'boolean') throw bad('requirePlanned doit être true ou false');
  if (foreign && raw) throw bad("requirePlanned ne s'applique pas à un plan tenu par un autre outil (lecture seule)");
  return { requirePlanned: raw };
}
