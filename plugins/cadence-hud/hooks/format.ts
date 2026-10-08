import type { ThemeKey } from 'claude-code'

import type { ModelsSummary, Wave, WaveLot } from '../types'

/** Couleur d'un taux d'occupation (contexte, fenêtre, budget) : vert, puis orange, puis rouge. */
export const colorOfPercent = (percent: number | undefined, warn = 60, bad = 85): ThemeKey =>
  percent === undefined ? 'subtle' : percent >= bad ? 'error' : percent >= warn ? 'warning' : 'success'

/** 1234 → "1k", 85 300 → "85k", 1 000 000 → "1M". */
export const k = (n: number | undefined): string => {
  if (n === undefined || !Number.isFinite(n)) return '-'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Une barre de `cells` cases, pleine à `percent`. */
export const bar = (percent: number | undefined, cells = 10): string => {
  const full = percent === undefined ? 0 : Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

/** Durée courte : 42 s, 3 min, 1 h 05, puis en jours dès 24 h : 6 j 15 h, 3 j. */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')}`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d} j` : `${d} j ${h % 24} h`
}

/** Complète à `width` cellules (pour aligner une colonne). */
export const pad = (text: string, width: number): string => text.padEnd(width)

/** Temps avant une date ISO ("↻ 2 h 10"), ou vide si inconnue ou passée. */
export const untilReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || t <= now) return ''
  return `↻ ${duration(t - now)}`
}

export const limitLabel = (kind: string): string =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7j' : kind === 'spend_limit' ? 'EUR' : kind

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

export const lotStatusFr = (status: string): string => STATUS_FR[status] ?? status

/** Les trois colonnes d'un lot : "L75" · "corrige" · "fix@sonnet 3 min +1 ✝ · p2". */
export const lotCells = (lot: WaveLot, now: number): { lot: string; status: string; detail: string } => {
  const detail: string[] = []
  if (lot.step) {
    const since = Date.parse(lot.step.started)
    const age = Number.isFinite(since) ? ` ${duration(now - since)}` : ''
    const dead = lot.step.alive ? '' : ' ✝'
    const sub = lot.step.sub > 0 ? ` +${lot.step.sub}` : ''
    detail.push(`${lot.step.kind}@${lot.step.model}${age}${sub}${dead}`)
  } else if (lot.next && lot.status !== 'ready') {
    detail.push(`→ ${lot.next}`)
  }
  if (lot.pass > 0) detail.push(`p${lot.pass}`)
  return { lot: lot.lot, status: lotStatusFr(lot.status), detail: detail.join(' · ') }
}

/** "L75 corrige · fix@sonnet 3 min" — les cellules sur une ligne. */
export const lotText = (lot: WaveLot, now: number): string => {
  const c = lotCells(lot, now)
  return [`${c.lot} ${c.status}`, c.detail].filter(Boolean).join(' · ')
}

/** Le projet commun à tous les lots d'une vague, ou null s'ils en ont plusieurs. */
export const commonProject = (wave: Wave): string | null => {
  const projects = new Set(wave.lots.map(l => l.project))
  return projects.size === 1 ? [...projects][0]! : null
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

/** Tronque à `width` caractères, avec trois points ASCII (« … » est de largeur ambiguë, que cells() ne couvre pas). */
export const fit = (text: string, width: number): string =>
  width <= 2 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 3))}...`

const STATUS_PLURAL_FR: Record<string, string> = {
  queued: 'en attente',
  question: 'questions',
  ready: 'prêts',
  'handed-back': 'rendus',
  failed: 'échecs',
  suspended: 'suspendus',
}

/** Le bilan des lots d'une vague : "3 prêts · 1 échec · 3 suspendus", dans l'ordre prêt, échec, rendu, question, suspendu, reste. */
export const lotCounts = (wave: Wave): string => {
  const order = ['ready', 'failed', 'handed-back', 'question', 'suspended']
  const counts = new Map<string, number>()
  for (const lot of wave.lots) counts.set(lot.status, (counts.get(lot.status) ?? 0) + 1)
  const statuses = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b)
  })
  return statuses
    .map(s => {
      const n = counts.get(s)!
      return `${n} ${n > 1 ? (STATUS_PLURAL_FR[s] ?? lotStatusFr(s)) : lotStatusFr(s)}`
    })
    .join(' · ')
}

/** "il y a 12 min" depuis une date ISO, ou vide si inconnue. */
export const ago = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return `il y a ${duration(Math.max(0, now - t))}`
}

/** Le nom court d'un identifiant de modèle : `claude-fable-5-1` → `fable`, `claude-sonnet-5-5` → `sonnet`, autre → l'identifiant. */
export const shortModel = (id: string): string => {
  const m = /^(?:[a-z0-9]+\.)?(?:anthropic\.)?claude-([a-z]+)/i.exec(id)
  return m ? m[1]!.toLowerCase() : id
}

/** "fable 410k sonnet 85k", du plus cher au moins cher (le coût ordonne, il ne s'affiche pas) ; vide sans modèle. */
export const modelsText = (models: ModelsSummary): string =>
  Object.entries(models.byModel)
    .sort(([, a], [, b]) => b.usd - a.usd || b.tokens - a.tokens)
    .map(([name, m]) => `${name} ${k(m.tokens)}`)
    .join(' ')

/** Un tour fini attribue ses tokens au modèle `name` et la part du coût de session apparue depuis le dernier tour :
 *  `total` est le coût courant de /cost (undefined quand il n'a pu être lu) ; un total absent, inchangé ou plus bas
 *  ne répartit rien, jamais de part négative, et la somme des parts reste égale au dernier total vu. */
export const attributeTurn = (m: ModelsSummary, name: string, tokens: number, total: number | undefined): ModelsSummary => {
  const seen = total !== undefined && total > m.usdSeen ? total : m.usdSeen
  const usd = seen - m.usdSeen
  const before = m.byModel[name] ?? { tokens: 0, usd: 0 }
  return { byModel: { ...m.byModel, [name]: { tokens: before.tokens + tokens, usd: before.usd + usd } }, usdSeen: seen }
}

/** Largeur des caractères de largeur ambiguë d'après `CADENCE_HUD_AMBIGUOUS` (le module n'a pas de `process` : la valeur vient de `$.env`) : 1 ou 2, et 2 (le pire cas) sans variable ni valeur valide. */
export const parseAmbiguous = (value: string | undefined): 1 | 2 => (value?.trim() === '1' ? 1 : 2)

/**
 * Largeur en cellules terminal (la première ligne de la bande n'emploie que de l'ASCII et ces symboles) : les caractères de largeur ambiguë (formes géométriques ▰▱, symboles ⚙,
 * traits │, flèches ↻) comptent pour `ambiguous` (2 par défaut : le pire cas, comme dans un terminal réglé en
 * ambiguous-width=2), et les caractères larges (CJK, emoji) toujours pour 2. Au défaut, un terminal en largeur 1 n'affiche jamais plus que ce que la mesure a prévu.
 */
export const cells = (text: string, ambiguous: 1 | 2 = 2): number => {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const isAmbiguous =
      (c >= 0x2190 && c <= 0x21ff) || // flèches
      (c >= 0x2500 && c <= 0x27bf) // traits, blocs, formes géométriques, symboles, dingbats
    const isWide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      c >= 0x1f300
    n += isWide ? 2 : isAmbiguous ? ambiguous : 1
  }
  return n
}

/**
 * Garde les segments d'une ligne qui tiennent dans `width` cellules : tant que la somme des textes dépasse, le
 * segment au `drop` le plus haut tombe (0 = ne tombe jamais). Puis, une fois le compte bon, les segments tombés
 * qui tiendraient dans la place restante reviennent, du plus utile au moins utile (`back` le plus bas, `drop` à défaut) : un gros
 * segment tombé ne prive pas la ligne des petits qui entrent. Un segment qui `requires` la clé d'un autre ne
 * revient que si celui-là est gardé. Les textes sont mesurés par `cells` avec la même largeur ambiguë. Rend les segments gardés, dans leur ordre.
 */
export const fitSegments = <S extends { key?: string; text: string; drop: number; back?: number; requires?: string }>(
  segments: readonly S[],
  width: number,
  ambiguous: 1 | 2 = 2,
): S[] => {
  const kept = new Set(segments)
  const length = () => [...kept].reduce((n, s) => n + cells(s.text, ambiguous), 0)
  while (length() > width) {
    let idx: S | undefined
    for (const s of segments) if (kept.has(s) && s.drop > 0 && (!idx || s.drop > idx.drop)) idx = s
    if (!idx) break
    kept.delete(idx)
  }
  let free = width - length()
  const dropped = segments.filter(s => !kept.has(s)).sort((a, b) => (a.back ?? a.drop) - (b.back ?? b.drop))
  for (const s of dropped) {
    const needed = cells(s.text, ambiguous)
    const parent = s.requires === undefined || segments.some(o => kept.has(o) && o.key === s.requires)
    if (parent && needed <= free) {
      kept.add(s)
      free -= needed
    }
  }
  return segments.filter(s => kept.has(s))
}
