import type { ThemeKey } from 'claude-code'

import type { LotsBoard, LotsRow, TourLot } from '../types'
import { colorOfLot, lotStatusFr } from './format'

// ── L401 : le panneau des lots (/hud lots) — lecture de `cadence lead tour --json`, arbre et mise en page ───────────

/** Sous cette largeur de corps, la liste after: passe sur une ligne à part. */
export const NARROW_BODY = 60

/** Lit la sortie de `cadence lead tour --json` pour le panneau : toutes les lignes, celles en erreur comprises (parseTour les écarte). `outdated` : aucune ligne lisible ne porte `lots` (cadence plus ancien que le mod) ; une ligne en erreur n'en a jamais et ne le dit donc pas. */
export const parseLotsBoard = (stdout: string): LotsBoard => {
  const raw: unknown = JSON.parse(stdout)
  const rows: LotsRow[] = (Array.isArray(raw) ? raw : [])
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof (r as { project?: unknown }).project === 'string')
    .map(r => ({
      project: r.project as string,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
      ...(Array.isArray(r.lots) ? { lots: r.lots.filter((l): l is TourLot => typeof l?.id === 'string').map(l => ({ ...l, after: Array.isArray(l.after) ? l.after : [] })) } : {}),
    }))
  const readable = rows.filter(r => !r.error)
  return { rows, outdated: readable.length > 0 && readable.every(r => r.lots === undefined) }
}

/** La signature des dates de plans lues par PLAN_STAMPS : change dès qu'un plan est modifié, ajouté ou retiré ; vide quand la sortie est illisible (la surveillance est alors sans effet, la minute reste). */
export const stampsSignature = (stdout: string): string => {
  try {
    const raw: unknown = JSON.parse(stdout)
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.entries(raw).map(([path, mtime]) => `${path}=${String(mtime)}`).sort().join('|') : ''
  } catch {
    return ''
  }
}

/** Une sous-tâche native : son id est `<lot>/<n>` et son parent est ce lot (le sous-lot d'un plan tenu par un autre outil a un id propre). */
export const isTask = (l: TourLot): boolean => l.parent !== undefined && l.id.startsWith(`${l.parent}/`)

/** Le nombre de lots non clos d'un projet : les sous-lots de Lot.parent comptent, les sous-tâches natives non. */
export const openCount = (lots: readonly TourLot[]): number => lots.filter(l => !isTask(l)).length

export type LotNode = { lot: TourLot; children: LotNode[] }

/**
 * L'arbre des lots d'un projet. Un lot dont `parent` est un lot du tableau est rangé sous lui ; un parent clos ou inconnu, un
 * parent de lui-même, une chaîne de parents qui revient au lot laissent le lot au premier niveau. Pour un id présent plusieurs fois,
 * la première occurrence reçoit les sous-lots et les autres restent au premier niveau.
 */
export const lotTree = (lots: readonly TourLot[]): LotNode[] => {
  const nodes = lots.map(lot => ({ lot, children: [] as LotNode[] }))
  const first = new Map<string, LotNode>()
  for (const n of nodes) if (!first.has(n.lot.id)) first.set(n.lot.id, n)
  const returnsTo = (start: LotNode, parent: string): boolean => {
    const seen = new Set<string>()
    for (let at: string | undefined = parent; at !== undefined && !seen.has(at); at = first.get(at)?.lot.parent) {
      if (at === start.lot.id) return true
      seen.add(at)
    }
    return false
  }
  const top: LotNode[] = []
  for (const n of nodes) {
    const parent = n.lot.parent !== undefined && first.get(n.lot.id) === n ? first.get(n.lot.parent) : undefined
    if (parent && !returnsTo(n, n.lot.parent!)) parent.children.push(n)
    else top.push(n)
  }
  return top
}

export type FlatLot = { lot: TourLot; depth: number; branch: '' | '├' | '└' }

/** L'arbre à plat, dans l'ordre d'affichage ; chaque sous-lot porte ├ (suivi d'un frère) ou └ (le dernier). */
export const flattenTree = (nodes: readonly LotNode[], depth = 0): FlatLot[] =>
  nodes.flatMap((n, i) => [{ lot: n.lot, depth, branch: depth === 0 ? ('' as const) : i === nodes.length - 1 ? ('└' as const) : ('├' as const) }, ...flattenTree(n.children, depth + 1)])

const WAVE_GLYPH: Record<string, string> = { queued: '…', question: '?', ready: '✔', 'handed-back': '↩', failed: '✖', suspended: '⏸' }

export type LotState = { text: string; color: ThemeKey }

/** L'état d'un lot en mots, glyphe et couleur : celui de la vague s'il y en a un (mots et couleurs de la bande), sinon celui du plan. Une sous-tâche n'a que son statut. `openIds` : les lots non clos du projet. */
export const lotState = (lot: TourLot, openIds: ReadonlySet<string>, waveStatus?: string): LotState => {
  if (isTask(lot)) return lot.status === 'doing' ? { text: '▶ en cours', color: 'claude' } : { text: '○ à faire', color: 'text' }
  if (waveStatus !== undefined) return { text: `${WAVE_GLYPH[waveStatus] ?? '⟳'} ${lotStatusFr(waveStatus)}`, color: colorOfLot(waveStatus) }
  if (lot.status === 'doing') return { text: '▶ en cours', color: 'claude' }
  return lot.after.some(id => openIds.has(id)) ? { text: '⊘ bloqué', color: 'subtle' } : { text: '○ libre', color: 'text' }
}

/** « 15:05 » : l'heure locale de la dernière lecture. */
export const readTime = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Tronque à `max` caractères avec « … » (une cellule, comme le Text du moteur) ; jamais plus long que `max`, vide à zéro. */
export const ellipsize = (text: string, max: number): string => (max <= 0 ? '' : text.length <= max ? text : max === 1 ? '…' : `${text.slice(0, max - 1)}…`)

export type PanelLine =
  | { kind: 'project'; name: string; count: number; error?: string }
  | {
      kind: 'lot'
      id: string
      /** Retrait et branche (« ␣␣├␣ ») qui précèdent l'id. */
      lead: string
      title: string
      state: LotState
      after: { id: string; struck: boolean }[]
      afterOwnLine: boolean
      /** Largeurs communes à toutes les lignes, pour l'alignement. */
      idWidth: number
      stateWidth: number
    }

export type Panel = { lines: PanelLine[]; /** lignes de lot non affichées faute de hauteur */ more: number }

/** La vague d'un lot : le projet de la vague est le nom du dossier du projet du tour (« apps/ol » ↔ « ol »). */
const sameProject = (row: string, wave: string): boolean => row === wave || row.split('/').pop() === wave

/**
 * Les lignes du panneau pour `columns` colonnes de corps et `height` lignes de corps : le titre et le pied en prennent deux ;
 * si l'arbre est plus haut, les premières lignes restent et `more` compte les lots que la ligne « … +N lots de plus » (une ligne de plus) remplace.
 */
export const buildPanel = (input: {
  rows: readonly LotsRow[]
  columns: number
  height: number
  waves: readonly { project: string; lot: string; status: string }[]
}): Panel => {
  const { rows, columns, waves } = input
  const narrow = columns < NARROW_BODY
  type Block = { project: LotsRow; flat: FlatLot[]; open: Set<string> }
  const blocks: Block[] = rows
    .filter(r => r.error || (r.lots && r.lots.length > 0))
    .map(r => ({ project: r, flat: flattenTree(lotTree(r.lots ?? [])), open: new Set((r.lots ?? []).map(l => l.id)) }))
  const leadOf = (f: FlatLot) => (f.depth === 0 ? '  ' : `  ${'  '.repeat(f.depth - 1)}${f.branch} `)
  const all = blocks.flatMap(b => b.flat)
  const idWidth = Math.max(0, ...all.map(f => leadOf(f).length + f.lot.id.length))
  const stateOf = (b: Block, f: FlatLot) => lotState(f.lot, b.open, waves.find(w => w.lot === f.lot.id && sameProject(b.project.project, w.project))?.status)
  const stateWidth = Math.max(0, ...blocks.flatMap(b => b.flat.map(f => stateOf(b, f).text.length)))

  const lines: (PanelLine & { height: number })[] = []
  for (const b of blocks) {
    if (b.project.error) {
      lines.push({ kind: 'project', name: b.project.project, count: 0, error: `illisible : ${b.project.error}`, height: 1 })
      continue
    }
    lines.push({ kind: 'project', name: b.project.project, count: openCount(b.project.lots ?? []), height: 1 })
    for (const f of b.flat) {
      const after = f.lot.after.map(id => ({ id, struck: !b.open.has(id) }))
      const afterText = after.length ? `after: ${after.map(a => a.id).join(' ')}` : ''
      const afterOwnLine = narrow && after.length > 0
      const room = columns - idWidth - 2 - stateWidth - 2 - (afterText && !narrow ? afterText.length + 2 : 0)
      lines.push({ kind: 'lot', id: f.lot.id, lead: leadOf(f), title: ellipsize(f.lot.title, Math.max(1, room)), state: stateOf(b, f), after, afterOwnLine, idWidth, stateWidth, height: afterOwnLine ? 2 : 1 })
    }
  }

  const room = Math.max(1, input.height - 2)
  const total = lines.reduce((n, l) => n + l.height, 0)
  if (total <= room) return { lines: lines.map(({ height: _h, ...l }) => l as PanelLine), more: 0 }
  let used = 0
  let kept = 0
  while (kept < lines.length && used + lines[kept]!.height <= room - 1) used += lines[kept++]!.height
  while (kept > 0 && lines[kept - 1]!.kind === 'project') kept-- // un nom de projet sans aucun de ses lots n'apprend rien
  return { lines: lines.slice(0, kept).map(({ height: _h, ...l }) => l as PanelLine), more: lines.slice(kept).filter(l => l.kind === 'lot').length }
}
