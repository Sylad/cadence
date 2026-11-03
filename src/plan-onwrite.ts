/** Délai de la commande `plan.onWrite` : une republication du plan, pas un build. */
export const ON_WRITE_TIMEOUT_MS = 120_000;

/**
 * La raison d'un échec de `plan.onWrite` en une ligne (L429) : la première ligne « Error: … » de la sortie d'erreur (un script Node qui jette
 * imprime d'abord le fichier, le code fautif et un caret, puis le motif, puis la pile : garder la fin de la pile cachait le motif) ; sans
 * ligne de ce genre, la première ligne non vide de la sortie d'erreur, puis de la sortie standard. Les lignes de pile (« at … ») et la
 * bannière « Node.js v… » ne sont jamais la raison.
 */
export function failureReason(stderr: string | null, stdout: string | null): string {
  const lines = (text: string | null) => (text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l));
  const err = lines(stderr);
  return err.find((l) => /^(?:\w+)?Error\b/.test(l)) ?? err[0] ?? lines(stdout)[0] ?? '';
}
