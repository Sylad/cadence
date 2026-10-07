import type { ThemeKey } from 'claude-code'

import type { Wave, WaveLot } from '../types'

/** Couleur d'un taux d'occupation (contexte, fenêtre, budget) : vert, puis orange, puis rouge. */
export const colorOfPercent = (percent: number | undefined, warn = 60, bad = 85): ThemeKey =>
  percent === undefined ? 'subtle' : percent >= bad ? 'error' : percent >= warn ? 'warning' : 'success'

/** 1234 → "1k", 85 300 → "85k", 1 000 000 → "1M". */
export const k = (n: number | undefined): string => {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Une barre de `cells` cases, pleine à `percent`. */
export const bar = (percent: number | undefined, cells = 10): string => {
  const full = percent === undefined ? 0 : Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

/** Durée courte : 42 s, 3 min, 1 h 05. */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')}`
}

/** Temps avant une date ISO ("↻ 2 h 10"), ou vide si inconnue ou passée. */
export const untilReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || t <= now) return ''
  return `↻ ${duration(t - now)}`
}

export const limitLabel = (kind: string): string =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7j' : kind === 'spend_limit' ? '€' : kind

/** Couleur d'un lot orchestré selon son statut. */
export const colorOfLot = (status: string): ThemeKey => {
  switch (status) {
    case 'ready':
      return 'success'
    case 'failed':
    case 'handed-back':
      return 'error'
    case 'question':
    case 'suspended':
      return 'warning'
    case 'queued':
      return 'subtle'
    default:
      return 'claude'
  }
}

const STATUS_FR: Record<string, string> = {
  queued: 'en attente',
  implementing: 'implémente',
  reviewing: 'relit',
  fixing: 'corrige',
  question: 'QUESTION',
  ready: 'prêt',
  'handed-back': 'rendu',
  failed: 'échec',
  suspended: 'suspendu',
}

/** "L75 corrige · fix@sonnet 3 min ×2" */
export const lotText = (lot: WaveLot, now: number): string => {
  const parts = [`${lot.lot} ${STATUS_FR[lot.status] ?? lot.status}`]
  if (lot.step) {
    const since = Date.parse(lot.step.started)
    const age = Number.isFinite(since) ? ` ${duration(now - since)}` : ''
    const dead = lot.step.alive ? '' : ' ✝'
    const sub = lot.step.sub > 0 ? ` +${lot.step.sub}` : ''
    parts.push(`${lot.step.kind}@${lot.step.model}${age}${sub}${dead}`)
  } else if (lot.next && lot.status !== 'ready') {
    parts.push(`→ ${lot.next}`)
  }
  if (lot.pass > 0) parts.push(`p${lot.pass}`)
  return parts.join(' · ')
}

export const wavePercent = (wave: Wave): number | undefined =>
  wave.budget && wave.consumed !== undefined ? Math.round((100 * wave.consumed) / wave.budget) : undefined

export const waveSessions = (wave: Wave): number => wave.lots.filter(l => l.step?.alive).length

export const waveStatusFr = (status: string | undefined): string => {
  switch (status) {
    case 'running':
      return 'en cours'
    case 'suspended-budget':
      return 'suspendue (budget)'
    case 'suspended-quota':
      return 'suspendue (quota)'
    case 'done':
      return 'terminée'
    case 'interrupted':
      return 'interrompue'
    default:
      return status ?? '?'
  }
}

/** Tronque à `width` cellules, avec une ellipse. */
export const fit = (text: string, width: number): string =>
  width <= 1 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
