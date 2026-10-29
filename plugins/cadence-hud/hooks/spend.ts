import type { Wave } from '../types'
import { duration, k } from './format'
import { ellipsize } from './lots'

// ── L414 : « lots en cours : budget et durée », en tête du panneau des lots ───────────────────────────────────────

/** Les états de vague où une session travaille le lot ou l'attend sur une question : le lot est « en cours » et dépense son budget. */
const SPENDING = new Set(['implementing', 'reviewing', 'fixing', 'question'])

/** Au-delà de ce multiple du temps habituel d'un lot de sa taille, un lot en cours est signalé. */
export const OVERTIME = 1.5

export type SpendRow = {
  project: string
  lot: string
  /** Tokens comptés par les étapes du lot. */
  consumed: number
  /** Budget des passes ordinaires : `budget` de l'état moins la part réservée à l'escalade tant qu'elle n'est pas engagée ; nul sans budget. */
  budget: number | null
  /** Minutes écoulées depuis le début de la première étape, portes du programme comprises ; nul sans début lisible. */
  minutes: number | null
  /** Temps habituel (minutes) d'un lot de cette taille, `cadence perf` ; nul sans mesure pour sa classe. */
  usual: number | null
  tokensOver: boolean
  timeOver: boolean
}

/** La classe de taille d'un lot, la clé de `lotMinutes` de `cadence perf` : l'estimate, « +spec » pour un lot passé par la chaîne spec. */
const classOf = (estimate: number | null | undefined, spec: boolean | undefined): string | null => (typeof estimate === 'number' ? `${estimate}${spec ? '+spec' : ''}` : null)

/**
 * Les lots en cours des vagues VIVANTES, lot par lot : tokens consommés sur le budget, temps écoulé à `at` et temps habituel de sa classe (`typical`, minutes par clé de classe).
 * Le budget dépassé est celui des passes ordinaires ; la part réservée à l'escalade ne compte que l'escalade engagée. Le temps est dépassé au-delà de OVERTIME fois l'habituel,
 * jamais sans temps habituel pour la classe (ni sans estimate) : on ne sait pas. Un lot repris dans plusieurs vagues vivantes n'est compté que dans la première.
 */
export const spendOf = (waves: readonly Wave[], typical: Readonly<Record<string, number>>, at: number): SpendRow[] => {
  const seen = new Set<string>()
  return waves.filter(w => w.live).flatMap(w =>
    w.lots.flatMap((l): SpendRow[] => {
      const key = `${l.project}:${l.lot}`
      if (!SPENDING.has(l.status) || seen.has(key)) return []
      seen.add(key)
      const since = Date.parse(l.since ?? '')
      // jusqu'à `at`, jamais jusqu'à la fin de la dernière étape : une porte du programme (build, tests) tourne sans session alors que le lot reste en cours, et `lotMinutes` compte ces portes
      const minutes = Number.isFinite(since) ? Math.max(0, at - since) / 60_000 : null
      const budget = typeof l.budget === 'number' ? l.budget - (l.escalated ? 0 : (l.escalationReserve ?? 0)) : null
      const cls = classOf(l.estimate, l.spec)
      const usual = cls !== null && cls in typical ? typical[cls]! : null
      const consumed = l.consumed ?? 0
      return [{ project: l.project, lot: l.lot, consumed, budget, minutes, usual, tokensOver: budget !== null && consumed > budget, timeOver: minutes !== null && usual !== null && minutes > usual * OVERTIME }]
    }),
  )
}

/** Sous ce nombre de lots dans une fenêtre, sa médiane n'est pas un temps habituel : la même borne que `MIN_SAMPLE` de `cadence perf` (src/perf.ts), qui refuse alors toute tendance. */
export const MIN_SAMPLE = 5

/** Le temps habituel d'un lot par classe, lu de `cadence perf --json` (`lotMinutes`) : la médiane de la fenêtre courante, à défaut de la précédente, d'au moins MIN_SAMPLE lots ; une sortie illisible ou étrangère n'en donne aucun. */
export const parseTypical = (stdout: string): Record<string, number> => {
  try {
    const raw: unknown = JSON.parse(stdout)
    const by = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { lotMinutes?: unknown }).lotMinutes : undefined
    if (typeof by !== 'object' || by === null || Array.isArray(by)) return {}
    const out: Record<string, number> = {}
    for (const [cls, ind] of Object.entries(by)) {
      const { current, previous, lots } = (typeof ind === 'object' && ind !== null ? ind : {}) as { current?: unknown; previous?: unknown; lots?: { current?: unknown; previous?: unknown } | null }
      const sample = (n: unknown) => typeof n === 'number' && n >= MIN_SAMPLE
      const minutes = [sample(lots?.current) ? current : undefined, sample(lots?.previous) ? previous : undefined].find((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (minutes !== undefined) out[cls] = minutes
    }
    return out
  } catch {
    return {}
  }
}

export type SpendLine = { text: string; tone: 'title' | 'warning' | 'text' }

/**
 * Les lignes du bloc, pour `columns` colonnes et au plus `height` lignes : le titre avec le compte, un lot par ligne (les lots en dépassement d'abord, l'ordre des vagues ensuite),
 * « … +N lots en cours » quand la hauteur n'en montre pas tous et qu'une ligne reste pour le dire. Aucune ligne sans lot en cours ni sous deux lignes de hauteur ; à deux lignes, le titre et le premier lot.
 */
export const buildSpend = (rows: readonly SpendRow[], columns: number, height: number): { lines: SpendLine[] } => {
  if (rows.length === 0 || height < 2) return { lines: [] }
  const over = (r: SpendRow) => r.tokensOver || r.timeOver
  const ordered = [...rows.filter(over), ...rows.filter(r => !over(r))]
  // Deux lignes : le titre et un lot, sans « +N » (il ne tiendrait pas) ; le lot en dépassement passe en tête, il ne doit jamais être caché
  const shown = ordered.length <= height - 1 ? ordered.length : Math.max(1, height - 2)
  const lines: SpendLine[] = [{ text: ellipsize(`Lots en cours : budget et durée (${rows.length})`, columns), tone: 'title' }]
  for (const r of ordered.slice(0, shown)) {
    const tokens = `${r.budget === null ? k(r.consumed) : `${k(r.consumed)}/${k(r.budget)}`} tokens${r.tokensOver ? ' dépassé' : ''}`
    const time = r.minutes === null ? '' : ` · ${duration(r.minutes * 60_000)}${r.usual === null ? '' : ` (habituel ${duration(r.usual * 60_000)}${r.timeOver ? ', dépassé' : ''})`}`
    lines.push({ text: ellipsize(`${over(r) ? '⚠' : '▶'} ${r.project}:${r.lot}  ${tokens}${time}`, columns), tone: over(r) ? 'warning' : 'text' })
  }
  const hidden = ordered.length - shown
  if (hidden > 0 && lines.length < height) lines.push({ text: ellipsize(`… +${hidden} lot${hidden > 1 ? 's' : ''} en cours`, columns), tone: 'text' })
  return { lines }
}
