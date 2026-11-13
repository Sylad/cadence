import type { ThemeKey } from 'claude-code'

import type { BancPassage, EnCours } from '../types'

// ── Task 16 (cadence 2) : l'état du banc, lu de `historique.jsonl` (une ligne par passage, `ligneHistorique` de v2/src/bench/verdict.ts) ──

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** La sortie de BANC_READER (collect.ts) : `null` (fichier absent) ou ses lignes ; une sortie illisible lève (le passage d'avant reste affiché). */
export const readBanc = (stdout: string): BancPassage[] | null => {
  const raw: unknown = JSON.parse(stdout)
  const h = typeof raw === 'object' && raw !== null && 'h' in raw ? (raw as { h: unknown }).h : undefined
  if (h === null) return null
  if (!Array.isArray(h)) throw new Error('historique du banc : sortie illisible')
  return parseBanc(strings(h))
}

/** `en-cours.json` (écrit par `passage`, v2/src/bench/cli.ts) dans la même sortie du lecteur : null s'il manque ou s'il est illisible. */
export const readEnCours = (stdout: string): EnCours | null => {
  try {
    const c: unknown = (JSON.parse(stdout) as { c?: unknown }).c
    const o: unknown = typeof c === 'string' ? JSON.parse(c) : null
    if (typeof o !== 'object' || o === null) return null
    const x = o as Record<string, unknown>
    const ok = ['debut', 'phase_debut', 'banc', 'phase'].every(k => typeof x[k] === 'string') && [x.bancs_total, x.termines, x.repetition].every(n => typeof n === 'number')
    const seq = x.etape === undefined || (typeof x.etape === 'string' && /^\d+\/\d+$/.test(x.etape)) // un banc séquence : « k/n »
    return ok && seq ? (x as unknown as EnCours) : null
  } catch {
    return null
  }
}

const SIX_HEURES = 6 * 3600_000
/** « 7 min », « 1 h 24 » : une durée en millisecondes. */
export const duree = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** La ligne d'un passage en cours, avant toute autre ligne du banc : accent ; orange avec « bloqué ? » quand la phase n'a pas changé depuis plus de 6 h. */
export const enCoursLine = (e: EnCours | null, now: number): { text: string; color: ThemeKey } | null => {
  if (!e) return null
  const bloque = now - Date.parse(e.phase_debut) > SIX_HEURES
  const rep = (e.repetitions ?? 1) > 1 ? ` · répétition ${e.repetition}/${e.repetitions}` : ''
  const text = e.etape ? `séquence ⟳ ${e.banc} · étape ${e.etape}${rep} · ${e.phase} · ${duree(now - Date.parse(e.phase_debut))} (depuis ${duree(now - Date.parse(e.debut))})${bloque ? ' · bloqué ?' : ''}` : `banc ⟳ ${Math.min(e.termines + 1, e.bancs_total)}/${e.bancs_total} bancs · ${e.banc} #${e.repetition} · ${e.phase} · ${duree(now - Date.parse(e.phase_debut))} (depuis ${duree(now - Date.parse(e.debut))})${bloque ? ' · bloqué ?' : ''}`
  return { text, color: bloque ? 'warning' : 'claude' }
}

/** Les passages lisibles de l'historique, dans l'ordre du fichier ; une ligne illisible (JSON invalide, date ou verdict absent) est sautée. */
export const parseBanc = (lines: string[]): BancPassage[] =>
  lines.flatMap(l => {
    try {
      const x: unknown = JSON.parse(l)
      if (typeof x !== 'object' || x === null || Array.isArray(x)) return []
      const o = x as Record<string, unknown>
      if (typeof o.date !== 'string' || Number.isNaN(Date.parse(o.date)) || typeof o.vert !== 'boolean') return []
      // contrôles éclair rouges (`eclair_ok: false`) : le passage s'affiche ✗, même sur un verdict vert
      const eclairRouge = o.eclair_ok === false
      return [{ date: o.date, candidat: typeof o.candidat === 'string' ? o.candidat : '?', bancs: strings(o.bancs), hebdo: o.hebdo === true, ...(o.type === 'sequence' && { sequence: true }), ...(typeof o.niveau === 'string' && { niveau: o.niveau }), vert: o.vert && !eclairRouge, rouges: [...strings(o.rouges), ...(eclairRouge ? ['contrôles éclair'] : [])] }]
    } catch {
      return []
    }
  })

// Recopie de parisJour de v2/src/bench/verdict.ts (le plugin ne dépend pas de v2).
const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const parisJour = (d: Date) => {
  const p = Object.fromEntries(PARIS.formatToParts(d).map(x => [x.type, x.value]))
  return { jour: `${p.year}-${p.month}-${p.day}`, sem: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? ''), jjmm: `${p.day}-${p.month}`, heure: `${p.hour}:${p.minute}` }
}
/** La sorte d'un passage : séquence ; micro ou mécanique (L689, sans juge IA) ; puis, sur les bancs de base (`<banc>#k` = répétition k) : 1, 3 et 6 exactement = court ; hebdo ; le banc 1 seul = éclair ; sinon le nombre de bancs. */
export const sorte = (p: BancPassage): string => {
  if (p.sequence) return 'séquence'
  if (p.niveau) return p.niveau === 'mecanique' ? 'mécanique' : p.niveau
  const base = [...new Set(p.bancs.map(id => id.replace(/#[^#]*$/, '')))]
  const n = [...new Set(base.map(id => id.split('-')[0]))].sort()
  if (n.join(',') === '1,3,6' && base.length === 3) return 'court'
  if (p.hebdo) return 'hebdo'
  if (n.join(',') === '1' && base.length === 1) return 'éclair'
  return `${base.length} banc${base.length > 1 ? 's' : ''}`
}

/** La ligne du banc dans la bande ; `null` sans historique (fichier absent) ou sans passage. Plus de banc du weekend exigé (L689, décision de Sylvain du 13-11). */
export const bancLine = (passages: BancPassage[] | null, _now: number): { text: string; color: ThemeKey } | null => {
  if (!passages) return null
  const last = passages.at(-1)
  if (last && !last.vert) {
    const rouges = last.rouges.slice(0, 3).join(', ')
    return { text: `banc ✗ ${parisJour(new Date(last.date)).jjmm}${rouges ? ` : ${rouges}` : ''}`, color: 'error' }
  }
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
