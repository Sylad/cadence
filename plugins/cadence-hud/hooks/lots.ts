import type { ThemeKey } from 'claude-code'

import type { LotsBoard, LotsRow, MoveAsk, TourLot } from '../types'
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

/** Le groupe de frères d'un lot : les lots du projet (''), ou les sous-tâches d'un même lot (le lot) ; `raf move` ne place un lot que par rapport à un frère. */
export const groupOf = (l: TourLot): string => (isTask(l) ? l.parent! : '')

/** Ce que le panneau demande à raf, ou pourquoi il ne le demande pas. */
export type MovePlan = { ok: true; argv: string[] } | { ok: false; reason: string }

/** Contrôle une demande de déplacement contre les lots lus du projet : les ids sont ceux du tableau (la demande vient du dessin, donc à vérifier) et les deux lots ont le même parent. Le reste (vague, plan en lecture seule, lot archivé) est dit par `raf move` lui-même. */
/** `undefined` : rien à faire (un lot lâché sur lui-même). */
export const planMove = (lots: readonly TourLot[], ask: MoveAsk): MovePlan | undefined => {
  const lot = lots.find(l => l.id === ask.id)
  const target = lots.find(l => l.id === ask.target)
  if (!lot || !target || (ask.place !== 'before' && ask.place !== 'after')) return { ok: false, reason: `lot inconnu : ${!lot ? ask.id : ask.target}` }
  if (lot === target) return undefined
  if (groupOf(lot) !== groupOf(target)) return { ok: false, reason: `${lot.id} et ${target.id} n'ont pas le même parent : un lot se réordonne parmi les lots de son projet, une sous-tâche parmi celles de son lot` }
  return { ok: true, argv: ['raf', 'move', lot.id, `--${ask.place}`, target.id] }
}

/** La raison d'un refus de `raf move` : la première ligne de son erreur, sans le préfixe « raf: » ; le code de sortie si elle est vide. */
export const refusalReason = (stderr: string, exitCode: number): string => stderr.split('\n').map(l => l.trim()).find(l => l !== '')?.replace(/^raf\s*:\s*/, '') ?? `raf move : code ${exitCode}`

/** Le dossier d'un projet du tour : le dossier interrogé lui-même quand le tour n'a qu'une ligne portant son nom (un projet sans sous-projet), sinon `<dossier>/<projet>` ; `raf` s'y lance. */
export const projectDir = (folder: string, project: string, rows: readonly LotsRow[]): string =>
  rows.length === 1 && folder.replace(/\/+$/, '').split('/').pop() === project ? folder : `${folder.replace(/\/+$/, '')}/${project}`

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

/** Les états de vague où le lot est travaillé (ou attend la personne) : implémentation, revue, correction, question, prêt, rendu. */
const WORKED_IN_WAVE = new Set(['implementing', 'reviewing', 'fixing', 'question', 'ready', 'handed-back'])

/** Le rang d'un lot dans son projet (L410) : 0 en cours (doing, ou travaillé dans une vague), 1 prêt (à faire, aucun after: ouvert), 2 le reste. */
export const lotRank = (lot: TourLot, openIds: ReadonlySet<string>, waveStatus?: string): 0 | 1 | 2 => {
  if (lot.status === 'doing' || (waveStatus !== undefined && WORKED_IN_WAVE.has(waveStatus))) return 0
  return isTask(lot) || !lot.after.some(id => openIds.has(id)) ? 1 : 2
}

/**
 * L'arbre rangé par rang : en cours, prêts, reste ; l'ordre du plan est gardé dans un même rang. Un sous-lot reste sous son parent
 * (le tri se fait entre frères) et un parent dont un descendant est en cours (rang 0) passe au rang 0 et remonte avec lui ; un sous-lot seulement prêt ne change pas le rang de son parent.
 */
export const sortTree = (nodes: readonly LotNode[], rankOf: (lot: TourLot) => number): LotNode[] => {
  const ranked = nodes.map(n => {
    const children = sortTree(n.children, rankOf)
    return { node: { lot: n.lot, children }, rank: children.some(c => hasInProgress(c, rankOf)) ? 0 : rankOf(n.lot) }
  })
  return ranked.map((r, i) => ({ ...r, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map(r => r.node)
}

const hasInProgress = (n: LotNode, rankOf: (lot: TourLot) => number): boolean => rankOf(n.lot) === 0 || n.children.some(c => hasInProgress(c, rankOf))

export type FlatLot = { lot: TourLot; depth: number; branch: '' | '├' | '└'; /** ses sous-lots directs, montrés ou non */ children: number; /** tous ses descendants, à toute profondeur : ce que cache le lot replié */ descendants: number }

/** Le nombre de lots sous un nœud, à toute profondeur (sous-lots `parent:` et sous-tâches natives) ; 0 pour une feuille. */
export const descendantCount = (n: LotNode): number => n.children.reduce((s, c) => s + 1 + descendantCount(c), 0)

/** L'arbre à plat, dans l'ordre d'affichage ; chaque sous-lot porte ├ (suivi d'un frère) ou └ (le dernier). `isOpen` : les sous-lots d'un lot ne sont mis à plat que s'il dit oui (tous, par défaut). */
export const flattenTree = (nodes: readonly LotNode[], isOpen: (lot: TourLot) => boolean = () => true, depth = 0): FlatLot[] =>
  nodes.flatMap((n, i) => [
    { lot: n.lot, depth, branch: depth === 0 ? ('' as const) : i === nodes.length - 1 ? ('└' as const) : ('├' as const), children: n.children.length, descendants: descendantCount(n) },
    ...(isOpen(n.lot) ? flattenTree(n.children, isOpen, depth + 1) : []),
  ])

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

/** Le nombre de lots du premier niveau qu'un projet montre tant que la personne n'a pas demandé le reste (L411). */
export const LOTS_PER_PROJECT = 5

/** La clé du choix « le reste du projet est déplié » dans les états du panneau (vrai = déplié). */
export const moreKey = (project: string): string => `more:${project}`

/** La clé du choix « les sous-lots de ce lot sont dépliés » dans les états du panneau (vrai = déplié) ; par projet, un même id pouvant se trouver dans deux. */
export const openKey = (project: string, id: string): string => `open:${project}#${id}`

/**
 * Les lignes visibles d'un projet : les LOTS_PER_PROJECT premiers lots du premier niveau (ou tous, si la personne a déplié le reste), et les sous-lots des seuls lots dépliés.
 * `hidden` : les lots du premier niveau que le plafond cache (le N du bouton) ; `behind` : tous les lots du reste, leurs sous-lots à toute profondeur compris (ce qu'un bouton replié cache vraiment).
 */
const visibleLots = (project: string, tree: readonly LotNode[], views: Readonly<Record<string, boolean>>): { flat: FlatLot[]; hidden: number; behind: number } => ({
  flat: flattenTree(views[moreKey(project)] === true ? tree : tree.slice(0, LOTS_PER_PROJECT), lot => views[openKey(project, lot.id)] === true),
  hidden: Math.max(0, tree.length - LOTS_PER_PROJECT),
  behind: tree.slice(LOTS_PER_PROJECT).reduce((n, node) => n + 1 + descendantCount(node), 0),
})

/** Le compte des sous-lots d'un lot, tel qu'il s'affiche après son titre. */
export const subsText = (count: number): string => `${count} sous-lot${count > 1 ? 's' : ''}`

/** Le texte du bouton du reste d'un projet : « + N lots » replié, « moins » déplié. */
export const moreText = (hidden: number, expanded: boolean): string => (expanded ? 'moins' : `+ ${hidden} lot${hidden > 1 ? 's' : ''}`)

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
      /** Le groupe de frères (groupOf) : on ne réordonne qu'à l'intérieur. */
      group: string
      /** Largeurs communes à toutes les lignes, pour l'alignement. */
      idWidth: number
      stateWidth: number
      /** Présent quand le lot a des sous-lots : sa bascule (clé de ses états), leur nombre (`count`, les directs, affiché), tous ses descendants (`total`, ce que cache le lot replié) et s'ils sont montrés. */
      subs?: { key: string; count: number; total: number; open: boolean }
    }
  /** Le bouton « + N lots » / « moins » du reste d'un projet de plus de LOTS_PER_PROJECT lots : `hidden`, les lots du premier niveau du reste (le N affiché) ; `behind`, tous les lots du reste, sous-lots compris (ce que le bouton cache tant qu'il est replié). */
  | { kind: 'more'; project: string; hidden: number; behind: number; expanded: boolean }

export type Panel = { lines: PanelLine[]; /** lignes de lot non affichées faute de hauteur */ more: number }

/** La vague d'un lot : le projet de la vague est le nom du dossier du projet du tour (« apps/ol » ↔ « ol »). */
const sameProject = (row: string, wave: string): boolean => row === wave || row.split('/').pop() === wave

/**
 * Les lignes du panneau pour `columns` colonnes de corps et `height` lignes de corps : le titre et le pied en prennent deux ;
 * si l'arbre est plus haut, les premières lignes restent et `more` compte les lots que la ligne « … +N lots de plus » (une ligne de plus) remplace ; un projet replié placé après la coupure garde sa ligne, de même que le bouton « + N lots » / « moins » du projet que la coupure traverse.
 */
export const buildPanel = (input: {
  rows: readonly LotsRow[]
  columns: number
  height: number
  waves: readonly { project: string; lot: string; status: string }[]
  /** Le choix de la personne par projet (vrai = replié) ; absent, le défaut de isFolded. */
  folds?: Readonly<Record<string, boolean>>
  /** Les dépliages choisis (moreKey, openKey ; vrai = déplié) ; absent, tout est replié. */
  views?: Readonly<Record<string, boolean>>
}): Panel => {
  const { rows, columns, waves } = input
  const folds = input.folds ?? {}
  const views = input.views ?? {}
  const narrow = columns < NARROW_BODY
  type Block = { project: LotsRow; flat: FlatLot[]; hidden: number; behind: number; open: Set<string>; folded: boolean }
  const blocks: Block[] = rows
    .filter(r => r.error || (r.lots && r.lots.length > 0))
    .map(r => {
      const open = new Set((r.lots ?? []).map(l => l.id))
      const waveOf = (l: TourLot) => waves.find(w => w.lot === l.id && sameProject(r.project, w.project))?.status
      const tree = sortTree(lotTree(r.lots ?? []), l => lotRank(l, open, waveOf(l)))
      const { flat, hidden, behind } = visibleLots(r.project, tree, views)
      return { project: r, flat, hidden, behind, open, folded: !r.error && isFolded(r.project, r.lots ?? [], folds) }
    })
  const baseLead = (f: FlatLot) => (f.depth === 0 ? '  ' : `  ${'  '.repeat(f.depth - 1)}${f.branch} `)
  const isOpen = (b: Block, f: FlatLot) => views[openKey(b.project.project, f.lot.id)] === true
  // un lot à sous-lots porte sa bascule (▸ replié, ▾ déplié) dans la dernière cellule de son retrait, collée à l'id à tous les niveaux (au premier : « ␣▸L401 », sous la colonne du glyphe du projet)
  const leadOf = (b: Block, f: FlatLot) => {
    const lead = baseLead(f)
    if (f.children === 0) return lead
    const glyph = isOpen(b, f) ? '▾' : '▸'
    return `${lead.slice(0, -1)}${glyph}`
  }
  const shown = blocks.filter(b => !b.folded)
  const idWidth = Math.max(0, ...shown.flatMap(b => b.flat.map(f => leadOf(b, f).length + f.lot.id.length)))
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
      const subs = f.children > 0 ? { key: openKey(b.project.project, f.lot.id), count: f.children, total: f.descendants, open: isOpen(b, f) } : undefined
      const room = columns - idWidth - 2 - stateWidth - 2 - (afterText && !narrow ? afterText.length + 2 : 0) - (subs ? subsText(subs.count).length + 2 : 0)
      lines.push({
        kind: 'lot', id: f.lot.id, lead: leadOf(b, f), title: ellipsize(f.lot.title, Math.max(1, room)), state: stateOf(b, f), after, afterOwnLine, group: groupOf(f.lot), idWidth, stateWidth, ...(subs ? { subs } : {}), height: afterOwnLine ? 2 : 1,
      })
    }
    if (b.hidden > 0) lines.push({ kind: 'more', project: b.project.project, hidden: b.hidden, behind: b.behind, expanded: views[moreKey(b.project.project)] === true, height: 1 })
  }
  // les lots qu'une ligne cache et qu'aucune autre ligne ne porte : les descendants d'un lot replié (à toute profondeur), le reste d'un projet derrière un bouton replié
  const hides = (l: PanelLine): number => (l.kind === 'lot' ? (l.subs && !l.subs.open ? l.subs.total : 0) : l.kind === 'more' && !l.expanded ? l.behind : 0)

  const room = Math.max(1, input.height - 2)
  const total = lines.reduce((n, l) => n + l.height, 0)
  if (total <= room) return { lines: lines.map(({ height: _h, ...l }) => l as PanelLine), more: 0 }
  const isFoldedLine = (l: PanelLine) => l.kind === 'project' && !!l.folded
  const tail = (from: number) => lines.slice(from).filter(isFoldedLine) // les projets repliés après la coupure gardent leur ligne
  // le bouton « + N lots » / « moins » du projet que la coupure traverse garde sa ligne, comme un projet replié : il n'est jamais coupé avec les lots
  const pending = (n: number) => {
    const next = lines.slice(n).findIndex(l => l.kind !== 'lot')
    const last = lines[n - 1]
    return last && last.kind === 'lot' && next >= 0 && lines[n + next]!.kind === 'more' ? (lines[n + next] as PanelLine & { height: number }) : undefined
  }
  const cost = (n: number) => lines.slice(0, n).reduce((s, l) => s + l.height, 0) + (pending(n) ? 1 : 0) + tail(n).length
  let kept = 0
  while (kept < lines.length && cost(kept + 1) <= room - 1) kept++
  while (kept > 0 && (cost(kept) > room - 1 || (lines[kept - 1]!.kind === 'project' && !isFoldedLine(lines[kept - 1]!)))) kept-- // un nom de projet sans aucun de ses lots n'apprend rien
  const button = pending(kept)
  const shownLines = [...lines.slice(0, kept), ...(button ? [button] : []), ...tail(kept)]
  // des projets repliés plus nombreux que la place : on garde ce qui tient avec le pied, les lots des lignes retirées passent dans « … +N »
  const fits = shownLines.slice(0, Math.max(0, room - 1))
  const dropped = shownLines.slice(fits.length)
  const droppedLots = dropped.reduce((n, l) => n + (l.kind === 'project' ? l.count : 0), 0)
  // un bouton replié coupé avec son projet cachait des lots qu'aucune ligne ne compte, sous-lots compris : ils passent dans « … +N » comme les autres
  const cutButtons = lines.slice(kept).filter(l => l.kind === 'more' && l !== button).reduce((n, l) => n + hides(l), 0)
  // un lot replié que la coupure retire emporte ses descendants à toute profondeur, qui ne sont plus des lignes : ils passent dans « … +N » avec lui
  const cutLots = lines.slice(kept).reduce((n, l) => n + (l.kind === 'lot' ? 1 + hides(l) : 0), 0)
  return { lines: fits.map(({ height: _h, ...l }) => l as PanelLine), more: cutLots + droppedLots + cutButtons }
}

/** Une ligne de lot du panneau, telle que le dessin la porte ; le projet la date. */
export type PanelLot = Extract<PanelLine, { kind: 'lot' }>

/** Lit ce que la région Client a posté : un déplacement d'un projet, ou rien (la donnée vient du dessin, elle n'est pas crue). Les ids sont vérifiés plus loin, contre le tableau lu. */
export const parseMoveAsk = (data: unknown): (MoveAsk & { project: string }) | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d.kind !== 'move' || typeof d.project !== 'string' || typeof d.id !== 'string' || typeof d.target !== 'string') return undefined
  return d.place === 'before' || d.place === 'after' ? { project: d.project, id: d.id, target: d.target, place: d.place } : undefined
}
