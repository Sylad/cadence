import { expect, test } from 'claude-code/testing'

import { buildPanel, flattenTree, isTask, lotState, lotTree, openCount, parseLotsBoard, readTime } from '../hooks/lots'
import type { LotsRow, TourLot } from '../types'

const lot = (id: string, status: 'todo' | 'doing' = 'todo', extra: Partial<TourLot> = {}): TourLot => ({ id, title: `Titre ${id}`, status, after: [], ...extra })
const task = (parent: string, n: number, status: 'todo' | 'doing' = 'todo'): TourLot => ({ id: `${parent}/${n}`, title: `Tâche ${n}`, status, after: [], parent })
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
const panel = (over: Partial<Parameters<typeof buildPanel>[0]> = {}) => buildPanel({ rows: ROWS, columns: 70, height: 40, waves: [], ...over })

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
  const only = buildPanel({ rows: [{ project: 'p', lots: [lot('L9', 'todo', { after: ['L400'] })] }], columns: 70, height: 40, waves: [] })
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
  const p = buildPanel({ rows: [long], columns: 49, height: 40, waves: [] })
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
  const p = buildPanel({ rows: [{ project: 'p', lots: [lot('L401'), task('L401', 2)] }], columns: 24, height: 40, waves: [] })
  const sub = p.lines.find(l => l.kind === 'lot' && l.id === 'L401/2')
  expect(sub).toBeDefined()
})

test('R17 — titre long : tronqué sur une ligne', () => {
  const p = buildPanel({ rows: [{ project: 'p', lots: [lot('L1', 'todo', { title: 'x'.repeat(200) })] }], columns: 70, height: 40, waves: [] })
  const l = p.lines.find(x => x.kind === 'lot')!
  expect(l.kind === 'lot' && l.title.length).toBeLessThan(70)
  expect(l.kind === 'lot' && l.title.endsWith('…')).toBe(true)
})

test('R17 — arbre plus haut que le panneau : « … +N lots de plus »', () => {
  const many = { project: 'p', lots: Array.from({ length: 12 }, (_, i) => lot(`L${i + 1}`)) }
  // 6 lignes de corps : titre, pied, la ligne « … +N » et le nom du projet laissent 2 lots
  const p = buildPanel({ rows: [many], columns: 70, height: 6, waves: [] })
  const shown = p.lines.filter(l => l.kind === 'lot')
  expect(shown).toHaveLength(2)
  expect(p.more).toBe(10)
})

test('R17 — sous-tâches comprises dans les lignes comptées de « de plus »', () => {
  const rows = [{ project: 'p', lots: [lot('L1'), task('L1', 1), task('L1', 2), task('L1', 3)] }]
  const p = buildPanel({ rows, columns: 70, height: 6, waves: [] })
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
const folding = (rows: LotsRow[], folds: Record<string, boolean> = {}) => buildPanel({ rows, columns: 70, height: 400, waves: [], folds })
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
  const p = buildPanel({ rows: [{ project: 'maritime', lots: many(200) }, { project: 'ol', lots: many(5) }], columns: 70, height: 6, waves: [], folds: {} })
  // sur 6 lignes, titre et pied en prennent 2 et « … +N » une : restent maritime (replié), ol et son premier lot
  expect(p.lines.map(l => l.kind === 'project' ? l.name : l.id)).toEqual(['maritime', 'ol', 'L1'])
  expect(p.more).toBe(4)
})

test('R3 — un projet replié placé après la coupure garde sa ligne : jamais de disparition silencieuse', () => {
  const rows = [{ project: 'A', lots: many(8) }, { project: 'B', lots: many(25) }, { project: 'C', lots: many(25) }]
  const p = buildPanel({ rows, columns: 70, height: 12, waves: [], folds: {} })
  const names = p.lines.filter(l => l.kind === 'project').map(l => l.kind === 'project' && l.name)
  expect(names).toEqual(['A', 'B', 'C'])
  // les lots de A que la coupe retire sont comptés, ceux de B et C (repliés) non
  expect(p.lines.filter(l => l.kind === 'lot').length + p.more).toBe(8)
  expect(p.more).toBeGreaterThan(0)
})

test('R3 — des projets repliés plus nombreux que la place : le corps ne dépasse pas sa hauteur, les lots des lignes retirées sont comptés', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ project: `P${i + 1}`, lots: many(25) }))
  const p = buildPanel({ rows, columns: 70, height: 6, waves: [], folds: {} })
  // height 6 : room 4, dont une ligne pour « … +N » ; les lots des trois projets retirés (3 × 25) y sont comptés
  expect(p.lines.map(l => l.kind === 'project' && l.name)).toEqual(['P1', 'P2', 'P3'])
  expect(p.more).toBe(75)
})

test('R3 — un lot caché derrière un projet ouvert et un replié : le replié reste, le pied compte les lots ouverts cachés', () => {
  const rows = [{ project: 'maritime', lots: many(159) }, { project: 'B', lots: many(25) }, { project: 'ol', lots: many(3) }]
  const p = buildPanel({ rows, columns: 70, height: 22, waves: [], folds: { maritime: false } })
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
