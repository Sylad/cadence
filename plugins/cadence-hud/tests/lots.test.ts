import { expect, test } from 'claude-code/testing'

import { buildPanel, displayOrder, flattenTree, groupOf, isTask, lotState, lotTree, moreKey, openCount, openKey, parseLotsBoard, parseMoveAsk, planMove, projectDir, readTime, refusalReason } from '../hooks/lots'
import type { LotsRow, TourLot } from '../types'

const lot = (id: string, status: 'todo' | 'doing' = 'todo', extra: Partial<TourLot> = {}): TourLot => ({ id, title: `Titre ${id}`, status, after: [], ...extra })
const task = (parent: string, n: number, status: 'todo' | 'doing' = 'todo'): TourLot => ({ id: `${parent}/${n}`, title: `Tâche ${n}`, status, after: [], parent })
/** Tout déplié (le reste de chaque projet, les sous-lots de chaque lot) : les règles d'ordre, de repli et de coupe se lisent sur l'arbre entier, le plafond de L411 a ses tests plus bas. */
const everything = (rows: readonly LotsRow[]): Record<string, boolean> =>
  Object.fromEntries(rows.flatMap(r => [[moreKey(r.project), true], ...(r.lots ?? []).map(l => [openKey(r.project, l.id), true])]))
const build = (input: Parameters<typeof buildPanel>[0]) => buildPanel({ views: everything(input.rows), ...input })
const ids = (nodes: ReturnType<typeof lotTree>): unknown[] => nodes.map(n => (n.children.length ? [n.lot.id, ids(n.children)] : n.lot.id))

test('R14 — lignes sans champ lots : le tableau se dit trop ancien, une ligne en erreur seule ne le dit pas', () => {
  expect(parseLotsBoard(JSON.stringify([{ project: 'a', progress: {} }, { project: 'b', progress: {} }])).outdated).toBe(true)
  expect(parseLotsBoard(JSON.stringify([{ project: 'a', lots: [] }])).outdated).toBe(false)
  // les lignes en erreur n'ont jamais de lots : seules les autres décident
  expect(parseLotsBoard(JSON.stringify([{ project: 'x', error: 'illisible' }])).outdated).toBe(false)
  expect(parseLotsBoard(JSON.stringify([{ project: 'x', error: 'illisible' }, { project: 'a', progress: {} }])).outdated).toBe(true)
  expect(parseLotsBoard(JSON.stringify([{ project: 'x', error: 'illisible' }, { project: 'a', lots: [lot('L1')] }])).outdated).toBe(false)
  expect(() => parseLotsBoard('pas du json')).toThrow()
  expect(parseLotsBoard('{}').rows).toEqual([])
})

test('R11 — parent ouvert : le sous-lot est rattaché', () => {
  expect(ids(lotTree([lot('L1'), lot('L2', 'todo', { parent: 'L1' }), lot('L3')]))).toEqual([['L1', ['L2']], 'L3'])
  // profondeur libre
  expect(ids(lotTree([lot('A'), lot('B', 'todo', { parent: 'A' }), lot('C', 'todo', { parent: 'B' })]))).toEqual([['A', [['B', ['C']]]]])
})

test('R11 — sous-tâche native <lot>/<n> : rendue sous son lot avec ├/└', () => {
  const lines = flattenTree(lotTree([lot('L401', 'doing'), task('L401', 1, 'doing'), task('L401', 2)]))
  expect(lines.map(l => `${l.branch}${l.lot.id}`)).toEqual(['L401', '├L401/1', '└L401/2'])
  expect(lines.map(l => l.depth)).toEqual([0, 1, 1])
})

test('R11 — parent clos ou inconnu : premier niveau', () => {
  expect(ids(lotTree([lot('L2', 'todo', { parent: 'L1' })]))).toEqual(['L2'])
})

test('R11 — parent de lui-même : premier niveau, pas de boucle', () => {
  expect(ids(lotTree([lot('L1', 'todo', { parent: 'L1' })]))).toEqual(['L1'])
})

test('R11 — cycle A→B→A : tous au premier niveau, pas de boucle', () => {
  expect(ids(lotTree([lot('A', 'todo', { parent: 'B' }), lot('B', 'todo', { parent: 'A' })]))).toEqual(['A', 'B'])
  // un lot pendu à un membre du cycle reste sous lui, et la construction se termine
  expect(ids(lotTree([lot('A', 'todo', { parent: 'B' }), lot('B', 'todo', { parent: 'A' }), lot('C', 'todo', { parent: 'A' })]))).toEqual([['A', ['C']], 'B'])
})

test('R11 — id dupliqué : la première occurrence porte les sous-lots', () => {
  const nodes = lotTree([lot('L1'), lot('L1'), lot('L2', 'todo', { parent: 'L1' })])
  expect(ids(nodes)).toEqual([['L1', ['L2']], 'L1'])
})

test('R21 — compte du projet : lots seuls, sous-tâches natives non comptées', () => {
  expect(openCount([lot('L1'), task('L1', 1), task('L1', 2), lot('L2')])).toBe(2)
})

test('R21 — sous-lot de Lot.parent compté', () => {
  const sub = lot('T2', 'doing', { parent: 'T1' })
  expect(isTask(sub)).toBe(false)
  expect(isTask(task('T1', 1))).toBe(true)
  expect(openCount([lot('T1'), sub])).toBe(2)
})

const GLYPHS = { queued: ['… en attente', 'subtle'], implementing: ['⟳ implémente', 'claude'], reviewing: ['⟳ relit', 'claude'], fixing: ['⟳ corrige', 'claude'], question: ['? QUESTION', 'warning'], ready: ['✔ prêt', 'success'], 'handed-back': ['↩ rendu', 'error'], failed: ['✖ échec', 'error'], suspended: ['⏸ suspendu', 'warning'] } as const

test('R5 — un lot de chaque statut de vague : mot, glyphe et couleur de la table', () => {
  for (const [status, [text, color]] of Object.entries(GLYPHS)) expect(lotState(lot('L1'), new Set(['L1']), status)).toEqual({ text, color })
})

test('R5 — lot doing : « ▶ en cours »', () => {
  expect(lotState(lot('L1', 'doing'), new Set(['L1']))).toEqual({ text: '▶ en cours', color: 'claude' })
})

test('R5 — lot todo sans after: ouvert : « ○ libre »', () => {
  expect(lotState(lot('L1'), new Set(['L1']))).toEqual({ text: '○ libre', color: 'text' })
})

test('R5 — lot todo dont un after: est ouvert : « ⊘ bloqué »', () => {
  expect(lotState(lot('L2', 'todo', { after: ['L1'] }), new Set(['L1', 'L2']))).toEqual({ text: '⊘ bloqué', color: 'subtle' })
})

test('R5 — statut de vague inconnu : affiché tel quel', () => {
  expect(lotState(lot('L1'), new Set(['L1']), 'merging')).toEqual({ text: '⟳ merging', color: 'claude' })
})

test('R5 — en vague, l’état de la vague l’emporte sur le plan', () => {
  expect(lotState(lot('L2', 'todo', { after: ['L1'] }), new Set(['L1', 'L2']), 'reviewing').text).toBe('⟳ relit')
})

test('R20 — sous-tâche doing : « ▶ en cours »', () => {
  expect(lotState(task('L1', 1, 'doing'), new Set(['L1']))).toEqual({ text: '▶ en cours', color: 'claude' })
})

test('R20 — sous-tâche todo : « ○ à faire », sans after:', () => {
  expect(lotState(task('L1', 1), new Set(['L1']))).toEqual({ text: '○ à faire', color: 'text' })
  // jamais l'état de vague de son lot
  expect(lotState(task('L1', 1), new Set(['L1']), 'failed').text).toBe('○ à faire')
})

const ROWS: LotsRow[] = [
  { project: 'cadence', lots: [lot('L401', 'doing'), task('L401', 1, 'doing'), task('L401', 2), lot('L402', 'todo', { after: ['L400', 'L401'] })] },
  { project: 'ol', lots: [lot('L80')] },
]
const panel = (over: Partial<Parameters<typeof buildPanel>[0]> = {}) => build({ rows: ROWS, columns: 70, height: 40, waves: [], ...over })

test('R4 — deux projets : un bloc par projet, dans l’ordre de priority:', () => {
  const heads = panel().lines.filter(l => l.kind === 'project')
  expect(heads.map(h => [h.name, h.count])).toEqual([['cadence', 2], ['ol', 1]])
})

test('R20 — l’id affiché est <lot>/<n>', () => {
  const sub = panel().lines.find(l => l.kind === 'lot' && l.id === 'L401/1')
  expect(sub).toBeDefined()
  expect(sub!.kind === 'lot' && sub!.lead).toBe('  ├ ')
})

test('R6 — lot avec after: les ids sont listés ; sans after: aucune mention', () => {
  const lots = panel().lines.filter(l => l.kind === 'lot')
  expect(lots.find(l => l.id === 'L402')!.after.map(a => a.id)).toEqual(['L400', 'L401'])
  expect(lots.find(l => l.id === 'L401')!.after).toEqual([])
})

test('R6 — after: vers un lot clos ou inconnu : id barré, lot non bloqué', () => {
  const l402 = panel().lines.find(l => l.kind === 'lot' && l.id === 'L402')!
  expect(l402.kind === 'lot' && l402.after).toEqual([{ id: 'L400', struck: true }, { id: 'L401', struck: false }])
  const only = build({ rows: [{ project: 'p', lots: [lot('L9', 'todo', { after: ['L400'] })] }], columns: 70, height: 40, waves: [] })
  const l9 = only.lines.find(l => l.kind === 'lot')!
  expect(l9.kind === 'lot' && l9.state.text).toBe('○ libre')
})

test('R7 — un projet en erreur : son message, les autres projets présents', () => {
  const p = panel({ rows: [{ project: 'cassé', error: 'raf.yaml ligne 12 : YAML invalide' }, ...ROWS] })
  expect(p.lines[0]).toMatchObject({ kind: 'project', name: 'cassé', error: 'illisible : raf.yaml ligne 12 : YAML invalide' })
  expect(p.lines.filter(l => l.kind === 'project').map(l => l.name)).toEqual(['cassé', 'cadence', 'ol'])
})

test('R7 — la ligne cadence.yaml en erreur est affichée comme un projet illisible', () => {
  const p = panel({ rows: [{ project: 'cadence.yaml', error: 'priority invalide' }, ...ROWS] })
  expect(p.lines[0]).toMatchObject({ kind: 'project', name: 'cadence.yaml', error: 'illisible : priority invalide' })
})

test('R5 — la vague d’un projet imbriqué se retrouve par le nom du dossier', () => {
  const p = panel({ rows: [{ project: 'apps/ol', lots: [lot('L80')] }], waves: [{ project: 'ol', lot: 'L80', status: 'fixing' }] })
  const l80 = p.lines.find(l => l.kind === 'lot')!
  expect(l80.kind === 'lot' && l80.state.text).toBe('⟳ corrige')
})

test('R15 — corps de 70 colonnes : une seule ligne par lot', () => {
  const p = panel({ columns: 70 })
  const l402 = p.lines.find(l => l.kind === 'lot' && l.id === 'L402')!
  expect(l402.kind === 'lot' && l402.afterOwnLine).toBe(false)
  expect(p.lines.filter(l => l.kind === 'lot')).toHaveLength(5)
})

test('R15 — corps sous 60 colonnes : after: sur une ligne à part, titre tronqué, id et état conservés', () => {
  const long = { project: 'p', lots: [lot('L402', 'todo', { title: 'Un titre vraiment très long pour une colonne étroite', after: ['L400'] })] }
  const p = build({ rows: [long], columns: 49, height: 40, waves: [] })
  const l = p.lines.find(x => x.kind === 'lot')!
  if (l.kind !== 'lot') throw new Error('ligne de lot attendue')
  expect(l.afterOwnLine).toBe(true)
  expect(l.title.endsWith('…')).toBe(true)
  expect(l.id).toBe('L402')
  expect(l.state.text).toBe('○ libre')
  // la ligne tient dans le corps : tête + id + titre + état
  expect(l.lead.length + l.id.length + 2 + l.title.length + 2 + l.stateWidth).toBeLessThanOrEqual(49)
})

test('R15 — l’id d’une sous-tâche n’est jamais tronqué, même à 24 colonnes', () => {
  const p = build({ rows: [{ project: 'p', lots: [lot('L401'), task('L401', 2)] }], columns: 24, height: 40, waves: [] })
  const sub = p.lines.find(l => l.kind === 'lot' && l.id === 'L401/2')
  expect(sub).toBeDefined()
})

test('R17 — titre long : tronqué sur une ligne', () => {
  const p = build({ rows: [{ project: 'p', lots: [lot('L1', 'todo', { title: 'x'.repeat(200) })] }], columns: 70, height: 40, waves: [] })
  const l = p.lines.find(x => x.kind === 'lot')!
  expect(l.kind === 'lot' && l.title.length).toBeLessThan(70)
  expect(l.kind === 'lot' && l.title.endsWith('…')).toBe(true)
})

test('R17 — arbre plus haut que le panneau : « … +N lots de plus »', () => {
  const many = { project: 'p', lots: Array.from({ length: 12 }, (_, i) => lot(`L${i + 1}`)) }
  // 6 lignes de corps : titre, pied, la ligne « … +N », le nom du projet et le bouton « moins » (L411) laissent 1 lot
  const p = build({ rows: [many], columns: 70, height: 6, waves: [] })
  const shown = p.lines.filter(l => l.kind === 'lot')
  expect(shown).toHaveLength(1)
  expect(p.more).toBe(11)
})

test('R17 — sous-tâches comprises dans les lignes comptées de « de plus »', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), task('L1', 1), task('L1', 2), task('L1', 3)] }]
  const p = build({ rows, columns: 70, height: 6, waves: [] })
  expect(p.lines.filter(l => l.kind === 'lot')).toHaveLength(2)
  expect(p.more).toBe(2)
})

test('R17 — tout tient : rien n’est coupé', () => {
  expect(panel({ height: 40 }).more).toBe(0)
})

test('R8 — l’heure de dernière lecture se lit HH:MM', () => {
  const at = new Date(2026, 9, 28, 15, 5).getTime()
  expect(readTime(at)).toBe('15:05')
})

// ── L409 : replier / déplier un projet ─────────────────────────────────────────────────────────────────────────────

const many = (n: number, doing = 0): TourLot[] => Array.from({ length: n }, (_, i) => lot(`L${i + 1}`, i < doing ? 'doing' : 'todo'))
const folding = (rows: LotsRow[], folds: Record<string, boolean> = {}) => build({ rows, columns: 70, height: 400, waves: [], folds })
const heads = (p: ReturnType<typeof buildPanel>) => p.lines.filter(l => l.kind === 'project')

test('R1 — un projet de plus de 20 lots ouverts est replié par défaut : sa ligne seule (nom, nombre de lots, en cours)', () => {
  const p = folding([{ project: 'maritime', lots: many(21, 3) }, { project: 'ol', lots: [lot('L80')] }])
  expect(heads(p)[0]).toMatchObject({ name: 'maritime', count: 21, doing: 3, folded: true })
  expect(p.lines.filter(l => l.kind === 'lot').map(l => l.kind === 'lot' && l.id)).toEqual(['L80'])
  expect(heads(p)[1]).toMatchObject({ name: 'ol', folded: false })
})

test('R1 — vingt lots ouverts : le projet reste ouvert ; les sous-tâches ne comptent pas dans le seuil', () => {
  const twenty = folding([{ project: 'p', lots: many(20) }])
  expect(heads(twenty)[0]).toMatchObject({ folded: false })
  expect(twenty.lines.filter(l => l.kind === 'lot')).toHaveLength(20)
  const tasks = Array.from({ length: 30 }, (_, i) => ({ ...lot(`L1/${i + 1}`), parent: 'L1' }))
  expect(heads(folding([{ project: 'p', lots: [lot('L1'), ...tasks] }]))[0]).toMatchObject({ count: 1, folded: false })
})

test('R2 — le choix de la personne l’emporte sur le défaut, dans les deux sens', () => {
  const rows = [{ project: 'maritime', lots: many(30) }, { project: 'ol', lots: [lot('L80')] }]
  const p = folding(rows, { maritime: false, ol: true })
  expect(heads(p).map(h => h.kind === 'project' && h.folded)).toEqual([false, true])
  expect(p.lines.filter(l => l.kind === 'lot')).toHaveLength(30)
})

test('R3 — un projet replié ne compte pas dans « … +N lots de plus » et laisse sa place aux autres', () => {
  const p = build({ rows: [{ project: 'maritime', lots: many(200) }, { project: 'ol', lots: many(5) }], columns: 70, height: 6, waves: [], folds: {} })
  // sur 6 lignes, titre et pied en prennent 2 et « … +N » une : restent maritime (replié), ol et son premier lot
  expect(p.lines.map(l => l.kind === 'project' ? l.name : l.kind === 'lot' ? l.id : 'more')).toEqual(['maritime', 'ol', 'L1'])
  expect(p.more).toBe(4)
})

test('R3 — un projet replié placé après la coupure garde sa ligne : jamais de disparition silencieuse', () => {
  const rows = [{ project: 'A', lots: many(8) }, { project: 'B', lots: many(25) }, { project: 'C', lots: many(25) }]
  const p = build({ rows, columns: 70, height: 12, waves: [], folds: {} })
  const names = p.lines.filter(l => l.kind === 'project').map(l => l.kind === 'project' && l.name)
  expect(names).toEqual(['A', 'B', 'C'])
  // les lots de A que la coupe retire sont comptés, ceux de B et C (repliés) non
  expect(p.lines.filter(l => l.kind === 'lot').length + p.more).toBe(8)
  expect(p.more).toBeGreaterThan(0)
})

test('R3 — des projets repliés plus nombreux que la place : le corps ne dépasse pas sa hauteur, les lots des lignes retirées sont comptés', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ project: `P${i + 1}`, lots: many(25) }))
  const p = build({ rows, columns: 70, height: 6, waves: [], folds: {} })
  // height 6 : room 4, dont une ligne pour « … +N » ; les lots des trois projets retirés (3 × 25) y sont comptés
  expect(p.lines.map(l => l.kind === 'project' && l.name)).toEqual(['P1', 'P2', 'P3'])
  expect(p.more).toBe(75)
})

test('R3 — un lot caché derrière un projet ouvert et un replié : le replié reste, le pied compte les lots ouverts cachés', () => {
  const rows = [{ project: 'maritime', lots: many(159) }, { project: 'B', lots: many(25) }, { project: 'ol', lots: many(3) }]
  const p = build({ rows, columns: 70, height: 22, waves: [], folds: { maritime: false } })
  const names = p.lines.filter(l => l.kind === 'project').map(l => l.kind === 'project' && l.name)
  expect(names).toContain('B')
  expect(p.lines.filter(l => l.kind === 'lot').length + p.more).toBe(162)
})

test('R4 — un projet illisible ne se replie pas', () => {
  const p = folding([{ project: 'cassé', error: 'x' }], { cassé: true })
  expect(heads(p)[0]).toMatchObject({ error: 'illisible : x' })
  expect(heads(p)[0]).not.toHaveProperty('folded')
})

// ── L410 : l'ordre d'un projet — en cours, puis prêts, puis le reste ───────────────────────────────────────────────

const order = (rows: LotsRow[], waves: { project: string; lot: string; status: string }[] = []): string[] =>
  panel({ rows, waves }).lines.flatMap(l => (l.kind === 'lot' ? [l.id] : []))

test('L410 — en cours (doing) avant les prêts, puis le reste bloqué, l’ordre du plan gardé dans chaque groupe', () => {
  const rows = [{ project: 'p', lots: [lot('L1', 'todo', { after: ['L9'] }), lot('L2'), lot('L3', 'doing'), lot('L4'), lot('L5', 'doing'), lot('L9', 'todo', { after: ['L1'] })] }]
  expect(order(rows)).toEqual(['L3', 'L5', 'L2', 'L4', 'L1', 'L9'])
})

test('L410 — en vague : implémentation, revue, correction, question, rendu comptent comme en cours ; en attente non', () => {
  const lots = [lot('L1'), lot('L2'), lot('L3'), lot('L4'), lot('L5'), lot('L6'), lot('L7')]
  const waves = [
    { project: 'p', lot: 'L2', status: 'implementing' },
    { project: 'p', lot: 'L3', status: 'reviewing' },
    { project: 'p', lot: 'L4', status: 'question' },
    { project: 'p', lot: 'L5', status: 'handed-back' },
    { project: 'p', lot: 'L6', status: 'fixing' },
    { project: 'p', lot: 'L7', status: 'queued' },
  ]
  expect(order([{ project: 'p', lots }], waves)).toEqual(['L2', 'L3', 'L4', 'L5', 'L6', 'L1', 'L7'])
})

test('L410 — une vague prête (ready) compte comme en cours', () => {
  expect(order([{ project: 'p', lots: [lot('L1'), lot('L2')] }], [{ project: 'p', lot: 'L2', status: 'ready' }])).toEqual(['L2', 'L1'])
})

test('L410 — une vague en échec ou suspendue ne compte pas comme en cours : le lot suit le plan, avec les prêts s’il est libre', () => {
  const lots = [lot('L1', 'todo', { after: ['L9'] }), lot('L2'), lot('L3'), lot('L4'), lot('L9')]
  const waves = [{ project: 'p', lot: 'L3', status: 'failed' }, { project: 'p', lot: 'L4', status: 'suspended' }]
  expect(order([{ project: 'p', lots }], waves)).toEqual(['L2', 'L3', 'L4', 'L9', 'L1'])
})

test('L410 — un sous-lot reste sous son parent, et le parent dont un sous-lot est en cours remonte avec lui', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), lot('L2'), lot('L3', 'todo', { parent: 'L2' }), lot('L4', 'doing', { parent: 'L2' }), lot('L5')] }]
  expect(order(rows)).toEqual(['L2', 'L4', 'L3', 'L1', 'L5'])
})

test('L410 — sous-tâche native en cours : son lot remonte, elle passe avant ses sœurs', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), lot('L2'), task('L2', 1), task('L2', 2, 'doing')] }]
  expect(order(rows)).toEqual(['L2', 'L2/2', 'L2/1', 'L1'])
})

test('L410 — aucun lot en cours : l’ordre du plan est inchangé', () => {
  const rows = [{ project: 'p', lots: [lot('L3'), lot('L1'), lot('L2')] }]
  expect(order(rows)).toEqual(['L3', 'L1', 'L2'])
})

test('L410 — un parent bloqué dont les sous-tâches sont seulement à faire ne remonte pas parmi les prêts', () => {
  const rows = [{ project: 'p', lots: [lot('L3'), lot('L5', 'todo', { after: ['L3'] }), task('L5', 1), task('L5', 2), lot('L6')] }]
  expect(order(rows)).toEqual(['L3', 'L6', 'L5', 'L5/1', 'L5/2'])
})

test('L410 — un parent bloqué dont un sous-lot est libre mais pas en cours reste dans le reste', () => {
  const rows = [{ project: 'p', lots: [lot('L3'), lot('L5', 'todo', { after: ['L3'] }), lot('L7', 'todo', { parent: 'L5' }), lot('L6')] }]
  expect(order(rows)).toEqual(['L3', 'L6', 'L5', 'L7'])
})

// ── L411 : cinq lots par projet, « + N lots » / « moins », sous-lots repliés ───────────────────────────────────────

const view = (rows: LotsRow[], views: Record<string, boolean> = {}) => buildPanel({ rows, columns: 70, height: 400, waves: [], views })
const lotIds = (p: ReturnType<typeof buildPanel>) => p.lines.flatMap(l => (l.kind === 'lot' ? [l.id] : []))
const moreLine = (p: ReturnType<typeof buildPanel>) => p.lines.find(l => l.kind === 'more')

test('R1 — au plus 5 lots par projet : les 5 premiers dans l’ordre affiché (en cours d’abord), le compte du projet reste entier', () => {
  const lots = [...Array.from({ length: 7 }, (_, i) => lot(`L${i + 1}`)), lot('L8', 'doing')]
  const p = view([{ project: 'p', lots }])
  expect(lotIds(p)).toEqual(['L8', 'L1', 'L2', 'L3', 'L4'])
  expect(p.lines[0]).toMatchObject({ kind: 'project', count: 8 })
})

test('R1 — cinq lots ou moins : tout est montré, aucun bouton', () => {
  const p = view([{ project: 'p', lots: Array.from({ length: 5 }, (_, i) => lot(`L${i + 1}`)) }])
  expect(lotIds(p)).toHaveLength(5)
  expect(moreLine(p)).toBeUndefined()
})

test('R1 — le plafond compte les lots du premier niveau : un lot et ses sous-lots tiennent pour un', () => {
  const lots = [lot('L1'), lot('L2'), lot('L3'), lot('L4'), lot('L5'), lot('L6'), lot('L7', 'todo', { parent: 'L5' }), lot('L8', 'todo', { parent: 'L5' })]
  const p = view([{ project: 'p', lots }], { [openKey('p', 'L5')]: true })
  expect(lotIds(p)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L7', 'L8'])
  expect(moreLine(p)).toMatchObject({ hidden: 1 })
})

test('R2 — plus de 5 lots : un bouton « + N lots » compte le reste, replié par défaut', () => {
  const p = view([{ project: 'p', lots: Array.from({ length: 12 }, (_, i) => lot(`L${i + 1}`)) }])
  expect(moreLine(p)).toEqual({ kind: 'more', project: 'p', hidden: 7, behind: 7, expanded: false })
  expect(p.lines.at(-1)).toMatchObject({ kind: 'more' })
})

test('R2 — le bouton déplié montre tout le reste du projet et devient « moins »', () => {
  const p = view([{ project: 'p', lots: Array.from({ length: 12 }, (_, i) => lot(`L${i + 1}`)) }], { [moreKey('p')]: true })
  expect(lotIds(p)).toHaveLength(12)
  expect(moreLine(p)).toEqual({ kind: 'more', project: 'p', hidden: 7, behind: 7, expanded: true })
})

test('R2 — le choix est par projet : déplier l’un ne déplie pas l’autre', () => {
  const rows = ['a', 'b'].map(project => ({ project, lots: Array.from({ length: 7 }, (_, i) => lot(`L${i + 1}`)) }))
  const p = view(rows, { [moreKey('a')]: true })
  expect(p.lines.filter(l => l.kind === 'more').map(l => l.kind === 'more' && [l.project, l.expanded])).toEqual([['a', true], ['b', false]])
  expect(lotIds(p)).toHaveLength(12)
})

test('R3 — un lot qui a des sous-lots est replié par défaut : ses sous-lots sont cachés, leur compte est donné', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), lot('L2', 'todo', { parent: 'L1' }), lot('L3', 'todo', { parent: 'L1' }), task('L1', 1)] }]
  const p = view(rows)
  expect(lotIds(p)).toEqual(['L1'])
  expect(p.lines.find(l => l.kind === 'lot')).toMatchObject({ subs: { key: openKey('p', 'L1'), count: 3, open: false } })
})

test('R3 — déplié, le lot montre ses sous-lots dans l’ordre affiché ; un lot sans sous-lot n’a pas de bascule', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), lot('L2', 'todo', { parent: 'L1' }), lot('L3')] }]
  const p = view(rows, { [openKey('p', 'L1')]: true })
  expect(lotIds(p)).toEqual(['L1', 'L2', 'L3'])
  expect(p.lines.find(l => l.kind === 'lot' && l.id === 'L1')).toMatchObject({ subs: { count: 1, open: true } })
  expect(p.lines.find(l => l.kind === 'lot' && l.id === 'L3')).not.toHaveProperty('subs')
})

test('R3 — le choix de dépli est par projet : le même id dans deux projets ne se déplie pas ensemble', () => {
  const lots = [lot('L1'), lot('L2', 'todo', { parent: 'L1' })]
  const p = view([{ project: 'a', lots }, { project: 'b', lots }], { [openKey('a', 'L1')]: true })
  expect(lotIds(p)).toEqual(['L1', 'L2', 'L1'])
})

test('R3 — un sous-lot qui a lui-même des sous-lots se plie de même', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), lot('L2', 'todo', { parent: 'L1' }), lot('L3', 'todo', { parent: 'L2' })] }]
  expect(lotIds(view(rows, { [openKey('p', 'L1')]: true }))).toEqual(['L1', 'L2'])
  expect(lotIds(view(rows, { [openKey('p', 'L1')]: true, [openKey('p', 'L2')]: true }))).toEqual(['L1', 'L2', 'L3'])
})

test('R3 — le compte des sous-lots est gardé sur la ligne même étroite : le titre cède, jamais l’id ni le compte', () => {
  const rows = [{ project: 'p', lots: [lot('L1', 'todo', { title: 'x'.repeat(200) }), lot('L2', 'todo', { parent: 'L1' })] }]
  const p = buildPanel({ rows, columns: 40, height: 40, waves: [], views: {} })
  const l1 = p.lines.find(l => l.kind === 'lot')!
  expect(l1.kind === 'lot' && l1.title.endsWith('…')).toBe(true)
  expect(l1.kind === 'lot' && l1.subs?.count).toBe(1)
})

test('R4 — un projet replié (L409) ne montre ni lots ni bouton', () => {
  const p = view([{ project: 'p', lots: Array.from({ length: 9 }, (_, i) => lot(`L${i + 1}`)) }], {})
  expect(moreLine(buildPanel({ rows: [{ project: 'p', lots: Array.from({ length: 9 }, (_, i) => lot(`L${i + 1}`)) }], columns: 70, height: 40, waves: [], folds: { p: true } }))).toBeUndefined()
  expect(moreLine(p)).toBeDefined()
})

const twelve = (name: string) => ({ project: name, lots: Array.from({ length: 12 }, (_, i) => lot(`L${i + 1}`)) })
const buttons = (p: ReturnType<typeof buildPanel>) => p.lines.filter(l => l.kind === 'more')

test('R4 — le bouton « + N lots » reste affiché quand la hauteur coupe les lots : les lots coupés passent dans « … +N », jamais le bouton', () => {
  const p = buildPanel({ rows: [twelve('p')], columns: 70, height: 6, waves: [], views: {} })
  expect(p.lines.filter(l => l.kind === 'lot').map(l => l.kind === 'lot' && l.id)).toEqual(['L1'])
  expect(buttons(p)).toEqual([{ kind: 'more', project: 'p', hidden: 7, behind: 7, expanded: false }])
  expect(p.more).toBe(4) // L2 à L5 coupés ; les 7 autres sont derrière le bouton, qui les annonce
})

test('R4 — « moins » reste affiché quand la hauteur coupe le reste déplié : le projet se replie toujours', () => {
  const p = buildPanel({ rows: [twelve('p')], columns: 70, height: 10, waves: [], views: { [moreKey('p')]: true } })
  expect(buttons(p)).toEqual([{ kind: 'more', project: 'p', hidden: 7, behind: 7, expanded: true }])
  expect(p.lines.filter(l => l.kind === 'lot')).toHaveLength(5)
  expect(p.more).toBe(7)
})

test('R4 — un bouton coupé avec son projet compte les lots qu’il cachait dans « … +N »', () => {
  const p = buildPanel({ rows: [twelve('a'), twelve('b')], columns: 70, height: 12, waves: [], views: {} })
  const visible = p.lines.filter(l => l.kind === 'lot').length
  // 24 lots en tout : ce que le panneau montre + ce que « … +N » annonce + ce que les boutons affichés annoncent
  const behindButtons = buttons(p).reduce((n, l) => n + (l.kind === 'more' ? l.behind : 0), 0)
  expect(visible + p.more + behindButtons).toBe(24)
})

/** Ce que le panneau rend compte de : les lots affichés, ceux qu'un lot replié affiché cache (tous ses descendants), ceux qu'un bouton replié affiché cache (sous-lots compris), et « … +N ». */
const accounted = (p: ReturnType<typeof buildPanel>) =>
  p.lines.reduce((n, l) => n + (l.kind === 'lot' ? 1 + (l.subs && !l.subs.open ? l.subs.total : 0) : l.kind === 'more' && !l.expanded ? l.behind : 0), 0) + p.more

test('L411 — la coupe compte tous les descendants d’un lot replié qu’elle retire, petits-enfants compris (sonde 1)', () => {
  // S1 > S3 > S5, plus S2 ; hauteur 4 : aucune ligne de lot ne tient, le pied doit compter les 4 lots (S5 est un petit-enfant)
  const rows = [{ project: 's', lots: [lot('S1'), lot('S2'), lot('S3', 'todo', { parent: 'S1' }), lot('S5', 'todo', { parent: 'S3' })] }]
  const p = buildPanel({ rows, columns: 70, height: 4, waves: [] })
  expect(p.lines.filter(l => l.kind === 'lot')).toHaveLength(0)
  expect(p.more).toBe(4)
  // le lot replié affiché porte le total de ses descendants, pas seulement ses sous-lots directs
  const whole = buildPanel({ rows, columns: 70, height: 40, waves: [] })
  expect(whole.lines.find(l => l.kind === 'lot' && l.id === 'S1')).toMatchObject({ subs: { count: 1, total: 2, open: false } })
})

test('L411 — un bouton coupé avec son projet compte les sous-lots cachés derrière lui (sonde 2)', () => {
  // deux projets de 9 lots : 7 au premier niveau, 2 sous-lots sous L7 (derrière le bouton) ; hauteur 9
  const nine = (name: string) => ({ project: name, lots: [...Array.from({ length: 7 }, (_, i) => lot(`L${i + 1}`)), lot('L8', 'todo', { parent: 'L7' }), lot('L9', 'todo', { parent: 'L7' })] })
  const p = buildPanel({ rows: [nine('a'), nine('b')], columns: 70, height: 9, waves: [], views: {} })
  expect(p.lines.filter(l => l.kind === 'lot')).toHaveLength(4)
  // le bouton gardé (projet a) annonce 2 lots du premier niveau, en cache 4
  expect(buttons(p)).toEqual([{ kind: 'more', project: 'a', hidden: 2, behind: 4, expanded: false }])
  // L5 de a, L1 à L5 de b, et les 4 lots derrière le bouton coupé de b (L6, L7, L8, L9)
  expect(p.more).toBe(10)
  expect(accounted(p)).toBe(18)
})

test('L411 — trois niveaux derrière un bouton coupé : la chaîne entière est comptée dans « … +N »', () => {
  // b : L1 à L7 au premier niveau, L7 > L8 > L9 ; le bouton de b (2 lots du premier niveau, 4 en tout) est coupé avec son projet
  const b = { project: 'b', lots: [...Array.from({ length: 7 }, (_, i) => lot(`L${i + 1}`)), lot('L8', 'todo', { parent: 'L7' }), lot('L9', 'todo', { parent: 'L8' })] }
  const p = buildPanel({ rows: [twelve('a'), b], columns: 70, height: 12, waves: [], views: {} })
  expect(p.lines.filter(l => l.kind === 'lot').map(l => l.kind === 'lot' && l.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5'])
  expect(buttons(p)).toEqual([{ kind: 'more', project: 'a', hidden: 7, behind: 7, expanded: false }])
  // les 9 lots de b : 5 lignes coupées + 4 derrière son bouton coupé (dont L8 et L9, à deux et trois niveaux)
  expect(p.more).toBe(9)
  expect(accounted(p)).toBe(21)
})

/** Un générateur déterministe (mulberry32) : le test rejoue toujours les mêmes arbres. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Un projet au hasard : des lots du premier niveau, des sous-lots `parent:` à toute profondeur, des sous-tâches natives `<lot>/<n>`, quelques after: et lots en cours. */
const randomProject = (name: string, rnd: () => number): LotsRow => {
  const lots: TourLot[] = []
  const count = 1 + Math.floor(rnd() * 14)
  for (let i = 0; i < count; i++) {
    const status = rnd() < 0.15 ? 'doing' : 'todo'
    const after = lots.length > 0 && rnd() < 0.2 ? [lots[Math.floor(rnd() * lots.length)]!.id] : []
    const draw = rnd()
    const parent = lots.length > 0 && draw < 0.55 ? lots[Math.floor(rnd() * lots.length)]! : undefined
    if (parent && draw < 0.2) lots.push(task(parent.id, i, status))
    else if (parent) lots.push(lot(`L${i + 1}`, status, { parent: parent.id, after }))
    else lots.push(lot(`L${i + 1}`, status, { after }))
  }
  return { project: name, lots }
}

test('L411 — propriété : pour tout arbre et toute hauteur, lots affichés + descendants cachés + lots derrière les boutons gardés + « … +N » = total du tableau', () => {
  const rnd = prng(2026_10_28)
  let cases = 0
  for (let round = 0; round < 120; round++) {
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => randomProject(`p${i}`, rnd))
    const total = rows.reduce((n, r) => n + (r.lots?.length ?? 0), 0)
    const views: Record<string, boolean> = {}
    for (const r of rows) {
      if (rnd() < 0.5) views[moreKey(r.project)] = true
      for (const l of r.lots ?? []) if (rnd() < 0.5) views[openKey(r.project, l.id)] = true
    }
    const columns = rnd() < 0.5 ? 30 : 70
    const folds = Object.fromEntries(rows.map(r => [r.project, false]))
    const whole = buildPanel({ rows, columns, height: 1000, waves: [], views, folds })
    expect(whole.more).toBe(0)
    for (let height = 1; height <= whole.lines.length + 4; height++) {
      const p = buildPanel({ rows, columns, height, waves: [], views, folds })
      if (accounted(p) !== total) throw new Error(`hauteur ${height}, colonnes ${columns} : ${accounted(p)} lots rendus pour ${total}\n${JSON.stringify({ rows, views })}`)
      cases++
    }
  }
  expect(cases).toBeGreaterThan(1000)
})

test('L411 — la bascule d’un lot à sous-lots est collée à l’id à tous les niveaux, sous la colonne du glyphe du projet', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), lot('L2', 'todo', { parent: 'L1' }), lot('L3'), lot('L4', 'todo', { parent: 'L2' })] }]
  const p = buildPanel({ rows, columns: 70, height: 40, waves: [], views: { [openKey('p', 'L1')]: true } })
  const leads = Object.fromEntries(p.lines.flatMap(l => (l.kind === 'lot' ? [[l.id, l.lead]] : [])))
  expect(leads).toEqual({ L1: ' ▾', L2: '  └▸', L3: '  ' })
// ── L402 : réordonner ──────────────────────────────────────────────────────────────────────────────────────

const PLAN = [lot('L1'), lot('L2'), task('L2', 1), task('L2', 2), lot('L3')]
/** Tous les lots au même rang d'affichage : l'écran suit l'ordre du plan. */
const flat = () => 1

test('R20 — un lot se place avant ou après un lot du même projet : la demande à raf', () => {
  expect(planMove(PLAN, { id: 'L3', target: 'L1', place: 'before' }, flat)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L3', '--before', 'L1'], planOnly: false })
  expect(planMove(PLAN, { id: 'L1', target: 'L3', place: 'after' }, flat)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L1', '--after', 'L3'], planOnly: false })
})

test('R20 — une sous-tâche se place parmi celles de son lot', () => {
  expect(planMove(PLAN, { id: 'L2/2', target: 'L2/1', place: 'before' }, flat)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L2/2', '--before', 'L2/1'], planOnly: false })
})

test('R21 — parents différents : refusé avec sa raison, raf n’est pas appelé', () => {
  for (const [id, target] of [['L2/1', 'L1'], ['L1', 'L2/1']] as const) {
    const plan = planMove(PLAN, { id, target, place: 'after' }, flat)
    expect(plan?.kind).toBe('refused')
    expect(plan?.kind === 'refused' && plan.reason).toMatch(new RegExp(`${id.replace('/', '\\/')} et ${target.replace('/', '\\/')} n'ont pas le même parent`))
  }
  expect(groupOf(task('L2', 1))).toBe('L2')
  expect(groupOf(lot('L1', 'todo', { parent: 'L0' }))).toBe('')
})

test('R21 — un lot lâché sur lui-même ne demande rien ; un id inconnu ou une place inconnue est refusé', () => {
  expect(planMove(PLAN, { id: 'L1', target: 'L1', place: 'after' }, flat)).toBeUndefined()
  expect(planMove(PLAN, { id: 'L9', target: 'L1', place: 'after' }, flat)).toEqual({ kind: 'refused', reason: 'lot inconnu : L9' })
  expect(planMove(PLAN, { id: 'L1', target: 'L9', place: 'after' }, flat)).toEqual({ kind: 'refused', reason: 'lot inconnu : L9' })
  expect(planMove(PLAN, { id: 'L1', target: 'L3', place: 'beside' as never }, flat)?.kind).toBe('refused')
})

test('R22 — un lot déjà à sa place dans le plan : raf n’est pas demandé, le panneau le dit (lots et sous-tâches)', () => {
  expect(planMove(PLAN, { id: 'L1', target: 'L2', place: 'before' }, flat)).toEqual({ kind: 'unchanged', text: 'L1 est déjà avant L2 dans le plan : rien à déplacer' })
  expect(planMove(PLAN, { id: 'L2', target: 'L1', place: 'after' }, flat)).toEqual({ kind: 'unchanged', text: 'L2 est déjà après L1 dans le plan : rien à déplacer' })
  expect(planMove(PLAN, { id: 'L2/1', target: 'L2/2', place: 'before' }, flat)).toEqual({ kind: 'unchanged', text: 'L2/1 est déjà avant L2/2 dans le plan : rien à déplacer' })
  // les sous-tâches entre L2 et L3 ne comptent pas : L3 est bien déjà juste après L2 parmi les lots
  expect(planMove(PLAN, { id: 'L3', target: 'L2', place: 'after' }, flat)).toEqual({ kind: 'unchanged', text: 'L3 est déjà après L2 dans le plan : rien à déplacer' })
  // mais L1 avant L3 déplace bien L1 (L2 est entre les deux)
  expect(planMove(PLAN, { id: 'L1', target: 'L3', place: 'before' }, flat)?.kind).toBe('move')
})

test('R22 — L410 : un déplacement entre deux groupes d’affichage change le plan sans changer l’écran : planOnly', () => {
  const l1First = (l: TourLot) => (l.id === 'L1' ? 0 : 1) // L1 en cours : affiché en tête quelle que soit sa place dans le plan
  expect(displayOrder(PLAN, l1First)).toEqual(['L1', 'L2', 'L2/1', 'L2/2', 'L3'])
  // L1 après L3 : le plan devient L2, L3, L1 ; l'écran reste L1, L2, L3
  expect(planMove(PLAN, { id: 'L1', target: 'L3', place: 'after' }, l1First)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L1', '--after', 'L3'], planOnly: true })
  // L3 avant L1 : le plan devient L3, L1, L2 ; l'écran L1, L3, L2 — visible
  expect(planMove(PLAN, { id: 'L3', target: 'L1', place: 'before' }, l1First)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L3', '--before', 'L1'], planOnly: false })
  // et L2 avant L1, qui est déjà le cas à l'écran mais pas dans le plan : le plan change, l'écran non
  expect(planMove(PLAN, { id: 'L2', target: 'L1', place: 'before' }, l1First)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L2', '--before', 'L1'], planOnly: true })
})

test('R22 — tableau périmé (stale) : ni « déjà » ni « plan seul » sur un ordre qui n’est plus celui du plan, raf tranche ; les refus restent', () => {
  const l1First = (l: TourLot) => (l.id === 'L1' ? 0 : 1)
  expect(planMove(PLAN, { id: 'L1', target: 'L2', place: 'before' }, flat, true)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L1', '--before', 'L2'], planOnly: false })
  expect(planMove(PLAN, { id: 'L1', target: 'L3', place: 'after' }, l1First, true)).toEqual({ kind: 'move', argv: ['raf', 'move', 'L1', '--after', 'L3'], planOnly: false })
  expect(planMove(PLAN, { id: 'L2/1', target: 'L1', place: 'after' }, flat, true)?.kind).toBe('refused')
  expect(planMove(PLAN, { id: 'L9', target: 'L1', place: 'after' }, flat, true)).toEqual({ kind: 'refused', reason: 'lot inconnu : L9' })
  expect(planMove(PLAN, { id: 'L1', target: 'L1', place: 'after' }, flat, true)).toBeUndefined()
})

test('R21 — la raison d’un refus de raf : sa première ligne sans le préfixe, le code à défaut', () => {
  expect(refusalReason('raf: move : orchestration en cours (vague w1, pid 3) — attendre\nsuite', 2)).toBe('move : orchestration en cours (vague w1, pid 3) — attendre')
  expect(refusalReason('\n  \n', 2)).toBe('raf move : code 2')
})

test('R20 — le dossier d’un projet du tour : le dossier lui-même pour un projet seul, sinon dossier/projet', () => {
  const one = [{ project: 'cadence' }]
  expect(projectDir('/w/cadence', 'cadence', one)).toBe('/w/cadence')
  expect(projectDir('/w/cadence/', 'cadence', one)).toBe('/w/cadence/')
  expect(projectDir('/w', 'apps/ol', [{ project: 'apps/ol' }, { project: 'cadence' }])).toBe('/w/apps/ol')
})

test('R20 — chaque ligne de lot du panneau porte son groupe de frères', () => {
  const panel = buildPanel({ rows: [{ project: 'p', lots: PLAN }], columns: 80, height: 30, waves: [] })
  expect(panel.lines.flatMap(l => (l.kind === 'lot' ? [`${l.id}:${l.group}`] : []))).toEqual(['L1:', 'L2:', 'L2/1:L2', 'L2/2:L2', 'L3:'])
})

test('R22 — ce que la région Client poste est vérifié : seule une demande complète passe', () => {
  expect(parseMoveAsk({ kind: 'move', project: 'p', id: 'L1', target: 'L2', place: 'after' })).toEqual({ project: 'p', id: 'L1', target: 'L2', place: 'after' })
  for (const bad of [null, 'move', 7, {}, { kind: 'move', project: 'p', id: 'L1', target: 'L2', place: 'beside' }, { kind: 'move', project: 'p', id: 1, target: 'L2', place: 'after' }, { kind: 'other', project: 'p', id: 'L1', target: 'L2', place: 'after' }]) {
    expect(parseMoveAsk(bad)).toBeUndefined()
  }
})
