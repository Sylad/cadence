import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { dirtyContents } from './git.js';

/** Délai de la commande `plan.onWrite` : une republication du plan, pas un build. */
export const ON_WRITE_TIMEOUT_MS = 120_000;

/**
 * La raison d'un échec de `plan.onWrite` en une ligne (L429) : la première ligne « Error: … » de la sortie d'erreur (un script Node qui jette
 * imprime d'abord le fichier, le code fautif et un caret, puis le motif, puis la pile : garder la fin de la pile cachait le motif) ; sans
 * ligne de ce genre, la première ligne non vide de la sortie d'erreur, puis de la sortie standard. Les lignes de pile (« at … ») et la
 * bannière « Node.js v… » ne sont jamais la raison.
 */
function failureReason(stderr: string | null, stdout: string | null): string {
  const lines = (text: string | null) => (text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l));
  const err = lines(stderr);
  return err.find((l) => /^(?:\w+)?Error\b/.test(l)) ?? err[0] ?? lines(stdout)[0] ?? '';
}

/** Le constat d'un `plan.onWrite` en échec (L346, L471), sans la suite que lui donne `onFailure` : la commande, la cause (délai, démarrage, code) et le motif. */
export function failureMessage(command: string, r: { error?: Error; status: number | null; signal: string | null; stderr: string | null; stdout: string | null }, limitMs: number): string {
  const why = r.error ? (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `délai de ${limitMs / 1000} s dépassé` : r.error.message : `code ${r.status ?? r.signal}`;
  const tail = failureReason(r.stderr, r.stdout);
  return `plan.onWrite en échec (${command}, ${why})${tail ? ` : ${tail}` : ''}`;
}

/**
 * Après une commande réussie : cite ce qu'elle a écrit sans le déclarer (L436 ; le plan, les archives et les déclarés ont leur propre chemin), le retient dans `writtenByHook`
 * pour qu'il soit commité avec le plan — sans quoi la livraison refuse « 1 fichier modifié » —, et cite ce qu'elle n'a pas produit (chemin mal déclaré).
 */
export function noticeHookFiles(hook: { cwd: string; files: string[] }, before: Map<string, string>, written: string[], writtenByHook: Set<string>, notice: (line: string) => void): void {
  const known = new Set([...written.map((p) => relative(hook.cwd, p)), ...hook.files]);
  const undeclared = [...dirtyContents(hook.cwd)].filter(([f, content]) => before.get(f) !== content && !known.has(f)).map(([f]) => f);
  for (const f of undeclared) writtenByHook.add(f);
  if (undeclared.length > 0) notice(`raf: plan.onWrite a écrit ${undeclared.join(', ')}, absent de plan.onWrite.files — l'ajouter dans cadence.yaml (il est cité dans le commit proposé cette fois)`);
  const missing = hook.files.filter((f) => !existsSync(resolve(hook.cwd, f)));
  if (missing.length > 0) notice(`raf: plan.onWrite a réussi mais le fichier déclaré est absent : ${missing.join(', ')} — vérifier plan.onWrite.files dans cadence.yaml`);
}
