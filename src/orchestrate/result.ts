import { RafError } from '../plan.js';

/** Les quatre compteurs d'une session. Le budget compte `counted` : entrée + écriture de cache + sortie. */
export interface Tokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  counted: number;
}

export interface SessionResult {
  isError: boolean;
  subtype: string;
  result: string;
  sessionId: string;
  numTurns: number;
  durationMs: number;
  tokens: Tokens;
  /** Sortie demandée par --json-schema (`structured_output`), absente d'une erreur. */
  structured?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function field<T>(obj: Record<string, unknown>, path: string, kind: 'string' | 'number' | 'boolean'): T {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!isObject(cur) || !(k in cur)) throw new RafError(`sortie de claude : champ « ${path} » absent`);
    cur = cur[k];
  }
  if (typeof cur !== kind) throw new RafError(`sortie de claude : champ « ${path} » de type ${typeof cur} (attendu ${kind})`);
  return cur as T;
}

/**
 * Lit la sortie `claude -p --output-format json` (un objet unique). Les noms de champs sont ceux d'un
 * échantillon réel (test/fixtures/claude-result.sample.json) : un champ absent est une erreur nommée,
 * jamais un zéro. `structured` : la sortie de --json-schema est attendue (sauf quand la session a échoué).
 */
export function parseSession(stdout: string, opts: { structured: boolean }): SessionResult {
  if (stdout.trim() === '') throw new RafError('sortie de claude vide');
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new RafError('sortie de claude illisible (JSON attendu)');
  }
  if (!isObject(raw)) throw new RafError('sortie de claude illisible (objet attendu)');
  const isError = field<boolean>(raw, 'is_error', 'boolean');
  const input = field<number>(raw, 'usage.input_tokens', 'number');
  const cacheWrite = field<number>(raw, 'usage.cache_creation_input_tokens', 'number');
  const cacheRead = field<number>(raw, 'usage.cache_read_input_tokens', 'number');
  const output = field<number>(raw, 'usage.output_tokens', 'number');
  const result: SessionResult = {
    isError,
    subtype: field<string>(raw, 'subtype', 'string'),
    result: typeof raw.result === 'string' ? raw.result : '',
    sessionId: field<string>(raw, 'session_id', 'string'),
    numTurns: field<number>(raw, 'num_turns', 'number'),
    durationMs: field<number>(raw, 'duration_ms', 'number'),
    tokens: { input, cacheWrite, cacheRead, output, counted: input + cacheWrite + output },
  };
  if (!isError && opts.structured) {
    if (!('structured_output' in raw)) throw new RafError('sortie de claude : champ « structured_output » absent (--json-schema ignoré ?)');
    result.structured = raw.structured_output;
  }
  return result;
}

/** Le message d'une session arrêtée par la limite d'usage (quota) ; l'heure de remise suit « | » quand elle est donnée. */
export function isQuotaMessage(text: string): boolean {
  return /usage limit|limit reached|rate limit|quota/i.test(text);
}

/** Heure de remise (epoch s) lue dans « …limit reached|1759600000 », sinon null. */
export function quotaReset(text: string): Date | null {
  const m = /\|(\d{9,})\s*$/.exec(text.trim());
  return m ? new Date(Number(m[1]) * 1000) : null;
}
