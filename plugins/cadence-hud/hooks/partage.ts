// ── L712 (D-20) : le partage de la hauteur du panneau des lots — l'arbre des lots d'abord, les blocs secondaires ensuite ───────────

/** Les blocs secondaires du panneau, au-dessus de l'arbre des lots. */
export type Bloc = 'banc' | 'livraisons' | 'depenses' | 'decisions'

/** L'ordre dans lequel les blocs cèdent leur place à l'arbre : le banc d'abord, les décisions en dernier. */
export const CEDENT: readonly Bloc[] = ['banc', 'livraisons', 'depenses', 'decisions']

/**
 * La hauteur laissée à chaque bloc dans un corps de `corps` lignes quand l'arbre en demande `arbre` : tant que l'arbre n'a pas sa part, les blocs se replient
 * en une ligne dans l'ordre CEDENT, puis cèdent leur dernière ligne dans le même ordre. `tailles` : la hauteur que chaque bloc prendrait seul (0 : absent) ;
 * `planchers` : les lignes qu'un bloc garde quoi qu'il arrive (la ligne ⚠ d'un lot en dépassement, L414 : le signal ne disparaît jamais faute de place).
 */
export const partage = (corps: number, arbre: number, tailles: Readonly<Record<Bloc, number>>, planchers: Readonly<Partial<Record<Bloc, number>>> = {}): Record<Bloc, number> => {
  const h = { ...tailles }
  const reste = () => corps - CEDENT.reduce((n, b) => n + h[b], 0)
  for (const b of CEDENT) {
    if (reste() >= arbre) return h
    h[b] = Math.min(h[b], Math.max(1, planchers[b] ?? 0))
  }
  for (const b of CEDENT) {
    if (reste() >= arbre) return h
    h[b] = Math.min(h[b], planchers[b] ?? 0)
  }
  return h
}

/** Les lignes d'un bloc pour la hauteur que le partage lui laisse : toutes, sa ligne repliée, ou rien. */
export const lignesDuBloc = <T>(toutes: readonly T[], repliee: T | undefined, hauteur: number): T[] =>
  hauteur >= toutes.length ? [...toutes] : hauteur >= 1 && repliee !== undefined ? [repliee] : []
