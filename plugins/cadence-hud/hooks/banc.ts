import type { ThemeKey } from 'claude-code'

import type { BancPassage } from '../types'

// ── Task 16 (cadence 2) : l'état du banc, lu de `historique.jsonl` (une ligne par passage, `ligneHistorique` de v2/src/bench/verdict.ts) ──

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** La sortie de BANC_READER (collect.ts) : `null` (fichier absent) ou ses lignes ; une sortie illisible lève (le passage d'avant reste affiché). */
export const readBanc = (stdout: string): BancPassage[] | null => {
  const raw: unknown = JSON.parse(stdout)
  if (raw === null) return null
  if (!Array.isArray(raw)) throw new Error('historique du banc : sortie illisible')
  return parseBanc(strings(raw))
}

/** Les passages lisibles de l'historique, dans l'ordre du fichier ; une ligne illisible (JSON invalide, date ou verdict absent) est sautée. */
export const parseBanc = (lines: string[]): BancPassage[] =>
  lines.flatMap(l => {
    try {
      const x: unknown = JSON.parse(l)
      if (typeof x !== 'object' || x === null || Array.isArray(x)) return []
      const o = x as Record<string, unknown>
      if (typeof o.date !== 'string' || Number.isNaN(Date.parse(o.date)) || typeof o.vert !== 'boolean') return []
      return [{ date: o.date, candidat: typeof o.candidat === 'string' ? o.candidat : '?', bancs: strings(o.bancs), hebdo: o.hebdo === true, vert: o.vert, rouges: strings(o.rouges) }]
    } catch {
      return []
    }
  })

// Recopie de parisJour et samediCourant de v2/src/bench/verdict.ts (le plugin ne dépend pas de v2) : la même règle que `statut`.
const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const parisJour = (d: Date) => {
  const p = Object.fromEntries(PARIS.formatToParts(d).map(x => [x.type, x.value]))
  return { jour: `${p.year}-${p.month}-${p.day}`, sem: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? ''), jjmm: `${p.day}-${p.month}`, heure: `${p.hour}:${p.minute}` }
}
const samediCourant = (d: Date): string => {
  const { jour, sem } = parisJour(d)
  const [y = 0, m = 1, j = 1] = jour.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, j - ((sem + 1) % 7))).toISOString().slice(0, 10)
}

/** Du lundi au vendredi (heure de Paris), aucun passage hebdo depuis le samedi : le banc du weekend manque (`banc_du_weekend` de `statut`). */
const weekendManquant = (passages: BancPassage[], now: number): boolean => {
  const d = new Date(now)
  if ([6, 0].includes(parisJour(d).sem)) return false
  const sam = samediCourant(d)
  return !passages.some(x => x.hebdo && parisJour(new Date(x.date)).jour >= sam)
}

/** La sorte d'un passage : les bancs 1, 3 et 6 exactement = court ; hebdo ; le banc 1 seul = éclair ; sinon le nombre de bancs. */
export const sorte = (p: BancPassage): string => {
  const n = [...new Set(p.bancs.map(id => id.split('-')[0]))].sort()
  if (n.join(',') === '1,3,6' && p.bancs.length === 3) return 'court'
  if (p.hebdo) return 'hebdo'
  if (n.join(',') === '1' && p.bancs.length === 1) return 'éclair'
  return `${p.bancs.length} banc${p.bancs.length > 1 ? 's' : ''}`
}

/** La ligne du banc dans la bande ; `null` sans historique (fichier absent) ou sans rien à dire. Rouge l'emporte sur orange, orange sur vert. */
export const bancLine = (passages: BancPassage[] | null, now: number): { text: string; color: ThemeKey } | null => {
  if (!passages) return null
  const last = passages.at(-1)
  const manque = weekendManquant(passages, now)
  if (last && !last.vert) {
    const rouges = last.rouges.slice(0, 3).join(', ')
    return { text: `banc ✗ ${parisJour(new Date(last.date)).jjmm}${rouges ? ` : ${rouges}` : ''}${manque ? ' · ⚠ weekend manquant' : ''}`, color: 'error' }
  }
  if (manque) return { text: 'banc ⚠ weekend manquant', color: 'warning' }
  return last ? { text: `banc ✓ ${parisJour(new Date(last.date)).jjmm} ${sorte(last)} · ${last.candidat}/A`, color: 'success' } : null
}

/** Le détail du panneau : les 5 derniers passages, le plus récent d'abord (date et heure de Paris, sorte, verdict, critères rouges). */
export const bancDetail = (passages: BancPassage[]): string[] =>
  passages
    .slice(-5)
    .reverse()
    .map(p => {
      const { jjmm, heure } = parisJour(new Date(p.date))
      return `${jjmm} ${heure}  ${sorte(p)}  ${p.vert ? '✓ vert' : `✗ rouge${p.rouges.length ? ` : ${p.rouges.join(', ')}` : ''}`}`
    })
