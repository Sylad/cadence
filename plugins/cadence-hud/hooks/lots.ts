import type { ThemeKey } from 'claude-code'

import type { LotsBoard, LotsRow, MoveAsk, TourLot, Wave } from '../types'
import { cycleOf, cycleSegments } from './cycle'
import type { CycleInput, CycleSeg } from './cycle'
import { colorOfDone, colorOfLot, isWaveShown, lotStatusFr, progressBar } from './format'

// ── L401 : le panneau des lots (/hud lots) — lecture de `cadence lead tour --json`, arbre et mise en page ───────────

/** Sous cette largeur de corps, la liste after: passe sur une ligne à part. */
export const NARROW_BODY = 60

const isProgress = (p: unknown): p is NonNullable<LotsRow['progress']> =>
  typeof p === 'object' && p !== null && ['done', 'doing', 'todo', 'added7'].every(k => Number.isFinite((p as Record<string, unknown>)[k]))

/** Lit la sortie de `cadence lead tour --json` pour le panneau : toutes les lignes, celles en erreur comprises. `outdated` : aucune ligne lisible ne porte `lots` (cadence plus ancien que le mod) ; une ligne en erreur n'en a jamais et ne le dit donc pas. */
export const parseLotsBoard = (stdout: string): LotsBoard => {
  const raw: unknown = JSON.parse(stdout)
  const rows: LotsRow[] = (Array.isArray(raw) ? raw : [])
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof (r as { project?: unknown }).project === 'string')
    .map(r => ({
      project: r.project as string,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
      ...(isProgress(r.progress) ? { progress: r.progress } : {}),
      ...(Array.isArray(r.doing) ? { doing: r.doing.filter((d): d is { id: string } => typeof d?.id === 'string').map(d => ({ id: d.id })) } : {}),
      ...(Array.isArray(r.closed) ? { closed: r.closed.filter((c): c is { id: string; finished: string; delivered?: unknown } => typeof c?.id === 'string' && typeof c?.finished === 'string').map(c => ({ id: c.id, finished: c.finished, ...(c.delivered === true ? { delivered: true as const } : {}) })) } : {}),
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

/** Une sous-tâche native : son id est `<lot>/<n>` et son parent est ce lot (un sous-lot à plat, `parent:` posé par `raf add --under` ou par un autre outil, a un id propre). */
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

/** L'état d'un lot en mots, glyphe et couleur : celui de la vague s'il y en a un (mots et couleurs de la bande), sinon celui du plan (un lot doing sans vague est « en sommeil »). Une sous-tâche n'a que son statut. `openIds` : les lots non clos du projet. */
export const lotState = (lot: TourLot, openIds: ReadonlySet<string>, waveStatus?: string, runState?: string): LotState => {
  if (isTask(lot)) return lot.status === 'doing' ? { text: '▶ en cours', color: 'claude' } : { text: '○ à faire', color: 'text' }
  if (waveStatus !== undefined) return { text: `${WAVE_GLYPH[waveStatus] ?? '⟳'} ${lotStatusFr(waveStatus)}`, color: colorOfLot(waveStatus) }
  // L687 : un lot qu'un run de cadence run vivant joue n'est pas en sommeil ; il dit son run, dans ses mots (« ⟳ run », « ⏸ run en quota »)
  if (runState !== undefined) return runState === 'quota' ? { text: '⏸ run en quota', color: 'warning' } : { text: '⟳ run', color: 'claude' }
  // doing au plan sans session de vague : rien ne tourne (L659), « en cours » serait faux
  if (lot.status === 'doing') return { text: '◌ en sommeil', color: 'subtle' }
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

/** Les trois lignes repliées d'un projet : lots ouverts que la vague dit prêts, lots livrés, lots clos non livrés (L592). */
export type FoldGroup = 'prets' | 'livres' | 'clos'

const FOLD_LABEL: Record<FoldGroup, string> = { prets: 'prêts', livres: 'livrés', clos: 'clos non livrés' }
const FOLD_STATE: Record<FoldGroup, string> = { prets: '✔ prêt', livres: '✔ livré', clos: '✔ clos' }
const FOLD_ORDER: FoldGroup[] = ['prets', 'livres', 'clos']

/** La clé du choix « cette ligne repliée est dépliée » dans les états du panneau (vrai = déplié) ; par projet, un même id pouvant se trouver dans deux. */
export const foldKey = (group: FoldGroup, project: string): string => `${group}:${project}`

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
  /** Une ligne repliée (L592) : « prêts : 4 », « livrés : 11 » ou « clos non livrés : 3 », bouton de clé `key` (foldKey) ; `count`, les lots qu'elle replie. */
  | { kind: 'fold'; project: string; group: FoldGroup; key: string; text: string; count: number; expanded: boolean }
  /** Un lot d'une ligne repliée dépliée : la ligne de lot telle que lotRow la dessine, sans frise ni after:. */
  | { kind: 'folded'; row: PanelLot }

export type Panel = { lines: PanelLine[]; /** lots non affichés faute de hauteur */ more: number; /** ceux d'entre eux qui sont en cours (L712) : la ligne horsVue les nomme */ enCours: number }

/** La vague d'un lot : le projet de la vague est le nom du dossier du projet du tour (« apps/ol » ↔ « ol »). */
const sameProject = (row: string, wave: string): boolean => row === wave || row.split('/').pop() === wave

/** Un lot d'une vague, tel que le panneau en a besoin : son projet, son id, l'état de la vague et ce dont la frise de son cycle a besoin (L413). */
export type PanelWaveLot = { project: string; lot: string; /** Le titre que la vague porte (collect.ts) ; '' quand elle n'en donne pas. */ title?: string } & CycleInput

/** Les lots des vagues affichées à `at` (isWaveShown), les vagues vivantes d'abord : l'état que le panneau prête à un lot est celui de la première vague qui le porte. */
export const waveLotsOf = (waves: readonly Wave[], at: number): PanelWaveLot[] => {
  const shown = waves.filter(w => isWaveShown(w, at))
  return [...shown.filter(w => w.live), ...shown.filter(w => !w.live)].flatMap(w => w.lots.map(l => ({ project: l.project, lot: l.lot, title: l.title, status: l.status, pass: l.pass, next: l.next, gate: l.gate ?? null, trail: l.trail ?? [] })))
}

/** Le rang d'affichage (L410) des lots d'un projet lu, celui que buildPanel applique : en cours, prêts, le reste, d'après le plan et l'état des vagues. */
export const rankerOf = (row: LotsRow, waves: readonly PanelWaveLot[]): ((lot: TourLot) => 0 | 1 | 2) => {
  const open = new Set((row.lots ?? []).map(l => l.id))
  return lot => lotRank(lot, open, waves.find(w => w.lot === lot.id && sameProject(row.project, w.project))?.status)
}

/** Le retrait de la ligne d'un lot d'une ligne repliée dépliée : celui d'un lot du premier niveau. */
const REST_LEAD = '  '

/** Un lot est clos au plan si une ligne `closed` de son projet porte son id (L609) : le critère du panneau (restGroups) et de la bande (foldWave), un seul. */
export const estClos = (closed: LotsRow['closed'], id: string): boolean => (closed ?? []).some(c => c.id === id)

type RestGroup = { group: FoldGroup; items: { id: string; title: string }[] }

/**
 * Les lots que le projet replie (L592), dans l'ordre prêts, livrés, clos non livrés ; un groupe vide n'existe pas. Prêt : un lot ouvert au plan, hors sous-tâche, sans sous-lot, que la vague dit `ready` (titre du plan) ;
 * livré ou clos : un lot d'une vague affichée dont l'id est dans `closed` du projet (titre de la vague, `''` s'il n'en a pas), « livré » quand le plan le dit `delivered`. Le plan l'emporte sur la vague.
 */
const restGroups = (r: LotsRow, waves: readonly PanelWaveLot[]): RestGroup[] => {
  const open = r.lots ?? []
  const waveOf = (id: string) => waves.find(w => w.lot === id && sameProject(r.project, w.project))
  const prets = open.filter(l => !isTask(l) && l.parent === undefined && waveOf(l.id)?.status === 'ready' && !open.some(o => o.parent === l.id)).map(l => ({ id: l.id, title: l.title }))
  const shut = new Map((r.closed ?? []).map(c => [c.id, c.delivered === true]))
  // un même lot peut figurer dans deux vagues : la première (les vivantes d'abord, waveLotsOf) donne le titre
  const closed = waves.filter((w, i) => sameProject(r.project, w.project) && estClos(r.closed, w.lot) && waves.findIndex(o => o.lot === w.lot && sameProject(r.project, o.project)) === i)
  const of = (delivered: boolean) => closed.filter(w => shut.get(w.lot) === delivered).map(w => ({ id: w.lot, title: w.title ?? '' }))
  const groups: Record<FoldGroup, RestGroup['items']> = { prets, livres: of(true), clos: of(false) }
  return FOLD_ORDER.filter(g => groups[g].length > 0).map(g => ({ group: g, items: groups[g] }))
}

/** Le compteur des lots clos au plan d'une vague, sous la bande ou au bout de sa ligne finie (L601) : « livrés : 3 · clos non livrés : 1 » ; vide quand aucun lot n'est clos. */
export const foldText = (livres: number, clos: number): string =>
  [livres > 0 ? `livrés : ${livres}` : '', clos > 0 ? `clos non livrés : ${clos}` : ''].filter(Boolean).join(' · ')

/**
 * Les lots d'une vague vivante pour la bande (L609) : `open`, ceux que le plan ne dit pas clos, dans l'ordre de la vague ; `livres` et `clos`, le compte de ceux qu'il dit clos avec et sans `delivered`.
 * Sans tableau lu (`null`) ou d'un cadence trop ancien (`outdated`, `closed` n'y dit rien des lots), tous les lots restent ouverts ; un projet absent du tableau garde les siens.
 */
export const foldWave = <T extends { project: string; lot: string }>(board: LotsBoard | null, lots: readonly T[]): { open: T[]; livres: number; clos: number } => {
  const open: T[] = []
  let livres = 0
  let clos = 0
  for (const l of lots) {
    const closed = board && !board.outdated ? board.rows.find(r => !r.error && sameProject(r.project, l.project))?.closed : undefined
    if (!estClos(closed, l.lot)) open.push(l)
    else if (closed?.some(c => c.id === l.lot && c.delivered === true)) livres++
    else clos++
  }
  return { open, livres, clos }
}

/** Ce que le panneau dessine : le tableau lu, la largeur et la hauteur du corps, les vagues et les choix de la personne. */
export type PanelInput = {
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
  /** Les lots joués par un run vivant de `cadence run` (L687) : le dossier de son dépôt, le lot et son état (`quota` quand il attend la remise à zéro). */
  runs?: readonly { project: string; lot: string; state: string }[]
}

/** Ce que la coupe sait d'une ligne du panneau (L712), en plus de sa hauteur. */
type Meta = {
  /** L'indice de la ligne de son projet (le sien, pour une ligne de projet). */
  head: number
  /** La ligne sans laquelle elle ne se montre pas : le lot parent d'un sous-lot, la ligne repliée qu'un lot déplie. */
  up?: number
  /** Elle passe avant les autres quand la hauteur manque : un lot du groupe « en cours » (L410), un projet replié qui a des lots en cours, un projet illisible. */
  prio: boolean
  /** Les lots en cours qu'elle montre ou cache derrière elle : ceux qui manquent au panneau quand elle n'y est pas. */
  enCours: number
}

type Ligne = PanelLine & { height: number }

/** Tous les lots d'un sous-arbre, à toute profondeur. */
const lotsOf = (nodes: readonly LotNode[]): TourLot[] => nodes.flatMap(n => [n.lot, ...lotsOf(n.children)])

/** Les lignes du panneau dans l'ordre d'affichage, avant toute coupe, avec ce que la coupe en sait (`meta`, même indice). */
const panelLines = (input: Omit<PanelInput, 'height'>): { lines: Ligne[]; meta: Meta[] } => {
  const { rows, columns, waves } = input
  const now = input.now ?? Date.now()
  const folds = input.folds ?? {}
  const views = input.views ?? {}
  const narrow = columns < NARROW_BODY
  type Block = { project: LotsRow; tree: LotNode[]; rankOf: (lot: TourLot) => 0 | 1 | 2; flat: FlatLot[]; hidden: number; behind: number; open: Set<string>; folded: boolean; ranks: Map<TourLot, number>; rest: RestGroup[] }
  const blocks: Block[] = rows
    .filter(r => r.error || (r.lots && r.lots.length > 0))
    .map(r => {
      const rankOf = rankerOf(r, waves)
      const rest = restGroups(r, waves)
      const prets = new Set(rest.find(g => g.group === 'prets')?.items.map(i => i.id))
      const tree = sortTree(lotTree((r.lots ?? []).filter(l => !prets.has(l.id))), rankOf)
      const { flat, hidden, behind } = visibleLots(r.project, tree, views)
      return { project: r, tree, rankOf, flat, hidden, behind, open: new Set((r.lots ?? []).map(l => l.id)), folded: !r.error && isFolded(r.project, r.lots ?? [], folds), ranks: displayRanks(r.lots ?? [], rankOf), rest }
    })
  const expandedRest = (b: Block) => b.rest.filter(g => views[foldKey(g.group, b.project.project)] === true)
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
  const idWidth = Math.max(0, ...shown.flatMap(b => [...b.flat.map(f => leadOf(b, f).length + f.lot.id.length), ...expandedRest(b).flatMap(g => g.items.map(i => REST_LEAD.length + i.id.length))]))
  const stateOf = (b: Block, f: FlatLot) =>
    lotState(f.lot, b.open, waves.find(w => w.lot === f.lot.id && sameProject(b.project.project, w.project))?.status, input.runs?.find(r => r.lot === f.lot.id && sameProject(b.project.project, r.project))?.state)
  const stateWidth = Math.max(0, ...shown.flatMap(b => [...b.flat.map(f => stateOf(b, f).text.length), ...expandedRest(b).map(g => FOLD_STATE[g.group].length)]))

  const lines: Ligne[] = []
  const meta: Meta[] = []
  for (const b of blocks) {
    const head = lines.length
    if (b.project.error) {
      lines.push({ kind: 'project', name: b.project.project, count: 0, doing: 0, error: `illisible : ${b.project.error}`, height: 1 })
      meta.push({ head, prio: true, enCours: 0 })
      continue
    }
    const top = (b.project.lots ?? []).filter(l => !isTask(l))
    const doing = top.filter(l => l.status === 'doing').length
    lines.push({ kind: 'project', name: b.project.project, count: top.length, doing, folded: b.folded, height: 1 })
    meta.push({ head, prio: b.folded && doing > 0, enCours: b.folded ? doing : 0 })
    if (b.folded) continue
    const nodeOf = new Map<TourLot, LotNode>()
    const walk = (nodes: readonly LotNode[]): void => nodes.forEach(n => (nodeOf.set(n.lot, n), walk(n.children)))
    walk(b.tree)
    const parents: number[] = [] // l'indice du dernier lot montré à chaque profondeur
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
      // un lot replié cache ses descendants : leurs lots en cours manquent avec lui
      const caches = subs && !subs.open ? lotsOf(nodeOf.get(f.lot)?.children ?? []) : []
      meta.push({ head, ...(f.depth > 0 ? { up: parents[f.depth - 1] } : {}), prio: b.ranks.get(f.lot) === 0, enCours: [f.lot, ...caches].filter(l => b.rankOf(l) === 0).length })
      parents[f.depth] = lines.length - 1
    }
    if (b.hidden > 0) {
      const expanded = views[moreKey(b.project.project)] === true
      lines.push({ kind: 'more', project: b.project.project, hidden: b.hidden, behind: b.behind, expanded, height: 1 })
      meta.push({ head, prio: false, enCours: expanded ? 0 : lotsOf(b.tree.slice(LOTS_PER_PROJECT)).filter(l => b.rankOf(l) === 0).length })
    }
    for (const g of b.rest) {
      const key = foldKey(g.group, b.project.project)
      const expanded = views[key] === true
      const fold = lines.length
      lines.push({ kind: 'fold', project: b.project.project, group: g.group, key, text: `${FOLD_LABEL[g.group]} : ${g.items.length}`, count: g.items.length, expanded, height: 1 })
      meta.push({ head, prio: false, enCours: 0 })
      if (!expanded) continue
      const room = Math.max(1, columns - idWidth - 2 - stateWidth - 2)
      for (const i of g.items) {
        const state: LotState = { text: FOLD_STATE[g.group], color: 'subtle' }
        lines.push({ kind: 'folded', row: { kind: 'lot', id: i.id, lead: REST_LEAD, title: ellipsize(i.title, room), state, after: [], afterOwnLine: false, group: '', rank: 2, idWidth, stateWidth }, height: 1 })
        meta.push({ head, up: fold, prio: false, enCours: 0 })
      }
    }
  }
  return { lines, meta }
}

/** Les lots qu'une ligne cache et qu'aucune autre ligne ne porte : les descendants d'un lot replié (à toute profondeur), le reste d'un projet derrière un bouton replié. */
const hides = (l: PanelLine): number => (l.kind === 'lot' ? (l.subs && !l.subs.open ? l.subs.total : 0) : l.kind === 'more' && !l.expanded ? l.behind : l.kind === 'fold' && !l.expanded ? l.count : 0)

/** Les lignes à ajouter à `pris` pour montrer la ligne `i` : elle, ses parents (sous-lot, lot d'une ligne repliée dépliée) et le nom de son projet. */
const chaine = (meta: readonly Meta[], pris: ReadonlySet<number>, i: number): number[] => {
  const out: number[] = []
  for (let at: number | undefined = i; at !== undefined && !pris.has(at); at = meta[at]!.up) out.push(at)
  if (!pris.has(meta[i]!.head) && !out.includes(meta[i]!.head)) out.push(meta[i]!.head)
  return out
}

/**
 * La coupe « en cours d'abord » (L712), dans `budget` lignes : chaque ligne prioritaire (Meta.prio), dans l'ordre d'affichage et avec le nom de son projet, avant toute autre ligne de n'importe quel projet ;
 * puis les lignes repliées (L592) des projets montrés, puis, seulement si toutes ont tenu, le reste dans l'ordre, tant qu'il tient. Un nom de projet sans aucune de ses lignes n'apprend rien ; un bouton « + N lots » suit un lot gardé de son projet. `seulPrio` : s'arrêter après les prioritaires.
 */
const enCoursDAbord = (lines: readonly Ligne[], meta: readonly Meta[], budget: number, seulPrio = false): { pris: Set<number>; used: number } => {
  const pris = new Set<number>()
  let used = 0
  const prendre = (i: number) => {
    const c = chaine(meta, pris, i)
    const cout = c.reduce((n, j) => n + lines[j]!.height, 0)
    if (used + cout > budget) return
    c.forEach(j => pris.add(j))
    used += cout
  }
  meta.forEach((m, i) => m.prio && prendre(i))
  // tant qu'une ligne prioritaire manque, aucune autre ne prend la place, pas même une ligne plus courte qui tiendrait
  if (seulPrio || meta.some((m, i) => m.prio && !pris.has(i))) return { pris, used }
  // les lignes repliées prêts, livrés, clos (L592) d'un projet montré gardent leur place avant ses autres lots : elles comptent ce qu'elles replient
  lines.forEach((l, i) => l.kind === 'fold' && pris.has(meta[i]!.head) && prendre(i))
  lines.forEach((l, i) => {
    if (pris.has(i) || (l.kind === 'project' && !l.folded && !l.error)) return
    if (l.kind === 'more' && !lines.some((o, j) => o.kind === 'lot' && pris.has(j) && meta[j]!.head === meta[i]!.head)) return
    prendre(i)
  })
  return { pris, used }
}

/** Les lots en cours que les lignes absentes de `montrees` portent ou cachent : ceux que le pied du panneau compte (L712). */
const enCoursHors = (meta: readonly Meta[], montrees: ReadonlySet<number>): number => meta.reduce((n, m, i) => n + (montrees.has(i) ? 0 : m.enCours), 0)

/**
 * Les lignes du panneau pour `columns` colonnes de corps et `height` lignes de corps : le titre et le pied en prennent deux ; si l'arbre est plus haut, une ligne de plus dit ce qui manque (horsVue).
 * Les premières lignes restent tant qu'elles montrent tous les lots en cours : un projet replié placé après la coupure garde sa ligne, de même que le bouton « + N lots » / « moins » et les lignes
 * repliées prêts, livrés, clos (L592) du projet que la coupure traverse. Sinon (L712), chaque lot en cours de chaque projet garde sa ligne, avec le nom de son projet, avant tout autre lot (enCoursDAbord).
 * `more` compte les lots non affichés, `enCours` ceux d'entre eux qui sont en cours.
 */
export const buildPanel = (input: PanelInput): Panel => {
  const { lines, meta } = panelLines(input)
  const strip = (ls: readonly Ligne[]): PanelLine[] => ls.map(({ height: _h, ...l }) => l as PanelLine)

  const room = Math.max(1, input.height - 2)
  const total = lines.reduce((n, l) => n + l.height, 0)
  if (total <= room) return { lines: strip(lines), more: 0, enCours: 0 }
  const isFoldedLine = (l: PanelLine) => l.kind === 'project' && !!l.folded
  const tail = (from: number) => lines.slice(from).filter(isFoldedLine) // les projets repliés après la coupure gardent leur ligne
  // les lignes qui gardent leur place quand la coupure traverse un projet, jamais coupées avec ses lots : le bouton « + N lots » / « moins » (après un lot gardé) et les lignes repliées prêts, livrés, clos (L592) ; les lots d'une ligne dépliée, eux, sont coupés
  const reserved = (n: number) => {
    const last = lines[n - 1]
    const rest = lines.slice(n)
    const end = rest.findIndex(l => l.kind === 'project')
    return !last ? [] : (end < 0 ? rest : rest.slice(0, end)).filter(l => l.kind === 'fold' || (l.kind === 'more' && last.kind === 'lot'))
  }
  const cost = (n: number) => lines.slice(0, n).reduce((s, l) => s + l.height, 0) + reserved(n).length + tail(n).length
  let kept = 0
  while (kept < lines.length && cost(kept + 1) <= room - 1) kept++
  while (kept > 0 && (cost(kept) > room - 1 || (lines[kept - 1]!.kind === 'project' && !isFoldedLine(lines[kept - 1]!) && reserved(kept).length === 0))) kept-- // un nom de projet sans aucun de ses lots ni de ses lignes repliées n'apprend rien
  const keptBack = reserved(kept)
  const shownLines = [...lines.slice(0, kept), ...keptBack, ...tail(kept)]
  // des projets repliés plus nombreux que la place : on garde ce qui tient avec le pied, les lots des lignes retirées passent dans « … +N »
  const fits = shownLines.slice(0, Math.max(0, room - 1))
  const dropped = shownLines.slice(fits.length)
  const droppedLots = dropped.reduce((n, l) => n + (l.kind === 'project' ? l.count : l.kind === 'fold' ? hides(l) : 0), 0)
  // un bouton ou une ligne repliée coupés avec leur projet cachaient des lots qu'aucune ligne ne compte, sous-lots compris : ils passent dans « … +N » comme les autres
  const cutButtons = lines.slice(kept).filter(l => (l.kind === 'more' || l.kind === 'fold') && !keptBack.includes(l)).reduce((n, l) => n + hides(l), 0)
  // un lot replié que la coupure retire emporte ses descendants à toute profondeur, qui ne sont plus des lignes : ils passent dans « … +N » avec lui ; de même les lots d'une ligne repliée dépliée
  const cutLots = lines.slice(kept).reduce((n, l) => n + (l.kind === 'lot' ? 1 + hides(l) : l.kind === 'folded' ? 1 : 0), 0)
  const montrees = new Set(fits.map(l => lines.indexOf(l)))
  if (meta.every((m, i) => !m.prio || montrees.has(i))) return { lines: strip(fits), more: cutLots + droppedLots + cutButtons, enCours: enCoursHors(meta, montrees) }

  // la coupe laisserait un lot en cours sans ligne (L712, D-20) : les lots en cours d'abord, puis le reste ; ce qui manque est compté
  const { pris } = enCoursDAbord(lines, meta, room - 1)
  const absents = lines.filter((_, i) => !pris.has(i))
  const more = absents.reduce((n, l) => n + (l.kind === 'lot' ? 1 + hides(l) : l.kind === 'folded' ? 1 : l.kind === 'project' ? (l.folded ? l.count : 0) : hides(l)), 0)
  return { lines: strip(lines.filter((_, i) => pris.has(i))), more, enCours: enCoursHors(meta, pris) }
}

/** La ligne qui dit ce que le panneau ne montre pas (L712) : « … +2 lots en cours non affichés · +5 lots de plus », ou « … +5 lots de plus » quand tous les lots en cours sont là. */
export const horsVue = (p: Pick<Panel, 'more' | 'enCours'>): string => {
  const s = (n: number) => (n > 1 ? 's' : '')
  const reste = Math.max(0, p.more - p.enCours)
  return `… ${[p.enCours > 0 ? `+${p.enCours} lot${s(p.enCours)} en cours non affiché${s(p.enCours)}` : '', reste > 0 ? `+${reste} lot${s(reste)} de plus` : ''].filter(Boolean).join(' · ')}`
}

/**
 * La hauteur que l'arbre des lots demande dans le partage du panneau (L712), au plus `max` : celle qui montre chaque lot en cours de chaque projet avec le nom de son projet, plus la ligne
 * qui compte le reste ; sans lot en cours, celle qui montre une première ligne ; tout tient : la hauteur de tout l'arbre. Calculée sur la coupe elle-même (enCoursDAbord), qui garde ces lignes
 * à toute hauteur au moins égale : rien ne suppose que buildPanel montre davantage quand la hauteur grandit. Sans projet à montrer : 1, la ligne qui le dit.
 */
export const besoinArbre = (input: Omit<PanelInput, 'height'>, max: number): number => {
  const { lines, meta } = panelLines(input)
  if (lines.length === 0) return 1
  const total = lines.reduce((n, l) => n + l.height, 0)
  let { used } = enCoursDAbord(lines, meta, Infinity, true)
  if (used === 0) {
    const premiere = lines.findIndex(l => l.kind !== 'project' || l.folded || l.error)
    used = premiere < 0 ? 0 : chaine(meta, new Set(), premiere).reduce((n, j) => n + lines[j]!.height, 0)
  }
  return Math.min(max, total + 2, used + 3)
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

/** L'avancement d'un projet pour l'ordre des projets (L481, rendu par D-1 suite de L716) : la barre de la bande, sa couleur selon la part de lots clos, `fait/total`.
 *  Rien pour un projet illisible ou d'un cadence qui ne donne pas `progress`. */
export const projectProgress = (r: LotsRow): { bar: string; color: ThemeKey; figures: string } | undefined => {
  if (r.error !== undefined || !r.progress) return undefined
  const { done, doing, todo } = r.progress
  return { bar: progressBar(done, done + doing + todo), color: colorOfDone(done, done + doing + todo), figures: `${done}/${done + doing + todo}` }
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

/**
 * Ce que le panneau dit après un déplacement réussi (L687, D-1) : « à commiter » seulement quand le fichier modifié est dans un dépôt git. `inGit` : vrai dans un dépôt,
 * faux hors dépôt (git y répond « not a git repository »), null quand git n'a pas pu répondre (on garde alors le conseil d'avant, plutôt que de taire un commit dû).
 * Case : le dossier parent de dix projets porte le `cadence.yaml` de `priority:` sans être un dépôt ; le panneau disait « à commiter » un fichier que rien ne commite.
 */
export const movedText = (kind: 'lot' | 'project', ask: { id: string; place: 'before' | 'after'; target: string }, inGit: boolean | null): string => {
  const head = `${ask.id} placé ${ask.place === 'before' ? 'avant' : 'après'} ${ask.target}`
  if (kind === 'project') return `${head} — priority: du cadence.yaml est modifiée${inGit === false ? ' (dossier hors dépôt git : rien à commiter)' : ', à commiter'}`
  return `${head} — le plan est modifié${inGit === false ? ' (dossier hors dépôt git : rien à commiter)' : ', à commiter (raf move ne commite pas)'}`
}
