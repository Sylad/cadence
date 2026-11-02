import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { Day } from './dates.js';
import { RafError } from './plan.js';

/** Fichier d'acquittement docs-ok d'un plan en lecture seule, relatif à la racine du dépôt (L386). */
export const DOCS_OK_FILE = '.cadence/docs-ok.yaml';

/** Les acquittements du fichier : lot → { date, reason }. Une entrée sans raison n'acquitte rien ; un fichier illisible est une erreur qui le nomme. */
export function readDocsOkFile(file: string | null): Record<string, { date: Day; reason: string }> {
  if (!file || !existsSync(file)) return {};
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) throw new RafError(`${file} : ${doc.errors[0].message}`);
  const raw = doc.toJSON() as unknown;
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RafError(`${file} : la racine doit être un objet (lot → { date, reason })`);
  const out: Record<string, { date: Day; reason: string }> = {};
  for (const [id, v] of Object.entries(raw)) {
    const e = v as { date?: unknown; reason?: unknown } | null;
    if (e && typeof e === 'object' && typeof e.reason === 'string' && e.reason.trim() !== '') out[id] = { date: String(e.date ?? ''), reason: e.reason.trim() };
  }
  return out;
}
