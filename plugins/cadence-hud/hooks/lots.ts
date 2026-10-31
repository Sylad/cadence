import type { ThemeKey } from 'claude-code'

import type { LotsBoard, LotsRow, MoveAsk, TourLot, Wave } from '../types'
import { cycleOf, cycleSegments } from './cycle'
import type { CycleInput, CycleSeg } from './cycle'
import { colorOfDone, colorOfLot, isWaveShown, lotStatusFr, progressBar, projectFigures } from './format'

// ── L401 : le panneau des lots (/hud lots) — lecture de `cadence lead tour --json`, arbre et mise en page ───────────

/** Sous cette largeur de corps, la liste after: passe sur une ligne à part. */
export const NARROW_BODY = 60

const isProgress = (p: unknown): p is NonNullable<LotsRow['progress']> =>
  typeof p === 'object' && p !== null && ['done', 'doing', 'todo', 'added7'].every(k => Number.isFinite((p as Record<string, unknown>)[k]))

/** Lit la sortie de `cadence lead tour --json` pour le panneau : toutes les lignes, celles en erreur comprises (parseTour les écarte). `outdated` : aucune ligne lisible ne porte `lots` (cadence plus ancien que le mod) ; une ligne en erreur n'en a jamais et ne le dit donc pas. */
export const parseLotsBoard = (stdout: string): LotsBoard => {
  const raw: unknown = JSON.parse(stdout)
  const rows: LotsRow[] = (Array.isArray(raw) ? raw : [])
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof (r as { project?: unknown }).project === 'string')
    .map(r => ({
      project: r.project as string,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
      ...(isProgress(r.progress) ? { progress: r.progress } : {}),
      ...(Array.isArray(r.doing) ? { doing: r.doing.filter((d): d is { id: string } => typeof d?.id === 'string').map(d => ({ id: d.id })) } : {}),
      ...(Array.isArray(r.closed) ? { closed: r.closed.filter((c): c is { id: string; finished: string } => typeof c?.id === 'string' && typeof c?.finished === 'string').map(c => ({ id: c.id, finished: c.finished })) } : {}),
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
export type MovePlan =
  | { kind: 'move'; argv: string[] }
  | { kind: 'unchanged'; /** Le lot est déjà à cette place parmi les lots de son groupe d'affichage : `raf move` ne changerait rien, on ne le lance pas et on le dit. */ text: string }
  | { kind: 'refused'; reason: string }

/** Les lots tels que le plan les porterait après le déplacement : `lot` retiré, puis remis juste avant ou après `target` (les autres gardent leur ordre, comme `raf move`). */
const movedLots = (lots: readonly TourLot[], lot: TourLot, target: TourLot, place: 'before' | 'after'): TourLot[] => {
  const without = lots.filter(l => l !== lot)
  const at = without.indexOf(target) + (place === 'after' ? 1 : 0)
  return [...without.slice(0, at), lot, ...without.slice(at)]
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i])

/** Le groupe d'affichage (L410) de chaque lot lu : son rang dans l'arbre rangé de buildPanel — un parent dont un descendant est en cours est dans le groupe « en cours ». */
const displayRanks = (lots: readonly TourLot[], rankOf: (lot: TourLot) => number): Map<TourLot, number> => {
  const ranks = new Map<TourLot, number>()
  const walk = (nodes: readonly LotNode[]) => {
    for (const n of nodes) {
      ranks.set(n.lot, hasInProgress(n, rankOf) ? 0 : rankOf(n.lot))
      walk(n.children)
    }
  }
  walk(lotTree(lots))
  return ranks
}

/** Le groupe d'un lot en un mot, pour dire où le lâcher est refusé : en cours, libre, bloqué. */
const GROUP_STATE = ['en cours', 'libre', 'bloqué']
/** Les lots d'un groupe, au pluriel : « les lots en cours », « les libres », « les bloqués » (avec `noun`, « lots » ou « sous-tâches »). */
const groupPlural = (rank: number, noun: string): string => (rank === 0 ? `les ${noun} en cours` : rank === 1 ? 'les libres' : 'les bloqués')

/**
 * Contrôle une demande de déplacement contre les lots lus du projet (dans l'ordre du plan, celui que `cadence lead tour` émet) : les ids sont ceux du tableau (la demande vient
 * du dessin, donc à vérifier), les deux lots ont le même parent et le même groupe d'affichage. Le reste (vague, plan en lecture seule, lot archivé) est dit par `raf move` lui-même.
 * L'écran est trié par état (L410 : en cours, libres, le reste) : un lot ne se réordonne qu'à l'intérieur de son groupe d'affichage, un lâcher sur un lot d'un autre groupe est refusé
 * sans appeler raf. Dans un groupe l'écran suit l'ordre du plan ; une demande qui laisse l'ordre du groupe tel qu'il est n'appelle pas raf (`unchanged`). `rankOf` : le rang d'affichage de chaque lot, celui de buildPanel ([rankerOf]).
 * `stale` : le tableau lu est périmé (un `raf move` a réussi depuis sa lecture et la relecture n'est pas finie) — on ne juge alors plus « déjà » sur un ordre qui n'est plus celui du plan :
 * raf est appelé et tranche. Les refus, qui ne tiennent qu'à l'état des lots, restent.
 * `undefined` : rien à faire (un lot lâché sur lui-même).
 */
export const planMove = (lots: readonly TourLot[], ask: MoveAsk, rankOf: (lot: TourLot) => number, stale = false): MovePlan | undefined => {
  const lot = lots.find(l => l.id === ask.id)
  const target = lots.find(l => l.id === ask.target)
  if (!lot || !target || (ask.place !== 'before' && ask.place !== 'after')) return { kind: 'refused', reason: `lot inconnu : ${!lot ? ask.id : ask.target}` }
  if (lot === target) return undefined
  if (groupOf(lot) !== groupOf(target)) return { kind: 'refused', reason: `${lot.id} et ${target.id} n'ont pas le même parent : un lot se réordonne parmi les lots de son projet, une sous-tâche parmi celles de son lot` }
  const ranks = displayRanks(lots, rankOf)
  const fromRank = ranks.get(lot)!
  const targetRank = ranks.get(target)!
  if (fromRank !== targetRank) {
    return { kind: 'refused', reason: `${target.id} est ${GROUP_STATE[targetRank]} : ${isTask(lot) ? 'une sous-tâche' : 'un lot'} ${GROUP_STATE[fromRank]} se range parmi ${groupPlural(fromRank, isTask(lot) ? 'sous-tâches' : 'lots')}` }
  }
  const argv = ['raf', 'move', lot.id, `--${ask.place}`, target.id]
  if (stale) return { kind: 'move', argv }
  const moved = movedLots(lots, lot, target, ask.place)
  const siblings = (all: readonly TourLot[]) => all.filter(l => groupOf(l) === groupOf(lot) && ranks.get(l) === fromRank).map(l => l.id)
  if (sameOrder(siblings(lots), siblings(moved))) return { kind: 'unchanged', text: `${lot.id} est déjà ${ask.place === 'before' ? 'avant' : 'après'} ${target.id} dans le plan : rien à déplacer` }
  return { kind: 'move', argv }
}

/** La raison d'un refus d'une commande : la première ligne de son erreur, sans le préfixe « raf: » ; le code de sortie, avec `command`, si elle est vide. */
export const refusalReason = (stderr: string, exitCode: number, command = 'raf move'): string => stderr.split('\n').map(l => l.trim()).find(l => l !== '')?.replace(/^raf\s*:\s*/, '') ?? `${command} : code ${exitCode}`

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
      /** Le groupe d'affichage (L410 : 0 en cours, 1 libres, 2 le reste) : on ne réordonne pas non plus d'un groupe à l'autre. */
      rank: number
      /** Largeurs communes à toutes les lignes, pour l'alignement. */
      idWidth: number
      stateWidth: number
      /** Présent quand le lot a des sous-lots : sa bascule (clé de ses états), leur nombre (`count`, les directs, affiché), tous ses descendants (`total`, ce que cache le lot replié) et s'ils sont montrés. */
      subs?: { key: string; count: number; total: number; open: boolean }
      /** La frise du cycle du lot (L413), sur une ligne sous lui : présente pour un lot de vague ou tenu en cours par le plan, absente sinon. */
      cycle?: CycleSeg[]
    }
  /** Le bouton « + N lots » / « moins » du reste d'un projet de plus de LOTS_PER_PROJECT lots : `hidden`, les lots du premier niveau du reste (le N affiché) ; `behind`, tous les lots du reste, sous-lots compris (ce que le bouton cache tant qu'il est replié). */
  | { kind: 'more'; project: string; hidden: number; behind: number; expanded: boolean }

export type Panel = { lines: PanelLine[]; /** lignes de lot non affichées faute de hauteur */ more: number }

/** La vague d'un lot : le projet de la vague est le nom du dossier du projet du tour (« apps/ol » ↔ « ol »). */
const sameProject = (row: string, wave: string): boolean => row === wave || row.split('/').pop() === wave

/** Un lot d'une vague, tel que le panneau en a besoin : son projet, son id, l'état de la vague et ce dont la frise de son cycle a besoin (L413). */
export type PanelWaveLot = { project: string; lot: string } & CycleInput

/** Les lots des vagues affichées à `at` (isWaveShown), les vagues vivantes d'abord : l'état que le panneau prête à un lot est celui de la première vague qui le porte. */
export const waveLotsOf = (waves: readonly Wave[], at: number): PanelWaveLot[] => {
  const shown = waves.filter(w => isWaveShown(w, at))
  return [...shown.filter(w => w.live), ...shown.filter(w => !w.live)].flatMap(w => w.lots.map(l => ({ project: l.project, lot: l.lot, status: l.status, pass: l.pass, next: l.next, gate: l.gate ?? null, trail: l.trail ?? [] })))
}

/** Le rang d'affichage (L410) des lots d'un projet lu, celui que buildPanel applique : en cours, prêts, le reste, d'après le plan et l'état des vagues. */
export const rankerOf = (row: LotsRow, waves: readonly PanelWaveLot[]): ((lot: TourLot) => 0 | 1 | 2) => {
  const open = new Set((row.lots ?? []).map(l => l.id))
  return lot => lotRank(lot, open, waves.find(w => w.lot === lot.id && sameProject(row.project, w.project))?.status)
}

/**
 * Les lignes du panneau pour `columns` colonnes de corps et `height` lignes de corps : le titre et le pied en prennent deux ;
 * si l'arbre est plus haut, les premières lignes restent et `more` compte les lots que la ligne « … +N lots de plus » (une ligne de plus) remplace ; un projet replié placé après la coupure garde sa ligne, de même que le bouton « + N lots » / « moins » du projet que la coupure traverse.
 */
export const buildPanel = (input: {
  rows: readonly LotsRow[]
  columns: number
  height: number
  waves: readonly PanelWaveLot[]
  /** Le choix de la personne par projet (vrai = replié) ; absent, le défaut de isFolded. */
  folds?: Readonly<Record<string, boolean>>
  /** Les dépliages choisis (moreKey, openKey ; vrai = déplié) ; absent, tout est replié. */
  views?: Readonly<Record<string, boolean>>
  /** L'heure (ms) à laquelle les durées de la frise sont calculées ; absent, maintenant. */
  now?: number
}): Panel => {
  const { rows, columns, waves } = input
  const now = input.now ?? Date.now()
  const folds = input.folds ?? {}
  const views = input.views ?? {}
  const narrow = columns < NARROW_BODY
  type Block = { project: LotsRow; flat: FlatLot[]; hidden: number; behind: number; open: Set<string>; folded: boolean; ranks: Map<TourLot, number> }
  const blocks: Block[] = rows
    .filter(r => r.error || (r.lots && r.lots.length > 0))
    .map(r => {
      const rankOf = rankerOf(r, waves)
      const tree = sortTree(lotTree(r.lots ?? []), rankOf)
      const { flat, hidden, behind } = visibleLots(r.project, tree, views)
      return { project: r, flat, hidden, behind, open: new Set((r.lots ?? []).map(l => l.id)), folded: !r.error && isFolded(r.project, r.lots ?? [], folds), ranks: displayRanks(r.lots ?? [], rankOf) }
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
      // la frise (L413) : les lots de vague, ceux que le plan tient en cours ; jamais une sous-tâche. Elle tient sous le titre : le corps moins le retrait de l'id
      const wave = waves.find(w => w.lot === f.lot.id && sameProject(b.project.project, w.project))
      const cycle = isTask(f.lot) ? [] : cycleSegments(cycleOf(wave, { reviewed: f.lot.reviewed === true, doing: f.lot.status === 'doing' }, now), columns - idWidth - 2)
      lines.push({
        kind: 'lot', id: f.lot.id, lead: leadOf(b, f), title: ellipsize(f.lot.title, Math.max(1, room)), state: stateOf(b, f), after, afterOwnLine, group: groupOf(f.lot), rank: b.ranks.get(f.lot)!, idWidth, stateWidth, ...(subs ? { subs } : {}), ...(cycle.length > 0 ? { cycle } : {}), height: (afterOwnLine ? 2 : 1) + (cycle.length > 0 ? 1 : 0),
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

/** Les rangées qu'une ligne de lot prend à l'écran : le lot, sa liste after: si elle passe à part, sa frise (L413). */
export const rowsOf = (l: Pick<PanelLot, 'afterOwnLine' | 'cycle'>): number => 1 + (l.afterOwnLine ? 1 : 0) + (l.cycle ? 1 : 0)

/** Lit une bascule de sous-lots postée par la région Client (L411 dans la région L402) : `key` doit être la clé openKey d'un lot du projet lu, sinon rien (la donnée vient du dessin, elle n'est pas crue). */
export const parseToggleAsk = (data: unknown, rows: readonly LotsRow[]): { project: string; key: string } | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d.kind !== 'toggle' || typeof d.project !== 'string' || typeof d.key !== 'string') return undefined
  const row = rows.find(r => r.project === d.project && !r.error)
  return row && (row.lots ?? []).some(l => openKey(d.project as string, l.id) === d.key) ? { project: d.project, key: d.key } : undefined
}

/** Lit ce que la région Client a posté : un déplacement d'un projet, ou rien (la donnée vient du dessin, elle n'est pas crue). Les ids sont vérifiés plus loin, contre le tableau lu. */
export const parseMoveAsk = (data: unknown): (MoveAsk & { project: string }) | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d.kind !== 'move' || typeof d.project !== 'string' || typeof d.id !== 'string' || typeof d.target !== 'string') return undefined
  return d.place === 'before' || d.place === 'after' ? { project: d.project, id: d.id, target: d.target, place: d.place } : undefined
}

// ── L449 : l'ordre des projets, réécrit dans la liste priority: du cadence.yaml du dossier (cadence lead priority) ──

/** La ligne que `lead tour` ajoute quand le cadence.yaml du dossier est illisible : elle n'est pas un projet, on ne la range pas. */
const FOLDER_PROBLEM = 'cadence.yaml'

/** Les projets que le panneau range, dans l'ordre où le tour les donne (celui de `priority:`) : toute ligne du tour sauf l'erreur du cadence.yaml du dossier. */
export const projectsOf = (rows: readonly LotsRow[]): LotsRow[] => rows.filter(r => !(r.error !== undefined && r.project === FOLDER_PROBLEM))

/** Une ligne de la région des projets : le nom et ce que le projet tient (son nombre de lots non clos, ou l'erreur de sa lecture). */
export const projectDetail = (r: LotsRow): string => {
  if (r.error !== undefined) return 'illisible'
  const n = openCount(r.lots ?? [])
  return `${n} lot${n > 1 ? 's' : ''} non clos`
}

/** L'avancement d'un projet comme la bande l'écrit (L481) : la barre, sa couleur selon la part de lots clos, les chiffres. Rien pour un projet illisible ou d'un cadence qui ne donne pas `progress`. */
export const projectProgress = (r: LotsRow): { bar: string; color: ThemeKey; figures: string } | undefined => {
  if (r.error !== undefined || !r.progress) return undefined
  const { done, doing, todo } = r.progress
  return { bar: progressBar(done, done + doing + todo), color: colorOfDone(done, done + doing + todo), figures: projectFigures({ project: r.project, doing: r.doing, progress: r.progress }) }
}

/** Lit ce que la région des projets a posté : placer `id` avant ou après `target`, deux projets différents du tableau lu, sinon rien (la donnée vient du dessin, elle n'est pas crue). */
export const parseProjectMoveAsk = (data: unknown, rows: readonly LotsRow[]): MoveAsk | undefined => {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d.kind !== 'project-move' || typeof d.id !== 'string' || typeof d.target !== 'string' || d.id === d.target) return undefined
  if (d.place !== 'before' && d.place !== 'after') return undefined
  const names = projectsOf(rows).map(r => r.project)
  return names.includes(d.id) && names.includes(d.target) ? { id: d.id, target: d.target, place: d.place } : undefined
}

/** La commande qui range un projet : `cadence lead priority` sur le dossier du tour. */
export const priorityArgv = (folder: string, ask: MoveAsk): string[] => ['cadence', 'lead', 'priority', ask.id, `--${ask.place}`, ask.target, folder]
