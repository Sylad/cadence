import type { LastDelivery, LotsBoard } from '../types'
import { ellipsize } from './lots'

// ── L415 : « dernière livraison par projet », sous les lots en cours du panneau des lots ─────────────────────────

export type DeliveryRow = {
  project: string
  /** Sha de la dernière livraison, sur 7 caractères (deliver écrit le sha entier). */
  sha: string
  /** Jours depuis le jour du journal (le journal ne date qu'au jour) ; jamais négatif. */
  age: number
  status: 'verte' | 'rouge'
  /** Ids des lots clos après la dernière livraison verte ; nul quand le plan n'est pas connu (projet absent du tableau, en erreur, cadence trop ancien pour `closed`). */
  undelivered: string[] | null
}

/** La sortie du script LAST_DELIVERIES ; illisible ou étrangère, elle n'en donne aucune, et une entrée mal formée est sautée. */
export const parseLastDeliveries = (stdout: string): LastDelivery[] => {
  try {
    const raw: unknown = JSON.parse(stdout)
    return (Array.isArray(raw) ? raw : []).flatMap((d): LastDelivery[] => {
      const o = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>
      const ok = typeof o.project === 'string' && typeof o.day === 'string' && typeof o.sha === 'string' && (o.status === 'verte' || o.status === 'rouge') && (o.green === null || typeof o.green === 'string')
      return ok ? [{ project: o.project as string, day: o.day as string, sha: o.sha as string, status: o.status as 'verte' | 'rouge', green: o.green as string | null }] : []
    })
  } catch {
    return []
  }
}

const dayOf = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Jours entre deux jours AAAA-MM-JJ (UTC : pas de décalage d'heure d'été) ; nul si l'un n'est pas un jour. */
const daysBetween = (from: string, to: string): number | null => {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null
}

export const ageLabel = (days: number): string => (days <= 0 ? 'aujourd’hui' : days === 1 ? 'hier' : `il y a ${days} j`)

/**
 * La dernière livraison de chaque projet et ses lots clos non livrés, à l'heure `at`. Un lot clos est livré quand une livraison verte a eu lieu le jour de sa clôture ou après
 * (la règle du délai de livraison de `cadence perf`) : non livré, il est clos APRÈS le jour de la dernière verte — une livraison rouge ne livre rien ; sans verte jamais, tous les
 * lots clos le sont. Le plan est lu dans `board` (`closed` de `cadence lead tour --json`) : sans lui, `undelivered` est nul — on ne sait pas, ce n'est pas « rien à livrer ».
 */
export const deliveriesOf = (last: readonly LastDelivery[], board: LotsBoard | null, at: number): DeliveryRow[] =>
  last.map(d => {
    const row = board?.rows.find(r => r.project === d.project && !r.error)
    const undelivered = row?.closed ? row.closed.filter(c => d.green === null || c.finished > d.green).map(c => c.id) : null
    return { project: d.project, sha: d.sha.slice(0, 7), age: Math.max(0, daysBetween(d.day, dayOf(at)) ?? 0), status: d.status, undelivered }
  })

/** Rouge d'abord, puis le plus de lots clos non livrés, puis le nom. */
const order = (a: DeliveryRow, b: DeliveryRow): number =>
  Number(b.status === 'rouge') - Number(a.status === 'rouge') || (b.undelivered?.length ?? 0) - (a.undelivered?.length ?? 0) || a.project.localeCompare(b.project)

const textOf = (r: DeliveryRow): string => {
  const rest = r.undelivered === null ? '' : r.undelivered.length === 0 ? ' · rien à livrer' : ` · ${r.undelivered.length} lot${r.undelivered.length > 1 ? 's' : ''} clos non livré${r.undelivered.length > 1 ? 's' : ''} : ${r.undelivered.join(', ')}`
  return `${r.status === 'rouge' ? '✖' : '✔'} ${r.project}  ${r.sha} · ${ageLabel(r.age)} · ${r.status}${rest}`
}

export type DeliveryLine = { text: string; tone: 'title' | 'error' | 'text' }

/**
 * La hauteur du bloc : le titre et un projet par ligne, dans ce que les décisions et les dépenses (`used` lignes) laissent de la moitié du corps — l'arbre garde le reste ;
 * sous deux lignes (le titre et un projet), rien.
 */
export const deliveriesHeight = (projects: number, bodyRows: number, used: number): number => {
  const h = Math.min(projects + 1, Math.floor(bodyRows / 2) - used)
  return projects === 0 || h < 2 ? 0 : h
}

/** Les lignes du bloc, pour `columns` colonnes et au plus `height` lignes : le titre avec le compte, un projet par ligne, « … +N projets » quand la hauteur ne les montre pas tous. Aucune ligne sans projet ni sous deux lignes. */
export const buildDeliveries = (rows: readonly DeliveryRow[], columns: number, height: number): { lines: DeliveryLine[] } => {
  if (rows.length === 0 || height < 2) return { lines: [] }
  const ordered = [...rows].sort(order)
  const shown = ordered.length <= height - 1 ? ordered.length : Math.max(1, height - 2)
  const lines: DeliveryLine[] = [{ text: ellipsize(`Dernière livraison par projet (${rows.length})`, columns), tone: 'title' }]
  for (const r of ordered.slice(0, shown)) lines.push({ text: ellipsize(textOf(r), columns), tone: r.status === 'rouge' ? 'error' : 'text' })
  const hidden = ordered.length - shown
  if (hidden > 0 && lines.length < height) lines.push({ text: ellipsize(`… +${hidden} projet${hidden > 1 ? 's' : ''}`, columns), tone: 'text' })
  return { lines }
}
