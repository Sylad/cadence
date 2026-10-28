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

/** Au-delà de ce nombre de lots ouverts, un projet est replié tant que la personne n'a pas choisi. */
export const FOLD_ABOVE = 20

/** Le projet est-il replié : le choix de la personne (`folds`, vrai = replié) l'emporte sur le défaut (plus de FOLD_ABOVE lots ouverts). */
export const isFolded = (project: string, lots: readonly TourLot[], folds: Readonly<Record<string, boolean>>): boolean => folds[project] ?? openCount(lots) > FOLD_ABOVE

export type PanelLine =
  | { kind: 'project'; name: string; count: number; error?: string; /** lots en cours (hors sous-tâches) */ doing: number; /** absent d'un projet illisible, qui ne se replie pas */ folded?: boolean }
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
 * si l'arbre est plus haut, les premières lignes restent et `more` compte les lots que la ligne « … +N lots de plus » (une ligne de plus) remplace ; un projet replié placé après la coupure garde sa ligne.
 */
export const buildPanel = (input: {
  rows: readonly LotsRow[]
  columns: number
  height: number
  waves: readonly { project: string; lot: string; status: string }[]
  /** Le choix de la personne par projet (vrai = replié) ; absent, le défaut de isFolded. */
  folds?: Readonly<Record<string, boolean>>
}): Panel => {
  const { rows, columns, waves } = input
  const folds = input.folds ?? {}
  const narrow = columns < NARROW_BODY
  type Block = { project: LotsRow; flat: FlatLot[]; open: Set<string>; folded: boolean }
  const blocks: Block[] = rows
    .filter(r => r.error || (r.lots && r.lots.length > 0))
    .map(r => ({ project: r, flat: flattenTree(lotTree(r.lots ?? [])), open: new Set((r.lots ?? []).map(l => l.id)), folded: !r.error && isFolded(r.project, r.lots ?? [], folds) }))
  const leadOf = (f: FlatLot) => (f.depth === 0 ? '  ' : `  ${'  '.repeat(f.depth - 1)}${f.branch} `)
  const shown = blocks.filter(b => !b.folded)
  const all = shown.flatMap(b => b.flat)
  const idWidth = Math.max(0, ...all.map(f => leadOf(f).length + f.lot.id.length))
  const stateOf = (b: Block, f: FlatLot) => lotState(f.lot, b.open, waves.find(w => w.lot === f.lot.id && sameProject(b.project.project, w.project))?.status)
  const stateWidth = Math.max(0, ...shown.flatMap(b => b.flat.map(f => stateOf(b, f).text.length)))

  const lines: (PanelLine & { height: number })[] = []
  for (const b of blocks) {
    if (b.project.error) {
      lines.push({ kind: 'project', name: b.project.project, count: 0, doing: 0, error: `illisible : ${b.project.error}`, height: 1 })
      continue
    }
    const top = (b.project.lots ?? []).filter(l => !isTask(l))
    lines.push({ kind: 'project', name: b.project.project, count: top.length, doing: top.filter(l => l.status === 'doing').length, folded: b.folded, height: 1 })
    if (b.folded) continue
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
  const isFoldedLine = (l: PanelLine) => l.kind === 'project' && !!l.folded
  const tail = (from: number) => lines.slice(from).filter(isFoldedLine) // les projets repliés après la coupure gardent leur ligne
  let kept = 0
  let used = 0
  while (kept < lines.length && used + lines[kept]!.height <= room - 1) used += lines[kept++]!.height
  const cost = (n: number) => lines.slice(0, n).reduce((s, l) => s + l.height, 0) + tail(n).length
  while (kept > 0 && (cost(kept) > room - 1 || (lines[kept - 1]!.kind === 'project' && !isFoldedLine(lines[kept - 1]!)))) kept-- // un nom de projet sans aucun de ses lots n'apprend rien
  const shownLines = [...lines.slice(0, kept), ...tail(kept)]
  // des projets repliés plus nombreux que la place : on garde ce qui tient avec le pied, les lots des lignes retirées passent dans « … +N »
  const fits = shownLines.slice(0, Math.max(0, room - 1))
  const dropped = shownLines.slice(fits.length)
  const droppedLots = dropped.reduce((n, l) => n + (l.kind === 'project' ? l.count : 0), 0)
  return { lines: fits.map(({ height: _h, ...l }) => l as PanelLine), more: lines.slice(kept).filter(l => l.kind === 'lot').length + droppedLots }
}
